/**
 * Tests for Layer 0 — Protocol types and utilities
 */

import { describe, it, expect } from 'vitest';
import {
  isTextBlock,
  isThinkingBlock,
  isToolUseBlock,
  type ContentBlock,
  type TextBlock,
  type ThinkingBlock,
  type ToolUseBlock,
} from '../src/protocol/messages.js';
import {
  createEmptyAccumulator,
  type StreamAccumulator,
} from '../src/protocol/events.js';

describe('Protocol: Message type guards', () => {
  it('isTextBlock identifies text blocks', () => {
    const block: ContentBlock = { type: 'text', text: 'hello' };
    expect(isTextBlock(block)).toBe(true);
  });

  it('isTextBlock rejects non-text blocks', () => {
    const block: ContentBlock = { type: 'thinking', thinking: 'hmm', signature: '' };
    expect(isTextBlock(block)).toBe(false);
  });

  it('isThinkingBlock identifies thinking blocks', () => {
    const block: ContentBlock = { type: 'thinking', thinking: 'analyzing...', signature: 'sig' };
    expect(isThinkingBlock(block)).toBe(true);
  });

  it('isToolUseBlock identifies tool_use blocks', () => {
    const block: ContentBlock = { type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'ls' } };
    expect(isToolUseBlock(block)).toBe(true);
  });

  it('type guards are mutually exclusive', () => {
    const text: ContentBlock = { type: 'text', text: 'hello' };
    const thinking: ContentBlock = { type: 'thinking', thinking: 'hmm', signature: '' };
    const tool: ContentBlock = { type: 'tool_use', id: 'x', name: 'Y', input: {} };

    expect(isTextBlock(text)).toBe(true);
    expect(isThinkingBlock(text)).toBe(false);
    expect(isToolUseBlock(text)).toBe(false);

    expect(isTextBlock(thinking)).toBe(false);
    expect(isThinkingBlock(thinking)).toBe(true);
    expect(isToolUseBlock(thinking)).toBe(false);

    expect(isTextBlock(tool)).toBe(false);
    expect(isThinkingBlock(tool)).toBe(false);
    expect(isToolUseBlock(tool)).toBe(true);
  });
});

describe('Protocol: Stream accumulator', () => {
  it('creates an empty accumulator with zeroed usage', () => {
    const acc = createEmptyAccumulator();
    expect(acc.messageId).toBe('');
    expect(acc.model).toBe('');
    expect(acc.contentBlocks).toEqual([]);
    expect(acc.stopReason).toBeNull();
    expect(acc.usage.input_tokens).toBe(0);
    expect(acc.usage.output_tokens).toBe(0);
  });
});
