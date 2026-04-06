/**
 * VERIFICATION_AGENT — Auto-verify after Write/Edit
 *
 * PostToolUse hook that runs silent verification after file modifications:
 * - TypeScript files → run tsc --noEmit on the file
 * - If errors detected → append warning to result so model auto-corrects
 *
 * Zero LLM cost — pure shell execution.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HookRegistry, PostToolUsePayload, PostToolUseResult } from '../hooks.js';
import { logger } from '../../utils/logger.js';

const execAsync = promisify(execFile);

export function registerVerificationHook(hookRegistry: HookRegistry): void {
  hookRegistry.register({
    type: 'PostToolUse',
    pluginName: 'builtin:verification-agent',
    priority: 40, // After tool execution, before anti-lazy (80)
    handler: async (payload: PostToolUsePayload): Promise<PostToolUseResult> => {
      // Only verify Write/Edit on TypeScript files
      if (payload.tool !== 'Write' && payload.tool !== 'Edit') return {};
      if (payload.result.is_error) return {}; // Already errored

      const filePath = (payload.call.input['file_path'] as string) ?? '';
      if (!filePath.endsWith('.ts') && !filePath.endsWith('.tsx')) return {};

      try {
        // Run quick typecheck on the specific file
        const { stderr } = await execAsync('npx', ['tsc', '--noEmit', '--pretty', 'false', filePath], {
          timeout: 15_000,
          cwd: process.cwd(),
        });

        // If stderr has errors, append warning
        if (stderr && stderr.includes('error TS')) {
          const errorCount = (stderr.match(/error TS/g) ?? []).length;
          const firstErrors = stderr.split('\n').filter(l => l.includes('error TS')).slice(0, 3).join('\n');
          const content = typeof payload.result.content === 'string'
            ? payload.result.content
            : JSON.stringify(payload.result.content);

          return {
            modifiedResult: {
              ...payload.result,
              content: content + `\n\n⚠️ [VERIFICATION: TypeScript errors detected (${errorCount}). Fix them before proceeding.]\n${firstErrors}`,
            },
          };
        }
      } catch (err) {
        // tsc not found or timeout — non-critical, skip silently
        logger.debug('verification hook: tsc check skipped', err instanceof Error ? err.message : String(err));
      }

      return {};
    },
  });
}
