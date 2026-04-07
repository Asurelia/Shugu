/**
 * Credentials: Structured vault error types
 *
 * Every vault operation throws a typed error on failure.
 * No catch-all booleans, no silent swallowing.
 */

// ─── Error Codes ───────────────────────────────────────

export type VaultErrorCode =
  | 'wrong_password'
  | 'corrupted'
  | 'not_found'
  | 'disk_read'
  | 'disk_write'
  | 'already_exists'
  | 'locked';

// ─── Base Class ────────────────────────────────────────

export class VaultError extends Error {
  constructor(
    message: string,
    public readonly code: VaultErrorCode,
  ) {
    super(message);
    this.name = 'VaultError';
  }
}

// ─── Specific Errors ───────────────────────────────────

export class WrongPasswordError extends VaultError {
  constructor() {
    super('Incorrect master password', 'wrong_password');
    this.name = 'WrongPasswordError';
  }
}

export class CorruptedVaultError extends VaultError {
  constructor(vaultPath: string, detail?: string) {
    super(
      `Vault file is corrupted: ${vaultPath}${detail ? ` (${detail})` : ''}`,
      'corrupted',
    );
    this.name = 'CorruptedVaultError';
  }
}

export class VaultNotFoundError extends VaultError {
  constructor(vaultPath: string) {
    super(`Vault file not found: ${vaultPath}`, 'not_found');
    this.name = 'VaultNotFoundError';
  }
}

export class VaultDiskError extends VaultError {
  constructor(
    operation: 'disk_read' | 'disk_write',
    vaultPath: string,
    cause?: unknown,
  ) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause ?? 'unknown');
    super(
      `Vault ${operation === 'disk_read' ? 'read' : 'write'} failed: ${vaultPath} — ${causeMsg}`,
      operation,
    );
    this.name = 'VaultDiskError';
  }
}

export class VaultAlreadyExistsError extends VaultError {
  constructor(vaultPath: string) {
    super(`Vault already exists: ${vaultPath}`, 'already_exists');
    this.name = 'VaultAlreadyExistsError';
  }
}

// ─── Type Guard ────────────────────────────────────────

export function isVaultError(err: unknown): err is VaultError {
  return err instanceof VaultError;
}

// ─── Node.js Error Type Guard ──────────────────────────

export function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
