/**
 * Tests: CredentialVault with structured errors
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialVault } from '../src/credentials/vault.js';
import {
  WrongPasswordError, CorruptedVaultError, VaultNotFoundError,
  VaultDiskError, VaultAlreadyExistsError, VaultError,
} from '../src/credentials/errors.js';
import type { Credential } from '../src/credentials/types.js';

let tempDir: string;
let vaultPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'vault-test-'));
  vaultPath = join(tempDir, 'credentials.enc');
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ─── init() ────────────────────────────────────────────

describe('init', () => {
  it('creates a new vault file', async () => {
    const vault = new CredentialVault(vaultPath);
    await vault.init('test-password');
    expect(await vault.exists()).toBe(true);
    expect(vault.isUnlocked).toBe(true);
  });

  it('throws VaultAlreadyExistsError if vault exists', async () => {
    const vault = new CredentialVault(vaultPath);
    await vault.init('password1');
    vault.lock();

    const vault2 = new CredentialVault(vaultPath);
    await expect(vault2.init('password2')).rejects.toThrow(VaultAlreadyExistsError);
  });
});

// ─── unlock() ──────────────────────────────────────────

describe('unlock', () => {
  it('unlocks with correct password', async () => {
    const vault = new CredentialVault(vaultPath);
    await vault.init('correct-password');
    vault.lock();

    await vault.unlock('correct-password');
    expect(vault.isUnlocked).toBe(true);
  });

  it('throws WrongPasswordError with wrong password', async () => {
    const vault = new CredentialVault(vaultPath);
    await vault.init('correct-password');
    vault.lock();

    await expect(vault.unlock('wrong-password')).rejects.toThrow(WrongPasswordError);
    expect(vault.isUnlocked).toBe(false);
  });

  it('throws VaultNotFoundError if file missing', async () => {
    const vault = new CredentialVault(join(tempDir, 'nonexistent.enc'));
    await expect(vault.unlock('any')).rejects.toThrow(VaultNotFoundError);
  });

  it('throws CorruptedVaultError if file is not valid JSON', async () => {
    await writeFile(vaultPath, 'this is not json', 'utf-8');
    const vault = new CredentialVault(vaultPath);
    await expect(vault.unlock('any')).rejects.toThrow(CorruptedVaultError);
  });

  it('throws CorruptedVaultError if JSON missing required fields', async () => {
    await writeFile(vaultPath, JSON.stringify({ version: 1, salt: 'abc' }), 'utf-8');
    const vault = new CredentialVault(vaultPath);
    await expect(vault.unlock('any')).rejects.toThrow(CorruptedVaultError);
  });

  it('throws CorruptedVaultError if version is wrong', async () => {
    await writeFile(vaultPath, JSON.stringify({
      version: 99, salt: 'a', iv: 'b', tag: 'c', data: 'd',
    }), 'utf-8');
    const vault = new CredentialVault(vaultPath);
    await expect(vault.unlock('any')).rejects.toThrow(CorruptedVaultError);
  });

  it('preserves error code on VaultError subclasses', async () => {
    const vault = new CredentialVault(join(tempDir, 'missing.enc'));
    try {
      await vault.unlock('any');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(VaultError);
      expect((err as VaultError).code).toBe('not_found');
    }
  });
});

// ─── changePassword() ──────────────────────────────────

describe('changePassword', () => {
  it('re-encrypts vault with new password', async () => {
    const vault = new CredentialVault(vaultPath);
    await vault.init('old-password');
    await vault.changePassword('old-password', 'new-password');
    vault.lock();

    // Old password should fail
    await expect(vault.unlock('old-password')).rejects.toThrow(WrongPasswordError);

    // New password should work
    await vault.unlock('new-password');
    expect(vault.isUnlocked).toBe(true);
  });

  it('throws WrongPasswordError if current password is wrong', async () => {
    const vault = new CredentialVault(vaultPath);
    await vault.init('real-password');
    await expect(vault.changePassword('fake-password', 'new'))
      .rejects.toThrow(WrongPasswordError);
  });

  it('preserves credentials after password change', async () => {
    const vault = new CredentialVault(vaultPath);
    await vault.init('old-pass');

    const cred: Credential = {
      service: 'github',
      label: 'test',
      values: { token: 'FAKE_ghp_secret12300000000000000000000' },
      addedAt: new Date().toISOString(),
      domains: ['github.com'],
    };
    await vault.add(cred);

    await vault.changePassword('old-pass', 'new-pass');
    vault.lock();

    await vault.unlock('new-pass');
    const retrieved = vault.get('github', 'test');
    expect(retrieved).toBeDefined();
    expect(retrieved!.values['token']).toBe('FAKE_ghp_secret12300000000000000000000');
  });
});

// ─── CRUD operations ───────────────────────────────────

describe('CRUD', () => {
  let vault: CredentialVault;

  beforeEach(async () => {
    vault = new CredentialVault(vaultPath);
    await vault.init('crud-test');
  });

  it('add + get credential', async () => {
    await vault.add({
      service: 'github', label: 'personal',
      values: { token: 'FAKE_ghp_xxx00000000000000000000000000' }, addedAt: '2026-01-01',
    });
    const cred = vault.get('github', 'personal');
    expect(cred).toBeDefined();
    expect(cred!.values['token']).toBe('FAKE_ghp_xxx00000000000000000000000000');
  });

  it('add overwrites same service+label', async () => {
    await vault.add({
      service: 'github', label: 'work',
      values: { token: 'old' }, addedAt: '2026-01-01',
    });
    await vault.add({
      service: 'github', label: 'work',
      values: { token: 'new' }, addedAt: '2026-01-02',
    });
    const cred = vault.get('github', 'work');
    expect(cred!.values['token']).toBe('new');
  });

  it('remove returns true when found', async () => {
    await vault.add({
      service: 'aws', label: 'prod',
      values: { access_key_id: 'AK' }, addedAt: '2026-01-01',
    });
    const removed = await vault.remove('aws', 'prod');
    expect(removed).toBe(true);
    expect(vault.get('aws', 'prod')).toBeUndefined();
  });

  it('remove returns false when not found', async () => {
    const removed = await vault.remove('vercel');
    expect(removed).toBe(false);
  });

  it('list returns service+label+addedAt only (no secrets)', async () => {
    await vault.add({
      service: 'github', label: 'main',
      values: { token: 'secret!' }, addedAt: '2026-04-07',
    });
    const items = vault.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      service: 'github', label: 'main', addedAt: '2026-04-07',
    });
    // No 'values' or 'token' in the output
    expect((items[0] as Record<string, unknown>)['values']).toBeUndefined();
  });

  it('getByDomain matches partial domain', async () => {
    await vault.add({
      service: 'github', label: 'default',
      values: { token: 'tok' }, addedAt: '2026-01-01',
      domains: ['github.com', 'api.github.com'],
    });
    const cred = vault.getByDomain('api.github.com');
    expect(cred).toBeDefined();
    expect(cred!.service).toBe('github');
  });

  it('all operations throw when locked', () => {
    vault.lock();
    expect(() => vault.get('github')).toThrow('Vault is locked');
    expect(() => vault.list()).toThrow('Vault is locked');
    expect(() => vault.getByDomain('github.com')).toThrow('Vault is locked');
  });
});

// ─── exists() error handling ────────────────────────────

describe('exists', () => {
  it('returns false when file does not exist', async () => {
    const vault = new CredentialVault(join(tempDir, 'nope.enc'));
    expect(await vault.exists()).toBe(false);
  });

  it('returns true when file exists', async () => {
    const vault = new CredentialVault(vaultPath);
    await vault.init('test');
    vault.lock();

    const vault2 = new CredentialVault(vaultPath);
    expect(await vault2.exists()).toBe(true);
  });
});
