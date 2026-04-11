/**
 * Layer 8 — Agents: Git worktree isolation
 *
 * Creates isolated git worktrees for sub-agents so they can edit files
 * without conflicting with the main workspace.
 *
 * Lifecycle:
 * 1. Create worktree from current branch
 * 2. Sub-agent works in the worktree
 * 3. On completion: merge changes back or discard
 * 4. Cleanup worktree
 */

import { rm, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { git, resolveGitRoot } from '../utils/git.js';
import { logger } from '../utils/logger.js';

// ─── Worktree ───────────────────────────────────────────

export interface Worktree {
  id: string;
  path: string;
  branch: string;
  baseBranch: string;
  createdAt: Date;
}

// ─── Cleanup Result ─────────────────────────────────────

export interface WorktreeCleanupResult {
  removed: boolean;
  branchDeleted: boolean;
  warnings: string[];
}

// ─── Merge Result ───────────────────────────────────────

export interface MergeResult {
  merged: boolean;
  conflicts: boolean;
  error?: string;
  conflictFiles?: string[];
}

/**
 * Create a new git worktree for isolated agent work.
 */
export async function createWorktree(
  repoDir: string,
  prefix: string = 'pcc-agent',
): Promise<Worktree> {
  const gitRoot = await resolveGitRoot(repoDir);

  const id = randomUUID().slice(0, 8);
  const branch = `${prefix}-${id}`;
  const worktreePath = join(gitRoot, '.pcc-worktrees', branch);

  // Get current branch
  const baseBranch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], gitRoot)).trim();

  // Create worktree with new branch
  await git(['worktree', 'add', '-b', branch, worktreePath], gitRoot);

  return {
    id,
    path: worktreePath,
    branch,
    baseBranch,
    createdAt: new Date(),
  };
}

/**
 * Remove a worktree and optionally its branch.
 * Returns a structured result with warnings instead of swallowing errors.
 */
export async function removeWorktree(
  repoDir: string,
  worktree: Worktree,
  deleteBranch: boolean = true,
): Promise<WorktreeCleanupResult> {
  const warnings: string[] = [];
  let removed = false;
  let branchDeleted = false;

  try {
    await git(['worktree', 'remove', '--force', worktree.path], repoDir);
    removed = true;
  } catch (err) {
    // If worktree remove fails, try manual cleanup
    try {
      await rm(worktree.path, { recursive: true, force: true });
      await git(['worktree', 'prune'], repoDir);
      removed = true;
    } catch (rmErr) {
      const msg = rmErr instanceof Error ? rmErr.message : String(rmErr);
      warnings.push(`Failed to remove worktree at ${worktree.path}: ${msg}`);
    }
  }

  if (deleteBranch) {
    try {
      await git(['branch', '-D', worktree.branch], repoDir);
      branchDeleted = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Failed to delete branch ${worktree.branch}: ${msg}`);
    }
  }

  return { removed, branchDeleted, warnings };
}

/**
 * Check if a worktree has uncommitted changes.
 */
export async function worktreeHasChanges(worktree: Worktree): Promise<boolean> {
  const status = await git(['status', '--porcelain'], worktree.path);
  return status.trim().length > 0;
}

/**
 * Merge worktree changes back into the base branch.
 */
export async function mergeWorktree(
  repoDir: string,
  worktree: Worktree,
  commitMessage?: string,
): Promise<MergeResult> {
  // First commit any changes in the worktree
  const hasChanges = await worktreeHasChanges(worktree);
  if (hasChanges) {
    await git(['add', '-A'], worktree.path);
    try {
      await git(
        ['commit', '-m', commitMessage ?? `Agent work from ${worktree.branch}`],
        worktree.path,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { merged: false, conflicts: false, error: `Commit failed: ${msg}` };
    }
  }

  // Try to merge into base branch
  try {
    await git(['checkout', worktree.baseBranch], repoDir);
    await git(['merge', '--no-ff', worktree.branch, '-m', `Merge agent work: ${worktree.branch}`], repoDir);
    return { merged: true, conflicts: false };
  } catch (mergeErr) {
    // Collect conflict files before aborting
    let conflictFiles: string[] = [];
    try {
      const diffOut = await git(['diff', '--name-only', '--diff-filter=U'], repoDir);
      conflictFiles = diffOut.trim().split('\n').filter(Boolean);
    } catch {
      // Best effort — ignore if diff fails
    }

    // Abort the merge
    let abortError: string | undefined;
    try {
      await git(['merge', '--abort'], repoDir);
    } catch (abortErr) {
      abortError = abortErr instanceof Error ? abortErr.message : String(abortErr);
    }

    const mergeMsg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
    const error = abortError
      ? `Merge failed: ${mergeMsg}; abort also failed: ${abortError}`
      : undefined;

    return { merged: false, conflicts: true, error, conflictFiles };
  }
}

/**
 * Clean up orphaned worktrees left behind by crashed sessions.
 * Removes worktrees in .pcc-worktrees/ that are older than maxAgeMs
 * and have no uncommitted changes.
 */
export async function cleanupOrphanWorktrees(
  repoDir: string,
  maxAgeMs: number = 60 * 60 * 1000, // 1 hour default
): Promise<{ removed: string[]; skipped: string[]; errors: string[] }> {
  const removed: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  let gitRoot: string;
  try {
    gitRoot = await resolveGitRoot(repoDir);
  } catch {
    return { removed, skipped, errors: ['Not a git repository'] };
  }

  const worktreesDir = join(gitRoot, '.pcc-worktrees');

  let entries: string[];
  try {
    entries = await readdir(worktreesDir);
  } catch {
    // No worktrees directory — nothing to clean up
    return { removed, skipped, errors };
  }

  const now = Date.now();

  for (const entry of entries) {
    const entryPath = join(worktreesDir, entry);

    try {
      const entryStats = await stat(entryPath);
      if (!entryStats.isDirectory()) continue;

      // Skip if younger than maxAgeMs
      const ageMs = now - entryStats.mtimeMs;
      if (ageMs < maxAgeMs) {
        skipped.push(entry);
        continue;
      }

      // Check for uncommitted changes — skip if present
      try {
        const status = await git(['status', '--porcelain'], entryPath);
        if (status.trim().length > 0) {
          skipped.push(entry);
          continue;
        }
      } catch {
        // git status failed — worktree may be corrupt, try to remove anyway
      }

      // Remove the worktree
      try {
        await git(['worktree', 'remove', '--force', entryPath], gitRoot);
      } catch {
        await rm(entryPath, { recursive: true, force: true });
        await git(['worktree', 'prune'], gitRoot);
      }

      // Try to delete the branch
      try {
        await git(['branch', '-D', entry], gitRoot);
      } catch {
        // Branch may not exist or may already be deleted
      }

      removed.push(entry);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${entry}: ${msg}`);
    }
  }

  if (removed.length > 0) {
    logger.debug(`Cleaned up ${removed.length} orphan worktree(s): ${removed.join(', ')}`);
  }

  return { removed, skipped, errors };
}
