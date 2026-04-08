/**
 * Built-in behavior hooks
 *
 * Lightweight PostToolUse hooks that enforce quality and security.
 * No LLM calls — pure pattern matching. Zero token cost.
 *
 * Hooks:
 * 1. Anti-laziness: detect TODO/stub/truncation in Write/Edit outputs
 * 2. Secret scanning: detect API keys/tokens in Bash output
 * 3. Truncation marking: ensure truncated outputs are clearly marked
 */

import type { HookRegistry, PostToolUsePayload, PostToolUseResult, PreToolUsePayload, PreToolUseResult } from '../hooks.js';

// ─── Secret Patterns ───────────────────────────────────

export const SECRET_PATTERNS = [
  // API Keys
  /(?:api[_-]?key|apikey)\s*[:=]\s*['"]?([a-zA-Z0-9_\-]{20,})/i,
  // AWS
  /AKIA[0-9A-Z]{16}/,
  /(?:aws_secret_access_key|aws_secret)\s*[:=]\s*['"]?([a-zA-Z0-9/+=]{40})/i,
  // Generic tokens
  /(?:token|secret|password|passwd|api_secret)\s*[:=]\s*['"]?([a-zA-Z0-9_\-\.]{16,})/i,
  // Bearer tokens
  /Bearer\s+[a-zA-Z0-9_\-\.]{20,}/i,
  // Private keys
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/,
  // GitHub tokens
  /gh[pousr]_[a-zA-Z0-9]{36,}/,
  // Slack tokens
  /xox[baprs]-[a-zA-Z0-9\-]+/,
  // Generic hex secrets (32+ chars)
  /(?:secret|key|token)\s*[:=]\s*['"]?[a-f0-9]{32,}/i,
];

// ─── Lazy Code Patterns ────────────────────────────────

const LAZY_PATTERNS = [
  /\/\/\s*\.{3}\s*rest\s+remains/i,
  /\/\/\s*\.{3}\s*same\s+as\s+before/i,
  /\/\/\s*TODO:?\s+implement/i,
  /\/\/\s*FIXME:?\s+implement/i,
  /\/\*\s*\.{3}\s*\*\//,
  /#\s*\.{3}\s*rest\s+remains/i,
  /pass\s+#\s*TODO/,
  /raise\s+NotImplementedError/,
  /throw\s+new\s+Error\(['"]not\s+implemented['"]\)/i,
];

// ─── Register Hooks ────────────────────────────────────

export function registerBehaviorHooks(hookRegistry: HookRegistry): void {
  // 1. Secret scanning on Bash/WebFetch output
  hookRegistry.register({
    type: 'PostToolUse',
    pluginName: 'builtin:secret-scanner',
    priority: 10, // High priority — runs early
    handler: async (payload: PostToolUsePayload): Promise<PostToolUseResult> => {
      if (payload.tool !== 'Bash' && payload.tool !== 'WebFetch') return {};

      const content = typeof payload.result.content === 'string'
        ? payload.result.content
        : JSON.stringify(payload.result.content);

      const detectedSecrets: string[] = [];
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(content)) {
          detectedSecrets.push(pattern.source.slice(0, 30));
        }
      }

      if (detectedSecrets.length > 0) {
        // Append a warning to the result (don't block — the model needs the output)
        return {
          modifiedResult: {
            ...payload.result,
            content: content + `\n\n⚠️ [SECURITY WARNING: Output may contain secrets/credentials (${detectedSecrets.length} pattern(s) matched). Do NOT include these in code, commits, or responses to the user.]`,
          },
        };
      }

      return {};
    },
  });

  // 2. Anti-laziness on Write/Edit results
  hookRegistry.register({
    type: 'PostToolUse',
    pluginName: 'builtin:anti-lazy',
    priority: 80, // Low priority — runs late
    handler: async (payload: PostToolUsePayload): Promise<PostToolUseResult> => {
      if (payload.tool !== 'Write' && payload.tool !== 'Edit') return {};

      // Check the input (what was written), not the result
      const written = typeof payload.call.input['content'] === 'string'
        ? payload.call.input['content'] as string
        : typeof payload.call.input['new_string'] === 'string'
          ? payload.call.input['new_string'] as string
          : '';

      if (!written) return {};

      const lazyMatches: string[] = [];
      for (const pattern of LAZY_PATTERNS) {
        if (pattern.test(written)) {
          lazyMatches.push(pattern.source.slice(0, 40));
        }
      }

      if (lazyMatches.length > 0) {
        const content = typeof payload.result.content === 'string'
          ? payload.result.content
          : JSON.stringify(payload.result.content);

        return {
          modifiedResult: {
            ...payload.result,
            content: content + `\n\n⚠️ [COMPLETENESS WARNING: The code you just wrote contains incomplete patterns (${lazyMatches.length} detected: TODO/stub/placeholder). You MUST complete the implementation — do not leave stubs.]`,
          },
        };
      }

      return {};
    },
  });

  // 3. File write path safety check + input normalization
  hookRegistry.register({
    type: 'PreToolUse',
    pluginName: 'builtin:path-safety',
    priority: 5, // Very high priority
    handler: async (payload: PreToolUsePayload): Promise<PreToolUseResult> => {
      // Normalize paths for file tools (fix backslashes, redundant cd, etc.)
      if (payload.tool === 'Write' || payload.tool === 'Edit' || payload.tool === 'Read') {
        const filePath = (payload.call.input['file_path'] as string) ?? '';
        const lower = filePath.toLowerCase();

        // Block writes to sensitive files
        if ((payload.tool === 'Write' || payload.tool === 'Edit') &&
            (lower.endsWith('.env') || lower.endsWith('.env.local') || lower.endsWith('.env.production'))) {
          return { proceed: false, blockReason: `Cannot write to environment file "${filePath}" — use credentials vault instead` };
        }

        if ((payload.tool === 'Write' || payload.tool === 'Edit') &&
            (lower.includes('id_rsa') || lower.includes('id_ed25519') || lower.endsWith('.pem'))) {
          return { proceed: false, blockReason: `Cannot write to private key file "${filePath}"` };
        }

        // Normalize path: fix mixed slashes
        if (filePath.includes('\\')) {
          return {
            proceed: true,
            modifiedCall: {
              ...payload.call,
              input: { ...payload.call.input, file_path: filePath.replace(/\\/g, '/') },
            },
          };
        }
      }

      // Normalize Bash commands
      if (payload.tool === 'Bash') {
        let cmd = (payload.call.input['command'] as string) ?? '';
        let modified = false;

        // Strip redundant "cd /cwd && " prefix
        const cdMatch = cmd.match(/^cd\s+["']?([^"'&]+)["']?\s*&&\s*(.+)$/);
        if (cdMatch) {
          cmd = cdMatch[2]!.trim();
          modified = true;
        }

        // Fix \\; to \; in find -exec commands
        if (cmd.includes('\\\\;')) {
          cmd = cmd.replace(/\\\\;/g, '\\;');
          modified = true;
        }

        // Fix Windows backslash paths in bash
        if (process.platform === 'win32' && cmd.includes('\\') && !cmd.includes('\\n') && !cmd.includes('\\t')) {
          cmd = cmd.replace(/\\/g, '/');
          modified = true;
        }

        if (modified) {
          return {
            proceed: true,
            modifiedCall: {
              ...payload.call,
              input: { ...payload.call.input, command: cmd },
            },
          };
        }
      }

      // Normalize Write: strip trailing whitespace except for markdown (2 spaces = line break)
      if (payload.tool === 'Write') {
        const content = (payload.call.input['content'] as string) ?? '';
        const filePath = (payload.call.input['file_path'] as string) ?? '';
        const isMarkdown = filePath.endsWith('.md') || filePath.endsWith('.mdx');

        if (!isMarkdown && content.includes(' \n')) {
          return {
            proceed: true,
            modifiedCall: {
              ...payload.call,
              input: {
                ...payload.call.input,
                content: content.split('\n').map(line => line.trimEnd()).join('\n'),
              },
            },
          };
        }
      }

      return { proceed: true };
    },
  });
}
