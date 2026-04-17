/**
 * Micro-logger — minimal file logger for non-critical errors.
 *
 * Writes to ~/.pcc/shugu.log with timestamp + level.
 * Rotates when file exceeds 1 MB (keeps 1 backup).
 * All methods are safe to call fire-and-forget (never throws).
 */

import { appendFile, stat, rename, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LOG_DIR = join(homedir(), '.pcc');
const LOG_FILE = join(LOG_DIR, 'shugu.log');
const LOG_BACKUP = join(LOG_DIR, 'shugu.log.1');
const MAX_SIZE = 1_048_576; // 1 MB
const CHECK_INTERVAL_MS = 60_000; // Check size every 60s

let lastSizeCheck = 0;
let dirEnsured = false;

async function ensureDir(): Promise<void> {
  if (dirEnsured) return;
  try {
    await mkdir(LOG_DIR, { recursive: true });
    dirEnsured = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      dirEnsured = true;
    }
    // Other errors: don't set flag, will retry next write
  }
}

async function maybeRotate(): Promise<void> {
  if (Date.now() - lastSizeCheck < CHECK_INTERVAL_MS) return;
  lastSizeCheck = Date.now();
  try {
    const st = await stat(LOG_FILE);
    if (st.size > MAX_SIZE) {
      await rename(LOG_FILE, LOG_BACKUP);
    }
  } catch {
    // File doesn't exist yet — fine
  }
}

function formatLine(level: string, message: string, detail?: string): string {
  const ts = new Date().toISOString();
  const base = `[${ts}] ${level}: ${message}`;
  return detail ? `${base} | ${detail}\n` : `${base}\n`;
}

async function write(level: string, message: string, detail?: string): Promise<void> {
  try {
    await ensureDir();
    await maybeRotate();
    await appendFile(LOG_FILE, formatLine(level, message, detail));
  } catch {
    // Logger must never throw — if we can't write, silently discard
  }
}

export const logger = {
  debug(message: string, detail?: string): void {
    write('DEBUG', message, detail);
  },
  warn(message: string, detail?: string): void {
    write('WARN', message, detail);
  },
  error(message: string, detail?: string): void {
    write('ERROR', message, detail);
  },
};
