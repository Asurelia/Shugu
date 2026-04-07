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
      // Append missing results — create a modified copy, do NOT mutate the original
      const syntheticResults = missingBlocks.map(
        (b): ToolResultBlock => ({
          type: 'tool_result',
          tool_use_id: b.id,
          content: '[Tool execution was interrupted — no result available]',
          is_error: true,
        }),
      );

      const existingContent = Array.isArray(nextMsg.content)
        ? [...nextMsg.content]
        : [{ type: 'text' as const, text: nextMsg.content }];

      // Push a modified copy of nextMsg and skip it in the next iteration
      result.push({
        ...nextMsg,
        content: [...existingContent, ...syntheticResults],
      } as UserMessage);
      i++; // Skip the original nextMsg since we pushed a modified copy
    }
  }

  // Second pass: remove orphaned tool_results (tool_use_id has no matching tool_use)
  // This prevents API 400 "tool result's tool id not found" errors
  const allToolUseIds = new Set<string>();
  for (const msg of result) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (isToolUseBlock(block)) allToolUseIds.add(block.id);
      }
    }
  }

  for (const msg of result) {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const filtered = (msg.content as ContentBlock[]).filter((block) => {
        if ((block as { type: string }).type === 'tool_result') {
          return allToolUseIds.has((block as ToolResultBlock).tool_use_id);
        }
        return true;
      });
      if (filtered.length !== (msg.content as ContentBlock[]).length) {
        (msg as UserMessage).content = filtered.length > 0 ? filtered : 'ok';
      }
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
      content: '[Tool execution was interrupted — no result available]',
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
  budgetAllowsContinuation?: boolean,
): { continue: boolean; reason?: string; autoContinue?: boolean } {
  // Natural stop
  if (turnResult.stopReason === 'end_turn' && !turnResult.needsToolExecution) {
    return { continue: false, reason: 'end_turn' };
  }

  // Max tokens hit without tool use — check if budget allows continuation
  if (turnResult.stopReason === 'max_tokens' && !turnResult.needsToolExecution) {
    if (budgetAllowsContinuation) {
      return { continue: true, autoContinue: true };
    }
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

// ─── Auto-Continuation ─────────────────────────────────

/** Threshold: auto-continue if used less than 90% of budget */
export const CONTINUATION_THRESHOLD = 0.9;

/** Stop auto-continuing if last 2 continuations added < this many tokens */
export const DIMINISHING_RETURNS_THRESHOLD = 500;

/** Max number of auto-continuations before stopping */
export const MAX_CONTINUATIONS = 5;

/**
 * Track auto-continuation state for diminishing returns detection.
 */
export class ContinuationTracker {
  private continuationCount = 0;
  private recentDeltas: number[] = [];

  /**
   * Check if budget allows another continuation.
   */
  shouldContinue(usedTokens: number, contextWindow: number): boolean {
    if (this.continuationCount >= MAX_CONTINUATIONS) return false;

    const usage = usedTokens / contextWindow;
    if (usage >= CONTINUATION_THRESHOLD) return false;

    // Check diminishing returns (last 2 continuations < threshold)
    if (this.recentDeltas.length >= 2) {
      const last2 = this.recentDeltas.slice(-2);
      if (last2.every(d => d < DIMINISHING_RETURNS_THRESHOLD)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Record a continuation and its token output.
   */
  recordContinuation(outputTokens: number): void {
    this.continuationCount++;
    this.recentDeltas.push(outputTokens);
  }

  /**
   * Reset for a new user turn.
   */
  reset(): void {
    this.continuationCount = 0;
    this.recentDeltas = [];
  }

  get count(): number {
    return this.continuationCount;
  }
}
