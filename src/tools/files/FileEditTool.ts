/**
 * Layer 3 — Tools: FileEditTool
 *
 * Performs exact string replacements in files.
 * The old_string must be unique in the file (unless replace_all is true).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import type { Tool, ToolCall, ToolResult, ToolContext, ToolDefinition } from '../../protocol/tools.js';
import { validateWorkspacePath } from '../../policy/workspace.js';

export const FileEditToolDefinition: ToolDefinition = {
  name: 'Edit',
  description: `Performs exact string replacements in files.

Usage:
- You MUST use the Read tool at least once on a file before editing it. This tool will error if you attempt an edit without reading the file first.
- When editing text from Read tool output, preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: line number + tab. Everything after that is the actual file content to match. Never include any part of the line number prefix in old_string or new_string.
- ALWAYS prefer editing existing files over creating new ones with Write.
- The edit will FAIL if old_string is not unique in the file. Either provide a larger string with more surrounding context to make it unique, or use replace_all to change every instance.
- Use replace_all for renaming variables or strings across the file.
- Do NOT re-read a file you just edited to verify — Edit would have errored if the change failed.
- Only use emojis if the user explicitly requests it.`,
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file to modify',
      },
      old_string: {
        type: 'string',
        description: 'The exact text to replace',
      },
      new_string: {
        type: 'string',
        description: 'The replacement text (must differ from old_string)',
      },
      replace_all: {
        type: 'boolean',
        description: 'Replace all occurrences (default: false)',
      },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  concurrencySafe: false,
  categories: ['core', 'file-ops'],
};

export class FileEditTool implements Tool {
  definition = FileEditToolDefinition;

  validateInput(input: Record<string, unknown>): string | null {
    if (typeof input['file_path'] !== 'string' || !input['file_path']) {
      return 'file_path must be a non-empty string';
    }
    if (typeof input['old_string'] !== 'string') {
      return 'old_string must be a string';
    }
    if (typeof input['new_string'] !== 'string') {
      return 'new_string must be a string';
    }
    if (input['old_string'] === input['new_string']) {
      return 'new_string must be different from old_string';
    }
    return null;
  }

  async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const filePath = call.input['file_path'] as string;
    const oldString = call.input['old_string'] as string;
    const newString = call.input['new_string'] as string;
    const replaceAll = (call.input['replace_all'] as boolean) ?? false;

    const absPath = isAbsolute(filePath) ? filePath : resolve(context.cwd, filePath);

    // Enforce read-before-edit: the model must Read a file before Edit
    if (context.readTracker && !context.readTracker.hasRead(absPath) && context.permissionMode !== 'bypass') {
      return {
        tool_use_id: call.id,
        content: 'You must use the Read tool to read this file before editing it. This ensures you understand the file content before making changes.',
        is_error: true,
      };
    }

    // Workspace boundary check (always enforced for edits)
    const validation = await validateWorkspacePath(filePath, context.cwd);
    if (!validation.valid) {
      return {
        tool_use_id: call.id,
        content: `Error: ${validation.reason}`,
        is_error: true,
      };
    }

    try {
      const content = await readFile(absPath, 'utf-8');

      // Check that old_string exists
      if (!content.includes(oldString)) {
        return {
          tool_use_id: call.id,
          content: `Error: old_string not found in ${absPath}. Make sure the string matches exactly (including whitespace and indentation).`,
          is_error: true,
        };
      }

      // Check uniqueness (unless replace_all)
      if (!replaceAll) {
        const occurrences = content.split(oldString).length - 1;
        if (occurrences > 1) {
          return {
            tool_use_id: call.id,
            content: `Error: old_string appears ${occurrences} times in ${absPath}. Use replace_all: true to replace all, or provide more context to make the match unique.`,
            is_error: true,
          };
        }
      }

      // Perform replacement
      let newContent: string;
      if (replaceAll) {
        newContent = content.split(oldString).join(newString);
      } else {
        newContent = content.replace(oldString, newString);
      }

      await writeFile(absPath, newContent, 'utf-8');

      const replacements = replaceAll
        ? content.split(oldString).length - 1
        : 1;

      return {
        tool_use_id: call.id,
        content: `File edited successfully: ${absPath} (${replacements} replacement${replacements > 1 ? 's' : ''})`,
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
        content: `Error editing file: ${message}`,
        is_error: true,
      };
    }
  }
}
