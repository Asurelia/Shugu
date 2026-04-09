/**
 * Layer 3 — Tools: FileWriteTool
 *
 * Creates or overwrites files. Creates parent directories if needed.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, isAbsolute, dirname } from 'node:path';
import type { Tool, ToolCall, ToolResult, ToolContext, ToolDefinition } from '../../protocol/tools.js';
import { validateWorkspacePath } from '../../policy/workspace.js';

export const FileWriteToolDefinition: ToolDefinition = {
  name: 'Write',
  description: `Writes content to a file. Creates the file if it doesn't exist, overwrites if it does. Creates parent directories as needed. Prefer Edit for modifying existing files.`,
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

    try {
      // Create parent directories
      await mkdir(dirname(absPath), { recursive: true });

      await writeFile(absPath, content, 'utf-8');

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
