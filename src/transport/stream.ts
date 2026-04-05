/**
 * Layer 1 — Transport: SSE Stream Parser
 *
 * Parses Server-Sent Events from MiniMax's Anthropic-compatible endpoint.
 * Handles both standard Anthropic stream events and MiniMax's reasoning_details.
 *
 * MiniMax SSE format:
 * - Standard `data:` prefix, terminated by `data: [DONE]`
 * - Reasoning comes as `reasoning_details` array in delta
 * - Each detail: {"type":"reasoning.text", "id":"...", "text":"..."}
 * - Text field is .text, NOT .content (critical bug source)
 */

import type {
  StreamEvent,
  StreamAccumulator,
  AccumulatingBlock,
  ContentDelta,
} from '../protocol/events.js';
import type {
  AssistantMessage,
  ContentBlock,
  Usage,
} from '../protocol/messages.js';

// ─── SSE Line Parser ────────────────────────────────────

export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  abortSignal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (abortSignal?.aborted) {
        break;
      }

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');

      // Keep the last potentially incomplete line in the buffer
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();

        // Skip empty lines and comments
        if (!trimmed || trimmed.startsWith(':')) continue;

        // Check for stream end
        if (trimmed === 'data: [DONE]') return;

        // Parse data lines
        if (trimmed.startsWith('data: ')) {
          const jsonStr = trimmed.slice(6);
          try {
            const event = JSON.parse(jsonStr) as StreamEvent;
            yield event;
          } catch {
            // Skip malformed JSON lines — MiniMax sometimes sends partial lines
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── Stream Accumulator ─────────────────────────────────

/**
 * Processes stream events and builds up complete content blocks.
 * Returns the final AssistantMessage when the stream is complete.
 */
export async function accumulateStream(
  events: AsyncGenerator<StreamEvent>,
  callbacks?: StreamCallbacks,
): Promise<AccumulatedResponse> {
  const blocks: AccumulatingBlock[] = [];
  let messageId = '';
  let model = '';
  let stopReason: string | null = null;
  const usage: Usage = { input_tokens: 0, output_tokens: 0 };

  for await (const event of events) {
    switch (event.type) {
      case 'message_start': {
        messageId = event.message.id;
        model = event.message.model;
        usage.input_tokens = event.message.usage.input_tokens;
        usage.output_tokens = event.message.usage.output_tokens;
        if (event.message.usage.cache_creation_input_tokens) {
          usage.cache_creation_input_tokens = event.message.usage.cache_creation_input_tokens;
        }
        if (event.message.usage.cache_read_input_tokens) {
          usage.cache_read_input_tokens = event.message.usage.cache_read_input_tokens;
        }
        break;
      }

      case 'content_block_start': {
        const block = createAccumulatingBlock(event.content_block);
        blocks[event.index] = block;
        callbacks?.onContentBlockStart?.(event.index, event.content_block.type);
        break;
      }

      case 'content_block_delta': {
        const block = blocks[event.index];
        if (!block) break;
        applyDelta(block, event.delta);
        callbacks?.onDelta?.(event.index, event.delta);
        break;
      }

      case 'content_block_stop': {
        const block = blocks[event.index];
        if (!block) break;
        const completed = finalizeBlock(block);
        callbacks?.onContentBlockComplete?.(event.index, completed);
        break;
      }

      case 'message_delta': {
        stopReason = event.delta.stop_reason;
        if (event.usage) {
          usage.output_tokens = event.usage.output_tokens;
        }
        break;
      }

      case 'message_stop': {
        // Stream complete
        break;
      }
    }
  }

  const contentBlocks = blocks.map(finalizeBlock);
  const message: AssistantMessage = {
    role: 'assistant',
    content: contentBlocks,
  };

  return { messageId, model, message, stopReason, usage };
}

// ─── Block Construction ─────────────────────────────────

function createAccumulatingBlock(
  start: { type: string; id?: string; name?: string },
): AccumulatingBlock {
  return {
    type: start.type as AccumulatingBlock['type'],
    text: '',
    toolId: (start as { id?: string }).id ?? '',
    toolName: (start as { name?: string }).name ?? '',
    inputJson: '',
    thinking: '',
    signature: '',
  };
}

function applyDelta(block: AccumulatingBlock, delta: ContentDelta): void {
  switch (delta.type) {
    case 'text_delta':
      block.text += delta.text;
      break;
    case 'input_json_delta':
      block.inputJson += delta.partial_json;
      break;
    case 'thinking_delta':
      block.thinking += delta.thinking;
      break;
    case 'signature_delta':
      block.signature += delta.signature;
      break;
  }
}

function finalizeBlock(block: AccumulatingBlock): ContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };

    case 'tool_use': {
      let input: Record<string, unknown> = {};
      if (block.inputJson) {
        try {
          input = JSON.parse(block.inputJson) as Record<string, unknown>;
        } catch {
          input = { _raw: block.inputJson };
        }
      }
      return {
        type: 'tool_use',
        id: block.toolId,
        name: block.toolName,
        input,
      };
    }

    case 'thinking':
      return {
        type: 'thinking',
        thinking: block.thinking,
        signature: block.signature || undefined,
      };

    default:
      return { type: 'text', text: block.text };
  }
}

// ─── Types ──────────────────────────────────────────────

export interface AccumulatedResponse {
  messageId: string;
  model: string;
  message: AssistantMessage;
  stopReason: string | null;
  usage: Usage;
}

export interface StreamCallbacks {
  onContentBlockStart?(index: number, type: string): void;
  onDelta?(index: number, delta: ContentDelta): void;
  onContentBlockComplete?(index: number, block: ContentBlock): void;
}
