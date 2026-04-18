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
import { resolveShell } from './shells.js';
import type { ShellConfig } from './shells.js';
import { buildSafeEnv } from '../../utils/security.js';

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes

export const BashToolDefinition: ToolDefinition = {
  name: 'Bash',
  description: `Executes a given bash command and returns its output.

The working directory persists between commands, but shell state does not. Each command runs in a fresh shell rooted at the project directory.

IMPORTANT: Avoid using Bash to run find, grep, cat, head, tail, sed, awk, or echo commands. Use the appropriate dedicated tool instead — this provides a much better experience for the user:
 - File search: Use Glob (NOT find or ls)
 - Content search: Use Grep (NOT grep or rg)
 - Read files: Use Read (NOT cat/head/tail)
 - Edit files: Use Edit (NOT sed/awk)
 - Write files: Use Write (NOT echo >/cat <<EOF)
 - Communication: Output text directly (NOT echo/printf)
Reserve Bash exclusively for system commands and terminal operations that require shell execution. If you are unsure and there is a relevant dedicated tool, default to using the dedicated tool.

# Instructions
 - Use absolute paths or chain with && for multi-step operations.
 - Always quote file paths that contain spaces with double quotes.
 - Try to maintain your current working directory by using absolute paths and avoiding cd.
 - You may specify an optional timeout in milliseconds (up to 600000ms / 10 minutes). Default: 120000ms (2 minutes).
 - IMPORTANT: Do not use commands with the -i flag (like git rebase -i or git add -i) since they require interactive input which is not supported.

# Committing changes with git

Only create commits when requested by the user. Follow these steps:

Git Safety Protocol:
- NEVER update the git config
- NEVER run destructive git commands (push --force, reset --hard, checkout ., clean -f, branch -D) unless the user explicitly requests it
- NEVER skip hooks (--no-verify, --no-gpg-sign) unless the user explicitly requests it
- NEVER force push to main/master — warn the user if they request it
- ALWAYS create NEW commits rather than amending, unless the user explicitly requests amend
- When staging files, prefer adding specific files by name rather than using "git add -A" or "git add ."
- NEVER commit unless the user explicitly asks you to

When committing:
1. Run git status and git diff to see changes
2. Run git log to match the repo's commit message style
3. Draft a concise commit message (1-2 sentences) focused on the "why"
4. Always pass the commit message via a HEREDOC:
   git commit -m "$(cat <<'EOF'
   Commit message here.

   Co-Authored-By: Shugu <noreply@shugu.dev>
   EOF
   )"
5. Run git status after to verify success

# Creating pull requests

Use gh for GitHub tasks (issues, PRs, checks, releases).
When creating PRs:
1. Check git status, git diff, git log to understand all changes
2. Keep the PR title short (under 70 characters)
3. Create PR with:
   gh pr create --title "the pr title" --body "$(cat <<'EOF'
   ## Summary
   <bullet points>

   ## Test plan
   [checklist]
   EOF
   )"`,
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The bash command to execute',
      },
      description: {
        type: 'string',
        description: 'Clear, concise description of what this command does (5-10 words for simple commands, more for complex ones)',
      },
      timeout: {
        type: 'number',
        description: 'Optional timeout in milliseconds (max 600000, default 120000)',
      },
    },
    required: ['command'],
  },
  concurrencySafe: false,
  categories: ['core'],
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

    if (context.bashDenylist && context.bashDenylist.length > 0) {
      const matched = context.bashDenylist.find((re) => re.test(command));
      if (matched) {
        return {
          tool_use_id: call.id,
          content: `Command blocked by denylist (pattern ${matched.source}): ${command}`,
          is_error: true,
        };
      }
    }

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

// ─── Shell Resolution (cached) ─────────────────────────

let cachedShell: ShellConfig | null = null;
function getShell(): ShellConfig {
  if (!cachedShell) cachedShell = resolveShell();
  return cachedShell;
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
    const shell = getShell();
    const child = spawn(shell.path, [...shell.args, command], {
      cwd,
      env: buildSafeEnv(),
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
