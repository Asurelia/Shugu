/**
 * Layer 5 — Credentials: Trust Store (TOFU for repo-local executables)
 *
 * Trust On First Use for executable content discovered in a repository:
 *   - .pcc/commands/*.md  (custom slash commands, prompt payloads)
 *   - .pcc/agents/*.md    (custom agent role prompts)
 *
 * Problem this solves
 * --------------------
 * Before this module, any file matching `.pcc/commands/*.md` in a cloned
 * repository would be silently wired into the command registry at startup.
 * A malicious repo could ship a `/deploy` command whose prompt body
 * instructs the model to exfiltrate secrets or run destructive bash.
 *
 * Trust model
 * -----------
 * On first encounter of a repository's executable markdown files, the
 * user is asked to approve the full list. We record:
 *   - The repository root (absolute path — user-scoped, not shared)
 *   - Each file's path + SHA-256 hash of its content at approval time
 *
 * On subsequent launches, files whose hash matches the recorded hash
 * load silently. Files whose hash changed, or new files, trigger a
 * re-prompt. Deleting a file is silent (no prompt needed).
 *
 * Storage is per-user at ~/.pcc/trusted-repos.json — never committed,
 * never transmitted. This is the same model as SSH known_hosts: not a
 * proof of safety, but a friction that catches repo rotation attacks
 * and surprise new-content after `git pull`.
 *
 * NOTE: Binary plugins (src/plugins/loader.ts) have their OWN confirmation
 * path via bootstrap.ts's `onConfirmLocal`. This trust store only covers
 * markdown commands + agents. Separation is deliberate: binary plugins
 * run code, markdown is prompt content — different threat surfaces,
 * different UX.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../utils/logger.js';

export const TRUST_STORE_FILENAME = 'trusted-repos.json';

// ─── File paths ────────────────────────────────────────

const ENV_TRUST_FILE = 'PCC_TRUST_FILE';

/** Resolve the trust file path, honoring the test override env var. */
function trustFilePath(): string {
  const override = process.env[ENV_TRUST_FILE];
  if (override && override.length > 0) return override;
  return join(homedir(), '.pcc', 'trusted-repos.json');
}

/**
 * Opt-out escape hatch for CI / headless runs.
 * When `PCC_TRUST_ALL=1`, every discovered file is auto-approved. Only
 * use when you already trust the environment (CI with vetted repos).
 */
const ENV_TRUST_ALL = 'PCC_TRUST_ALL';

// ─── Types ──────────────────────────────────────────────

/** A single approved file inside a repo. */
export interface TrustedFile {
  /** Repo-relative path, forward slashes. */
  relPath: string;
  /** SHA-256 of the file content at approval time (hex). */
  sha256: string;
}

/** Full entry for one repo. */
export interface TrustedRepo {
  /** Absolute path to repo root (key). */
  repoPath: string;
  /** Approved files at their approved hashes. */
  files: TrustedFile[];
  /** When the user approved (ISO 8601). */
  trustedAt: string;
}

/** Persisted schema. */
interface TrustStoreSchema {
  version: 1;
  repos: TrustedRepo[];
}

/**
 * A file discovered on disk at load time, before any trust check.
 */
export interface DiscoveredFile {
  /** Absolute path for reading. */
  absPath: string;
  /** Relative path to repo root, used as the stable key in the store. */
  relPath: string;
  /** Current content for hashing. */
  content: string;
}

/** Categorized result of a trust check against the persisted store. */
export interface TrustCheck {
  /** Files whose hash matches the store — approved automatically. */
  approved: DiscoveredFile[];
  /** Files not previously seen OR whose hash changed. Need user confirmation. */
  pending: DiscoveredFile[];
}

// ─── Hashing ────────────────────────────────────────────

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

// ─── Persistence ────────────────────────────────────────

async function readStore(): Promise<TrustStoreSchema> {
  const path = trustFilePath();
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { version?: number }).version === 1 &&
      Array.isArray((parsed as { repos?: unknown }).repos)
    ) {
      return parsed as TrustStoreSchema;
    }
    logger.warn(`trust-store: malformed store at ${path} — starting empty`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(
        `trust-store: failed to read ${path} — starting empty: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return { version: 1, repos: [] };
}

async function writeStore(store: TrustStoreSchema): Promise<void> {
  const path = trustFilePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(store, null, 2), 'utf8');
}

// ─── Public API ─────────────────────────────────────────

/**
 * Partition the discovered files into those already trusted (hash match)
 * and those needing confirmation (new or hash mismatch).
 *
 * @param repoPath Absolute path to the repo root. Files not under this
 *                 path are always returned as pending (caller error).
 */
export async function checkTrust(
  repoPath: string,
  files: DiscoveredFile[],
): Promise<TrustCheck> {
  const store = await readStore();
  const repo = store.repos.find((r) => r.repoPath === repoPath);

  const approved: DiscoveredFile[] = [];
  const pending: DiscoveredFile[] = [];

  for (const file of files) {
    const hash = hashContent(file.content);
    const entry = repo?.files.find((f) => f.relPath === file.relPath);
    if (entry && entry.sha256 === hash) {
      approved.push(file);
    } else {
      pending.push(file);
    }
  }

  return { approved, pending };
}

/**
 * Record the given files as trusted for this repo. Overwrites prior
 * hashes for the same relPath (re-approval on change). Preserves other
 * files in the repo's entry that aren't in the current discovery set
 * so deleting a file later does not forget the repo.
 */
export async function markTrusted(
  repoPath: string,
  files: DiscoveredFile[],
): Promise<void> {
  const store = await readStore();
  const existing = store.repos.find((r) => r.repoPath === repoPath);

  const newEntries: TrustedFile[] = files.map((f) => ({
    relPath: f.relPath,
    sha256: hashContent(f.content),
  }));

  if (existing) {
    // Replace entries for paths present in the update, preserve others.
    const updatedPaths = new Set(newEntries.map((e) => e.relPath));
    const kept = existing.files.filter((f) => !updatedPaths.has(f.relPath));
    existing.files = [...kept, ...newEntries];
    existing.trustedAt = new Date().toISOString();
  } else {
    store.repos.push({
      repoPath,
      files: newEntries,
      trustedAt: new Date().toISOString(),
    });
  }

  await writeStore(store);
}

/**
 * High-level flow used by loaders: given discovered files, return the
 * ones the user allowed. Handles the three cases:
 *
 *   1. `PCC_TRUST_ALL=1` — all auto-approved, store NOT updated (CI).
 *   2. `onConfirm` missing — non-interactive context (e.g. headless
 *      sub-agent). Only already-trusted files load; pending silently drop.
 *   3. Normal case — already-trusted load silently; pending are shown
 *      to `onConfirm`. On user approval, pending are hashed and persisted.
 *
 * @param onConfirm Callback that receives the pending files and returns
 *   `true` to approve them all, `false` to reject. Called only if there
 *   are pending files.
 */
export async function resolveTrust(
  repoPath: string,
  files: DiscoveredFile[],
  onConfirm?: (pending: DiscoveredFile[]) => Promise<boolean>,
): Promise<DiscoveredFile[]> {
  if (files.length === 0) return [];

  if (process.env[ENV_TRUST_ALL] === '1') {
    return files;
  }

  const { approved, pending } = await checkTrust(repoPath, files);

  if (pending.length === 0) {
    return approved;
  }

  if (!onConfirm) {
    // No confirmer available — load only what is already trusted.
    logger.debug(
      `trust-store: ${pending.length} unverified file(s) skipped (no interactive confirmer)`,
    );
    return approved;
  }

  const userSaidYes = await onConfirm(pending);
  if (!userSaidYes) {
    return approved;
  }

  await markTrusted(repoPath, pending);
  return [...approved, ...pending];
}

// Tests redirect the store via the PCC_TRUST_FILE env var (see trustFilePath).
