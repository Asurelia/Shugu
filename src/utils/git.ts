/**
 * Shared git utilities.
 */

import { spawn } from 'node:child_process';
import { relative, resolve } from 'node:path';

/**
 * Run a git command and return stdout.
 */
export function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`git ${args.join(' ')} failed (${code}): ${stderr}`));
    });
  });
}

/**
 * Resolve the git repository root from any subdirectory.
 */
export async function resolveGitRoot(cwd: string): Promise<string> {
  const root = (await git(['rev-parse', '--show-toplevel'], cwd)).trim();
  return resolve(root); // Normalize path separators
}

/**
 * Get the relative path from repo root to cwd.
 * Returns '' if cwd IS the root.
 */
export function relativeToCwd(repoRoot: string, cwd: string): string {
  const rel = relative(resolve(repoRoot), resolve(cwd));
  return rel; // '' if same, 'packages/api' if in subdirectory
}
