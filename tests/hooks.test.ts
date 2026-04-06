/**
 * Tests for Layer 14 — Plugins: Hook system
 */

import { describe, it, expect } from 'vitest';
import {
  HookRegistry,
  type PreToolUsePayload,
  type PostToolUsePayload,
  type HookHandler,
} from '../src/plugins/hooks.js';

describe('HookRegistry: PreToolUse', () => {
  it('proceeds when no hooks registered', async () => {
    const registry = new HookRegistry();
    const result = await registry.runPreToolUse({
      tool: 'Bash',
      call: { id: 'x', name: 'Bash', input: { command: 'ls' } },
    });
    expect(result.proceed).toBe(true);
  });

  it('allows hooks to block execution', async () => {
    const registry = new HookRegistry();
    registry.register({
      type: 'PreToolUse',
      pluginName: 'safety',
      priority: 0,
      handler: async (payload: PreToolUsePayload) => {
        if ((payload.call.input as Record<string, string>).command?.includes('rm -rf')) {
          return { proceed: false, blockReason: 'Dangerous command blocked' };
        }
        return { proceed: true };
      },
    });

    const safe = await registry.runPreToolUse({
      tool: 'Bash',
      call: { id: 'x', name: 'Bash', input: { command: 'ls' } },
    });
    expect(safe.proceed).toBe(true);

    const dangerous = await registry.runPreToolUse({
      tool: 'Bash',
      call: { id: 'x', name: 'Bash', input: { command: 'rm -rf /' } },
    });
    expect(dangerous.proceed).toBe(false);
    expect(dangerous.blockReason).toBe('Dangerous command blocked');
  });

  it('allows hooks to modify tool calls', async () => {
    const registry = new HookRegistry();
    registry.register({
      type: 'PreToolUse',
      pluginName: 'modifier',
      priority: 0,
      handler: async (payload: PreToolUsePayload) => ({
        proceed: true,
        modifiedCall: {
          ...payload.call,
          input: { ...payload.call.input, modified: true },
        },
      }),
    });

    const result = await registry.runPreToolUse({
      tool: 'Bash',
      call: { id: 'x', name: 'Bash', input: { command: 'ls' } },
    });

    expect(result.proceed).toBe(true);
    expect((result.modifiedCall as Record<string, unknown>).input).toHaveProperty('modified', true);
  });

  it('runs hooks in priority order', async () => {
    const registry = new HookRegistry();
    const order: string[] = [];

    registry.register({
      type: 'PreToolUse',
      pluginName: 'second',
      priority: 20,
      handler: async () => { order.push('second'); return { proceed: true }; },
    });

    registry.register({
      type: 'PreToolUse',
      pluginName: 'first',
      priority: 10,
      handler: async () => { order.push('first'); return { proceed: true }; },
    });

    registry.register({
      type: 'PreToolUse',
      pluginName: 'third',
      priority: 30,
      handler: async () => { order.push('third'); return { proceed: true }; },
    });

    await registry.runPreToolUse({
      tool: 'Bash',
      call: { id: 'x', name: 'Bash', input: {} },
    });

    expect(order).toEqual(['first', 'second', 'third']);
  });
});

describe('HookRegistry: PostToolUse', () => {
  it('allows hooks to modify results', async () => {
    const registry = new HookRegistry();
    registry.register({
      type: 'PostToolUse',
      pluginName: 'enricher',
      priority: 0,
      handler: async (payload: PostToolUsePayload) => ({
        modifiedResult: {
          ...payload.result,
          content: payload.result.content + '\n[enriched by plugin]',
        },
      }),
    });

    const result = await registry.runPostToolUse({
      tool: 'Bash',
      call: { id: 'x', name: 'Bash', input: {} },
      result: { tool_use_id: 'x', content: 'original output' },
      durationMs: 100,
    });

    expect(result.modifiedResult!.content).toBe('original output\n[enriched by plugin]');
  });
});

describe('HookRegistry: unregister', () => {
  it('removes all hooks from a plugin', async () => {
    const registry = new HookRegistry();

    registry.register({
      type: 'PreToolUse',
      pluginName: 'my-plugin',
      priority: 0,
      handler: async () => ({ proceed: false, blockReason: 'blocked' }),
    });

    // Before unregister: should block
    const before = await registry.runPreToolUse({
      tool: 'Bash',
      call: { id: 'x', name: 'Bash', input: {} },
    });
    expect(before.proceed).toBe(false);

    // Unregister
    registry.unregisterPlugin('my-plugin');

    // After unregister: should proceed
    const after = await registry.runPreToolUse({
      tool: 'Bash',
      call: { id: 'x', name: 'Bash', input: {} },
    });
    expect(after.proceed).toBe(true);
  });
});

describe('HookRegistry: error handling', () => {
  it('continues after a hook throws', async () => {
    const registry = new HookRegistry();

    registry.register({
      type: 'PreToolUse',
      pluginName: 'crashy',
      priority: 0,
      handler: async () => { throw new Error('plugin crash'); },
    });

    // Should not throw, should default to proceed
    const result = await registry.runPreToolUse({
      tool: 'Bash',
      call: { id: 'x', name: 'Bash', input: {} },
    });
    expect(result.proceed).toBe(true);
  });
});
