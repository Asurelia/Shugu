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
  return new Promise((resolve, reject) => {
    // Write prompt manually
    process.stdout.write(prompt);

    // Switch stdin to raw mode to capture individual keypresses.
    // This avoids the readline question/close race condition that breaks
    // on PowerShell 7 + Node.js 24 (close event fires before question callback).
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');

    let password = '';

    const onData = (ch: string) => {
      const code = ch.charCodeAt(0);

      if (ch === '\r' || ch === '\n') {
        // Enter pressed — done
        cleanup();
        process.stdout.write('\n');
        resolve(password);
      } else if (code === 3) {
        // Ctrl+C — cancel gracefully
        cleanup();
        process.stdout.write('\n');
        resolve('');
      } else if (code === 127 || code === 8) {
        // Backspace / Delete
        if (password.length > 0) {
          password = password.slice(0, -1);
          // Erase the mask character: move back, write space, move back
          if (mask) process.stdout.write('\b \b');
        }
      } else if (code >= 32) {
        // Printable character
        password += ch;
        if (mask) process.stdout.write(mask);
        // If mask is empty string, swallow completely (silent mode)
      }
      // Ignore other control characters
    };

    const cleanup = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(wasRaw ?? false);
      process.stdin.pause();
    };

    process.stdin.on('data', onData);
  });
}
