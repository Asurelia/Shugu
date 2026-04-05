/**
 * Layer 0 — Protocol: Thinking/Reasoning types
 *
 * MiniMax M2.7 has MANDATORY reasoning — it always runs, cannot be disabled.
 * With `reasoning_split: true`, thinking is exposed separately from the response.
 *
 * Key difference from Anthropic:
 * - Anthropic: thinking is optional, controlled via beta headers
 * - MiniMax: thinking is ALWAYS on, `reasoning_split` controls visibility
 * - MiniMax streaming: `reasoning_details[].text` (NOT `.content`)
 */

// ─── Thinking Configuration ─────────────────────────────

export interface ThinkingConfig {
  /**
   * Whether to expose thinking blocks separately.
   * For MiniMax, this maps to `reasoning_split: true` in the request.
   * Default: true (always show reasoning)
   */
  showThinking: boolean;

  /**
   * Optional budget for thinking tokens.
   * MiniMax doesn't enforce this server-side, but we can track it client-side.
   */
  budgetTokens?: number;
}

export const DEFAULT_THINKING_CONFIG: ThinkingConfig = {
  showThinking: true,
};

// ─── Reasoning Details (MiniMax streaming format) ───────

/**
 * MiniMax streams reasoning as `reasoning_details` array in the SSE delta.
 * Each entry has `type: "reasoning.text"` and the content is in `.text` (NOT `.content`).
 *
 * This is a critical quirk documented in minimax-api-reference.md.
 */
export interface MiniMaxReasoningDetail {
  type: 'reasoning.text';
  id: string;
  text: string;  // NOT .content — this was a bug source in the Shugu integration
}

// ─── Thinking Block Helpers ─────────────────────────────

export interface ReasoningAccumulator {
  details: MiniMaxReasoningDetail[];
  fullText: string;
}

export function createReasoningAccumulator(): ReasoningAccumulator {
  return { details: [], fullText: '' };
}

export function appendReasoningDelta(
  acc: ReasoningAccumulator,
  detail: MiniMaxReasoningDetail,
): ReasoningAccumulator {
  return {
    details: [...acc.details, detail],
    fullText: acc.fullText + detail.text,
  };
}
