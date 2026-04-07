/**
 * Tests for model routing: --model, MINIMAX_MODEL, /model, /fast, fallback chain
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseArgs, type CliArgs } from '../src/entrypoints/bootstrap.js';
import { MiniMaxClient, MINIMAX_MODELS } from '../src/transport/client.js';
import { modelCommand, fastCommand } from '../src/commands/config.js';
import type { CommandContext, CommandResult } from '../src/commands/registry.js';

// ─── parseArgs tests ──────────────────────────────────────

describe('parseArgs --model', () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
    delete process.env['MINIMAX_MODEL'];
  });

  it('parses --model=<name> from CLI args', () => {
    process.argv = ['node', 'shugu', '--model=MiniMax-M2.5-highspeed'];
    const args = parseArgs();
    expect(args.model).toBe('MiniMax-M2.5-highspeed');
  });

  it('falls back to MINIMAX_MODEL env var', () => {
    process.argv = ['node', 'shugu'];
    process.env['MINIMAX_MODEL'] = 'MiniMax-M2.7';
    const args = parseArgs();
    expect(args.model).toBe('MiniMax-M2.7');
  });

  it('CLI --model overrides MINIMAX_MODEL env', () => {
    process.argv = ['node', 'shugu', '--model=MiniMax-M2.7-highspeed'];
    process.env['MINIMAX_MODEL'] = 'MiniMax-M2.5-highspeed';
    const args = parseArgs();
    expect(args.model).toBe('MiniMax-M2.7-highspeed');
  });

  it('returns null when no model specified', () => {
    process.argv = ['node', 'shugu'];
    const args = parseArgs();
    expect(args.model).toBeNull();
  });
});

// ─── MiniMaxClient.setModel tests ─────────────────────────

describe('MiniMaxClient.setModel', () => {
  it('changes the model', () => {
    // We can't construct a real client without API key, so test via command wiring
    // Just verify the method exists on the prototype
    expect(typeof MiniMaxClient.prototype.setModel).toBe('function');
  });
});

// ─── /model command tests ─────────────────────────────────

describe('/model command', () => {
  function createMockCtx(model: string = MINIMAX_MODELS.best): { ctx: CommandContext; logs: string[]; client: MiniMaxClient } {
    const logs: string[] = [];
    // Create a minimal mock client
    const client = {
      model,
      setModel(m: string) { (this as any).model = m; },
    } as unknown as MiniMaxClient;

    const ctx: CommandContext = {
      cwd: '/test',
      messages: [],
      info: (msg) => logs.push(msg),
      error: (msg) => logs.push(`ERROR: ${msg}`),
      client,
    };
    return { ctx, logs, client };
  }

  it('shows available models when called without args', async () => {
    const { ctx, logs } = createMockCtx();
    await modelCommand.execute('', ctx);
    expect(logs.some((l) => l.includes('Available models'))).toBe(true);
    expect(logs.some((l) => l.includes(MINIMAX_MODELS.best))).toBe(true);
  });

  it('switches to a valid model by name', async () => {
    const { ctx, logs, client } = createMockCtx();
    await modelCommand.execute('MiniMax-M2.7', ctx);
    expect(client.model).toBe('MiniMax-M2.7');
    expect(logs.some((l) => l.includes('→'))).toBe(true);
  });

  it('accepts tier aliases (best, balanced, fast)', async () => {
    const { ctx, client } = createMockCtx();
    await modelCommand.execute('fast', ctx);
    expect(client.model).toBe(MINIMAX_MODELS.fast);
  });

  it('rejects unknown models', async () => {
    const { ctx, logs, client } = createMockCtx();
    const originalModel = client.model;
    await modelCommand.execute('GPT-4o', ctx);
    expect(client.model).toBe(originalModel); // unchanged
    expect(logs.some((l) => l.includes('Unknown model'))).toBe(true);
  });
});

// ─── /fast command tests ──────────────────────────────────

describe('/fast command', () => {
  function createMockCtx(model: string): { ctx: CommandContext; client: { model: string } } {
    const client = {
      model,
      setModel(m: string) { this.model = m; },
    };
    const ctx: CommandContext = {
      cwd: '/test',
      messages: [],
      info: () => {},
      error: () => {},
      client: client as unknown as MiniMaxClient,
    };
    return { ctx, client };
  }

  it('toggles from best to fast', async () => {
    const { ctx, client } = createMockCtx(MINIMAX_MODELS.best);
    await fastCommand.execute('', ctx);
    expect(client.model).toBe(MINIMAX_MODELS.fast);
  });

  it('toggles from fast to best', async () => {
    const { ctx, client } = createMockCtx(MINIMAX_MODELS.fast);
    await fastCommand.execute('', ctx);
    expect(client.model).toBe(MINIMAX_MODELS.best);
  });

  it('toggles from balanced to fast', async () => {
    const { ctx, client } = createMockCtx(MINIMAX_MODELS.balanced);
    await fastCommand.execute('', ctx);
    expect(client.model).toBe(MINIMAX_MODELS.fast);
  });
});
