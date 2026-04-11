/**
 * Layer 9 — Automation: Daemon
 *
 * Detached execution mode that runs PCC as a background process.
 * The daemon can:
 * - Run agentic loops without a terminal attached
 * - Persist state to disk for recovery
 * - Be supervised (auto-restart on crash)
 * - Communicate via a Unix socket or named pipe
 *
 * Uses Node.js child_process.fork() for spawning and a simple
 * JSON-lines IPC protocol for communication.
 */

import { fork, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type Server } from 'node:net';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { timingSafeCompare, buildSafeEnv } from '../utils/security.js';

// ─── Daemon Config ─────────────────────────────────────

export interface DaemonConfig {
  /** Directory for daemon state files (pid, log, socket) */
  stateDir: string;
  /** Path to the CLI entrypoint to fork */
  entrypoint: string;
  /** Working directory for the daemon */
  cwd: string;
  /** Environment variables to pass */
  env?: Record<string, string>;
  /** Auto-restart on crash */
  autoRestart?: boolean;
  /** Max restart attempts before giving up */
  maxRestarts?: number;
  /** Cooldown between restarts (ms) */
  restartCooldownMs?: number;
}

// ─── Daemon State ──────────────────────────────────────

export interface DaemonState {
  pid: number | null;
  status: 'stopped' | 'starting' | 'running' | 'error';
  startedAt?: string;
  lastError?: string;
  restartCount: number;
  socketPath: string;
}

// ─── IPC Messages ──────────────────────────────────────

export interface DaemonMessage {
  type: 'prompt' | 'status' | 'stop' | 'result' | 'heartbeat' | 'log';
  payload?: unknown;
  timestamp: string;
  /** IPC authentication nonce — validated by the worker on every message */
  nonce?: string;
}

// ─── Daemon Controller ─────────────────────────────────

/**
 * Controls a daemon process from the parent (REPL/CLI) side.
 * Handles spawning, monitoring, and communicating with the daemon.
 */
export class DaemonController extends EventEmitter {
  private config: DaemonConfig;
  private child: ChildProcess | null = null;
  private state: DaemonState;
  private ipcServer: Server | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private ipcNonce: string | null = null;

  constructor(config: DaemonConfig) {
    super();
    this.config = config;

    // Ensure state directory exists
    if (!existsSync(config.stateDir)) {
      mkdirSync(config.stateDir, { recursive: true });
    }

    const socketPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\pcc-daemon-${process.pid}`
      : join(config.stateDir, 'daemon.sock');

    this.state = {
      pid: null,
      status: 'stopped',
      restartCount: 0,
      socketPath,
    };
  }

  /**
   * Start the daemon process.
   */
  async start(): Promise<void> {
    if (this.state.status === 'running') {
      throw new Error('Daemon is already running');
    }

    this.state.status = 'starting';
    this.saveState();

    try {
      // Generate a cryptographic nonce for IPC authentication.
      // The child reads this from env and validates every incoming message.
      const ipcNonce = randomBytes(32).toString('hex');
      this.ipcNonce = ipcNonce;

      // Fork with sanitized env — only safe vars + daemon-specific extras
      this.child = fork(this.config.entrypoint, ['--daemon'], {
        cwd: this.config.cwd,
        env: buildSafeEnv({
          ...this.config.env,
          PCC_DAEMON: '1',
          PCC_DAEMON_SOCKET: this.state.socketPath,
          PCC_DAEMON_NONCE: ipcNonce,
        }),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });

      this.state.pid = this.child.pid ?? null;
      this.state.status = 'running';
      this.state.startedAt = new Date().toISOString();
      this.saveState();

      // Handle child output
      this.child.stdout?.on('data', (data: Buffer) => {
        this.emit('log', data.toString());
        this.appendLog(data.toString());
      });

      this.child.stderr?.on('data', (data: Buffer) => {
        this.emit('error-log', data.toString());
        this.appendLog(`[stderr] ${data.toString()}`);
      });

      // Handle IPC messages from child
      this.child.on('message', (msg: DaemonMessage) => {
        this.emit('message', msg);
      });

      // Handle exit
      this.child.on('exit', (code, signal) => {
        this.state.pid = null;
        this.state.status = 'stopped';
        this.saveState();
        this.emit('exit', code, signal);

        // Auto-restart if configured
        if (this.config.autoRestart && code !== 0) {
          const maxRestarts = this.config.maxRestarts ?? 5;
          if (this.state.restartCount < maxRestarts) {
            this.state.restartCount++;
            const cooldown = this.config.restartCooldownMs ?? 5000;
            setTimeout(() => this.start(), cooldown);
          } else {
            this.state.status = 'error';
            this.state.lastError = `Exceeded max restarts (${maxRestarts})`;
            this.saveState();
            this.emit('max-restarts');
          }
        }
      });

      // Start heartbeat monitoring
      this.startHeartbeat();

      // Unref the child so the parent can exit
      this.child.unref();
    } catch (error) {
      this.state.status = 'error';
      this.state.lastError = error instanceof Error ? error.message : String(error);
      this.saveState();
      throw error;
    }
  }

  /**
   * Stop the daemon process gracefully.
   */
  async stop(): Promise<void> {
    if (!this.child) {
      this.state.status = 'stopped';
      this.saveState();
      return;
    }

    this.stopHeartbeat();

    // Send stop message via IPC
    try {
      this.child.send({ type: 'stop', timestamp: new Date().toISOString(), nonce: this.ipcNonce ?? undefined });
    } catch {
      // IPC might be disconnected
    }

    // Give it 5 seconds to shut down gracefully
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        // Force kill
        this.child?.kill('SIGKILL');
        resolve();
      }, 5000);

      this.child!.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      // Try SIGTERM first
      this.child!.kill('SIGTERM');
    });

    this.child = null;
    this.state.pid = null;
    this.state.status = 'stopped';
    this.saveState();
  }

  /**
   * Send a prompt to the daemon for execution.
   */
  sendPrompt(prompt: string): void {
    if (!this.child) throw new Error('Daemon is not running');

    const msg: DaemonMessage = {
      type: 'prompt',
      payload: { prompt },
      timestamp: new Date().toISOString(),
      nonce: this.ipcNonce ?? undefined,
    };

    this.child.send(msg);
  }

  /**
   * Get the current daemon state.
   */
  getState(): DaemonState {
    return { ...this.state };
  }

  /**
   * Check if the daemon is alive by checking the PID file.
   * Useful for reconnecting after parent restart.
   */
  static isRunning(stateDir: string): boolean {
    const statePath = join(stateDir, 'daemon.json');
    if (!existsSync(statePath)) return false;

    try {
      const data = JSON.parse(readFileSync(statePath, 'utf-8')) as DaemonState;
      if (!data.pid) return false;

      // Check if process is actually alive
      try {
        process.kill(data.pid, 0); // Signal 0 = check existence
        return true;
      } catch {
        return false;
      }
    } catch {
      return false;
    }
  }

  /**
   * Read the daemon log file.
   */
  readLog(lines?: number): string {
    const logPath = join(this.config.stateDir, 'daemon.log');
    if (!existsSync(logPath)) return '';

    const content = readFileSync(logPath, 'utf-8');
    if (lines) {
      const allLines = content.split('\n');
      return allLines.slice(-lines).join('\n');
    }
    return content;
  }

  // ─── Private ────────────────────────────────────────

  private saveState(): void {
    const statePath = join(this.config.stateDir, 'daemon.json');
    writeFileSync(statePath, JSON.stringify(this.state, null, 2));
  }

  private appendLog(text: string): void {
    const logPath = join(this.config.stateDir, 'daemon.log');
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${text.trimEnd()}\n`;
    try {
      appendFileSync(logPath, line);
    } catch {
      // Log write failure is non-critical
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.child && !this.child.killed) {
        try {
          this.child.send({
            type: 'heartbeat',
            timestamp: new Date().toISOString(),
            nonce: this.ipcNonce ?? undefined,
          });
        } catch {
          // IPC broken — child may have died
        }
      }
    }, 30_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

// ─── Daemon-side Handler ───────────────────────────────

/**
 * Run inside the forked daemon process.
 * Listens for IPC messages and executes prompts.
 */
export class DaemonWorker extends EventEmitter {
  private running = false;

  constructor() {
    super();
  }

  /**
   * Start listening for IPC messages from the parent.
   */
  start(): void {
    if (!process.send) {
      throw new Error('DaemonWorker must run in a forked child process (process.send not available)');
    }

    this.running = true;

    // Read the IPC nonce from env (set by DaemonController at fork time)
    const expectedNonce = process.env['PCC_DAEMON_NONCE'] ?? '';

    process.on('message', (msg: DaemonMessage) => {
      // Validate IPC nonce — reject messages without valid authentication
      if (expectedNonce && !timingSafeCompare(msg.nonce ?? '', expectedNonce)) {
        // Drop unauthenticated message silently (don't reveal nonce exists)
        return;
      }

      switch (msg.type) {
        case 'prompt':
          this.emit('prompt', (msg.payload as { prompt: string }).prompt);
          break;
        case 'stop':
          this.stop();
          break;
        case 'heartbeat':
          this.sendMessage({ type: 'heartbeat', timestamp: new Date().toISOString() });
          break;
        case 'status':
          this.sendMessage({
            type: 'status',
            payload: { running: this.running },
            timestamp: new Date().toISOString(),
          });
          break;
      }
    });

    // Notify parent we're ready
    this.sendMessage({
      type: 'status',
      payload: { running: true },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Send a result back to the parent.
   */
  sendResult(result: string): void {
    this.sendMessage({
      type: 'result',
      payload: { result },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Send a log message to the parent.
   */
  sendLog(text: string): void {
    this.sendMessage({
      type: 'log',
      payload: { text },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Stop the daemon worker and exit.
   */
  stop(): void {
    this.running = false;
    this.emit('stop');
    // Give time for cleanup, then exit
    setTimeout(() => process.exit(0), 1000);
  }

  private sendMessage(msg: DaemonMessage): void {
    process.send?.(msg);
  }
}
