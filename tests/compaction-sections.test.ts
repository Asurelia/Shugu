/**
 * Tests for Plan 3 — Deep Compaction (9-Section Format)
 *
 * Verifies config values, CompactionResult shape, and compaction threshold behavior.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  compactConversation,
  DEFAULT_COMPACTION_CONFIG,
  type CompactionResult,
} from '../src/context/compactor.js';
import type { Message } from '../src/protocol/messages.js';

// ── Helpers ────────────────────────────────────────────────

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

// ── Tests ──────────────────────────────────────────────────

describe('Deep Compaction — config and result shape', () => {
  it('summaryMaxTokens is 3072', () => {
    expect(DEFAULT_COMPACTION_CONFIG.summaryMaxTokens).toBe(3072);
  });

  it('keepRecentTurns is still 6 (no regression)', () => {
    expect(DEFAULT_COMPACTION_CONFIG.keepRecentTurns).toBe(6);
  });

  it('returns wasCompacted: false when turns <= keepRecentTurns', async () => {
    const messages = buildConversation(5); // 5 turns, threshold is 6

    const client = {
      model: 'test',
      complete: vi.fn(),
      stream: vi.fn(),
    } as any;

    const result = await compactConversation(messages, client);

    expect(result.wasCompacted).toBe(false);
    expect(result.removedTurns).toBe(0);
    expect(result.messages).toBe(messages); // same reference — untouched
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('CompactionResult has expected fields', async () => {
    const messages = buildConversation(3);

    const client = {
      model: 'test',
      complete: vi.fn(),
      stream: vi.fn(),
    } as any;

    const result: CompactionResult = await compactConversation(messages, client);

    // Required fields always present
    expect(result).toHaveProperty('messages');
    expect(result).toHaveProperty('wasCompacted');
    expect(result).toHaveProperty('removedTurns');
    expect(Array.isArray(result.messages)).toBe(true);
    expect(typeof result.wasCompacted).toBe('boolean');
    expect(typeof result.removedTurns).toBe('number');

    // summaryLength is optional — absent when not compacted
    expect(result.summaryLength).toBeUndefined();
  });

  it('CompactionResult includes summaryLength when compacted', async () => {
    const messages = buildConversation(10); // well above keepRecentTurns=6

    const client = {
      model: 'test',
      complete: vi.fn().mockResolvedValue({
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '[GOAL] Test goal\n[FINDING] discovered something' }],
        },
        stopReason: 'end_turn',
        usage: { input_tokens: 200, output_tokens: 80 },
      }),
      stream: vi.fn(),
    } as any;

    const result: CompactionResult = await compactConversation(messages, client);

    expect(result.wasCompacted).toBe(true);
    expect(result.removedTurns).toBeGreaterThan(0);
    expect(typeof result.summaryLength).toBe('number');
    expect(result.summaryLength).toBeGreaterThan(0);
  });
});
