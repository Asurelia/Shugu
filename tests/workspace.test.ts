import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateWorkspacePath } from '../src/policy/workspace.js';

let workspaceDir: string;

beforeAll(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), 'workspace-test-'));
  await mkdir(join(workspaceDir, 'subdir'), { recursive: true });
  await writeFile(join(workspaceDir, 'existing.txt'), 'hello');
  await writeFile(join(workspaceDir, 'subdir', 'nested.txt'), 'world');
});

afterAll(async () => {
  await rm(workspaceDir, { recursive: true, force: true });
});

describe('validateWorkspacePath', () => {
  it('normal relative path within workspace → valid', async () => {
    const result = await validateWorkspacePath('subdir/nested.txt', workspaceDir);
    expect(result.valid).toBe(true);
    expect(result.resolvedPath).toBeTruthy();
  });

  it('absolute path within workspace → valid', async () => {
    const absPath = join(workspaceDir, 'existing.txt');
    const result = await validateWorkspacePath(absPath, workspaceDir);
    expect(result.valid).toBe(true);
  });

  it('path traversal with ../ escaping workspace → invalid', async () => {
    const result = await validateWorkspacePath('../escape.txt', workspaceDir);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('deeply nested path traversal (../../..) → invalid', async () => {
    const result = await validateWorkspacePath('subdir/../../../etc/passwd', workspaceDir);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('path to existing file within workspace → valid', async () => {
    const result = await validateWorkspacePath('existing.txt', workspaceDir);
    expect(result.valid).toBe(true);
    expect(result.resolvedPath).toContain('existing.txt');
  });

  it('path for new file (does not exist yet) in valid parent → valid', async () => {
    const result = await validateWorkspacePath('subdir/newfile.txt', workspaceDir);
    expect(result.valid).toBe(true);
  });

  it('workspace root itself → valid', async () => {
    const result = await validateWorkspacePath('.', workspaceDir);
    expect(result.valid).toBe(true);
  });
});
