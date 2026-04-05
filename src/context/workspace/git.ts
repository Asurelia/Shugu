/**
 * Layer 5 — Context: Git workspace detection
 *
 * Detects git status, branch, and recent changes for context injection.
 */

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

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
    await access(join(cwd, '.git'));
  } catch {
    return { isGitRepo: false };
  }

  const context: GitContext = { isGitRepo: true };

  try {
    context.branch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim();
    const status = (await runGit(['status', '--short'], cwd)).trim();
    context.status = status;
    context.hasUncommittedChanges = status.length > 0;
    const log = (await runGit(['log', '--oneline', '-5', '--no-decorate'], cwd)).trim();
    context.recentCommits = log.split('\n').filter(Boolean);
  } catch {
    // Partial context is fine
  }

  return context;
}

/**
 * Format git context for system prompt injection.
 */
export function formatGitContext(git: GitContext): string {
  if (!git.isGitRepo) {
    return '  - Not a git repository';
  }

  const lines: string[] = [];
  lines.push(`  - Git branch: ${git.branch ?? 'unknown'}`);
  if (git.hasUncommittedChanges) {
    lines.push('  - Uncommitted changes: yes');
  }
  if (git.recentCommits && git.recentCommits.length > 0) {
    lines.push('  - Recent commits:');
    for (const commit of git.recentCommits.slice(0, 3)) {
      lines.push(`    ${commit}`);
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
