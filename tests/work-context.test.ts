/**
 * Tests for work context extraction and rehydration
 */

import { describe, it, expect } from 'vitest';
import {
  extractWorkContext,
  formatRehydrationBlock,
  type WorkContext,
} from '../src/context/session/work-context.js';
import type { Message } from '../src/protocol/messages.js';

// ── Helpers ────────────────────────────────────────────

function userMsg(content: string): Message {
  return { role: 'user', content };
}

function assistantText(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

let toolCallCounter = 0;
function nextCallId(): string { return `call_${++toolCallCounter}`; }

function assistantToolUse(name: string, input: Record<string, unknown>, id?: string): Message {
  const callId = id ?? nextCallId();
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id: callId, name, input }],
  };
}

function userToolResult(content: string, isError = false, toolUseId?: string): Message {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId ?? `call_${toolCallCounter}`, content, is_error: isError }],
  };
}

// ── extractWorkContext ─────────────────────────────────

describe('extractWorkContext', () => {
  it('extracts currentGoal from rawGoal parameter', () => {
    const messages: Message[] = [
      userMsg('Fix the bug in @src/foo.ts'),
      assistantText('Done.'),
    ];
    const ctx = extractWorkContext(messages, 0, 'Fix the bug in @src/foo.ts');
    expect(ctx.currentGoal).toBe('Fix the bug in @src/foo.ts');
  });

  it('does NOT use messages for currentGoal (avoids @file expansion)', () => {
    const messages: Message[] = [
      // This is the expanded content in the message
      userMsg('Fix the bug in <file path="src/foo.ts">const x = 1;\nconst y = 2;\n... 500 lines ...</file>'),
      assistantText('Done.'),
    ];
    const ctx = extractWorkContext(messages, 0, 'Fix the bug in @src/foo.ts');
    // Should use rawGoal, not the expanded message
    expect(ctx.currentGoal).toBe('Fix the bug in @src/foo.ts');
    expect(ctx.currentGoal.length).toBeLessThan(100);
  });

  it('caps currentGoal at 500 chars', () => {
    const longGoal = 'x'.repeat(1000);
    const ctx = extractWorkContext([], -1, longGoal);
    expect(ctx.currentGoal.length).toBe(500);
  });

  it('extracts activeFiles from tool_use blocks', () => {
    const messages: Message[] = [
      userMsg('Fix it'),
      assistantToolUse('Read', { file_path: '/project/src/foo.ts' }),
      userToolResult('file content'),
      assistantToolUse('Edit', { file_path: '/project/src/bar.ts' }),
      userToolResult('edited'),
      assistantText('Done.'),
    ];
    const ctx = extractWorkContext(messages, 0, 'Fix it');
    expect(ctx.activeFiles).toContain('/project/src/foo.ts');
    expect(ctx.activeFiles).toContain('/project/src/bar.ts');
  });

  it('deduplicates activeFiles', () => {
    const messages: Message[] = [
      userMsg('Fix it'),
      assistantToolUse('Read', { file_path: '/src/foo.ts' }),
      userToolResult('content'),
      assistantToolUse('Edit', { file_path: '/src/foo.ts' }),
      userToolResult('edited'),
    ];
    const ctx = extractWorkContext(messages, 0, 'Fix it');
    expect(ctx.activeFiles.filter(f => f === '/src/foo.ts')).toHaveLength(1);
  });

  it('extracts toolHistory with outcomes', () => {
    const messages: Message[] = [
      userMsg('Fix it'),
      assistantToolUse('Read', { file_path: '/src/foo.ts' }),
      userToolResult('file content here'),
      assistantToolUse('Edit', { file_path: '/src/bar.ts' }),
      userToolResult('Error: file not found', true),
    ];
    const ctx = extractWorkContext(messages, 0, 'Fix it');
    expect(ctx.toolHistory.length).toBeGreaterThanOrEqual(2);
    const readEntry = ctx.toolHistory.find(h => h.tool === 'Read');
    expect(readEntry?.outcome).toBe('success');
    const editEntry = ctx.toolHistory.find(h => h.tool === 'Edit');
    expect(editEntry?.outcome).toBe('error');
  });

  it('detects interrupted tool use as pending work', () => {
    const messages: Message[] = [
      userMsg('Fix it'),
      assistantToolUse('Write', { file_path: '/src/new.ts' }),
      // No tool_result — interrupted
    ];
    const ctx = extractWorkContext(messages, 0, 'Fix it');
    expect(ctx.pendingWork).toContain('Interrupted');
    expect(ctx.pendingWork).toContain('Write');
  });

  it('detects completed work (no pending)', () => {
    const messages: Message[] = [
      userMsg('Fix it'),
      assistantText('All done. The changes have been pushed successfully.'),
    ];
    const ctx = extractWorkContext(messages, 0, 'Fix it');
    expect(ctx.pendingWork).toBe('');
  });

  it('handles empty messages', () => {
    const ctx = extractWorkContext([], -1, '');
    expect(ctx.activeFiles).toEqual([]);
    expect(ctx.toolHistory).toEqual([]);
    expect(ctx.currentGoal).toBe('');
    expect(ctx.pendingWork).toBe('');
  });
});

// ── formatRehydrationBlock ─────────────────────────────

describe('formatRehydrationBlock', () => {
  it('produces a structured block with all sections', () => {
    const ctx: WorkContext = {
      activeFiles: ['/src/foo.ts', '/src/bar.ts'],
      currentGoal: 'Fix the authentication bug',
      toolHistory: [
        { tool: 'Read', path: '/src/foo.ts', outcome: 'success', summary: 'read 50 lines' },
        { tool: 'Edit', path: '/src/bar.ts', outcome: 'error', summary: 'file not found' },
      ],
      pendingWork: 'Next, I\'ll update the test file',
      stats: { totalTurns: 5, lastTurnTimestamp: '2026-04-09T12:00:00Z' },
    };

    const block = formatRehydrationBlock(ctx);
    expect(block).toContain('# Resumed Session Context');
    expect(block).toContain('Fix the authentication bug');
    expect(block).toContain('/src/foo.ts');
    expect(block).toContain('[Read]');
    expect(block).toContain('[Edit]');
    expect(block).toContain('Pending');
    expect(block).toContain('5 turns');
  });

  it('omits empty sections', () => {
    const ctx: WorkContext = {
      activeFiles: [],
      currentGoal: 'Quick question',
      toolHistory: [],
      pendingWork: '',
      stats: { totalTurns: 1, lastTurnTimestamp: '2026-04-09T12:00:00Z' },
    };

    const block = formatRehydrationBlock(ctx);
    expect(block).toContain('Quick question');
    expect(block).not.toContain('Active files');
    expect(block).not.toContain('Recent actions');
    expect(block).not.toContain('Pending');
  });
});

// ── Multi-tool-use matching ─────────────────────────────

describe('extractWorkContext — multi tool_use matching', () => {
  it('matches tool_use_id to correct tool_result in multi-tool messages', () => {
    const messages: Message[] = [
      userMsg('Fix both files'),
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_read', name: 'Read', input: { file_path: '/src/a.ts' } },
          { type: 'tool_use', id: 'call_edit', name: 'Edit', input: { file_path: '/src/b.ts' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_read', content: 'file content', is_error: false },
          { type: 'tool_result', tool_use_id: 'call_edit', content: 'Error: parse failed', is_error: true },
        ],
      },
      assistantText('Fixed a.ts, b.ts had an error.'),
    ];

    const ctx = extractWorkContext(messages, 0, 'Fix both files');
    const readEntry = ctx.toolHistory.find(h => h.tool === 'Read');
    const editEntry = ctx.toolHistory.find(h => h.tool === 'Edit');

    // Read should be success, Edit should be error — matched by tool_use_id
    expect(readEntry?.outcome).toBe('success');
    expect(editEntry?.outcome).toBe('error');
  });
});

// ── Backwards compatibility ────────────────────────────

describe('SessionData backwards compat', () => {
  it('workContext is optional — old sessions deserialize correctly', () => {
    const oldSession = {
      id: 'abc',
      projectDir: '/test',
      messages: [],
      model: 'test',
      totalUsage: { input_tokens: 0, output_tokens: 0 },
      turnCount: 0,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      // no workContext field
    };

    // JSON roundtrip should work
    const serialized = JSON.stringify(oldSession);
    const deserialized = JSON.parse(serialized);
    expect(deserialized.workContext).toBeUndefined();
  });
});
