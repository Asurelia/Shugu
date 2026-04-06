/**
 * Layer 3 — Tools: WebFetchTool
 *
 * HTTP GET/POST with automatic HTML→Markdown conversion.
 * Auto-injects credentials from vault when domain matches a known service.
 * Falls back to raw fetch if no credentials needed.
 */

import type { Tool, ToolCall, ToolResult, ToolContext, ToolDefinition } from '../../protocol/tools.js';
import type { CredentialProvider } from '../../credentials/provider.js';

export const WebFetchToolDefinition: ToolDefinition = {
  name: 'WebFetch',
  description: `Fetch content from a URL. Returns the page content converted to Markdown. Supports GET and POST. Automatically uses stored credentials when accessing known services (GitHub, Notion, etc.). Use for: reading web pages, calling APIs, downloading data.`,
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch',
      },
      method: {
        type: 'string',
        description: 'HTTP method: GET (default) or POST',
      },
      headers: {
        type: 'object',
        description: 'Additional HTTP headers as key-value pairs',
      },
      body: {
        type: 'string',
        description: 'Request body for POST requests (JSON string)',
      },
    },
    required: ['url'],
  },
  concurrencySafe: true,
};

const MAX_RESPONSE_LENGTH = 100_000;
const TIMEOUT_MS = 30_000;

export class WebFetchTool implements Tool {
  definition = WebFetchToolDefinition;
  private credentialProvider: CredentialProvider | null = null;

  setCredentialProvider(provider: CredentialProvider): void {
    this.credentialProvider = provider;
  }

  validateInput(input: Record<string, unknown>): string | null {
    if (typeof input['url'] !== 'string' || !input['url']) {
      return 'url must be a non-empty string';
    }
    try {
      new URL(input['url'] as string);
    } catch {
      return 'url must be a valid URL';
    }
    return null;
  }

  async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const url = call.input['url'] as string;
    const method = ((call.input['method'] as string) ?? 'GET').toUpperCase();
    const extraHeaders = (call.input['headers'] as Record<string, string>) ?? {};
    const body = call.input['body'] as string | undefined;

    try {
      // Build headers — auto-inject credentials if available
      const headers: Record<string, string> = {
        'User-Agent': 'PCC/1.0 (Project CC Agent)',
        'Accept': 'text/html,application/json,text/plain,*/*',
        ...extraHeaders,
      };

      // Inject auth headers from vault
      if (this.credentialProvider) {
        const authHeaders = this.credentialProvider.getAuthHeaders(url);
        Object.assign(headers, authHeaders);
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch(url, {
        method,
        headers,
        body: method === 'POST' ? body : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const contentType = response.headers.get('content-type') ?? '';
      let content: string;

      if (contentType.includes('application/json')) {
        const json = await response.json();
        content = JSON.stringify(json, null, 2);
      } else {
        const text = await response.text();
        if (contentType.includes('text/html')) {
          content = htmlToMarkdown(text);
        } else {
          content = text;
        }
      }

      // Truncate if too long
      if (content.length > MAX_RESPONSE_LENGTH) {
        content = content.slice(0, MAX_RESPONSE_LENGTH) + `\n\n[Truncated — ${content.length} chars total]`;
      }

      const statusInfo = `HTTP ${response.status} ${response.statusText}`;
      // Wrap external content so the model can distinguish trusted vs untrusted data
      const wrapped = `<external-content source="${url}">\n${content}\n</external-content>`;
      if (!response.ok) {
        return {
          tool_use_id: call.id,
          content: `${statusInfo}\n\n${wrapped}`,
          is_error: true,
        };
      }

      return {
        tool_use_id: call.id,
        content: `${statusInfo} (${contentType})\n\n${wrapped}`,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        tool_use_id: call.id,
        content: `Fetch error: ${msg}`,
        is_error: true,
      };
    }
  }
}

// ─── HTML → Markdown (lightweight) ──────────────────────

function htmlToMarkdown(html: string): string {
  let md = html;

  // Remove script/style
  md = md.replace(/<script[\s\S]*?<\/script>/gi, '');
  md = md.replace(/<style[\s\S]*?<\/style>/gi, '');
  md = md.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  md = md.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  md = md.replace(/<header[\s\S]*?<\/header>/gi, '');

  // Convert common elements
  md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
  md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
  md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
  md = md.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n');
  md = md.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');
  md = md.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**');
  md = md.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*');
  md = md.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*');
  md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  md = md.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n');
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
  md = md.replace(/<br\s*\/?>/gi, '\n');
  md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n');
  md = md.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, '\n> $1\n');

  // Strip remaining tags
  md = md.replace(/<[^>]+>/g, '');

  // Decode entities
  md = md.replace(/&amp;/g, '&');
  md = md.replace(/&lt;/g, '<');
  md = md.replace(/&gt;/g, '>');
  md = md.replace(/&quot;/g, '"');
  md = md.replace(/&#39;/g, "'");
  md = md.replace(/&nbsp;/g, ' ');

  // Collapse whitespace
  md = md.replace(/\n{3,}/g, '\n\n');
  md = md.trim();

  return md;
}
