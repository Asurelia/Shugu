/**
 * Layer 5 — Context: Git workspace detection
 *
 * Detects git status, branch, and recent changes for context injection.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { sanitizeUntrustedContent } from '../../utils/security.js';

export interface GitContext {
  isGitRepo: boolean;
  branch?: string;
  hasUncommittedChanges?: boolean;
  recentCommits?: string[];
  status?: string;
}

/**
 * Gather git context for the current working directory.
 */
export async function getGitContext(cwd: string): Promise<GitContext> {
  try {
    const { execSync } = await import('node:child_process');
    execSync('git rev-parse --git-dir', { cwd, stdio: 'pipe' });
  } catch {
    return { isGitRepo: false };
  }

  const context: GitContext = { isGitRepo: true };

  try {
    // Run both git commands in parallel (2 spawns instead of 3)
    const [statusResult, logResult] = await Promise.all([
      runGit(['status', '--short', '--branch'], cwd),
      runGit(['log', '--oneline', '-5', '--no-decorate'], cwd),
    ]);

    // Parse status --branch output: first line is "## branch...tracking"
    const statusLines = statusResult.trim().split('\n');
    const branchLine = statusLines[0] ?? '';
    context.branch = branchLine.replace(/^##\s+/, '').split('...')[0]?.trim() ?? 'unknown';
    const changeLines = statusLines.slice(1).filter(Boolean);
    context.status = changeLines.join('\n');
    context.hasUncommittedChanges = changeLines.length > 0;

    context.recentCommits = logResult.trim().split('\n').filter(Boolean);
  } catch {
    // Partial context is fine
  }

  return context;
}

/**
 * Format git context for system prompt injection.
 *
 * SECURITY: Branch names and commit messages come from git history which may
 * be attacker-controlled (e.g., cloned untrusted repo). Content is sanitized
 * to prevent prompt injection via role-switching markers in commit messages.
 */
export function formatGitContext(git: GitContext): string {
  if (!git.isGitRepo) {
    return '  - Not a git repository';
  }

  const lines: string[] = [];
  const safeBranch = sanitizeUntrustedContent(git.branch ?? 'unknown');
  lines.push(`  - Git branch: ${safeBranch}`);
  if (git.hasUncommittedChanges) {
    lines.push('  - Uncommitted changes: yes');
  }
  if (git.recentCommits && git.recentCommits.length > 0) {
    lines.push('  - Recent commits:');
    for (const commit of git.recentCommits.slice(0, 3)) {
      // Truncate individual commit messages and sanitize
      const safeCommit = sanitizeUntrustedContent(commit.slice(0, 120));
      lines.push(`    ${safeCommit}`);
    }
  }
  return lines.join('\n');
}

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`git exited with code ${code}`));
    });
  });
}
