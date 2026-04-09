/**
 * Layer 3 — Tools: FileReadTool
 *
 * Reads files with optional offset/limit for large files.
 * Returns content with line numbers (cat -n format).
 */

import { readFile, stat } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import type { Tool, ToolCall, ToolResult, ToolContext, ToolDefinition } from '../../protocol/tools.js';
import { validateWorkspacePath } from '../../policy/workspace.js';
import { isSpillPath } from '../outputLimits.js';
import { READ_LIMITS } from '../../context/read-limits.js';

export const FileReadToolDefinition: ToolDefinition = {
  name: 'Read',
  description: `Reads a text file from the filesystem. Returns content with line numbers. Use offset and limit for large files.`,
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file to read',
      },
      offset: {
        type: 'number',
        description: 'Line number to start reading from (0-based). Only for large files.',
      },
      limit: {
        type: 'number',
        description: 'Number of lines to read. Only for large files.',
      },
    },
    required: ['file_path'],
  },
  concurrencySafe: true,
  categories: ['core', 'file-ops'],
};

const DEFAULT_LINE_LIMIT = READ_LIMITS.defaultLineLimit;

export class FileReadTool implements Tool {
  definition = FileReadToolDefinition;

  validateInput(input: Record<string, unknown>): string | null {
    if (typeof input['file_path'] !== 'string' || !input['file_path']) {
      return 'file_path must be a non-empty string';
    }
    return null;
  }

  async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const filePath = call.input['file_path'] as string;
    const offset = (call.input['offset'] as number) ?? 0;
    const limit = (call.input['limit'] as number) ?? DEFAULT_LINE_LIMIT;

    const absPath = isAbsolute(filePath) ? filePath : resolve(context.cwd, filePath);

    // Workspace boundary check (skip in bypass mode for reads)
    if (context.permissionMode !== 'bypass') {
      const validation = await validateWorkspacePath(filePath, context.cwd);
      if (!validation.valid) {
        // Allow reads of spilled output files even outside workspace
        if (!isSpillPath(absPath)) {
          return {
            tool_use_id: call.id,
            content: `Error: ${validation.reason}`,
            is_error: true,
          };
        }
      }
    }

    try {
      // Check file exists and get stats
      const stats = await stat(absPath);

      if (stats.isDirectory()) {
        return {
          tool_use_id: call.id,
          content: `Error: "${absPath}" is a directory, not a file. Use Bash with "ls" to list directory contents.`,
          is_error: true,
        };
      }

      const content = await readFile(absPath, 'utf-8');
      const lines = content.split('\n');
      const totalLines = lines.length;

      // Apply offset and limit
      const sliced = lines.slice(offset, offset + limit);

      // Format with line numbers (1-based, like cat -n)
      const numbered = sliced.map((line, i) => {
        const lineNum = offset + i + 1;
        return `${lineNum}\t${line}`;
      }).join('\n');

      let result = numbered;

      // Add truncation notice if applicable
      if (totalLines > offset + limit) {
        result += `\n\n(Showing lines ${offset + 1}-${offset + sliced.length} of ${totalLines}. Use offset and limit to read more.)`;
      }

      if (!result.trim()) {
        result = '(Empty file)';
      }

      return {
        tool_use_id: call.id,
        content: result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('ENOENT')) {
        return {
          tool_use_id: call.id,
          content: `Error: File not found: ${absPath}`,
          is_error: true,
        };
      }
      return {
        tool_use_id: call.id,
        content: `Error reading file: ${message}`,
        is_error: true,
      };
    }
  }
}
