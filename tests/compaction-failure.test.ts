/**
 * Tests for F8 — Compaction failure preserves original messages
 */

import { describe, it, expect, vi } from 'vitest';
import { compactConversation, DEFAULT_COMPACTION_CONFIG } from '../src/context/compactor.js';
import type { Message } from '../src/protocol/messages.js';

// Build enough turns to trigger compaction (need > keepRecentTurns)
function buildConversation(turnCount: number): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < turnCount; i++) {
    messages.push({ role: 'user', content: `User message ${i}` });
    messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: `Assistant response ${i}` }],
    });
  }
  return messages;
}

describe('compactConversation', () => {
  it('preserves original messages when summary generation fails', async () => {
    const messages = buildConversation(8); // More than keepRecentTurns (4)
    const originalLength = messages.length;

    // Mock client that throws on complete
    const failingClient = {
      model: 'test',
      complete: vi.fn().mockRejectedValue(new Error('Model unavailable')),
      stream: vi.fn(),
    } as any;

    const result = await compactConversation(messages, failingClient);

    // Should NOT compact — preserve originals
    expect(result.wasCompacted).toBe(false);
    expect(result.messages.length).toBe(originalLength);
    expect(result.messages).toBe(messages); // Same reference
    expect(result.removedTurns).toBe(0);
  });

  it('preserves original messages when summary is empty', async () => {
    const messages = buildConversation(8);

    // Mock client that returns empty text
    const emptyClient = {
      model: 'test',
      complete: vi.fn().mockResolvedValue({
        message: { role: 'assistant', content: [] },
        stopReason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
      stream: vi.fn(),
    } as any;

    const result = await compactConversation(messages, emptyClient);

    // Empty summary should also preserve originals
    expect(result.wasCompacted).toBe(false);
    expect(result.messages).toBe(messages);
  });

  it('compacts normally when summary succeeds', async () => {
    const messages = buildConversation(8);

    const successClient = {
      model: 'test',
      complete: vi.fn().mockResolvedValue({
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Summary of the conversation.' }],
        },
        stopReason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
      stream: vi.fn(),
    } as any;

    const result = await compactConversation(messages, successClient);

    expect(result.wasCompacted).toBe(true);
    expect(result.removedTurns).toBeGreaterThan(0);
    expect(result.messages.length).toBeLessThan(messages.length);
  });

  it('does not compact when there are too few turns', async () => {
    const messages = buildConversation(3); // Less than keepRecentTurns

    const client = {
      model: 'test',
      complete: vi.fn(),
      stream: vi.fn(),
    } as any;

    const result = await compactConversation(messages, client);

    expect(result.wasCompacted).toBe(false);
    expect(client.complete).not.toHaveBeenCalled();
  });
});
