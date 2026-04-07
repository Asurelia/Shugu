import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObsidianVault } from '../src/context/memory/obsidian.js';

let vaultDir: string;
let vault: ObsidianVault;

beforeAll(async () => {
  vaultDir = await mkdtemp(join(tmpdir(), 'obsidian-test-'));
  await mkdir(join(vaultDir, 'Notes'), { recursive: true });
  await writeFile(
    join(vaultDir, 'Notes', 'safe-note.md'),
    '---\ntitle: Safe Note\n---\n\nSafe content.',
    'utf-8',
  );
  vault = new ObsidianVault(vaultDir);
});

afterAll(async () => {
  await rm(vaultDir, { recursive: true, force: true });
});

describe('ObsidianVault path traversal protection', () => {
  it('readNote with traversal path returns null', async () => {
    const result = await vault.readNote('../../etc/passwd');
    expect(result).toBeNull();
  });

  it('readNote with deeply nested traversal returns null', async () => {
    const result = await vault.readNote('Notes/../../../secret.txt');
    expect(result).toBeNull();
  });

  it('readNote for valid note within vault works', async () => {
    const result = await vault.readNote('Notes/safe-note.md');
    expect(result).not.toBeNull();
    expect(result?.title).toBe('Safe Note');
  });

  it('createNote with traversal folder throws', async () => {
    await expect(
      vault.createNote('../../outside-folder', 'Evil Note', 'body'),
    ).rejects.toThrow(/path traversal/i);
  });

  it('updateNote with traversal path throws', async () => {
    await expect(
      vault.updateNote('../../outside-folder/evil.md', { body: 'pwned' }),
    ).rejects.toThrow(/path traversal/i);
  });

  it('deleteNote with traversal path throws', async () => {
    await expect(
      vault.deleteNote('../../outside-folder/evil.md'),
    ).rejects.toThrow(/path traversal/i);
  });

  it('createNote within vault creates the file', async () => {
    const relativePath = await vault.createNote('Notes', 'New Note', 'Hello world');
    expect(relativePath).toContain('Notes');
    expect(relativePath).toContain('new-note.md');
  });
});
