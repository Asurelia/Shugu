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
import { logger } from '../utils/logger.js';
import { isDockerAvailable } from '../plugins/host.js';

function describeError(err: unknown): string {
  if (err instanceof Error) {
    // Distinguish ENOENT (genuine "not found") from other errors that
    // would otherwise hide behind a generic "Not found" UX.
    const code = (err as NodeJS.ErrnoException).code;
    return code ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}

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
  } catch (err) {
    logger.debug('doctor: git --version failed', describeError(err));
    checks.push({ name: 'Git', ok: false, detail: `Not installed or not in PATH (${describeError(err)})` });
  }

  // 5. Git repo
  try {
    await execAsync('git', ['rev-parse', '--git-dir'], { cwd, timeout: 5000 });
    checks.push({ name: 'Git Repo', ok: true, detail: 'Current directory is a git repo' });
  } catch (err) {
    logger.debug('doctor: git rev-parse failed', describeError(err));
    checks.push({ name: 'Git Repo', ok: false, detail: 'Not a git repository' });
  }

  // 6. .pcc/ directory
  const pccDir = join(cwd, '.pcc');
  try {
    await access(pccDir);
    checks.push({ name: '.pcc/ Directory', ok: true, detail: 'Exists' });
  } catch (err) {
    logger.debug('doctor: .pcc access failed', describeError(err));
    checks.push({ name: '.pcc/ Directory', ok: false, detail: 'Not found — run /init to create' });
  }

  // 7. SHUGU.md
  try {
    const s = await stat(join(cwd, 'SHUGU.md'));
    checks.push({ name: 'SHUGU.md', ok: true, detail: `${Math.round(s.size / 1024)}KB` });
  } catch (err) {
    logger.debug('doctor: SHUGU.md stat failed', describeError(err));
    checks.push({ name: 'SHUGU.md', ok: false, detail: 'Not found — run /init to create' });
  }

  // 8. Sessions directory
  const sessDir = join(homedir(), '.pcc', 'sessions');
  try {
    await access(sessDir);
    checks.push({ name: 'Sessions Dir', ok: true, detail: sessDir });
  } catch (err) {
    logger.debug('doctor: sessions dir access failed', describeError(err));
    checks.push({ name: 'Sessions Dir', ok: false, detail: 'Not created yet (auto-created on first save)' });
  }

  // 9. Companion
  try {
    await access(join(homedir(), '.pcc', 'companion.json'));
    checks.push({ name: 'Companion', ok: true, detail: 'Hatched' });
  } catch (err) {
    logger.debug('doctor: companion.json access failed', describeError(err));
    checks.push({ name: 'Companion', ok: false, detail: 'Not hatched yet (launches on first REPL)' });
  }

  // 10. Obsidian vault
  const vaultPath = process.env['PCC_OBSIDIAN_VAULT'];
  if (vaultPath) {
    try {
      await access(join(vaultPath, '.obsidian'));
      checks.push({ name: 'Obsidian Vault', ok: true, detail: vaultPath });
    } catch (err) {
      logger.debug('doctor: vault access failed', describeError(err));
      checks.push({ name: 'Obsidian Vault', ok: false, detail: `Configured but not found: ${vaultPath}` });
    }
  } else {
    checks.push({ name: 'Obsidian Vault', ok: true, detail: 'Not configured (optional)' });
  }

  // 11. Plugin isolation mode — informational, always "ok"
  const dockerDisabled = process.env['PCC_DISABLE_DOCKER'] === '1';
  const nodeMajor = parseInt(process.version.slice(1).split('.')[0] ?? '0', 10);
  let pluginMode: string;
  if (dockerDisabled) {
    pluginMode = 'Docker disabled via PCC_DISABLE_DOCKER — falls back to Node --permission';
  } else if (isDockerAvailable()) {
    pluginMode = 'Docker (auto-detected, strongest isolation)';
  } else if (nodeMajor >= 22) {
    pluginMode = 'Node --permission (Docker not installed, OK for personal use)';
  } else {
    pluginMode = `Bare child process (Node ${process.version} < 22, no OS-level isolation)`;
  }
  checks.push({ name: 'Plugin Isolation', ok: true, detail: pluginMode });

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
