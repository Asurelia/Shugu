/**
 * Tests for Layer 5 — Credentials: Trust Store
 *
 * Covers the TOFU contract:
 *   - First-use prompt: unknown file → pending
 *   - Stable content: known hash → silent approve
 *   - Content change: hash mismatch → re-prompt
 *   - PCC_TRUST_ALL escape hatch
 *   - Headless (no onConfirm) drops pending silently
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkTrust,
  markTrusted,
  resolveTrust,
  hashContent,
  type DiscoveredFile,
} from '../src/credentials/trust-store.js';

let tmpRoot: string;
let storeFile: string;
let repoRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'trust-store-test-'));
  storeFile = join(tmpRoot, 'trusted-repos.json');
  repoRoot = join(tmpRoot, 'some-repo');
  await mkdir(repoRoot, { recursive: true });

  // Redirect the store to a per-test file
  process.env['PCC_TRUST_FILE'] = storeFile;
  delete process.env['PCC_TRUST_ALL'];
});

afterEach(async () => {
  delete process.env['PCC_TRUST_FILE'];
  delete process.env['PCC_TRUST_ALL'];
  await rm(tmpRoot, { recursive: true, force: true });
});

function discovered(relPath: string, content: string): DiscoveredFile {
  return {
    absPath: join(repoRoot, relPath),
    relPath,
    content,
  };
}

describe('hashContent', () => {
  it('produces stable SHA-256 hex', () => {
    const h1 = hashContent('hello');
    const h2 = hashContent('hello');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different content', () => {
    expect(hashContent('a')).not.toBe(hashContent('b'));
  });
});

describe('checkTrust', () => {
  it('returns all files as pending when no store exists', async () => {
    const files = [discovered('.pcc/commands/a.md', 'A')];
    const result = await checkTrust(repoRoot, files);
    expect(result.approved).toHaveLength(0);
    expect(result.pending).toHaveLength(1);
  });

  it('returns approved when hash matches store', async () => {
    const files = [discovered('.pcc/commands/a.md', 'A')];
    await markTrusted(repoRoot, files);

    const result = await checkTrust(repoRoot, files);
    expect(result.approved).toHaveLength(1);
    expect(result.pending).toHaveLength(0);
  });

  it('re-prompts when content changed (hash mismatch)', async () => {
    const original = [discovered('.pcc/commands/a.md', 'original')];
    await markTrusted(repoRoot, original);

    const modified = [discovered('.pcc/commands/a.md', 'MODIFIED')];
    const result = await checkTrust(repoRoot, modified);
    expect(result.approved).toHaveLength(0);
    expect(result.pending).toHaveLength(1);
  });

  it('isolates repos: approval in repo A does not apply to repo B', async () => {
    const repoB = join(tmpRoot, 'other-repo');
    await mkdir(repoB, { recursive: true });

    const fileA = [discovered('.pcc/commands/a.md', 'shared-content')];
    await markTrusted(repoRoot, fileA);

    const resultB = await checkTrust(repoB, fileA);
    expect(resultB.approved).toHaveLength(0);
    expect(resultB.pending).toHaveLength(1);
  });
});

describe('resolveTrust', () => {
  it('returns empty when no files provided', async () => {
    const result = await resolveTrust(repoRoot, []);
    expect(result).toHaveLength(0);
  });

  it('auto-approves all via PCC_TRUST_ALL', async () => {
    process.env['PCC_TRUST_ALL'] = '1';
    const files = [discovered('.pcc/commands/a.md', 'A')];

    let promptCalled = false;
    const result = await resolveTrust(repoRoot, files, async () => {
      promptCalled = true;
      return false;
    });

    expect(result).toHaveLength(1);
    expect(promptCalled).toBe(false);
  });

  it('does NOT persist when PCC_TRUST_ALL is set (ephemeral)', async () => {
    process.env['PCC_TRUST_ALL'] = '1';
    const files = [discovered('.pcc/commands/a.md', 'A')];
    await resolveTrust(repoRoot, files);

    delete process.env['PCC_TRUST_ALL'];
    const result = await checkTrust(repoRoot, files);
    expect(result.approved).toHaveLength(0);
    expect(result.pending).toHaveLength(1);
  });

  it('loads only already-trusted files when no confirmer provided', async () => {
    const trusted = [discovered('.pcc/commands/a.md', 'A')];
    const untrusted = [discovered('.pcc/commands/b.md', 'B')];
    await markTrusted(repoRoot, trusted);

    const result = await resolveTrust(repoRoot, [...trusted, ...untrusted]);
    expect(result).toHaveLength(1);
    expect(result[0]!.relPath).toBe('.pcc/commands/a.md');
  });

  it('prompts for pending, persists on approval', async () => {
    const files = [discovered('.pcc/commands/a.md', 'A')];

    let promptedWith: DiscoveredFile[] | null = null;
    const result = await resolveTrust(repoRoot, files, async (pending) => {
      promptedWith = pending;
      return true;
    });

    expect(result).toHaveLength(1);
    expect(promptedWith!).toHaveLength(1);

    // Next call must not prompt (already trusted)
    let prompted2 = false;
    const result2 = await resolveTrust(repoRoot, files, async () => {
      prompted2 = true;
      return true;
    });
    expect(result2).toHaveLength(1);
    expect(prompted2).toBe(false);
  });

  it('returns only already-trusted files when user rejects', async () => {
    const trusted = [discovered('a.md', 'A')];
    const pending = [discovered('b.md', 'B')];
    await markTrusted(repoRoot, trusted);

    const result = await resolveTrust(
      repoRoot,
      [...trusted, ...pending],
      async () => false,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.relPath).toBe('a.md');
  });

  it('detects content changes after first approval', async () => {
    const v1 = [discovered('a.md', 'original')];
    await resolveTrust(repoRoot, v1, async () => true);

    const v2 = [discovered('a.md', 'MODIFIED')];
    let prompted = false;
    const result = await resolveTrust(repoRoot, v2, async () => {
      prompted = true;
      return true;
    });

    expect(prompted).toBe(true);
    expect(result).toHaveLength(1);

    // Hash is now the v2 hash
    const store = JSON.parse(await readFile(storeFile, 'utf8'));
    const entry = store.repos[0].files.find((f: { relPath: string }) => f.relPath === 'a.md');
    expect(entry.sha256).toBe(hashContent('MODIFIED'));
  });
});

describe('markTrusted', () => {
  it('preserves unrelated files in the same repo across updates', async () => {
    // User approves file A at t0
    await markTrusted(repoRoot, [discovered('a.md', 'A')]);

    // Later, user approves file B in the same repo
    await markTrusted(repoRoot, [discovered('b.md', 'B')]);

    // Both should be trusted
    const result = await checkTrust(repoRoot, [
      discovered('a.md', 'A'),
      discovered('b.md', 'B'),
    ]);
    expect(result.approved).toHaveLength(2);
    expect(result.pending).toHaveLength(0);
  });

  it('updates hash when re-approving the same file', async () => {
    await markTrusted(repoRoot, [discovered('a.md', 'v1')]);
    await markTrusted(repoRoot, [discovered('a.md', 'v2')]);

    // v1 should no longer match
    const result = await checkTrust(repoRoot, [discovered('a.md', 'v1')]);
    expect(result.pending).toHaveLength(1);

    const result2 = await checkTrust(repoRoot, [discovered('a.md', 'v2')]);
    expect(result2.approved).toHaveLength(1);
  });
});

describe('malformed store handling', () => {
  it('starts empty on invalid JSON', async () => {
    await writeFile(storeFile, '{ invalid', 'utf8');
    const result = await checkTrust(repoRoot, [discovered('a.md', 'A')]);
    expect(result.pending).toHaveLength(1);
    expect(result.approved).toHaveLength(0);
  });

  it('starts empty on wrong schema version', async () => {
    await writeFile(storeFile, JSON.stringify({ version: 999, repos: [] }), 'utf8');
    const result = await checkTrust(repoRoot, [discovered('a.md', 'A')]);
    expect(result.pending).toHaveLength(1);
  });
});
