/**
 * Layer 3 — Tools: BashTool
 *
 * Executes shell commands with timeout, streaming stdout/stderr,
 * and working directory support.
 *
 * Reference: OpenClaude src/tools/BashTool/BashTool.ts
 */

import { spawn } from 'node:child_process';
import type { Tool, ToolCall, ToolResult, ToolContext, ToolDefinition } from '../../protocol/tools.js';
import { BASH_MAX_OUTPUT_CHARS, BASH_MAX_STDERR_CHARS, truncateBashOutput } from '../outputLimits.js';

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes

export const BashToolDefinition: ToolDefinition = {
  name: 'Bash',
  description: `Executes a bash command and returns its output. The working directory persists between calls. Use for: running commands, installing packages, checking system state, git operations. Avoid for: reading files (use FileRead), searching files (use Grep/Glob), writing files (use FileWrite).`,
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The bash command to execute',
      },
      timeout: {
        type: 'number',
        description: 'Optional timeout in milliseconds (max 600000, default 120000)',
      },
    },
    required: ['command'],
  },
  concurrencySafe: false,
};

export class BashTool implements Tool {
  definition = BashToolDefinition;

  validateInput(input: Record<string, unknown>): string | null {
    if (typeof input['command'] !== 'string' || !input['command']) {
      return 'command must be a non-empty string';
    }
    return null;
  }

  async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const command = call.input['command'] as string;
    const timeoutMs = Math.min(
      (call.input['timeout'] as number) || DEFAULT_TIMEOUT_MS,
      600_000,
    );

    try {
      const result = await runBash(command, context.cwd, timeoutMs, context.abortSignal);
      return {
        tool_use_id: call.id,
        content: formatOutput(result),
        is_error: result.exitCode !== 0,
      };
    } catch (error) {
      return {
        tool_use_id: call.id,
        content: `Error executing command: ${error instanceof Error ? error.message : String(error)}`,
        is_error: true,
      };
    }
  }
}

// ─── Shell Execution ────────────────────────────────────

interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

function runBash(
  command: string,
  cwd: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<BashResult> {
  return new Promise((resolve, reject) => {
    const shell = process.platform === 'win32' ? 'bash' : '/bin/bash';
    const child = spawn(shell, ['-c', command], {
      cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    // Collect with generous buffer — truncation applied at formatting time
    const RAW_BUFFER = BASH_MAX_OUTPUT_CHARS * 2;

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
      if (stdout.length > RAW_BUFFER) {
        stdout = stdout.slice(0, RAW_BUFFER);
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
      if (stderr.length > RAW_BUFFER) {
        stderr = stderr.slice(0, RAW_BUFFER);
      }
    });

    const abortHandler = () => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000);
    };

    if (abortSignal) {
      abortSignal.addEventListener('abort', abortHandler, { once: true });
    }

    child.on('error', (error) => {
      abortSignal?.removeEventListener('abort', abortHandler);
      reject(error);
    });

    child.on('close', (code, signal) => {
      abortSignal?.removeEventListener('abort', abortHandler);

      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        timedOut = true;
      }

      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 1,
        timedOut,
      });
    });
  });
}

// ─── Output Formatting ──────────────────────────────────

function formatOutput(result: BashResult): string {
  const parts: string[] = [];

  if (result.timedOut) {
    parts.push('(Command timed out)');
  }

  // Apply truncation with markers
  const truncated = truncateBashOutput(result.stdout, result.stderr);

  if (truncated.stdout) {
    parts.push(truncated.stdout);
    if (truncated.stdoutTruncated) {
      parts.push(`\n[STDOUT TRUNCATED — showing first ${BASH_MAX_OUTPUT_CHARS.toLocaleString()} of ${result.stdout.length.toLocaleString()} chars]`);
    }
  }

  if (truncated.stderr) {
    parts.push(`stderr:\n${truncated.stderr}`);
    if (truncated.stderrTruncated) {
      parts.push(`[STDERR TRUNCATED — showing first ${BASH_MAX_STDERR_CHARS.toLocaleString()} of ${result.stderr.length.toLocaleString()} chars]`);
    }
  }

  if (parts.length === 0) {
    if (result.exitCode === 0) {
      return '(No output)';
    }
    return `(Exit code: ${result.exitCode})`;
  }

  let output = parts.join('\n');

  if (result.exitCode !== 0 && !result.timedOut) {
    output += `\n(Exit code: ${result.exitCode})`;
  }

  return output;
}
