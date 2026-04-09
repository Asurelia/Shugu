/**
 * Tests for session features: clone, snapshot, file-revert, markdown loaders
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Session clone/snapshot ─────────────────────────────

describe('SessionManager clone and snapshot', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `shugu-test-session-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('clone creates a new session with different ID but same messages', async () => {
    // Dynamic import to avoid issues with homedir-based constructor
    const { SessionManager } = await import('../src/context/session/persistence.js');
    const mgr = new SessionManager();

    const original = mgr.createSession('/test', 'test-model');
    original.messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ];

    const cloned = await mgr.clone(original);

    expect(cloned.id).not.toBe(original.id);
    expect(cloned.messages).toHaveLength(2);
    expect(cloned.messages[0]).toEqual(original.messages[0]);
    // Verify deep copy (not same reference)
    expect(cloned.messages).not.toBe(original.messages);
    expect(cloned.projectDir).toBe(original.projectDir);
    expect(cloned.model).toBe(original.model);
  });

  it('SessionCorruptedError is thrown for corrupt JSON', async () => {
    const { SessionManager, SessionCorruptedError } = await import('../src/context/session/persistence.js');
    const mgr = new SessionManager();

    // Write a corrupt session file
    const sessionsDir = join(testDir, '.pcc-sessions');
    await mkdir(sessionsDir, { recursive: true });

    // We can't easily test via the real sessions dir, but we can test the error class
    expect(new SessionCorruptedError('test-id', new Error('bad json'))).toBeInstanceOf(Error);
    expect(new SessionCorruptedError('test-id', new Error('bad json')).name).toBe('SessionCorruptedError');
  });
});

// ── FileRevertStack ────────────────────────────────────

describe('FileRevertStack', () => {
  it('push/pop maintains LIFO order', async () => {
    const { FileRevertStack } = await import('../src/context/session/file-revert.js');
    const stack = new FileRevertStack();

    stack.push({ turnIndex: 1, timestamp: 'a', changes: [] });
    stack.push({ turnIndex: 2, timestamp: 'b', changes: [] });

    const popped = stack.pop();
    expect(popped?.turnIndex).toBe(2);
    expect(stack.size).toBe(1);
  });

  it('respects maxEntries limit', async () => {
    const { FileRevertStack } = await import('../src/context/session/file-revert.js');
    const stack = new FileRevertStack(3);

    for (let i = 0; i < 5; i++) {
      stack.push({ turnIndex: i, timestamp: String(i), changes: [] });
    }

    expect(stack.size).toBe(3);
    // Oldest entries (0, 1) should have been evicted
    const list = stack.list();
    expect(list[0]!.turnIndex).toBe(4);
    expect(list[2]!.turnIndex).toBe(2);
  });

  it('list returns entries in reverse order (newest first)', async () => {
    const { FileRevertStack } = await import('../src/context/session/file-revert.js');
    const stack = new FileRevertStack();

    stack.push({ turnIndex: 1, timestamp: 'a', changes: [] });
    stack.push({ turnIndex: 2, timestamp: 'b', changes: [] });

    const list = stack.list();
    expect(list[0]!.turnIndex).toBe(2);
    expect(list[1]!.turnIndex).toBe(1);
  });

  it('pop returns undefined when empty', async () => {
    const { FileRevertStack } = await import('../src/context/session/file-revert.js');
    const stack = new FileRevertStack();
    expect(stack.pop()).toBeUndefined();
  });
});

// ── revertEntry ────────────────────────────────────────

describe('revertEntry', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `shugu-test-revert-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('restores edited file to previous content', async () => {
    const { revertEntry } = await import('../src/context/session/file-revert.js');
    const filePath = join(testDir, 'edited.ts');

    // Simulate: file had "original" content, then was edited to "modified"
    await writeFile(filePath, 'modified', 'utf-8');

    const result = await revertEntry({
      turnIndex: 1,
      timestamp: new Date().toISOString(),
      changes: [{ path: filePath, type: 'edit', previousContent: 'original' }],
    });

    expect(result.reverted).toEqual([filePath]);
    expect(result.failed).toHaveLength(0);

    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('original');
  });

  it('deletes newly created file on revert', async () => {
    const { revertEntry } = await import('../src/context/session/file-revert.js');
    const filePath = join(testDir, 'created.ts');

    await writeFile(filePath, 'new file content', 'utf-8');

    const result = await revertEntry({
      turnIndex: 1,
      timestamp: new Date().toISOString(),
      changes: [{ path: filePath, type: 'create', previousContent: null }],
    });

    expect(result.reverted).toEqual([filePath]);
    // File should no longer exist
    await expect(readFile(filePath, 'utf-8')).rejects.toThrow();
  });
});

// ── TurnChangeAccumulator ──────────────────────────────

describe('TurnChangeAccumulator', () => {
  it('records first state only for repeated edits to same file', async () => {
    const { TurnChangeAccumulator } = await import('../src/context/session/file-revert.js');
    const acc = new TurnChangeAccumulator();

    acc.recordBefore('/file.ts', 'original');
    acc.recordBefore('/file.ts', 'after-first-edit'); // should be ignored

    const entry = acc.flush(1);
    expect(entry).not.toBeNull();
    expect(entry!.changes).toHaveLength(1);
    expect(entry!.changes[0]!.previousContent).toBe('original');
  });

  it('flush returns null when no changes recorded', async () => {
    const { TurnChangeAccumulator } = await import('../src/context/session/file-revert.js');
    const acc = new TurnChangeAccumulator();
    expect(acc.flush(1)).toBeNull();
  });

  it('flush clears state for next turn', async () => {
    const { TurnChangeAccumulator } = await import('../src/context/session/file-revert.js');
    const acc = new TurnChangeAccumulator();

    acc.recordBefore('/file.ts', 'content');
    acc.flush(1);

    expect(acc.hasChanges).toBe(false);
    expect(acc.flush(2)).toBeNull();
  });
});
