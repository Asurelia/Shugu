/**
 * Layer 0 — Protocol: Stream events
 *
 * Events emitted during streaming from the transport layer.
 * Mirrors the Anthropic SSE event types that MiniMax supports natively.
 */

import type { ContentBlock, StopReason, Usage } from './messages.js';

// ─── Stream Events ──────────────────────────────────────

export interface MessageStartEvent {
  type: 'message_start';
  message: {
    id: string;
    model: string;
    usage: Usage;
    /** MiniMax may include pre-computed reasoning as an array on message_start */
    reasoning_details?: Array<{ text: string }>;
  };
}

export interface ContentBlockStartEvent {
  type: 'content_block_start';
  index: number;
  content_block: ContentBlockStart;
}

export type ContentBlockStart =
  | { type: 'text'; text: '' }
  | { type: 'tool_use'; id: string; name: string; input: '' }
  | { type: 'thinking'; thinking: '' };

export interface ContentBlockDeltaEvent {
  type: 'content_block_delta';
  index: number;
  delta: ContentDelta;
}

export type ContentDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'input_json_delta'; partial_json: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'signature_delta'; signature: string };

export interface ContentBlockStopEvent {
  type: 'content_block_stop';
  index: number;
}

export interface MessageDeltaEvent {
  type: 'message_delta';
  delta: {
    stop_reason: StopReason;
  };
  usage?: {
    output_tokens: number;
  };
}

export interface MessageStopEvent {
  type: 'message_stop';
}

// ─── Reasoning Events (MiniMax-specific) ────────────────

export interface ReasoningDelta {
  type: 'reasoning.text';
  id: string;
  text: string;
}

// ─── Union ──────────────────────────────────────────────

export type StreamEvent =
  | MessageStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageDeltaEvent
  | MessageStopEvent
  | ReasoningDelta;

// ─── Stream State ───────────────────────────────────────

/**
 * Accumulator for building content blocks from streaming deltas.
 * Used by the stream parser to reconstruct complete blocks.
 */
export interface StreamAccumulator {
  messageId: string;
  model: string;
  contentBlocks: AccumulatingBlock[];
  stopReason: StopReason;
  usage: Usage;
}

export interface AccumulatingBlock {
  type: 'text' | 'tool_use' | 'thinking';
  text: string;       // For text blocks
  toolId: string;     // For tool_use blocks
  toolName: string;   // For tool_use blocks
  inputJson: string;  // For tool_use — accumulated JSON string
  thinking: string;   // For thinking blocks
  signature: string;  // For thinking blocks
}

export function createEmptyAccumulator(): StreamAccumulator {
  return {
    messageId: '',
    model: '',
    contentBlocks: [],
    stopReason: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}
