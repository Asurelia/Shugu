/**
 * Layer 10 — Remote: SSH execution
 *
 * Execute commands on a remote VPS via SSH.
 * Uses the system's ssh binary (no npm dependency).
 * Credentials from the vault (host, user, key_path, port).
 */

import { spawn } from 'node:child_process';
import type { VPSConfig } from '../credentials/provider.js';

// ─── SSH Execution ──────────────────────────────────────

export interface SSHResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Execute a single command on the VPS via SSH.
 */
export async function sshExec(
  config: VPSConfig,
  command: string,
  options: SSHExecOptions = {},
): Promise<SSHResult> {
  const sshArgs = buildSSHArgs(config, options);
  sshArgs.push(command);

  return new Promise((resolve, reject) => {
    const child = spawn('ssh', sshArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: options.timeoutMs ?? 60_000,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > 100_000) stdout = stdout.slice(0, 100_000);
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 100_000) stderr = stderr.slice(0, 100_000);
    });

    if (options.abortSignal) {
      options.abortSignal.addEventListener('abort', () => {
        child.kill('SIGTERM');
      }, { once: true });
    }

    child.on('error', (err) => {
      reject(new Error(`SSH connection failed: ${err.message}. Is 'ssh' installed?`));
    });

    child.on('close', (code) => {
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 1,
      });
    });
  });
}

/**
 * Upload a file to the VPS via scp.
 */
export async function scpUpload(
  config: VPSConfig,
  localPath: string,
  remotePath: string,
): Promise<void> {
  const args = [
    '-i', config.keyPath,
    '-P', String(config.port),
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'BatchMode=yes',
    localPath,
    `${config.user}@${config.host}:${remotePath}`,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn('scp', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`scp failed (${code}): ${stderr}`));
    });
  });
}

/**
 * Download a file from the VPS via scp.
 */
export async function scpDownload(
  config: VPSConfig,
  remotePath: string,
  localPath: string,
): Promise<void> {
  const args = [
    '-i', config.keyPath,
    '-P', String(config.port),
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'BatchMode=yes',
    `${config.user}@${config.host}:${remotePath}`,
    localPath,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn('scp', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`scp failed (${code}): ${stderr}`));
    });
  });
}

/**
 * Test SSH connectivity to the VPS.
 */
export async function sshTest(config: VPSConfig): Promise<boolean> {
  try {
    const result = await sshExec(config, 'echo ok', { timeoutMs: 10_000 });
    return result.stdout === 'ok' && result.exitCode === 0;
  } catch {
    return false;
  }
}

// ─── SSH Tunnel (for proxy) ─────────────────────────────

export interface SSHTunnel {
  localPort: number;
  kill: () => void;
  ready: Promise<void>;
}

/**
 * Open a SOCKS5 proxy tunnel via SSH dynamic port forwarding.
 * Usage: route fetch() through socks5://localhost:{localPort}
 */
export function openSOCKSProxy(
  config: VPSConfig,
  localPort: number = 1080,
): SSHTunnel {
  const args = buildSSHArgs(config, {});
  args.push('-D', String(localPort), '-N', '-f');

  let resolveReady: () => void;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });

  const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true });

  child.stderr?.on('data', () => {
    // SSH prints to stderr when tunnel is established
    resolveReady!();
  });

  // If no stderr after 3s, assume ready
  setTimeout(() => resolveReady!(), 3000);

  return {
    localPort,
    kill: () => {
      child.kill('SIGTERM');
    },
    ready,
  };
}

// ─── Helpers ────────────────────────────────────────────

interface SSHExecOptions {
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

function buildSSHArgs(config: VPSConfig, options: SSHExecOptions): string[] {
  const args: string[] = [
    '-i', config.keyPath,
    '-p', String(config.port),
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    `${config.user}@${config.host}`,
  ];
  return args;
}
