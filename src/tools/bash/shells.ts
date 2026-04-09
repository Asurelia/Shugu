/**
 * Shell Bridge — Multi-Shell Detection & Abstraction
 *
 * Auto-detects the best available shell on the current platform
 * and provides a uniform spawn interface for BashTool.
 *
 * Security note: execSync is used here exclusively with hardcoded
 * binary names (never user input) for synchronous startup detection.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export type ShellType = 'bash' | 'pwsh' | 'zsh' | 'cmd';

export interface ShellConfig {
  type: ShellType;
  path: string;
  args: string[]; // prefix args before the command, e.g. ['-c'] for bash
  envSetup?: string;
}

// ─── Binary Resolution ─────────────────────────────────

/**
 * Check whether a binary exists on the system.
 * Uses `where` on Windows, `which` on Unix.
 * Returns the resolved path or null.
 *
 * Only called with hardcoded shell names — never with user input.
 */
function whichBinary(name: string): string | null {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const result = execSync(`${cmd} ${name}`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5_000,
      encoding: 'utf-8',
    });
    // `where` on Windows can return multiple lines; take the first.
    const firstLine = result.trim().split(/\r?\n/)[0];
    return firstLine && firstLine.length > 0 ? firstLine : null;
  } catch {
    return null;
  }
}

// ─── Shell Config Builders ─────────────────────────────

function bashConfig(path: string): ShellConfig {
  return { type: 'bash', path, args: ['-c'] };
}

function zshConfig(path: string): ShellConfig {
  return { type: 'zsh', path, args: ['-c'] };
}

function pwshConfig(path: string): ShellConfig {
  return {
    type: 'pwsh',
    path,
    args: ['-NoProfile', '-NonInteractive', '-Command'],
  };
}

function cmdConfig(path: string): ShellConfig {
  return { type: 'cmd', path, args: ['/c'] };
}

// ─── Platform-Specific Detection ───────────────────────

function detectWindows(): ShellConfig {
  // 1. Try pwsh (PowerShell 7+)
  const pwsh = whichBinary('pwsh');
  if (pwsh) return pwshConfig(pwsh);

  // 2. Try powershell.exe (Windows PowerShell 5.1)
  const powershell = whichBinary('powershell.exe');
  if (powershell) return pwshConfig(powershell);

  // 3. Try bash (Git Bash / WSL)
  const bash = whichBinary('bash');
  if (bash) return bashConfig(bash);

  // 4. Fallback: cmd.exe via COMSPEC or hard path
  const comspec = process.env['COMSPEC'];
  if (comspec && existsSync(comspec)) return cmdConfig(comspec);

  return cmdConfig('C:\\Windows\\System32\\cmd.exe');
}

function detectUnix(): ShellConfig {
  const platform = process.platform;

  // 1. Honour $SHELL if it exists on disk
  const envShell = process.env['SHELL'];
  if (envShell && existsSync(envShell)) {
    if (envShell.endsWith('/zsh')) return zshConfig(envShell);
    if (envShell.endsWith('/bash')) return bashConfig(envShell);
    // Unknown shell in $SHELL — try it as bash-compatible
    return bashConfig(envShell);
  }

  // 2. macOS: prefer zsh → bash
  if (platform === 'darwin') {
    const zsh = whichBinary('zsh');
    if (zsh) return zshConfig(zsh);

    const bash = whichBinary('bash');
    if (bash) return bashConfig(bash);
  }

  // 3. Linux: prefer bash → zsh
  if (platform === 'linux') {
    const bash = whichBinary('bash');
    if (bash) return bashConfig(bash);

    const zsh = whichBinary('zsh');
    if (zsh) return zshConfig(zsh);
  }

  // 4. Absolute fallback
  if (existsSync('/bin/bash')) return bashConfig('/bin/bash');
  if (existsSync('/bin/sh')) return bashConfig('/bin/sh');

  return bashConfig('/bin/sh');
}

// ─── Public API ────────────────────────────────────────

/**
 * Detect the best default shell for the current platform.
 * Runs once (at import or first call) and is not cached here —
 * callers should cache the result if they need to.
 */
export function detectDefaultShell(): ShellConfig {
  if (process.platform === 'win32') {
    return detectWindows();
  }
  return detectUnix();
}

/**
 * Resolve a specific shell type to a ShellConfig.
 * If no preference is given, auto-detects the best available shell.
 */
export function resolveShell(preference?: ShellType): ShellConfig {
  if (!preference) {
    return detectDefaultShell();
  }

  switch (preference) {
    case 'bash': {
      const bash =
        process.platform === 'win32'
          ? whichBinary('bash')
          : whichBinary('bash') ?? (existsSync('/bin/bash') ? '/bin/bash' : null);
      if (bash) return bashConfig(bash);
      break;
    }
    case 'zsh': {
      const zsh = whichBinary('zsh');
      if (zsh) return zshConfig(zsh);
      break;
    }
    case 'pwsh': {
      const pwsh = whichBinary('pwsh') ?? whichBinary('powershell.exe');
      if (pwsh) return pwshConfig(pwsh);
      break;
    }
    case 'cmd': {
      const comspec = process.env['COMSPEC'];
      if (comspec && existsSync(comspec)) return cmdConfig(comspec);
      return cmdConfig('C:\\Windows\\System32\\cmd.exe');
    }
  }

  // Requested shell not found — fall back to auto-detection
  return detectDefaultShell();
}

/**
 * Return configs for every shell that is available on the current system.
 */
export function getAvailableShells(): ShellConfig[] {
  const shells: ShellConfig[] = [];

  // bash
  const bash =
    process.platform === 'win32'
      ? whichBinary('bash')
      : whichBinary('bash') ?? (existsSync('/bin/bash') ? '/bin/bash' : null);
  if (bash) shells.push(bashConfig(bash));

  // zsh
  const zsh = whichBinary('zsh');
  if (zsh) shells.push(zshConfig(zsh));

  // pwsh / powershell
  const pwsh = whichBinary('pwsh');
  if (pwsh) {
    shells.push(pwshConfig(pwsh));
  } else {
    const powershell = whichBinary('powershell.exe');
    if (powershell) shells.push(pwshConfig(powershell));
  }

  // cmd (Windows only)
  if (process.platform === 'win32') {
    const comspec = process.env['COMSPEC'];
    if (comspec && existsSync(comspec)) {
      shells.push(cmdConfig(comspec));
    } else if (existsSync('C:\\Windows\\System32\\cmd.exe')) {
      shells.push(cmdConfig('C:\\Windows\\System32\\cmd.exe'));
    }
  }

  return shells;
}
