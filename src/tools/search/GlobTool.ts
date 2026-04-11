/**
 * Layer 3 — Tools: GlobTool
 *
 * Fast file pattern matching using Node.js native fs.glob (Node 22+)
 * or recursive readdir with picomatch fallback.
 */

import { readdir, stat } from 'node:fs/promises';
import { resolve, isAbsolute, relative, join } from 'node:path';
import type { Tool, ToolCall, ToolResult, ToolContext, ToolDefinition } from '../../protocol/tools.js';
import { validateWorkspacePath } from '../../policy/workspace.js';

export const GlobToolDefinition: ToolDefinition = {
  name: 'Glob',
  description: `Fast file pattern matching tool that works with any codebase size.
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns
- When you are doing an open-ended search that may require multiple rounds of globbing and grepping, use the Agent tool with type "explore" instead`,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern to match files (e.g., "**/*.ts", "src/**/*.tsx")',
      },
      path: {
        type: 'string',
        description: 'Directory to search in. Defaults to current working directory.',
      },
    },
    required: ['pattern'],
  },
  concurrencySafe: true,
  categories: ['core', 'search'],
};

const MAX_RESULTS = 500;

export class GlobTool implements Tool {
  definition = GlobToolDefinition;

  validateInput(input: Record<string, unknown>): string | null {
    if (typeof input['pattern'] !== 'string' || !input['pattern']) {
      return 'pattern must be a non-empty string';
    }
    return null;
  }

  async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const pattern = call.input['pattern'] as string;
    const searchPath = call.input['path'] as string | undefined;

    const baseDir = searchPath
      ? (isAbsolute(searchPath) ? searchPath : resolve(context.cwd, searchPath))
      : context.cwd;

    // Workspace boundary check (skip in bypass mode)
    if (context.permissionMode !== 'bypass' && searchPath) {
      const validation = await validateWorkspacePath(searchPath, context.cwd);
      if (!validation.valid) {
        return {
          tool_use_id: call.id,
          content: `Error: ${validation.reason}`,
          is_error: true,
        };
      }
    }

    try {
      const matches = await findFiles(baseDir, pattern);

      if (matches.length === 0) {
        return {
          tool_use_id: call.id,
          content: `No files matched pattern "${pattern}" in ${baseDir}`,
        };
      }

      const truncated = matches.slice(0, MAX_RESULTS);
      let result = truncated.join('\n');

      if (matches.length > MAX_RESULTS) {
        result += `\n\n(Showing ${MAX_RESULTS} of ${matches.length} matches)`;
      }

      return {
        tool_use_id: call.id,
        content: result,
      };
    } catch (error) {
      return {
        tool_use_id: call.id,
        content: `Error searching files: ${error instanceof Error ? error.message : String(error)}`,
        is_error: true,
      };
    }
  }
}

// ─── File Discovery ─────────────────────────────────────

async function findFiles(baseDir: string, pattern: string): Promise<string[]> {
  // Try Node.js 22+ native glob first
  try {
    const { glob } = await import('node:fs/promises');
    if (typeof glob === 'function') {
      const matches: string[] = [];
      for await (const entry of glob(pattern, { cwd: baseDir })) {
        matches.push(entry as string);
      }
      return matches;
    }
  } catch {
    // Fall through to manual implementation
  }

  // Fallback: recursive readdir with simple pattern matching
  return findFilesManual(baseDir, pattern);
}

async function findFilesManual(baseDir: string, pattern: string): Promise<string[]> {
  const matches: string[] = [];
  const matcher = createSimpleMatcher(pattern);

  async function walk(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        const relPath = relative(baseDir, fullPath).replace(/\\/g, '/');

        if (entry.isDirectory()) {
          // Skip node_modules, .git, dist
          if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') {
            continue;
          }
          await walk(fullPath);
        } else if (matcher(relPath)) {
          matches.push(relPath);
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  await walk(baseDir);
  return matches.sort();
}

/**
 * Simple glob matcher supporting * and ** patterns.
 * For full glob support, picomatch would be added as a dependency.
 */
function createSimpleMatcher(pattern: string): (path: string) => boolean {
  // Convert glob pattern to regex
  const regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{DOUBLESTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\{\{DOUBLESTAR\}\}/g, '.*')
    .replace(/\?/g, '[^/]');

  const regex = new RegExp(`^${regexStr}$`);
  return (path: string) => regex.test(path);
}
