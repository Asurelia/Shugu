/**
 * Tests for BashTool denylist enforcement via ToolContext.bashDenylist.
 * Part of the socratic-agent plan (Task 2).
 */

import { describe, it, expect } from 'vitest';
import { BashTool } from '../src/tools/bash/BashTool.js';
import type { ToolCall, ToolContext } from '../src/protocol/tools.js';

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ac = new AbortController();
  return {
    cwd: process.cwd(),
    abortSignal: ac.signal,
    permissionMode: 'default',
    askPermission: async () => true,
    ...overrides,
  };
}

function call(command: string): ToolCall {
  return { id: 'c1', name: 'Bash', input: { command } };
}

describe('BashTool denylist', () => {
  it('blocks a command matching a denylist pattern', async () => {
    const tool = new BashTool();
    const result = await tool.execute(
      call('git reset --hard HEAD'),
      ctx({ bashDenylist: [/^git\s+(reset|push|checkout\s+--)/] }),
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toMatch(/blocked by denylist/i);
    expect(result.content).toContain('git reset');
  });

  it('allows a command not matching any pattern', async () => {
    const tool = new BashTool();
    const result = await tool.execute(
      call('echo safe-read-only'),
      ctx({ bashDenylist: [/^git\s+(reset|push)/] }),
    );
    expect(result.is_error).toBe(false);
    expect(result.content).toContain('safe-read-only');
  });

  it('is a no-op when bashDenylist is undefined', async () => {
    const tool = new BashTool();
    const result = await tool.execute(call('echo ok'), ctx());
    expect(result.content).toContain('ok');
  });
});
