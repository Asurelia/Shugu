/**
 * Tests for MiniMax reasoning_details parsing
 *
 * Verifies that:
 * 1. reasoning_details on message_start are converted to thinking blocks
 * 2. Separate reasoning.text events are accumulated into thinking blocks
 * 3. Output AssistantMessage.content includes thinking blocks with correct text
 */

import { describe, it, expect } from 'vitest';
import { accumulateStream, type AccumulatedResponse } from '../src/transport/stream.js';
import type { StreamEvent } from '../src/protocol/events.js';

// ─── Helper: create async generator from array ──────────

async function* streamFrom(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const event of events) {
    yield event;
  }
}

// ─── Tests ────────────────────────────────────────────────

describe('MiniMax reasoning_details parsing', () => {
  it('parses reasoning_details from message_start into thinking blocks', async () => {
    const events: StreamEvent[] = [
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          model: 'MiniMax-M2.7',
          usage: { input_tokens: 100, output_tokens: 50 },
          reasoning_details: [
            { text: 'Let me think about this step by step.' },
            { text: 'First, I need to check the file.' },
          ],
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Here is my answer.' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 50 },
      },
      { type: 'message_stop' },
    ];

    const result = await accumulateStream(streamFrom(events));

    // Should have 3 blocks: 2 thinking + 1 text
    expect(result.message.content.length).toBe(3);

    const thinkingBlocks = result.message.content.filter((b) => b.type === 'thinking');
    expect(thinkingBlocks.length).toBe(2);
    expect((thinkingBlocks[0] as { thinking: string }).thinking).toBe(
      'Let me think about this step by step.',
    );
    expect((thinkingBlocks[1] as { thinking: string }).thinking).toBe(
      'First, I need to check the file.',
    );

    const textBlocks = result.message.content.filter((b) => b.type === 'text');
    expect(textBlocks.length).toBe(1);
    expect((textBlocks[0] as { text: string }).text).toBe('Here is my answer.');
  });

  it('parses separate reasoning.text events into thinking blocks', async () => {
    const events: StreamEvent[] = [
      {
        type: 'message_start',
        message: {
          id: 'msg_2',
          model: 'MiniMax-M2.7',
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
      // MiniMax reasoning events (streamed)
      {
        type: 'reasoning.text',
        id: 'reasoning_1',
        text: 'Step 1: ',
      },
      {
        type: 'reasoning.text',
        id: 'reasoning_1',
        text: 'Analyze the problem.',
      },
      // Then normal text content
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'The answer is 42.' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 30 },
      },
      { type: 'message_stop' },
    ];

    const result = await accumulateStream(streamFrom(events));

    // Should have thinking block + text block
    const thinkingBlocks = result.message.content.filter((b) => b.type === 'thinking');
    expect(thinkingBlocks.length).toBe(1);
    expect((thinkingBlocks[0] as { thinking: string }).thinking).toBe(
      'Step 1: Analyze the problem.',
    );

    const textBlocks = result.message.content.filter((b) => b.type === 'text');
    expect(textBlocks.length).toBe(1);
    expect((textBlocks[0] as { text: string }).text).toBe('The answer is 42.');
  });

  it('handles message_start without reasoning_details gracefully', async () => {
    const events: StreamEvent[] = [
      {
        type: 'message_start',
        message: {
          id: 'msg_3',
          model: 'MiniMax-M2.7',
          usage: { input_tokens: 50, output_tokens: 20 },
          // No reasoning_details field
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Simple response.' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 20 },
      },
      { type: 'message_stop' },
    ];

    const result = await accumulateStream(streamFrom(events));

    // Should only have 1 text block, no thinking
    expect(result.message.content.length).toBe(1);
    expect(result.message.content[0]!.type).toBe('text');
  });

  it('handles both reasoning_details and reasoning.text events together', async () => {
    const events: StreamEvent[] = [
      {
        type: 'message_start',
        message: {
          id: 'msg_4',
          model: 'MiniMax-M2.7',
          usage: { input_tokens: 100, output_tokens: 50 },
          reasoning_details: [{ text: 'Pre-computed reasoning.' }],
        },
      },
      // Additional streaming reasoning
      {
        type: 'reasoning.text',
        id: 'reasoning_2',
        text: 'Streamed reasoning.',
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Final answer.' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
      },
      { type: 'message_stop' },
    ];

    const result = await accumulateStream(streamFrom(events));

    const thinkingBlocks = result.message.content.filter((b) => b.type === 'thinking');
    // Pre-computed + streamed = at least 2 thinking blocks
    expect(thinkingBlocks.length).toBeGreaterThanOrEqual(2);
  });
});
