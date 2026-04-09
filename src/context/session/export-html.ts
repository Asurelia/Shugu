/**
 * Layer 5 — Context: HTML export
 *
 * Export a session as a self-contained HTML file with dark theme.
 */

import type { SessionData } from './persistence.js';
import type { Message, ContentBlock } from '../../protocol/messages.js';
import {
  isTextBlock,
  isToolUseBlock,
  isToolResultBlock,
} from '../../protocol/messages.js';

// ─── Helpers ───────────────────────────────────────────

/**
 * Escape HTML special characters to prevent XSS in exported content.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Convert text content to HTML, handling code blocks (``` fenced)
 * and inline code (` backticks).
 */
function textToHtml(text: string): string {
  // Split on fenced code blocks: ```lang\n...\n```
  const parts = text.split(/(```[\s\S]*?```)/g);
  const htmlParts: string[] = [];

  for (const part of parts) {
    const fenceMatch = /^```(\w*)\n?([\s\S]*?)```$/.exec(part);
    if (fenceMatch) {
      const lang = fenceMatch[1] ?? '';
      const code = fenceMatch[2] ?? '';
      const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
      const langLabel = lang
        ? `<span class="code-lang">${escapeHtml(lang)}</span>`
        : '';
      htmlParts.push(
        `<div class="code-block">${langLabel}<pre${langAttr}><code>${escapeHtml(code)}</code></pre></div>`,
      );
    } else {
      // Handle inline code
      const inlineParts = part.split(/(`[^`]+`)/g);
      const inlineHtml = inlineParts
        .map((seg) => {
          const inlineMatch = /^`([^`]+)`$/.exec(seg);
          if (inlineMatch) {
            return `<code class="inline-code">${escapeHtml(inlineMatch[1] ?? '')}</code>`;
          }
          // Convert newlines to <br> for plain text segments
          return escapeHtml(seg).replace(/\n/g, '<br>');
        })
        .join('');
      htmlParts.push(inlineHtml);
    }
  }

  return htmlParts.join('');
}

/**
 * Flatten content blocks to plain text.
 */
function flattenText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter(isTextBlock)
    .map((b) => b.text)
    .join('');
}

/**
 * Render tool uses from an assistant message as HTML detail elements.
 */
function renderToolUses(
  content: ContentBlock[],
  nextMessage: Message | undefined,
): string {
  const toolUseBlocks = content.filter(isToolUseBlock);
  if (toolUseBlocks.length === 0) return '';

  // Build result map from the next (user) message's tool_result blocks
  const resultMap = new Map<string, string>();
  if (nextMessage && nextMessage.role === 'user') {
    const nextContent = nextMessage.content;
    if (Array.isArray(nextContent)) {
      for (const block of nextContent) {
        if (isToolResultBlock(block)) {
          const resultText =
            typeof block.content === 'string'
              ? block.content
              : block.content
                  .filter(isTextBlock)
                  .map((b) => b.text)
                  .join('');
          resultMap.set(block.tool_use_id, resultText);
        }
      }
    }
  }

  const toolHtmlParts = toolUseBlocks.map((block) => {
    const inputJson = escapeHtml(JSON.stringify(block.input, null, 2));
    const result = resultMap.get(block.id);
    const resultHtml =
      result !== undefined && result !== ''
        ? `<div class="tool-result"><strong>Result:</strong><pre><code>${escapeHtml(result)}</code></pre></div>`
        : '';
    return `<details class="tool-call">
<summary>Tool: ${escapeHtml(block.name)}</summary>
<div class="tool-input"><strong>Input:</strong><pre><code>${inputJson}</code></pre></div>
${resultHtml}
</details>`;
  });

  return toolHtmlParts.join('\n');
}

// ─── Main Export ────────────────────────────────────────

export function exportToHtml(session: SessionData): string {
  const messageCards: string[] = [];

  for (let i = 0; i < session.messages.length; i++) {
    const msg = session.messages[i]!;

    // Skip user messages that are purely tool results
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const hasText = msg.content.some(isTextBlock);
      const hasToolResult = msg.content.some(isToolResultBlock);
      if (!hasText && hasToolResult) continue;
    }

    const text = flattenText(msg.content);
    const roleLabel = msg.role === 'user' ? 'User' : 'Assistant';
    const roleClass = msg.role;

    let toolHtml = '';
    if (msg.role === 'assistant') {
      const nextMsg = session.messages[i + 1];
      toolHtml = renderToolUses(msg.content, nextMsg);
    }

    messageCards.push(`<div class="message ${roleClass}">
<div class="role-badge ${roleClass}">${roleLabel}</div>
<div class="message-content">${textToHtml(text)}</div>
${toolHtml}
</div>`);
  }

  const title = `Shugu Session ${escapeHtml(session.id)}`;
  const createdDate = new Date(session.createdAt).toLocaleString();
  const updatedDate = new Date(session.updatedAt).toLocaleString();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
    background: #1a1a2e;
    color: #eaeaea;
    line-height: 1.6;
    padding: 2rem;
    max-width: 900px;
    margin: 0 auto;
  }

  header {
    border-bottom: 1px solid #333;
    padding-bottom: 1rem;
    margin-bottom: 2rem;
  }

  header h1 {
    font-size: 1.5rem;
    color: #7f8fff;
    margin-bottom: 0.5rem;
  }

  .meta {
    font-size: 0.85rem;
    color: #888;
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
  }

  .meta span { white-space: nowrap; }

  .message {
    margin-bottom: 1.5rem;
    border-radius: 8px;
    padding: 1rem 1.25rem;
    border-left: 3px solid transparent;
  }

  .message.user {
    background: #16213e;
    border-left-color: #4ecca3;
  }

  .message.assistant {
    background: #1a1a3e;
    border-left-color: #7f8fff;
  }

  .role-badge {
    font-size: 0.75rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 0.5rem;
  }

  .role-badge.user { color: #4ecca3; }
  .role-badge.assistant { color: #7f8fff; }

  .message-content {
    word-wrap: break-word;
    overflow-wrap: break-word;
  }

  .code-block {
    position: relative;
    margin: 0.75rem 0;
  }

  .code-lang {
    position: absolute;
    top: 0.25rem;
    right: 0.5rem;
    font-size: 0.7rem;
    color: #666;
    text-transform: uppercase;
  }

  pre {
    background: #0f0f23;
    border-radius: 6px;
    padding: 1rem;
    overflow-x: auto;
    font-size: 0.85rem;
    line-height: 1.5;
  }

  code {
    font-family: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', Consolas, monospace;
  }

  .inline-code {
    background: #0f0f23;
    padding: 0.15em 0.4em;
    border-radius: 3px;
    font-size: 0.9em;
  }

  details.tool-call {
    margin-top: 0.75rem;
    border: 1px solid #333;
    border-radius: 6px;
    overflow: hidden;
  }

  details.tool-call summary {
    cursor: pointer;
    padding: 0.5rem 0.75rem;
    background: #0f0f23;
    font-size: 0.85rem;
    color: #c084fc;
    font-weight: 600;
  }

  details.tool-call summary:hover { background: #151530; }

  .tool-input, .tool-result {
    padding: 0.75rem;
    border-top: 1px solid #333;
  }

  .tool-input strong, .tool-result strong {
    font-size: 0.8rem;
    color: #888;
    display: block;
    margin-bottom: 0.25rem;
  }

  .tool-input pre, .tool-result pre {
    margin-top: 0.25rem;
    font-size: 0.8rem;
  }

  footer {
    border-top: 1px solid #333;
    padding-top: 1rem;
    margin-top: 2rem;
    font-size: 0.8rem;
    color: #555;
    text-align: center;
  }
</style>
</head>
<body>
<header>
  <h1>${title}</h1>
  <div class="meta">
    <span>Model: ${escapeHtml(session.model)}</span>
    <span>Turns: ${session.turnCount}</span>
    <span>Created: ${escapeHtml(createdDate)}</span>
    <span>Updated: ${escapeHtml(updatedDate)}</span>
    <span>Tokens: ${session.totalUsage.input_tokens} in / ${session.totalUsage.output_tokens} out</span>
  </div>
</header>
<main>
${messageCards.join('\n')}
</main>
<footer>
  Exported by Shugu &mdash; ${escapeHtml(new Date().toISOString())}
</footer>
</body>
</html>`;
}
