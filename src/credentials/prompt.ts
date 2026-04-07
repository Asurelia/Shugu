/**
 * Credentials: Password prompt with masked input
 *
 * Uses readline _writeToOutput override to suppress echo.
 * This is the standard Node.js pattern (used by inquirer, read, etc.).
 *
 * NEVER placed in src/ui/ — this is vault-specific input.
 */

import * as readline from 'node:readline';

// ─── Errors ────────────────────────────────────────────

export class PasswordMismatchError extends Error {
  constructor() {
    super('Passwords do not match');
    this.name = 'PasswordMismatchError';
  }
}

export class EmptyPasswordError extends Error {
  constructor() {
    super('Password cannot be empty');
    this.name = 'EmptyPasswordError';
  }
}

export class NoTTYError extends Error {
  constructor() {
    super('No TTY available for password input. Set PCC_VAULT_PASSWORD environment variable.');
    this.name = 'NoTTYError';
  }
}

// ─── Options ───────────────────────────────────────────

export interface PasswordPromptOptions {
  /** Prompt text (default: 'Master password: ') */
  prompt?: string;
  /** If true, ask twice and verify match */
  confirm?: boolean;
  /** Character to echo (default: '*', empty string for silent) */
  mask?: string;
}

// ─── Main Function ─────────────────────────────────────

/**
 * Prompt the user for a password with masked input.
 *
 * Throws NoTTYError if stdin is not a TTY.
 * Throws EmptyPasswordError if password is empty.
 * Throws PasswordMismatchError if confirm mode and passwords don't match.
 */
export async function promptPassword(options?: PasswordPromptOptions): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new NoTTYError();
  }

  const promptText = options?.prompt ?? 'Master password: ';
  const mask = options?.mask ?? '*';

  const password = await readHidden(promptText, mask);

  if (password.length === 0) {
    throw new EmptyPasswordError();
  }

  if (options?.confirm) {
    const confirmText = promptText.replace(/password/i, 'password (confirm)');
    const confirm = await readHidden(confirmText, mask);
    if (password !== confirm) {
      throw new PasswordMismatchError();
    }
  }

  return password;
}

// ─── Simple text prompt (non-secret, for vault add) ────

export async function promptText(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ─── Hidden Input ──────────────────────────────────────

function readHidden(prompt: string, mask: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    // Suppress echo by intercepting _writeToOutput
    // This is the standard Node.js pattern for password masking
    // (used by inquirer, read, etc.)
    type RLInternal = { _writeToOutput: (s: string) => void };
    const rlInternal = rl as unknown as RLInternal;
    const origWrite = rlInternal._writeToOutput.bind(rl);
    rlInternal._writeToOutput = function (str: string) {
      if (str.includes('\n') || str.includes('\r')) {
        origWrite('\n');
      } else if (str === prompt) {
        origWrite(str);
      } else if (mask) {
        origWrite(mask.repeat(str.length));
      }
      // If mask is empty string, swallow completely (silent mode)
    };

    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });

    // Handle Ctrl+C gracefully during password entry
    rl.on('close', () => {
      resolve('');
    });
  });
}
