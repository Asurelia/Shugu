/**
 * Layer 3 — Tools: GrepTool
 *
 * Content search using ripgrep (rg) if available, or native Node.js fallback.
 * Supports regex patterns and file type filtering.
 */

import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, isAbsolute, resolve } from 'node:path';
import type { Tool, ToolCall, ToolResult, ToolContext, ToolDefinition } from '../../protocol/tools.js';
import { validateWorkspacePath } from '../../policy/workspace.js';

export const GrepToolDefinition: ToolDefinition = {
  name: 'Grep',
  description: `Search file contents using regex patterns. Uses ripgrep if available. Supports glob filtering and output modes: "content" (matching lines), "files_with_matches" (file paths only), "count" (match counts).`,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Regex pattern to search for',
      },
      path: {
        type: 'string',
        description: 'File or directory to search in. Defaults to cwd.',
      },
      glob: {
        type: 'string',
        description: 'Glob pattern to filter files (e.g., "*.ts", "*.{ts,tsx}")',
      },
      output_mode: {
        type: 'string',
        description: 'Output mode: "content", "files_with_matches" (default), or "count"',
      },
      '-i': {
        type: 'boolean',
        description: 'Case insensitive search',
      },
      '-n': {
        type: 'boolean',
        description: 'Show line numbers (default: true for content mode)',
      },
      '-C': {
        type: 'number',
        description: 'Lines of context around each match',
      },
    },
    required: ['pattern'],
  },
  concurrencySafe: true,
  categories: ['core', 'search'],
};

const MAX_OUTPUT = 50_000;

export class GrepTool implements Tool {
  definition = GrepToolDefinition;

  validateInput(input: Record<string, unknown>): string | null {
    if (typeof input['pattern'] !== 'string' || !input['pattern']) {
      return 'pattern must be a non-empty string';
    }
    return null;
  }

  async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const pattern = call.input['pattern'] as string;
    const searchPath = call.input['path'] as string | undefined;
    const globFilter = call.input['glob'] as string | undefined;
    const outputMode = (call.input['output_mode'] as string) ?? 'files_with_matches';
    const caseInsensitive = call.input['-i'] as boolean | undefined;
    const contextLines = call.input['-C'] as number | undefined;

    const absPath = searchPath
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

    // Try ripgrep first
    const rgResult = await tryRipgrep(pattern, absPath, {
      glob: globFilter,
      outputMode,
      caseInsensitive,
      contextLines,
    });

    if (rgResult !== null) {
      return {
        tool_use_id: call.id,
        content: rgResult || `No matches found for pattern "${pattern}"`,
      };
    }

    // Fallback to native search
    try {
      const result = await nativeGrep(pattern, absPath, {
        glob: globFilter,
        outputMode,
        caseInsensitive,
      });
      return {
        tool_use_id: call.id,
        content: result || `No matches found for pattern "${pattern}"`,
      };
    } catch (error) {
      return {
        tool_use_id: call.id,
        content: `Error searching: ${error instanceof Error ? error.message : String(error)}`,
        is_error: true,
      };
    }
  }
}

// ─── Ripgrep ────────────────────────────────────────────

interface GrepOptions {
  glob?: string;
  outputMode: string;
  caseInsensitive?: boolean;
  contextLines?: number;
}

async function tryRipgrep(
  pattern: string,
  path: string,
  options: GrepOptions,
): Promise<string | null> {
  return new Promise((resolve) => {
    const args: string[] = [];

    if (options.outputMode === 'files_with_matches') args.push('-l');
    else if (options.outputMode === 'count') args.push('-c');
    else args.push('-n'); // content mode with line numbers

    if (options.caseInsensitive) args.push('-i');
    if (options.contextLines) args.push('-C', String(options.contextLines));
    if (options.glob) args.push('--glob', options.glob);

    // Skip common non-code directories
    args.push('--glob', '!node_modules', '--glob', '!.git', '--glob', '!dist');

    args.push(pattern, path);

    const child = spawn('rg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > MAX_OUTPUT) stdout = stdout.slice(0, MAX_OUTPUT);
    });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('error', () => resolve(null)); // rg not found
    child.on('close', (code) => {
      if (code === 2) resolve(null); // rg error
      else resolve(stdout.trim());
    });
  });
}

// ─── Native Fallback ────────────────────────────────────

async function nativeGrep(
  pattern: string,
  searchPath: string,
  options: Pick<GrepOptions, 'glob' | 'outputMode' | 'caseInsensitive'>,
): Promise<string> {
  const flags = options.caseInsensitive ? 'gi' : 'g';
  const regex = new RegExp(pattern, flags);
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
        const full = join(dir, entry.name);

        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile()) {
          // Simple glob check
          if (options.glob && !simpleGlobMatch(entry.name, options.glob)) continue;

          try {
            const content = await readFile(full, 'utf-8');
            const relPath = relative(searchPath, full).replace(/\\/g, '/');

            if (options.outputMode === 'files_with_matches') {
              if (regex.test(content)) results.push(relPath);
            } else if (options.outputMode === 'count') {
              const matches = content.match(regex);
              if (matches) results.push(`${relPath}:${matches.length}`);
            } else {
              const lines = content.split('\n');
              for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i]!)) {
                  results.push(`${relPath}:${i + 1}:${lines[i]}`);
                }
              }
            }
            regex.lastIndex = 0; // Reset regex state
          } catch {
            // Skip binary/unreadable files
          }
        }
      }
    } catch {
      // Skip unreadable dirs
    }
  }

  await walk(searchPath);
  return results.slice(0, 250).join('\n');
}

function simpleGlobMatch(filename: string, glob: string): boolean {
  const patterns = glob.replace(/\{([^}]+)\}/g, '($1)').replace(/,/g, '|');
  const regex = new RegExp(
    patterns.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$',
  );
  return regex.test(filename);
}
