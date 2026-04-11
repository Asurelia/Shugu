/**
 * Layer 3 — Tools: SemSearchTool
 *
 * Semantic workspace search backed by the local index (.pcc/index/).
 * This is SEPARATE from GrepTool — Grep does live lexical search over the filesystem,
 * SemSearch queries the pre-built workspace index for faster, broader discovery.
 *
 * The index must be initialized first via /workspace init.
 */

import type { Tool, ToolCall, ToolResult, ToolContext, ToolDefinition } from '../../protocol/tools.js';
import { WorkspaceQueryEngine, type SearchHit, type SearchOpts } from '../../context/workspace/query.js';
import { IndexStore } from '../../context/workspace/store.js';

export const SemSearchToolDefinition: ToolDefinition = {
  name: 'SemSearch',
  description: `Search the pre-built workspace index for files, symbols, and code chunks.

Usage:
- Faster than Grep for broad discovery and "find code related to X" queries
- Requires /workspace init to build the index first — returns an error if the index doesn't exist
- Use Grep for live exact-match regex searches on the current filesystem
- Use SemSearch for semantic/fuzzy searches when you don't know the exact pattern
- Supports language filtering and symbol-only mode for navigating large codebases`,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query — keywords, symbol names, or natural language description of what to find',
      },
      max_results: {
        type: 'number',
        description: 'Maximum number of results to return (default: 20)',
      },
      language: {
        type: 'string',
        description: 'Filter by language: "ts", "js", "py", "go", "rs", etc.',
      },
      file_glob: {
        type: 'string',
        description: 'Filter by file pattern (e.g., "*.ts", "**/test*")',
      },
      symbol_only: {
        type: 'boolean',
        description: 'Only search symbols (functions, classes, types), skip content',
      },
    },
    required: ['query'],
  },
  concurrencySafe: true,
  categories: ['search'],
};

export class SemSearchTool implements Tool {
  definition = SemSearchToolDefinition;

  validateInput(input: Record<string, unknown>): string | null {
    if (typeof input['query'] !== 'string' || !input['query']) {
      return 'query must be a non-empty string';
    }
    return null;
  }

  async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const query = call.input['query'] as string;
    const maxResults = (call.input['max_results'] as number) ?? 20;
    const language = call.input['language'] as string | undefined;
    const fileGlob = call.input['file_glob'] as string | undefined;
    const symbolOnly = call.input['symbol_only'] as boolean | undefined;

    // Check if index exists
    const store = new IndexStore(context.cwd);
    const meta = await store.getMeta();

    if (!meta) {
      return {
        tool_use_id: call.id,
        content: 'Workspace index not found. Run /workspace init to build the index first.',
        is_error: true,
      };
    }

    const engine = new WorkspaceQueryEngine(store);
    const opts: SearchOpts = {
      maxResults,
      language,
      fileGlob,
      symbolOnly,
    };

    try {
      const hits = await engine.search(query, opts);

      if (hits.length === 0) {
        return {
          tool_use_id: call.id,
          content: `No results found for "${query}" in workspace index (${meta.fileCount} files indexed, last sync: ${meta.lastSync}).`,
        };
      }

      const output = formatHits(hits, meta);
      return {
        tool_use_id: call.id,
        content: output,
      };
    } catch (err: unknown) {
      return {
        tool_use_id: call.id,
        content: `SemSearch error: ${err instanceof Error ? err.message : String(err)}`,
        is_error: true,
      };
    }
  }
}

// ─── Formatting ─────────────────────────────────────────

function formatHits(hits: SearchHit[], meta: { fileCount: number; lastSync: string }): string {
  const lines: string[] = [
    `Found ${hits.length} result(s) (index: ${meta.fileCount} files, synced ${meta.lastSync})`,
    '',
  ];

  for (const hit of hits) {
    const typeIcon = hit.matchType === 'symbol' ? '◆' :
                     hit.matchType === 'filename' ? '📄' : '≡';
    lines.push(`${typeIcon} ${hit.path}:${hit.line} [${hit.matchType}] (score: ${hit.score.toFixed(2)})`);

    // Show snippet for content/symbol matches
    if (hit.snippet && hit.matchType !== 'filename') {
      const snippetLines = hit.snippet.split('\n').slice(0, 5);
      for (const sl of snippetLines) {
        lines.push(`  ${sl}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}
