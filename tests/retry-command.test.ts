/**
 * Tests for /retry command — message pop logic and edge cases.
 *
 * Tests the handleInlineCommand /retry path directly by building
 * conversation histories and verifying correct message removal.
 */

import { describe, it, expect } from 'vitest';
import type { Message } from '../src/protocol/messages.js';
import type { ReplState } from '../src/entrypoints/repl-commands.js';
import { handleInlineCommand } from '../src/entrypoints/repl-commands.js';

// ── Helpers ────────────────────────────────────────────

function mockState(messages: Message[], lastHumanInputIdx: number): ReplState {
  const infos: string[] = [];
  const errors: string[] = [];
  return {
    app: {
      pushMessage: (msg: { type: string; text: string }) => {
        if (msg.type === 'info') infos.push(msg.text);
        if (msg.type === 'error') errors.push(msg.text);
      },
    } as ReplState['app'],
    budget: {} as ReplState['budget'],
    tokenTracker: {} as ReplState['tokenTracker'],
    renderer: { info: () => {}, error: () => {} } as unknown as ReplState['renderer'],
    permResolver: {} as ReplState['permResolver'],
    session: {} as ReplState['session'],
    conversationMessages: messages,
    client: {} as ReplState['client'],
    thinkingExpanded: false,
    lastHumanInputIdx,
  };
}

function userMsg(content: string): Message {
  return { role: 'user', content };
}

function assistantMsg(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

function assistantToolUse(): Message {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: '/test.ts' } }],
  };
}

function userToolResult(): Message {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file content' }],
  };
}

/** Synthetic reflection prompt injected by runLoop */
function syntheticReflection(): Message {
  return { role: 'user', content: '[System: Reflect on progress so far]' };
}

/** Synthetic continuation prompt injected by runLoop */
function syntheticContinuation(): Message {
  return { role: 'user', content: '[System: Your response was cut off due to length. Continue exactly where you left off.]' };
}

/** Synthetic loop detection injected by runLoop */
function syntheticLoopDetect(): Message {
  return { role: 'user', content: '[LOOP DETECTED] You have called the same tool 3 times with identical arguments.' };
}

// ── Tests ──────────────────────────────────────────────

describe('/retry — basic', () => {
  it('pops simple user→assistant pair and returns retry flag', async () => {
    const messages: Message[] = [
      userMsg('Fix the bug'),
      assistantMsg('Done, fixed it.'),
    ];
    const state = mockState(messages, 0);

    const result = await handleInlineCommand('/retry', state);

    expect(result.handled).toBe(false);
    expect(result.retry).toBe(true);
    expect(messages).toHaveLength(1); // only user message remains
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!.content).toBe('Fix the bug');
  });

  it('preserves earlier conversation turns', async () => {
    const messages: Message[] = [
      userMsg('Hello'),
      assistantMsg('Hi there!'),
      userMsg('Fix the bug'),          // lastHumanInputIdx = 2
      assistantMsg('Done, fixed it.'),
    ];
    const state = mockState(messages, 2);

    await handleInlineCommand('/retry', state);

    expect(messages).toHaveLength(3); // first turn + last user msg
    expect(messages[0]!.content).toBe('Hello');
    expect(messages[2]!.content).toBe('Fix the bug');
  });
});

describe('/retry — tool chains', () => {
  it('pops entire tool chain after the human input', async () => {
    const messages: Message[] = [
      userMsg('Read test.ts'),           // idx 0 = lastHumanInputIdx
      assistantToolUse(),                // idx 1
      userToolResult(),                  // idx 2 (synthetic tool_result)
      assistantMsg('File contents...'),  // idx 3
    ];
    const state = mockState(messages, 0);

    const result = await handleInlineCommand('/retry', state);

    expect(result.retry).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe('Read test.ts');
  });

  it('pops multi-round tool chain', async () => {
    const messages: Message[] = [
      userMsg('Fix and test'),            // idx 0
      assistantToolUse(),                 // idx 1 (Edit)
      userToolResult(),                   // idx 2
      assistantToolUse(),                 // idx 3 (Bash)
      userToolResult(),                   // idx 4
      assistantMsg('All done.'),          // idx 5
    ];
    const state = mockState(messages, 0);

    await handleInlineCommand('/retry', state);

    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe('Fix and test');
  });
});

describe('/retry — synthetic messages', () => {
  it('pops reflection + continuation prompts injected by runLoop', async () => {
    const messages: Message[] = [
      userMsg('Complex task'),             // idx 0 = lastHumanInputIdx
      assistantToolUse(),                  // idx 1
      userToolResult(),                    // idx 2
      syntheticReflection(),               // idx 3 — injected by loop
      assistantMsg('After reflection...'), // idx 4
      syntheticContinuation(),             // idx 5 — injected by loop
      assistantMsg('...continued'),        // idx 6
    ];
    const state = mockState(messages, 0);

    await handleInlineCommand('/retry', state);

    // Only the original human input should remain
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe('Complex task');
  });

  it('pops loop detection warnings injected by runLoop', async () => {
    const messages: Message[] = [
      userMsg('Fix it'),                   // idx 0
      assistantToolUse(),                  // idx 1
      userToolResult(),                    // idx 2
      assistantToolUse(),                  // idx 3 (same tool again)
      userToolResult(),                    // idx 4
      assistantToolUse(),                  // idx 5 (same tool 3rd time)
      userToolResult(),                    // idx 6
      syntheticLoopDetect(),               // idx 7 — injected by loop
      assistantMsg('Changed approach'),    // idx 8
    ];
    const state = mockState(messages, 0);

    await handleInlineCommand('/retry', state);

    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe('Fix it');
  });
});

describe('/retry — edge cases', () => {
  it('errors on empty conversation', async () => {
    const messages: Message[] = [];
    const state = mockState(messages, -1);

    const result = await handleInlineCommand('/retry', state);

    expect(result.handled).toBe(true);
    expect(result.retry).toBeUndefined();
    expect(messages).toHaveLength(0);
  });

  it('errors when last message is user (no assistant response)', async () => {
    const messages: Message[] = [userMsg('Hello')];
    const state = mockState(messages, 0);

    const result = await handleInlineCommand('/retry', state);

    expect(result.handled).toBe(true);
    expect(result.retry).toBeUndefined();
    expect(messages).toHaveLength(1);
  });

  it('errors when lastHumanInputIdx is stale (after /resume)', async () => {
    const messages: Message[] = [
      userMsg('Resumed session input'),
      assistantMsg('Response'),
    ];
    // lastHumanInputIdx = -1 (reset by /resume)
    const state = mockState(messages, -1);

    const result = await handleInlineCommand('/retry', state);

    expect(result.handled).toBe(true);
    expect(messages).toHaveLength(2); // unchanged
  });

  it('handles @file-expanded user messages (array content without tool_result)', async () => {
    const messages: Message[] = [
      // @file expansion produces array content with text blocks
      {
        role: 'user',
        content: 'Fix the bug in <file path="test.ts">const x = 1;</file>',
      },
      assistantMsg('Fixed.'),
    ];
    const state = mockState(messages, 0);

    const result = await handleInlineCommand('/retry', state);

    expect(result.retry).toBe(true);
    expect(messages).toHaveLength(1);
  });
});
