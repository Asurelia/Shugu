/**
 * Layer 9 — Automation: Background Sessions
 *
 * Run agentic loops in the background within the same process.
 * Background sessions are lightweight — they share the same Node.js
 * process as the REPL but run concurrently.
 *
 * Features:
 * - Start a background session with a prompt
 * - Attach to see live output
 * - List/kill running sessions
 * - Sessions write output to a log buffer
 */

import { EventEmitter } from 'node:events';
import { runLoop, type LoopConfig, type LoopEvent } from '../engine/loop.js';
import { InterruptController } from '../engine/interrupts.js';
import type { Message, AssistantMessage } from '../protocol/messages.js';
import type { Tool, ToolContext } from '../protocol/tools.js';
import { isTextBlock } from '../protocol/messages.js';
import { logger } from '../utils/logger.js';

// ─── Background Session ────────────────────────────────

export interface BackgroundSession {
  /** Unique session ID */
  id: string;
  /** Human-readable name */
  name: string;
  /** The prompt that started this session */
  prompt: string;
  /** Current status */
  status: 'running' | 'completed' | 'error' | 'aborted';
  /** When the session started */
  startedAt: string;
  /** When the session ended (if finished) */
  endedAt?: string;
  /** Number of turns completed */
  turns: number;
  /** Total cost in USD */
  costUsd: number;
  /** Final text response (when completed) */
  response?: string;
  /** Error message (if errored) */
  error?: string;
  /** Output log buffer (recent lines) */
  log: string[];
}

// ─── Background Manager ────────────────────────────────

export class BackgroundManager extends EventEmitter {
  private sessions = new Map<string, BackgroundSession>();
  private interrupts = new Map<string, InterruptController>();
  private attachedListeners = new Map<string, Set<(line: string) => void>>();
  private sessionCounter = 0;
  private maxLogLines = 200;

  /**
   * Start a background session.
   */
  async start(
    name: string,
    prompt: string,
    config: LoopConfig,
  ): Promise<BackgroundSession> {
    const id = `bg-${++this.sessionCounter}`;
    const interrupt = new InterruptController();

    const session: BackgroundSession = {
      id,
      name,
      prompt,
      status: 'running',
      startedAt: new Date().toISOString(),
      turns: 0,
      costUsd: 0,
      log: [],
    };

    this.sessions.set(id, session);
    this.interrupts.set(id, interrupt);
    this.attachedListeners.set(id, new Set());

    // Run the loop asynchronously (fire-and-forget)
    this.runSession(id, prompt, config, interrupt).catch((err) => {
      logger.warn(`background session ${id} failed`, err instanceof Error ? err.message : String(err));
    });

    this.emit('session:start', session);
    return session;
  }

  /**
   * Stop/abort a running session.
   */
  abort(id: string): boolean {
    const interrupt = this.interrupts.get(id);
    if (!interrupt) return false;

    interrupt.abort('User aborted');
    return true;
  }

  /**
   * Attach a listener to a session's output.
   * Returns an unsubscribe function.
   */
  attach(id: string, listener: (line: string) => void): (() => void) | null {
    const listeners = this.attachedListeners.get(id);
    if (!listeners) return null;

    listeners.add(listener);

    // Replay existing log
    const session = this.sessions.get(id);
    if (session) {
      for (const line of session.log) {
        listener(line);
      }
    }

    return () => {
      listeners.delete(listener);
    };
  }

  /**
   * Get a session by ID.
   */
  getSession(id: string): BackgroundSession | undefined {
    return this.sessions.get(id);
  }

  /**
   * List all sessions (optionally filtered by status).
   */
  list(status?: BackgroundSession['status']): BackgroundSession[] {
    const all = Array.from(this.sessions.values());
    return status ? all.filter((s) => s.status === status) : all;
  }

  /**
   * Remove a completed/errored/aborted session from the list.
   */
  remove(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session || session.status === 'running') return false;

    this.sessions.delete(id);
    this.interrupts.delete(id);
    this.attachedListeners.delete(id);
    return true;
  }

  /**
   * Number of currently running sessions.
   */
  get activeCount(): number {
    return this.list('running').length;
  }

  // ─── Private ────────────────────────────────────────

  private async runSession(
    id: string,
    prompt: string,
    config: LoopConfig,
    interrupt: InterruptController,
  ): Promise<void> {
    const session = this.sessions.get(id)!;
    const messages: Message[] = [{ role: 'user', content: prompt }];

    try {
      for await (const event of runLoop(messages, config, interrupt)) {
        this.processEvent(id, event);
      }

      if (session.status === 'running') {
        session.status = 'completed';
      }
    } catch (error) {
      session.status = 'error';
      session.error = error instanceof Error ? error.message : String(error);
      this.logLine(id, `[ERROR] ${session.error}`);
    } finally {
      session.endedAt = new Date().toISOString();
      this.emit('session:end', session);
    }
  }

  private processEvent(id: string, event: LoopEvent): void {
    const session = this.sessions.get(id);
    if (!session) return;

    switch (event.type) {
      case 'turn_start':
        this.logLine(id, `── Turn ${event.turnIndex + 1} ──`);
        break;

      case 'assistant_message':
        session.response = event.message.content
          .filter(isTextBlock)
          .map((b) => b.text)
          .join('');
        for (const block of event.message.content) {
          if (isTextBlock(block)) {
            this.logLine(id, block.text);
          }
        }
        break;

      case 'tool_executing':
        this.logLine(id, `[tool] ${event.call.name}`);
        break;

      case 'tool_result': {
        const preview = typeof event.result.content === 'string'
          ? event.result.content.slice(0, 200)
          : '[complex result]';
        this.logLine(id, `[result] ${preview}`);
        break;
      }

      case 'turn_end':
        session.turns++;
        break;

      case 'loop_end':
        session.costUsd = event.totalCost;
        if (event.reason === 'aborted') {
          session.status = 'aborted';
        }
        this.logLine(id, `── Loop ended: ${event.reason} (cost: $${event.totalCost.toFixed(4)}) ──`);
        break;

      case 'error':
        this.logLine(id, `[ERROR] ${event.error.message}`);
        break;
    }
  }

  private logLine(id: string, line: string): void {
    const session = this.sessions.get(id);
    if (!session) return;

    session.log.push(line);
    if (session.log.length > this.maxLogLines) {
      session.log.shift();
    }

    // Notify attached listeners
    const listeners = this.attachedListeners.get(id);
    if (listeners) {
      for (const listener of listeners) {
        listener(line);
      }
    }
  }
}
