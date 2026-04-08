/**
 * Tests: credential domain matching (F4 security fix)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialVault } from '../src/credentials/vault.js';
import type { Credential } from '../src/credentials/types.js';

let tempDir: string;
let vaultPath: string;
let vault: CredentialVault;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'domain-test-'));
  vaultPath = join(tempDir, 'credentials.enc');
  vault = new CredentialVault(vaultPath);
  await vault.init('test-password');

  const cred: Credential = {
    service: 'github',
    label: 'default',
    values: { token: 'FAKE_ghp_test000000000000000000000000' },
    addedAt: '2026-04-07',
    domains: ['github.com'],
  };
  await vault.add(cred);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('getByDomain — domain matching', () => {
  it('matches exact domain', () => {
    const cred = vault.getByDomain('github.com');
    expect(cred).toBeDefined();
    expect(cred!.service).toBe('github');
  });

  it('matches subdomain with dot boundary (api.github.com matches github.com)', () => {
    const cred = vault.getByDomain('api.github.com');
    expect(cred).toBeDefined();
    expect(cred!.service).toBe('github');
  });

  it('does NOT match evil-github.com (no dot boundary)', () => {
    const cred = vault.getByDomain('evil-github.com');
    expect(cred).toBeUndefined();
  });

  it('does NOT match notgithub.com', () => {
    const cred = vault.getByDomain('notgithub.com');
    expect(cred).toBeUndefined();
  });

  it('does NOT match github.com.evil.com', () => {
    const cred = vault.getByDomain('github.com.evil.com');
    expect(cred).toBeUndefined();
  });

  it('matches deep subdomain (sub.api.github.com matches github.com)', () => {
    const cred = vault.getByDomain('sub.api.github.com');
    expect(cred).toBeDefined();
    expect(cred!.service).toBe('github');
  });

  it('returns undefined for unrelated domain', () => {
    const cred = vault.getByDomain('example.com');
    expect(cred).toBeUndefined();
  });
});
