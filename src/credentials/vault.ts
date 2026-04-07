/**
 * Credentials: Encrypted vault
 *
 * AES-256-GCM encryption with PBKDF2 key derivation (100K iterations).
 * Same approach as 1Password/Bitwarden for at-rest encryption.
 *
 * Storage: ~/.pcc/credentials.enc
 * Format: { salt, iv, tag, ciphertext } — all base64 encoded
 *
 * ZERO SILENT ERRORS: every failure throws a typed VaultError subclass.
 */

import {
  createCipheriv, createDecipheriv,
  pbkdf2Sync, randomBytes, timingSafeEqual,
} from 'node:crypto';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { Credential, ServiceType } from './types.js';
import {
  WrongPasswordError, CorruptedVaultError, VaultNotFoundError,
  VaultDiskError, VaultAlreadyExistsError, isNodeError,
} from './errors.js';

// ─── Constants ──────────────────────────────────────────

const VAULT_PATH = join(homedir(), '.pcc', 'credentials.enc');
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16;
const SALT_LENGTH = 32;
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_DIGEST = 'sha512';

// ─── Vault Data ─────────────────────────────────────────

interface VaultData {
  version: 1;
  credentials: Credential[];
}

interface EncryptedVault {
  version: 1;
  salt: string;   // base64
  iv: string;     // base64
  tag: string;    // base64
  data: string;   // base64 ciphertext
}

// ─── Credential Vault ───────────────────────────────────

export class CredentialVault {
  private masterKey: Buffer | null = null;
  private credentials: Credential[] = [];
  private salt: Buffer | null = null;
  private vaultPath: string;

  constructor(vaultPath?: string) {
    this.vaultPath = vaultPath ?? VAULT_PATH;
  }

  /** Get the vault file path (for display/diagnostics). */
  get path(): string {
    return this.vaultPath;
  }

  /**
   * Check if a vault file exists on disk.
   * Throws VaultDiskError on permission/IO errors (NOT silent).
   */
  async exists(): Promise<boolean> {
    try {
      await access(this.vaultPath);
      return true;
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return false;
      }
      // Permission denied, IO error, etc. — DO NOT swallow
      throw new VaultDiskError('disk_read', this.vaultPath, err);
    }
  }

  /**
   * Initialize a new vault with a master password.
   * Throws VaultAlreadyExistsError if a vault file already exists.
   * Throws VaultDiskError on write failures.
   */
  async init(masterPassword: string): Promise<void> {
    if (await this.exists()) {
      throw new VaultAlreadyExistsError(this.vaultPath);
    }

    this.salt = randomBytes(SALT_LENGTH);
    this.masterKey = this.deriveKey(masterPassword, this.salt);
    this.credentials = [];

    try {
      await this.save();
    } catch (err: unknown) {
      this.masterKey = null;
      this.salt = null;
      this.credentials = [];
      if (err instanceof VaultDiskError) throw err;
      throw new VaultDiskError('disk_write', this.vaultPath, err);
    }
  }

  /**
   * Unlock an existing vault with the master password.
   * Throws WrongPasswordError if the password doesn't match.
   * Throws VaultNotFoundError if the vault file is missing.
   * Throws CorruptedVaultError if the file is malformed.
   * Throws VaultDiskError on IO errors.
   */
  async unlock(masterPassword: string): Promise<void> {
    // Read file
    let raw: string;
    try {
      raw = await readFile(this.vaultPath, 'utf-8');
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        throw new VaultNotFoundError(this.vaultPath);
      }
      throw new VaultDiskError('disk_read', this.vaultPath, err);
    }

    // Parse JSON structure
    let encrypted: EncryptedVault;
    try {
      encrypted = JSON.parse(raw) as EncryptedVault;
    } catch {
      throw new CorruptedVaultError(this.vaultPath, 'invalid JSON');
    }

    // Validate required fields
    if (!encrypted.salt || !encrypted.iv || !encrypted.tag || !encrypted.data) {
      throw new CorruptedVaultError(this.vaultPath, 'missing required fields');
    }
    if (encrypted.version !== 1) {
      throw new CorruptedVaultError(this.vaultPath, `unsupported version: ${encrypted.version}`);
    }

    // Derive key from password
    this.salt = Buffer.from(encrypted.salt, 'base64');
    this.masterKey = this.deriveKey(masterPassword, this.salt);

    // Decrypt
    try {
      const iv = Buffer.from(encrypted.iv, 'base64');
      const tag = Buffer.from(encrypted.tag, 'base64');
      const ciphertext = Buffer.from(encrypted.data, 'base64');

      const decipher = createDecipheriv(ALGORITHM, this.masterKey, iv);
      decipher.setAuthTag(tag);

      const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);

      const vaultData = JSON.parse(decrypted.toString('utf-8')) as VaultData;
      this.credentials = vaultData.credentials;
    } catch {
      // Auth tag mismatch = wrong password. Clear state.
      this.masterKey = null;
      this.credentials = [];
      this.salt = null;
      throw new WrongPasswordError();
    }
  }

  /**
   * Check if the vault is unlocked (key in memory).
   */
  get isUnlocked(): boolean {
    return this.masterKey !== null;
  }

  /**
   * Add a credential to the vault.
   * Throws VaultDiskError on save failure.
   */
  async add(credential: Credential): Promise<void> {
    this.ensureUnlocked();
    // Remove existing credential for same service+label
    this.credentials = this.credentials.filter(
      (c) => !(c.service === credential.service && c.label === credential.label),
    );
    this.credentials.push(credential);
    await this.save();
  }

  /**
   * Remove a credential by service and label.
   * Returns true if removed, false if not found.
   * Throws VaultDiskError on save failure.
   */
  async remove(service: ServiceType, label?: string): Promise<boolean> {
    this.ensureUnlocked();
    const before = this.credentials.length;
    this.credentials = this.credentials.filter((c) => {
      if (c.service !== service) return true;
      if (label && c.label !== label) return true;
      return false;
    });
    if (this.credentials.length < before) {
      await this.save();
      return true;
    }
    return false;
  }

  /**
   * Get credentials for a service.
   */
  get(service: ServiceType, label?: string): Credential | undefined {
    this.ensureUnlocked();
    if (label) {
      return this.credentials.find((c) => c.service === service && c.label === label);
    }
    return this.credentials.find((c) => c.service === service);
  }

  /**
   * Get a specific value from a credential.
   */
  getValue(service: ServiceType, key: string, label?: string): string | undefined {
    const cred = this.get(service, label);
    return cred?.values[key];
  }

  /**
   * Find credential matching a domain.
   */
  getByDomain(domain: string): Credential | undefined {
    this.ensureUnlocked();
    return this.credentials.find((c) =>
      c.domains?.some((d) => domain === d || domain.endsWith('.' + d)),
    );
  }

  /**
   * List all stored credentials (service + label only, no secrets).
   */
  list(): Array<{ service: ServiceType; label: string; addedAt: string }> {
    this.ensureUnlocked();
    return this.credentials.map((c) => ({
      service: c.service,
      label: c.label,
      addedAt: c.addedAt,
    }));
  }

  /**
   * Change the master password. Re-encrypts all credentials.
   * Throws WrongPasswordError if currentPassword doesn't match.
   * Throws VaultDiskError on save failure.
   */
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    this.ensureUnlocked();

    // Verify current password by deriving and comparing
    const testKey = this.deriveKey(currentPassword, this.salt!);
    if (!timingSafeEqual(testKey, this.masterKey!)) {
      throw new WrongPasswordError();
    }

    // Re-derive with new password and fresh salt
    this.salt = randomBytes(SALT_LENGTH);
    this.masterKey = this.deriveKey(newPassword, this.salt);
    await this.save();
  }

  /**
   * Lock the vault (clear all secrets from memory).
   */
  lock(): void {
    this.masterKey = null;
    this.credentials = [];
    this.salt = null;
  }

  // ─── Private ────────────────────────────────────────

  private ensureUnlocked(): void {
    if (!this.masterKey) {
      throw new Error('Vault is locked. Call unlock() first.');
    }
  }

  private deriveKey(password: string, salt: Buffer): Buffer {
    return pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, PBKDF2_DIGEST);
  }

  private async save(): Promise<void> {
    this.ensureUnlocked();

    try {
      await mkdir(dirname(this.vaultPath), { recursive: true });
    } catch (err: unknown) {
      throw new VaultDiskError('disk_write', this.vaultPath, err);
    }

    const vaultData: VaultData = {
      version: 1,
      credentials: this.credentials,
    };

    const plaintext = Buffer.from(JSON.stringify(vaultData), 'utf-8');
    const iv = randomBytes(IV_LENGTH);

    const cipher = createCipheriv(ALGORITHM, this.masterKey!, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    const encrypted: EncryptedVault = {
      version: 1,
      salt: this.salt!.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: ciphertext.toString('base64'),
    };

    try {
      await writeFile(this.vaultPath, JSON.stringify(encrypted, null, 2), 'utf-8');
    } catch (err: unknown) {
      throw new VaultDiskError('disk_write', this.vaultPath, err);
    }
  }
}
