/**
 * Layer 3 — Tools: FileWriteTool
 *
 * Creates or overwrites files. Creates parent directories if needed.
 */

import { writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, isAbsolute, dirname } from 'node:path';
import type { Tool, ToolCall, ToolResult, ToolContext, ToolDefinition, PermissionMode } from '../../protocol/tools.js';
import { validateWorkspacePath } from '../../policy/workspace.js';

/**
 * Permission modes that bypass the read-before-write guard.
 * Both express user intent to proceed without friction: 'fullAuto' trusts the
 * model's judgment, 'bypass' disables all friction. The guard exists to catch
 * accidental overwrites in interactive modes (default, plan, acceptEdits).
 */
const GUARD_BYPASS_MODES: readonly PermissionMode[] = ['fullAuto', 'bypass'];

export const FileWriteToolDefinition: ToolDefinition = {
  name: 'Write',
  description: `Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.
- Prefer the Edit tool for modifying existing files — it only sends the diff. Only use Write to create new files or for complete rewrites.
- NEVER create documentation files (*.md) or README files unless explicitly requested by the user.
- Do not create files unless they are absolutely necessary. Prefer editing existing files over creating new ones.
- Only use emojis if the user explicitly requests it.`,
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file to write',
      },
      content: {
        type: 'string',
        description: 'The content to write to the file',
      },
    },
    required: ['file_path', 'content'],
  },
  concurrencySafe: false,
  categories: ['core', 'file-ops'],
};

export class FileWriteTool implements Tool {
  definition = FileWriteToolDefinition;

  validateInput(input: Record<string, unknown>): string | null {
    if (typeof input['file_path'] !== 'string' || !input['file_path']) {
      return 'file_path must be a non-empty string';
    }
    if (typeof input['content'] !== 'string') {
      return 'content must be a string';
    }
    return null;
  }

  async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const filePath = call.input['file_path'] as string;
    const content = call.input['content'] as string;

    const absPath = isAbsolute(filePath) ? filePath : resolve(context.cwd, filePath);

    // Workspace boundary check (always enforced for writes)
    const validation = await validateWorkspacePath(filePath, context.cwd);
    if (!validation.valid) {
      return {
        tool_use_id: call.id,
        content: `Error: ${validation.reason}`,
        is_error: true,
      };
    }

    // Read-before-write guard: prevent accidental overwrites of existing files.
    // Skipped in fullAuto/bypass — those modes explicitly opt out of friction.
    try {
      await access(absPath);
      if (
        context.readTracker &&
        !context.readTracker.hasRead(absPath) &&
        !GUARD_BYPASS_MODES.includes(context.permissionMode)
      ) {
        return {
          tool_use_id: call.id,
          content: `Error: File "${filePath}" exists but was not read first. Use Read to examine it before overwriting.`,
          is_error: true,
        };
      }
    } catch {
      // File doesn't exist — OK to create
    }

    try {
      // Create parent directories
      await mkdir(dirname(absPath), { recursive: true });

      await writeFile(absPath, content, 'utf-8');

      // Invalidate: after write, the in-memory "read" marker no longer
      // reflects file state. A subsequent Write in interactive modes must
      // re-Read to confirm the model saw its own change.
      context.readTracker?.invalidate(absPath);

      const lineCount = content.split('\n').length;
      return {
        tool_use_id: call.id,
        content: `File written successfully: ${absPath} (${lineCount} lines)`,
      };
    } catch (error) {
      return {
        tool_use_id: call.id,
        content: `Error writing file: ${error instanceof Error ? error.message : String(error)}`,
        is_error: true,
      };
    }
  }
}
