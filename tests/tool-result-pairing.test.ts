/**
 * Tests for F7 — ensureToolResultPairing does not mutate input
 */

import { describe, it, expect } from 'vitest';
import { ensureToolResultPairing, buildToolResultMessage } from '../src/engine/turns.js';
import type { Message, AssistantMessage, UserMessage } from '../src/protocol/messages.js';

describe('ensureToolResultPairing', () => {
  it('does not mutate the original messages array', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'ls' } },
        ],
      } as AssistantMessage,
      // Missing tool_result — should get synthetic result added
      { role: 'user', content: 'next question' },
    ];

    // Deep clone for comparison
    const originalContent = (messages[2] as UserMessage).content;

    const result = ensureToolResultPairing(messages);

    // Original array should NOT be mutated
    expect((messages[2] as UserMessage).content).toBe(originalContent);
    expect(result.length).toBeGreaterThanOrEqual(messages.length);
  });

  it('adds synthetic results for orphaned tool_use blocks', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'ls' } },
        ],
      } as AssistantMessage,
      // No following user message
    ];

    const result = ensureToolResultPairing(messages);

    // Should add a synthetic tool_result user message
    expect(result.length).toBe(3); // original 2 + synthetic
    const syntheticMsg = result[2] as UserMessage;
    expect(syntheticMsg.role).toBe('user');
    expect(Array.isArray(syntheticMsg.content)).toBe(true);
    const content = syntheticMsg.content as Array<{ type: string; content: string }>;
    expect(content[0]!.type).toBe('tool_result');
    expect(content[0]!.content).toContain('interrupted');
  });

  it('preserves existing tool_results', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'ls' } },
        ],
      } as AssistantMessage,
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool_1', content: 'file1.txt\nfile2.txt' },
        ],
      } as UserMessage,
    ];

    const result = ensureToolResultPairing(messages);
    expect(result.length).toBe(3);
  });

  it('uses accurate message text for synthetic results', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'ls' } },
        ],
      } as AssistantMessage,
    ];

    const result = ensureToolResultPairing(messages);
    const syntheticMsg = result[2] as UserMessage;
    const content = syntheticMsg.content as Array<{ type: string; content: string }>;
    // Should use the new accurate text, not the old misleading one
    expect(content[0]!.content).not.toContain('internal error');
    expect(content[0]!.content).toContain('interrupted');
  });
});
