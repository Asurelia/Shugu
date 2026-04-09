/**
 * FILE_TRACKING — Capture file state before Write/Edit
 *
 * PreToolUse hook that reads the current content of a file before it
 * is modified by Write or Edit tools. Emits events via a callback
 * so the REPL layer can group changes by turn.
 *
 * This hook has NO session awareness — it just captures raw file content.
 * The REPL/session layer is responsible for grouping by turn.
 */

import { readFile } from 'node:fs/promises';
import type { HookRegistry, PreToolUsePayload, PreToolUseResult } from '../hooks.js';
import { logger } from '../../utils/logger.js';

/**
 * Callback for file state capture.
 * - previousContent = string → file exists, content captured (revert = restore)
 * - previousContent = null → file does not exist (revert = delete)
 * - not called at all → read failed for non-ENOENT reason (revert won't touch the file)
 */
export type FileBeforeCallback = (path: string, previousContent: string | null) => void;

/**
 * Register a PreToolUse hook that captures file content before Write/Edit.
 *
 * @param hookRegistry - The hook registry to register with
 * @param onFileBefore - Called with (absolutePath, previousContent | null) before each file mutation
 */
export function registerFileTrackingHook(
  hookRegistry: HookRegistry,
  onFileBefore: FileBeforeCallback,
): void {
  hookRegistry.register({
    type: 'PreToolUse',
    pluginName: 'builtin:file-tracking',
    priority: 10, // Run early, before other hooks
    handler: async (payload: PreToolUsePayload): Promise<PreToolUseResult> => {
      // Only track Write and Edit tools
      if (payload.tool !== 'Write' && payload.tool !== 'Edit') {
        return { proceed: true };
      }

      const filePath = payload.call.input['file_path'] as string | undefined;
      if (!filePath) {
        return { proceed: true };
      }

      // Read current file content before the tool modifies it
      try {
        const previousContent = await readFile(filePath, 'utf-8');
        onFileBefore(filePath, previousContent);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          // File doesn't exist yet — this is a create operation
          onFileBefore(filePath, null);
        } else {
          // Non-ENOENT error (permission, encoding, etc.) — do NOT record as create.
          // Skipping the callback means revert won't touch this file, which is safe.
          logger.warn(`file-tracking: cannot read ${filePath} before edit`, (err as Error).message);
        }
      }

      // Always proceed — we're just observing, not blocking
      return { proceed: true };
    },
  });
}
