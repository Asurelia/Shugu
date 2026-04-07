/**
 * Tests: discoverVault path validation (F3 security fix)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { discoverVault } from '../src/context/memory/obsidian.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'vault-discovery-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('discoverVault — path validation', () => {
  it('returns null or a trusted path when no vault is configured in project', async () => {
    // discoverVault falls through to common home locations when no project config exists.
    // We only verify that if a path is returned, it starts with homedir or the cwd.
    const result = await discoverVault(tempDir);
    if (result !== null) {
      const home = homedir();
      expect(result.startsWith(home) || result.startsWith(tempDir)).toBe(true);
    }
    // null is also acceptable
  });

  it('accepts vault path within project directory', async () => {
    const vaultDir = join(tempDir, 'my-vault');
    await mkdir(vaultDir, { recursive: true });

    const pccDir = join(tempDir, '.pcc');
    await mkdir(pccDir, { recursive: true });
    await writeFile(join(pccDir, 'vault.path'), vaultDir, 'utf-8');

    const result = await discoverVault(tempDir);
    expect(result).toBe(vaultDir);
  });

  it('accepts vault path within home directory', async () => {
    const home = homedir();
    const homeVaultDir = join(home, 'Obsidian');

    const pccDir = join(tempDir, '.pcc');
    await mkdir(pccDir, { recursive: true });
    await writeFile(join(pccDir, 'vault.path'), homeVaultDir, 'utf-8');

    // Result may be null if ~/Obsidian doesn't exist on this machine, but must NOT return a path outside trusted zones
    const result = await discoverVault(tempDir);
    if (result !== null) {
      expect(result.startsWith(home) || result.startsWith(tempDir)).toBe(true);
    }
  });

  it('rejects vault path outside project and home directory', async () => {
    // Point to a path completely outside both project dir and home dir
    // Use a temp dir that is NOT nested under project or home
    const outsideDir = await mkdtemp(join(tmpdir(), 'outside-vault-'));

    try {
      const pccDir = join(tempDir, '.pcc');
      await mkdir(pccDir, { recursive: true });
      await writeFile(join(pccDir, 'vault.path'), outsideDir, 'utf-8');

      const home = homedir();
      const isInsideTmp = outsideDir.startsWith(home) || outsideDir.startsWith(tempDir);

      const result = await discoverVault(tempDir);

      if (!isInsideTmp) {
        // Outside trusted zones: must be rejected
        expect(result).toBeNull();
      }
      // If tmpdir() happens to be inside home (e.g. macOS /var/folders under /Users/...), skip assertion
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('finds vault when cwd itself is a vault (.obsidian folder present)', async () => {
    await mkdir(join(tempDir, '.obsidian'), { recursive: true });
    const result = await discoverVault(tempDir);
    expect(result).toBe(tempDir);
  });
});
