/**
 * Tests for Phase 5 — /batch command: JSON extraction, path normalization,
 * overlap detection, command factory.
 */

import { describe, it, expect, vi } from 'vitest';
import { extractJSON, normalizeFilePaths, detectOverlap, createBatchCommand, type BatchUnit } from '../src/commands/batch.js';
import type { AgentOrchestrator } from '../src/agents/orchestrator.js';
import type { MiniMaxClient } from '../src/transport/client.js';
import type { CommandContext } from '../src/commands/registry.js';

// ─── extractJSON ─────────────────────────────────────────

describe('extractJSON', () => {
  it('parses valid JSON directly', () => {
    const input = JSON.stringify({ units: [{ name: 'a', description: 'do a', files: ['src/a.ts'] }] });
    const result = extractJSON<{ units: unknown[] }>(input);
    expect(result.data).not.toBeNull();
    expect(result.data!.units).toHaveLength(1);
    expect(result.error).toBeUndefined();
  });

  it('strips ```json fences and parses', () => {
    const inner = JSON.stringify({ units: [{ name: 'b', description: 'do b', files: [] }] });
    const input = `\`\`\`json\n${inner}\n\`\`\``;
    const result = extractJSON<{ units: unknown[] }>(input);
    expect(result.data).not.toBeNull();
    expect(result.data!.units).toHaveLength(1);
  });

  it('strips plain ``` fences and parses', () => {
    const inner = JSON.stringify({ units: [] });
    const input = `\`\`\`\n${inner}\n\`\`\``;
    const result = extractJSON<{ units: unknown[] }>(input);
    expect(result.data).not.toBeNull();
    expect(Array.isArray(result.data!.units)).toBe(true);
  });

  it('extracts JSON block from preamble text', () => {
    const inner = JSON.stringify({ units: [{ name: 'c', description: 'do c', files: ['src/c.ts'] }] });
    const input = `Here's the plan:\n${inner}`;
    const result = extractJSON<{ units: unknown[] }>(input);
    expect(result.data).not.toBeNull();
    expect(result.data!.units).toHaveLength(1);
  });

  it('returns error for completely broken input', () => {
    const result = extractJSON('not json at all');
    expect(result.data).toBeNull();
    expect(result.error).toBeDefined();
    expect(result.error).toContain('Could not extract JSON');
  });

  it('returns error for empty input', () => {
    const result = extractJSON('');
    expect(result.data).toBeNull();
    expect(result.error).toBeDefined();
  });
});

// ─── normalizeFilePaths ──────────────────────────────────

describe('normalizeFilePaths', () => {
  it('preserves forward slashes on POSIX', () => {
    const cwd = '/home/user/project';
    const files = ['src/a.ts'];
    const result = normalizeFilePaths(files, cwd);
    expect(result[0]).not.toContain('\\');
    expect(result[0]).toContain('/');
  });

  it('normalizes backslashes to forward slashes', () => {
    const cwd = '/home/user/project';
    const files = ['src\\a.ts'];
    const result = normalizeFilePaths(files, cwd);
    expect(result[0]).not.toContain('\\');
  });

  it('resolves relative paths against cwd', () => {
    const cwd = '/home/user/project';
    const files = ['./src/a.ts'];
    const result = normalizeFilePaths(files, cwd);
    expect(result[0]).toContain('src');
    expect(result[0]).toContain('a.ts');
    // Must be absolute (starts with / or drive letter on Windows)
    expect(result[0].length).toBeGreaterThan(files[0]!.length);
  });

  it('resolves multiple files', () => {
    const cwd = '/home/user/project';
    const files = ['src/a.ts', 'src/b.ts'];
    const result = normalizeFilePaths(files, cwd);
    expect(result).toHaveLength(2);
  });
});

// ─── detectOverlap ───────────────────────────────────────

describe('detectOverlap', () => {
  const cwd = '/home/user/project';

  it('returns empty array when no overlap', () => {
    const units: BatchUnit[] = [
      { name: 'unit-a', description: 'A', files: ['src/a.ts'] },
      { name: 'unit-b', description: 'B', files: ['src/b.ts'] },
    ];
    const result = detectOverlap(units, cwd);
    expect(result).toHaveLength(0);
  });

  it('reports overlap when two units share a file', () => {
    const units: BatchUnit[] = [
      { name: 'unit-a', description: 'A', files: ['src/shared.ts'] },
      { name: 'unit-b', description: 'B', files: ['src/shared.ts'] },
    ];
    const result = detectOverlap(units, cwd);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toContain('unit-a');
    expect(result[0]).toContain('unit-b');
  });

  it('handles units with no files without overlap', () => {
    const units: BatchUnit[] = [
      { name: 'unit-a', description: 'A', files: [] },
      { name: 'unit-b', description: 'B', files: [] },
    ];
    const result = detectOverlap(units, cwd);
    expect(result).toHaveLength(0);
  });

  it('does not report overlap for different files', () => {
    const units: BatchUnit[] = [
      { name: 'unit-a', description: 'A', files: ['src/foo.ts', 'src/bar.ts'] },
      { name: 'unit-b', description: 'B', files: ['src/baz.ts', 'src/qux.ts'] },
    ];
    const result = detectOverlap(units, cwd);
    expect(result).toHaveLength(0);
  });
});

// ─── createBatchCommand ──────────────────────────────────

describe('createBatchCommand', () => {
  const makeCtx = (): CommandContext => ({
    cwd: '/home/user/project',
    messages: [],
    info: vi.fn(),
    error: vi.fn(),
  });

  const mockOrchestrator = {} as unknown as AgentOrchestrator;
  const mockClient = {} as unknown as MiniMaxClient;

  it('returns a Command with name "batch"', () => {
    const cmd = createBatchCommand(mockOrchestrator, mockClient, '/home/user/project');
    expect(cmd.name).toBe('batch');
    expect(typeof cmd.execute).toBe('function');
  });

  it('returns error for empty args', async () => {
    const cmd = createBatchCommand(mockOrchestrator, mockClient, '/home/user/project');
    const result = await cmd.execute('', makeCtx());
    expect(result.type).toBe('error');
    expect((result as { type: 'error'; message: string }).message).toContain('Usage');
  });

  it('returns error for whitespace-only args', async () => {
    const cmd = createBatchCommand(mockOrchestrator, mockClient, '/home/user/project');
    const result = await cmd.execute('   ', makeCtx());
    expect(result.type).toBe('error');
  });

  it('"status" subcommand returns handled with no pending units', async () => {
    const cmd = createBatchCommand(mockOrchestrator, mockClient, '/home/user/project');
    const ctx = makeCtx();
    const result = await cmd.execute('status', ctx);
    expect(result.type).toBe('handled');
    expect(ctx.info).toHaveBeenCalled();
  });

  it('has usage property', () => {
    const cmd = createBatchCommand(mockOrchestrator, mockClient, '/home/user/project');
    expect(cmd.usage).toBeDefined();
    expect(cmd.usage).toContain('/batch');
  });
});
