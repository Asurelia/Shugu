/**
 * Tests for Layer 7 — Commands: Registry and dispatch
 */

import { describe, it, expect } from 'vitest';
import { CommandRegistry, type Command, type CommandContext, type CommandResult } from '../src/commands/registry.js';

function createMockContext(): CommandContext {
  return {
    cwd: '/tmp/test',
    messages: [],
    info: () => {},
    error: () => {},
  };
}

describe('CommandRegistry', () => {
  it('registers and retrieves commands', () => {
    const registry = new CommandRegistry();
    const cmd: Command = {
      name: 'test',
      description: 'A test command',
      execute: async () => ({ type: 'handled' }),
    };

    registry.register(cmd);
    expect(registry.get('test')).toBe(cmd);
  });

  it('registers commands with aliases', () => {
    const registry = new CommandRegistry();
    const cmd: Command = {
      name: 'quit',
      aliases: ['exit', 'q'],
      description: 'Exit',
      execute: async () => ({ type: 'exit', reason: 'user' }),
    };

    registry.register(cmd);
    expect(registry.get('quit')).toBe(cmd);
    expect(registry.get('exit')).toBe(cmd);
    expect(registry.get('q')).toBe(cmd);
  });

  it('getAll deduplicates aliases', () => {
    const registry = new CommandRegistry();
    const cmd: Command = {
      name: 'help',
      aliases: ['h', '?'],
      description: 'Help',
      execute: async () => ({ type: 'handled' }),
    };

    registry.register(cmd);
    expect(registry.getAll()).toHaveLength(1);
  });

  it('returns undefined for unknown commands', () => {
    const registry = new CommandRegistry();
    expect(registry.get('nonexistent')).toBeUndefined();
  });
});

describe('CommandRegistry dispatch', () => {
  it('dispatches a slash command', async () => {
    const registry = new CommandRegistry();
    const cmd: Command = {
      name: 'test',
      description: 'Test',
      execute: async (args) => ({ type: 'prompt', prompt: `executed with: ${args}` }),
    };

    registry.register(cmd);
    const result = await registry.dispatch('/test hello world', createMockContext());
    expect(result).toEqual({ type: 'prompt', prompt: 'executed with: hello world' });
  });

  it('returns null for non-command input', async () => {
    const registry = new CommandRegistry();
    const result = await registry.dispatch('hello world', createMockContext());
    expect(result).toBeNull();
  });

  it('returns error for unknown commands', async () => {
    const registry = new CommandRegistry();
    const result = await registry.dispatch('/unknown', createMockContext());
    expect(result).not.toBeNull();
    expect(result!.type).toBe('error');
  });

  it('dispatches command with no args', async () => {
    const registry = new CommandRegistry();
    const cmd: Command = {
      name: 'clear',
      description: 'Clear',
      execute: async (args) => {
        expect(args).toBe('');
        return { type: 'clear' };
      },
    };

    registry.register(cmd);
    const result = await registry.dispatch('/clear', createMockContext());
    expect(result).toEqual({ type: 'clear' });
  });

  it('dispatches via alias', async () => {
    const registry = new CommandRegistry();
    const cmd: Command = {
      name: 'quit',
      aliases: ['q'],
      description: 'Quit',
      execute: async () => ({ type: 'exit', reason: 'user' }),
    };

    registry.register(cmd);
    const result = await registry.dispatch('/q', createMockContext());
    expect(result).toEqual({ type: 'exit', reason: 'user' });
  });
});
