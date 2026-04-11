/**
 * Layer 5 — Context: JSON export
 *
 * Export a session as a structured JSON document.
 */

import type { SessionData } from './persistence.js';
import type { Message, ContentBlock } from '../../protocol/messages.js';
import {
  isTextBlock,
  isToolUseBlock,
  isToolResultBlock,
} from '../../protocol/messages.js';
import { redactString } from '../../meta/redact.js';

// ─── Exported Types ────────────────────────────────────

export interface ExportedConversation {
  version: 1;
  tool: 'shugu';
  exportedAt: string;
  session: {
    id: string;
    model: string;
    turnCount: number;
    createdAt: string;
    updatedAt: string;
    projectDir: string;
  };
  messages: ExportedMessage[];
  totalUsage: { input_tokens: number; output_tokens: number };
}

export interface ExportedMessage {
  role: 'user' | 'assistant';
  content: string;
  toolUses?: ExportedToolUse[];
}

export interface ExportedToolUse {
  tool: string;
  input: Record<string, unknown>;
  result?: string;
}

// ─── Helpers ───────────────────────────────────────────

/**
 * Flatten content blocks into plain text, ignoring non-text blocks.
 */
function flattenTextContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter(isTextBlock)
    .map((b) => b.text)
    .join('');
}

/**
 * Extract tool use blocks from content, pairing them with their results
 * found in the subsequent user message (if any).
 */
function extractToolUses(
  content: ContentBlock[],
  nextMessage: Message | undefined,
): ExportedToolUse[] {
  const toolUseBlocks = content.filter(isToolUseBlock);
  if (toolUseBlocks.length === 0) return [];

  // Build a map of tool_use_id -> result string from the next message
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

  return toolUseBlocks.map((block) => {
    const exported: ExportedToolUse = {
      tool: block.name,
      input: block.input,
    };
    const result = resultMap.get(block.id);
    if (result !== undefined && result !== '') {
      // Redact secrets from tool results before export
      exported.result = redactString(result);
    }
    return exported;
  });
}

// ─── Main Export ────────────────────────────────────────

export function exportToJson(session: SessionData): string {
  const exportedMessages: ExportedMessage[] = [];

  for (let i = 0; i < session.messages.length; i++) {
    const msg = session.messages[i]!;

    // Skip user messages that are purely tool results (no human text)
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const hasText = msg.content.some(isTextBlock);
      const hasToolResult = msg.content.some(isToolResultBlock);
      if (!hasText && hasToolResult) continue;
    }

    const text = flattenTextContent(msg.content);

    const exported: ExportedMessage = {
      role: msg.role,
      content: text,
    };

    // Extract tool uses from assistant messages
    if (msg.role === 'assistant') {
      const nextMsg = session.messages[i + 1];
      const toolUses = extractToolUses(msg.content, nextMsg);
      if (toolUses.length > 0) {
        exported.toolUses = toolUses;
      }
    }

    exportedMessages.push(exported);
  }

  const conversation: ExportedConversation = {
    version: 1,
    tool: 'shugu',
    exportedAt: new Date().toISOString(),
    session: {
      id: session.id,
      model: session.model,
      turnCount: session.turnCount,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      projectDir: session.projectDir,
    },
    messages: exportedMessages,
    totalUsage: {
      input_tokens: session.totalUsage.input_tokens,
      output_tokens: session.totalUsage.output_tokens,
    },
  };

  return JSON.stringify(conversation, null, 2);
}
