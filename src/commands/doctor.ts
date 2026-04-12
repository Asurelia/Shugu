/**
 * /doctor command — Diagnostic health check
 *
 * Checks API connectivity, Node.js version, git, vault, and disk.
 * Like Claude Code's /doctor.
 */

import { access, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Command, CommandContext, CommandResult } from './registry.js';
import { isBlockedUrl } from '../utils/network.js';

const execAsync = promisify(execFile);

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

async function runChecks(cwd: string): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];

  // 1. API Key
  const apiKey = process.env['MINIMAX_API_KEY'] ?? process.env['ANTHROPIC_AUTH_TOKEN'] ?? '';
  checks.push({
    name: 'API Key',
    ok: apiKey.length > 10,
    detail: apiKey.length > 10 ? 'Configured (hidden)' : 'NOT SET — set MINIMAX_API_KEY',
  });

  // 2. API Connectivity
  if (apiKey.length > 10) {
    try {
      const baseUrl = process.env['MINIMAX_BASE_URL'] ?? 'https://api.minimax.io/anthropic/v1';
      // SECURITY: MINIMAX_BASE_URL is user-controlled — validate against SSRF
      const targetUrl = `${baseUrl}/messages`;
      const ssrfBlock = isBlockedUrl(targetUrl);
      if (ssrfBlock) {
        checks.push({ name: 'API Connectivity', ok: false, detail: `Blocked: ${ssrfBlock}` });
        return checks;
      }
      const resp = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'MiniMax-M2.7', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }], temperature: 0.01, stream: false }),
        signal: AbortSignal.timeout(10_000),
      });
      checks.push({ name: 'API Connectivity', ok: resp.status < 500, detail: `HTTP ${resp.status} (${resp.statusText})` });
    } catch (err) {
      checks.push({ name: 'API Connectivity', ok: false, detail: err instanceof Error ? err.message : 'Connection failed' });
    }
  } else {
    checks.push({ name: 'API Connectivity', ok: false, detail: 'Skipped (no API key)' });
  }

  // 3. Node.js version
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1).split('.')[0] ?? '0', 10);
  checks.push({ name: 'Node.js', ok: major >= 20, detail: `${nodeVersion}${major < 20 ? ' — requires >= 20' : ''}` });

  // 4. Git
  try {
    const { stdout } = await execAsync('git', ['--version'], { timeout: 5000 });
    checks.push({ name: 'Git', ok: true, detail: stdout.trim() });
  } catch {
    checks.push({ name: 'Git', ok: false, detail: 'Not installed or not in PATH' });
  }

  // 5. Git repo
  try {
    await execAsync('git', ['rev-parse', '--git-dir'], { cwd, timeout: 5000 });
    checks.push({ name: 'Git Repo', ok: true, detail: 'Current directory is a git repo' });
  } catch {
    checks.push({ name: 'Git Repo', ok: false, detail: 'Not a git repository' });
  }

  // 6. .pcc/ directory
  const pccDir = join(cwd, '.pcc');
  try {
    await access(pccDir);
    checks.push({ name: '.pcc/ Directory', ok: true, detail: 'Exists' });
  } catch {
    checks.push({ name: '.pcc/ Directory', ok: false, detail: 'Not found — run /init to create' });
  }

  // 7. SHUGU.md
  try {
    const s = await stat(join(cwd, 'SHUGU.md'));
    checks.push({ name: 'SHUGU.md', ok: true, detail: `${Math.round(s.size / 1024)}KB` });
  } catch {
    checks.push({ name: 'SHUGU.md', ok: false, detail: 'Not found — run /init to create' });
  }

  // 8. Sessions directory
  const sessDir = join(homedir(), '.pcc', 'sessions');
  try {
    await access(sessDir);
    checks.push({ name: 'Sessions Dir', ok: true, detail: sessDir });
  } catch {
    checks.push({ name: 'Sessions Dir', ok: false, detail: 'Not created yet (auto-created on first save)' });
  }

  // 9. Companion
  try {
    await access(join(homedir(), '.pcc', 'companion.json'));
    checks.push({ name: 'Companion', ok: true, detail: 'Hatched' });
  } catch {
    checks.push({ name: 'Companion', ok: false, detail: 'Not hatched yet (launches on first REPL)' });
  }

  // 10. Obsidian vault
  const vaultPath = process.env['PCC_OBSIDIAN_VAULT'];
  if (vaultPath) {
    try {
      await access(join(vaultPath, '.obsidian'));
      checks.push({ name: 'Obsidian Vault', ok: true, detail: vaultPath });
    } catch {
      checks.push({ name: 'Obsidian Vault', ok: false, detail: `Configured but not found: ${vaultPath}` });
    }
  } else {
    checks.push({ name: 'Obsidian Vault', ok: true, detail: 'Not configured (optional)' });
  }

  return checks;
}

// ─── Command ──────────────────────────────────────────

export const doctorCommand: Command = {
  name: 'doctor',
  aliases: ['health', 'diag'],
  description: 'Run diagnostic health checks',
  async execute(_args: string, ctx: CommandContext): Promise<CommandResult> {
    ctx.info('  Running diagnostics...\n');
    const checks = await runChecks(ctx.cwd);

    let passCount = 0;
    for (const check of checks) {
      const icon = check.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
      ctx.info(`  ${icon} ${check.name}: ${check.detail}`);
      if (check.ok) passCount++;
    }

    ctx.info(`\n  ${passCount}/${checks.length} checks passed`);
    return { type: 'handled' };
  },
};
