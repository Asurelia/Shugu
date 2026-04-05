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

import { spawn } from 'node:child_process';
import { access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// ─── Worktree ───────────────────────────────────────────

export interface Worktree {
  id: string;
  path: string;
  branch: string;
  baseBranch: string;
  createdAt: Date;
}

/**
 * Create a new git worktree for isolated agent work.
 */
export async function createWorktree(
  repoDir: string,
  prefix: string = 'pcc-agent',
): Promise<Worktree> {
  // Verify we're in a git repo
  try {
    await access(join(repoDir, '.git'));
  } catch {
    throw new Error('Not a git repository — worktree isolation requires git');
  }

  const id = randomUUID().slice(0, 8);
  const branch = `${prefix}-${id}`;
  const worktreePath = join(repoDir, '.pcc-worktrees', branch);

  // Get current branch
  const baseBranch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir)).trim();

  // Create worktree with new branch
  await git(['worktree', 'add', '-b', branch, worktreePath], repoDir);

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
 */
export async function removeWorktree(
  repoDir: string,
  worktree: Worktree,
  deleteBranch: boolean = true,
): Promise<void> {
  try {
    await git(['worktree', 'remove', '--force', worktree.path], repoDir);
  } catch {
    // If worktree remove fails, try manual cleanup
    try {
      await rm(worktree.path, { recursive: true, force: true });
      await git(['worktree', 'prune'], repoDir);
    } catch {
      // Best effort cleanup
    }
  }

  if (deleteBranch) {
    try {
      await git(['branch', '-D', worktree.branch], repoDir);
    } catch {
      // Branch may already be deleted
    }
  }
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
): Promise<{ merged: boolean; conflicts: boolean }> {
  // First commit any changes in the worktree
  const hasChanges = await worktreeHasChanges(worktree);
  if (hasChanges) {
    await git(['add', '-A'], worktree.path);
    await git(
      ['commit', '-m', commitMessage ?? `Agent work from ${worktree.branch}`],
      worktree.path,
    );
  }

  // Try to merge into base branch
  try {
    await git(['checkout', worktree.baseBranch], repoDir);
    await git(['merge', '--no-ff', worktree.branch, '-m', `Merge agent work: ${worktree.branch}`], repoDir);
    return { merged: true, conflicts: false };
  } catch {
    // Merge conflict
    try {
      await git(['merge', '--abort'], repoDir);
    } catch {
      // Already not merging
    }
    return { merged: false, conflicts: true };
  }
}

// ─── Git Helper ─────────────────────────────────────────

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`git ${args.join(' ')} failed (${code}): ${stderr}`));
    });
  });
}
