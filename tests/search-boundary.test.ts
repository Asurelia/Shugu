import { describe, it, expect } from 'vitest';
import { GlobTool } from '../src/tools/search/GlobTool.js';
import { GrepTool } from '../src/tools/search/GrepTool.js';
import type { ToolContext } from '../src/protocol/tools.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeContext(cwd: string, permissionMode: 'normal' | 'bypass' = 'normal'): ToolContext {
  return {
    cwd,
    permissionMode,
    sessionId: 'test',
  } as ToolContext;
}

describe('GlobTool workspace boundary', () => {
  it('rejects path traversal outside cwd in normal mode', async () => {
    const tool = new GlobTool();
    const result = await tool.execute(
      { id: 'g1', name: 'Glob', input: { pattern: '**/*.ts', path: '../../../etc' } },
      makeContext(join(tmpdir(), 'some-workspace')),
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toMatch(/Error:/);
  });

  it('allows same-dir glob (no path specified)', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'glob-test-'));
    try {
      const tool = new GlobTool();
      const result = await tool.execute(
        { id: 'g2', name: 'Glob', input: { pattern: '**/*.md' } },
        makeContext(tmpDir),
      );
      // No error — no path traversal, just an empty result
      expect(result.is_error).toBeFalsy();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('allows traversal in bypass mode', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'glob-bypass-'));
    try {
      const tool = new GlobTool();
      const result = await tool.execute(
        { id: 'g3', name: 'Glob', input: { pattern: '*.md', path: tmpDir } },
        makeContext(join(tmpdir(), 'workspace'), 'bypass'),
      );
      // Should not return a workspace rejection error
      expect(result.content).not.toMatch(/outside workspace/i);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('GrepTool workspace boundary', () => {
  it('rejects path traversal outside cwd in normal mode', async () => {
    const tool = new GrepTool();
    const result = await tool.execute(
      { id: 'r1', name: 'Grep', input: { pattern: 'hello', path: '../../../etc' } },
      makeContext(join(tmpdir(), 'some-workspace')),
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toMatch(/Error:/);
  });

  it('allows search without path (defaults to cwd)', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'grep-test-'));
    try {
      const tool = new GrepTool();
      const result = await tool.execute(
        { id: 'r2', name: 'Grep', input: { pattern: 'nonexistent_xyz_pattern_12345' } },
        makeContext(tmpDir),
      );
      expect(result.is_error).toBeFalsy();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('allows traversal in bypass mode', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'grep-bypass-'));
    try {
      const tool = new GrepTool();
      const result = await tool.execute(
        { id: 'r3', name: 'Grep', input: { pattern: 'hello', path: tmpDir } },
        makeContext(join(tmpdir(), 'workspace'), 'bypass'),
      );
      // No workspace rejection error
      expect(result.content).not.toMatch(/outside workspace/i);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }, 10000);
});
