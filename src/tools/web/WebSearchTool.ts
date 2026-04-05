/**
 * Layer 3 — Tools: WebSearchTool
 *
 * Web search using:
 * 1. MiniMax Search API (api.minimax.io/v1/coding_plan/search) — code-oriented, free
 * 2. DuckDuckGo HTML API — general fallback, no API key
 * 3. Google Custom Search — if Google credentials configured
 */

import type { Tool, ToolCall, ToolResult, ToolContext, ToolDefinition } from '../../protocol/tools.js';

export const WebSearchToolDefinition: ToolDefinition = {
  name: 'WebSearch',
  description: `Search the web and return results. Uses MiniMax Search API for code-related queries and DuckDuckGo for general searches. Returns titles, URLs, and snippets.`,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query',
      },
      type: {
        type: 'string',
        description: 'Search type: "code" (MiniMax, default for code queries) or "general" (DuckDuckGo)',
      },
      limit: {
        type: 'number',
        description: 'Max results to return (default: 5)',
      },
    },
    required: ['query'],
  },
  concurrencySafe: true,
};

export class WebSearchTool implements Tool {
  definition = WebSearchToolDefinition;

  validateInput(input: Record<string, unknown>): string | null {
    if (typeof input['query'] !== 'string' || !input['query']) {
      return 'query must be a non-empty string';
    }
    return null;
  }

  async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const query = call.input['query'] as string;
    const searchType = (call.input['type'] as string) ?? 'general';
    const limit = (call.input['limit'] as number) ?? 5;

    try {
      let results: SearchResult[];

      if (searchType === 'code') {
        results = await searchMiniMax(query, limit);
      } else {
        results = await searchDuckDuckGo(query, limit);
      }

      if (results.length === 0) {
        return {
          tool_use_id: call.id,
          content: `No results found for "${query}"`,
        };
      }

      const formatted = results.map((r, i) =>
        `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`,
      ).join('\n\n');

      return {
        tool_use_id: call.id,
        content: `Search results for "${query}":\n\n${formatted}`,
      };
    } catch (error) {
      return {
        tool_use_id: call.id,
        content: `Search error: ${error instanceof Error ? error.message : String(error)}`,
        is_error: true,
      };
    }
  }
}

// ─── Types ──────────────────────────────────────────────

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

// ─── MiniMax Search API ─────────────────────────────────

async function searchMiniMax(query: string, limit: number): Promise<SearchResult[]> {
  const apiKey = process.env['MINIMAX_API_KEY'] ?? '';
  if (!apiKey) return searchDuckDuckGo(query, limit); // Fallback

  try {
    const response = await fetch('https://api.minimax.io/v1/coding_plan/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query, limit }),
    });

    if (!response.ok) {
      return searchDuckDuckGo(query, limit); // Fallback on error
    }

    const data = await response.json() as { results?: Array<{ title: string; url: string; snippet: string }> };
    return (data.results ?? []).slice(0, limit).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.snippet ?? '',
    }));
  } catch {
    return searchDuckDuckGo(query, limit);
  }
}

// ─── DuckDuckGo HTML Search ─────────────────────────────

async function searchDuckDuckGo(query: string, limit: number): Promise<SearchResult[]> {
  try {
    const encoded = encodeURIComponent(query);
    const response = await fetch(`https://html.duckduckgo.com/html/?q=${encoded}`, {
      headers: {
        'User-Agent': 'PCC/1.0 (Project CC Agent)',
      },
    });

    const html = await response.text();
    return parseDDGResults(html, limit);
  } catch {
    return [];
  }
}

function parseDDGResults(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  // Parse DuckDuckGo HTML results
  const resultBlocks = html.match(/<a[^>]*class="result__a"[^>]*>[\s\S]*?<\/a>/g) ?? [];
  const snippetBlocks = html.match(/<a[^>]*class="result__snippet"[^>]*>[\s\S]*?<\/a>/g) ?? [];

  for (let i = 0; i < Math.min(resultBlocks.length, limit); i++) {
    const titleBlock = resultBlocks[i] ?? '';
    const snippetBlock = snippetBlocks[i] ?? '';

    const titleMatch = titleBlock.match(/>([^<]+)</);
    const urlMatch = titleBlock.match(/href="([^"]+)"/);
    const snippetMatch = snippetBlock.replace(/<[^>]+>/g, '').trim();

    if (titleMatch && urlMatch) {
      let url = urlMatch[1]!;
      // DuckDuckGo wraps URLs in a redirect
      if (url.includes('uddg=')) {
        const decoded = decodeURIComponent(url.split('uddg=')[1]?.split('&')[0] ?? url);
        url = decoded;
      }

      results.push({
        title: titleMatch[1]!.trim(),
        url,
        snippet: snippetMatch.slice(0, 200),
      });
    }
  }

  return results;
}
