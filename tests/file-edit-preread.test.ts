import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadTracker } from '../src/context/read-tracker.js';
import { FileReadTool } from '../src/tools/files/FileReadTool.js';
import { FileEditTool } from '../src/tools/files/FileEditTool.js';
import type { ToolContext, ToolCall } from '../src/protocol/tools.js';

let tempDir: string;
let readTool: FileReadTool;
let editTool: FileEditTool;
let tracker: ReadTracker;

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: tempDir,
    abortSignal: new AbortController().signal,
    permissionMode: 'fullAuto',
    askPermission: async () => true,
    readTracker: tracker,
    ...overrides,
  };
}

function makeCall(name: string, input: Record<string, unknown>, id = 'test-1'): ToolCall {
  return { id, name, input };
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'preread-test-'));
  readTool = new FileReadTool();
  editTool = new FileEditTool();
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  tracker = new ReadTracker();
});

describe('FileEdit pre-read enforcement', () => {
  it('Edit without prior Read (with readTracker) returns error', async () => {
    const filePath = join(tempDir, 'no-read.txt');
    await writeFile(filePath, 'original content');

    const ctx = makeContext();
    const result = await editTool.execute(
      makeCall('Edit', {
        file_path: filePath,
        old_string: 'original',
        new_string: 'modified',
      }),
      ctx,
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain('Read tool');

    // File should be unchanged
    const disk = await readFile(filePath, 'utf-8');
    expect(disk).toBe('original content');
  });

  it('Read then Edit same file succeeds', async () => {
    const filePath = join(tempDir, 'read-then-edit.txt');
    await writeFile(filePath, 'hello world');

    const ctx = makeContext();

    // Read the file first
    const readResult = await readTool.execute(
      makeCall('Read', { file_path: filePath }),
      ctx,
    );
    expect(readResult.is_error).toBeUndefined();

    // Now edit should succeed
    const editResult = await editTool.execute(
      makeCall('Edit', {
        file_path: filePath,
        old_string: 'hello',
        new_string: 'goodbye',
      }),
      ctx,
    );
    expect(editResult.is_error).toBeUndefined();

    const disk = await readFile(filePath, 'utf-8');
    expect(disk).toBe('goodbye world');
  });

  it('Read file A, Edit file B returns error', async () => {
    const fileA = join(tempDir, 'file-a.txt');
    const fileB = join(tempDir, 'file-b.txt');
    await writeFile(fileA, 'content A');
    await writeFile(fileB, 'content B');

    const ctx = makeContext();

    // Read file A
    await readTool.execute(
      makeCall('Read', { file_path: fileA }),
      ctx,
    );

    // Try to edit file B (not read)
    const result = await editTool.execute(
      makeCall('Edit', {
        file_path: fileB,
        old_string: 'content B',
        new_string: 'modified B',
      }),
      ctx,
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain('Read tool');

    // File B should be unchanged
    const disk = await readFile(fileB, 'utf-8');
    expect(disk).toBe('content B');
  });

  it('bypass mode skips the pre-read check', async () => {
    const filePath = join(tempDir, 'bypass.txt');
    await writeFile(filePath, 'bypass content');

    const ctx = makeContext({ permissionMode: 'bypass' });

    // Edit without reading — should succeed in bypass mode
    const result = await editTool.execute(
      makeCall('Edit', {
        file_path: filePath,
        old_string: 'bypass',
        new_string: 'overridden',
      }),
      ctx,
    );

    expect(result.is_error).toBeUndefined();

    const disk = await readFile(filePath, 'utf-8');
    expect(disk).toBe('overridden content');
  });

  it('no readTracker present (sub-agent compat) allows Edit without Read', async () => {
    const filePath = join(tempDir, 'no-tracker.txt');
    await writeFile(filePath, 'sub-agent content');

    // Context without readTracker
    const ctx = makeContext({ readTracker: undefined });

    const result = await editTool.execute(
      makeCall('Edit', {
        file_path: filePath,
        old_string: 'sub-agent',
        new_string: 'free-edit',
      }),
      ctx,
    );

    expect(result.is_error).toBeUndefined();

    const disk = await readFile(filePath, 'utf-8');
    expect(disk).toBe('free-edit content');
  });
});

describe('ReadTracker unit', () => {
  it('tracks reads correctly', () => {
    const t = new ReadTracker();
    expect(t.hasRead('/some/file.ts')).toBe(false);

    t.markRead('/some/file.ts');
    expect(t.hasRead('/some/file.ts')).toBe(true);
    expect(t.hasRead('/other/file.ts')).toBe(false);
  });

  it('getReadFiles returns all tracked paths', () => {
    const t = new ReadTracker();
    t.markRead('/a.ts');
    t.markRead('/b.ts');

    const files = t.getReadFiles();
    expect(files.size).toBe(2);
    expect(files.has('/a.ts')).toBe(true);
    expect(files.has('/b.ts')).toBe(true);
  });
});
