/**
 * Layer 2 — Engine: Turn management
 *
 * A "turn" is one cycle of: user message → model response → optional tool execution.
 * This module manages turn lifecycle, stop reason handling, and message pairing.
 */

import type {
  Message,
  AssistantMessage,
  UserMessage,
  ContentBlock,
  ToolUseBlock,
  ToolResultBlock,
  Usage,
} from '../protocol/messages.js';
import { isToolUseBlock, getToolUseBlocks } from '../protocol/messages.js';
import type { ToolCall, ToolResult } from '../protocol/tools.js';

// ─── Turn Result ────────────────────────────────────────

export interface TurnResult {
  assistantMessage: AssistantMessage;
  stopReason: string | null;
  usage: Usage;
  toolCalls: ToolCall[];
  needsToolExecution: boolean;
}

/**
 * Analyze an assistant response and determine what to do next.
 */
export function analyzeTurn(
  assistantMessage: AssistantMessage,
  stopReason: string | null,
  usage: Usage,
): TurnResult {
  const toolUseBlocks = getToolUseBlocks(assistantMessage);
  const toolCalls: ToolCall[] = toolUseBlocks.map((block) => ({
    id: block.id,
    name: block.name,
    input: block.input,
  }));

  return {
    assistantMessage,
    stopReason,
    usage,
    toolCalls,
    needsToolExecution: toolCalls.length > 0,
  };
}

// ─── Message Construction ───────────────────────────────

/**
 * Build a tool_result user message from executed tool results.
 * This is sent back to the model as the next user message in the loop.
 *
 * Critical MiniMax constraint: the FULL assistant response (including reasoning)
 * must be preserved in the conversation history. We never strip or modify
 * the assistant message — we only append the tool results as a new user message.
 */
export function buildToolResultMessage(results: ToolResult[]): UserMessage {
  const content: ToolResultBlock[] = results.map((result) => ({
    type: 'tool_result' as const,
    tool_use_id: result.tool_use_id,
    content: typeof result.content === 'string'
      ? result.content
      : result.content.map((c) => ({ type: 'text' as const, text: c.text ?? '' })),
    is_error: result.is_error,
  }));

  return {
    role: 'user',
    content,
  };
}

/**
 * Ensure all tool_use blocks in assistant messages have matching tool_result blocks
 * in the following user message. Orphaned tool_uses get synthetic error results.
 *
 * Adapted from OpenClaude src/services/api/claude.ts ensureToolResultPairing().
 */
export function ensureToolResultPairing(messages: Message[]): Message[] {
  const result: Message[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    result.push(msg);

    if (msg.role !== 'assistant') continue;

    const toolUseBlocks = (msg.content as ContentBlock[]).filter(isToolUseBlock);
    if (toolUseBlocks.length === 0) continue;

    // Check if the next message contains all expected tool_results
    const nextMsg = messages[i + 1];
    if (!nextMsg || nextMsg.role !== 'user') {
      // No user message follows — add synthetic error results
      result.push(buildSyntheticToolResults(toolUseBlocks));
      continue;
    }

    // Check for missing tool_results
    const existingResultIds = new Set(
      (Array.isArray(nextMsg.content) ? nextMsg.content : [])
        .filter((b): b is ToolResultBlock => (b as ContentBlock).type === 'tool_result')
        .map((b) => b.tool_use_id),
    );

    const missingBlocks = toolUseBlocks.filter((b) => !existingResultIds.has(b.id));
    if (missingBlocks.length > 0) {
      // Append missing results to the existing user message
      const syntheticResults = missingBlocks.map(
        (b): ToolResultBlock => ({
          type: 'tool_result',
          tool_use_id: b.id,
          content: '[Tool result missing due to internal error]',
          is_error: true,
        }),
      );

      const existingContent = Array.isArray(nextMsg.content)
        ? nextMsg.content
        : [{ type: 'text' as const, text: nextMsg.content }];

      result[result.length - 1] = { // Replace the nextMsg we haven't pushed yet
        ...nextMsg,
      };
      // Actually, nextMsg hasn't been pushed yet - it will be pushed in the next iteration
      // We need to modify it in place for the next push
      (messages[i + 1] as UserMessage).content = [...existingContent, ...syntheticResults];
    }
  }

  return result;
}

function buildSyntheticToolResults(toolUseBlocks: ToolUseBlock[]): UserMessage {
  return {
    role: 'user',
    content: toolUseBlocks.map((block) => ({
      type: 'tool_result' as const,
      tool_use_id: block.id,
      content: '[Tool result missing due to internal error]',
      is_error: true,
    })),
  };
}

// ─── Max Turns ──────────────────────────────────────────

export const DEFAULT_MAX_TURNS = 100;

export function shouldContinue(
  turnResult: TurnResult,
  turnCount: number,
  maxTurns: number,
): { continue: boolean; reason?: string } {
  // Natural stop
  if (turnResult.stopReason === 'end_turn' && !turnResult.needsToolExecution) {
    return { continue: false, reason: 'end_turn' };
  }

  // Max tokens hit without tool use
  if (turnResult.stopReason === 'max_tokens' && !turnResult.needsToolExecution) {
    return { continue: false, reason: 'max_tokens' };
  }

  // Turn limit
  if (turnCount >= maxTurns) {
    return { continue: false, reason: 'max_turns_reached' };
  }

  // Tool use — continue the loop
  if (turnResult.needsToolExecution) {
    return { continue: true };
  }

  // Default: stop
  return { continue: false, reason: turnResult.stopReason ?? 'unknown' };
}
