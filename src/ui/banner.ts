/**
 * Layer 11 — UI: Startup banner
 *
 * Claude Code-style layout with rounded corners:
 * ╭─── Shugu v1.0.0 ──────────────────────────────────────────────────────────────╮
 * │ [braille+SHUGU]                    │ Tips for getting started                  │
 * │                                    │ ...                                       │
 * │ Provider  MiniMax                  │ Recent activity                           │
 * │ Model     MiniMax-M2.7-highspeed   │ ...                                       │
 * │ ...                                │                                           │
 * ╰────────────────────────────────────────────────────────────────────────────────╯
 */

// ─── ANSI RGB ───────────────────────────────────────────

function rgb(r: number, g: number, b: number): string {
  return `\x1b[38;2;${r};${g};${b}m`;
}

function gradient(index: number, steps: number, start: number[], end: number[]): string {
  const ratio = steps > 1 ? index / (steps - 1) : 0;
  const r = Math.round((end[0]! - start[0]!) * ratio + start[0]!);
  const g = Math.round((end[1]! - start[1]!) * ratio + start[1]!);
  const b = Math.round((end[2]! - start[2]!) * ratio + start[2]!);
  return rgb(r, g, b);
}

const R = '\x1b[0m';
const B = '\x1b[1m';
const D = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const MAGENTA = '\x1b[35m';
const WHITE = '\x1b[37m';
const GRAY = '\x1b[90m';

const ORANGE_START = [160, 64, 0];
const ORANGE_END = [255, 180, 64];
const PURPLE_START = [100, 40, 120];
const PURPLE_END = [200, 150, 255];

// ─── Art Data ───────────────────────────────────────────

const FACE = [
  '⣿⠛⠛⠛⠛⠻⡆',
  '⠛⢛⣿⠋⢀⡾⠃',
  '⢠⡟⠁⣴⣿⢤⡄⣴⢶⠶⡆',
  '⠸⢷⣴⣤⡤⠾⠇⣽⠋⠼⣷',
  '⠀⠀⠀⠀⠀⠀⠀⠙⠛⠋⠉',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⣠⠟',
  '⠀⠀⠀⠀⠀⠀⠀⠀⢰⣯⣴',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠈⢹⡏',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⠁',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⡶',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠘⠷',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠘',
];

const SHUGU = [
  ' @@@@@@   @@@  @@@   @@@  @@@    @@@@@@@@   @@@  @@@',
  '@@@@@@@   @@@  @@@   @@@  @@@   @@@@@@@@@   @@@  @@@',
  '!@@       @@!  @@@   @@!  @@@   !@@         @@!  @@@',
  '!@!       !@!  @!@   !@!  @!@   !@!         !@!  @!@',
  '!!@@!!    @!@!@!@!   @!@  !@!   !@! @!@!@   @!@  !@!',
  ' !!@!!!   !!!@!!!!   !@!  !!!   !!! !!@!!   !@!  !!!',
  '     !:!  !!:  !!!   !!:  !!!   :!!   !!:   !!:  !!!',
  '   !:!    :!:  !:!   :!:  !:!   :!:   !::   :!:  !:!',
  ':::: ::   ::   :::   ::::: ::   ::: ::::    ::::: ::',
  ':: : :     :   : :    : :  :    :: :: :      : :  : ',
];

// ─── Banner Info ────────────────────────────────────────

export interface BannerInfo {
  version: string;
  provider: string;
  model: string;
  endpoint: string;
  tools: string[];
  clis: string[];
  mode: string;
  projectName: string;
  vaultStatus: string;
  cwd: string;
  tips: string[];
  recentActivity: string[];
}

// ─── Render ─────────────────────────────────────────────

export function renderBanner(info: BannerInfo): string {
  const W = process.stdout.columns ?? 120;
  const innerW = W - 2; // inside ╭...╯
  const splitPos = Math.floor(innerW * 0.52); // left column width
  const rightW = innerW - splitPos - 1; // -1 for the │ divider
  const lines: string[] = [];

  const bdr = GRAY;
  const title = ` Shugu v${info.version} `;

  // ╭─── Shugu v1.0.0 ─────────...─╮
  lines.push(`${bdr}╭───${R}${B}${title}${R}${bdr}${'─'.repeat(Math.max(0, innerW - title.length - 3))}╮${R}`);

  // Build all left-side rows
  const leftRows: string[] = [];

  // Braille + SHUGU combined rows
  const artRows = Math.max(FACE.length, SHUGU.length + 1);
  for (let i = 0; i < artRows; i++) {
    let row = '';
    // Face
    const faceColor = gradient(Math.min(i, FACE.length - 1), FACE.length, ORANGE_START, ORANGE_END);
    const faceStr = FACE[i] ?? '';
    row += `${faceColor}${faceStr}${R}`;
    // Pad between face and shugu
    const faceVisLen = [...faceStr].length;
    const gap = Math.max(1, 12 - faceVisLen);
    row += ' '.repeat(gap);
    // SHUGU (starts at face row 1)
    if (i >= 1 && i - 1 < SHUGU.length) {
      const si = i - 1;
      const shuguColor = gradient(si, SHUGU.length, PURPLE_START, PURPLE_END);
      row += `${shuguColor}${SHUGU[si]}${R}`;
    }
    leftRows.push(row);
  }

  // Blank line
  leftRows.push('');

  // Info rows
  const toolStr = info.tools.slice(0, 6).join(', ') + (info.tools.length > 6 ? ` +${info.tools.length - 6}` : '');
  const cliStr = info.clis.join(', ') || 'none detected';
  const vaultColor = info.vaultStatus === 'unlocked' ? GREEN : YELLOW;

  leftRows.push(`  ${B}Provider${R}  ${GREEN}${info.provider}${R}`);
  leftRows.push(`  ${B}Model${R}     ${CYAN}${info.model}${R}`);
  leftRows.push(`  ${B}Endpoint${R}  ${D}${info.endpoint}${R}`);
  leftRows.push(`  ${B}Tools${R}     ${toolStr}`);
  leftRows.push(`  ${B}CLIs${R}      ${cliStr}`);
  leftRows.push(`  ${B}Vault${R}     ${vaultColor}${info.vaultStatus}${R}`);
  leftRows.push(`  ${B}Mode${R}      ${info.mode}`);
  leftRows.push('');
  leftRows.push(`  ${GREEN}●${R} ${info.provider.toLowerCase()}  ${GREEN}Ready${R} — type ${B}/help${R} to begin`);
  leftRows.push(`           ${D}${info.cwd}${R}`);

  // Build right-side rows
  const rightRows: string[] = [];
  rightRows.push(`${B}${WHITE}Tips for getting started${R}`);
  rightRows.push(`Run ${B}/init${R} to create a CLAUDE.md file with instructions`);
  rightRows.push(`${GRAY}${'─'.repeat(rightW - 1)}${R}`);
  rightRows.push(`${B}${WHITE}Recent activity${R}`);

  if (info.recentActivity.length > 0) {
    for (const act of info.recentActivity.slice(0, 5)) {
      rightRows.push(`${GRAY}${act}${R}`);
    }
  } else {
    rightRows.push(`${GRAY}No recent activity${R}`);
  }

  // Pad right to match left height
  while (rightRows.length < leftRows.length) {
    rightRows.push('');
  }

  // Combine left + right into bordered rows
  const totalRows = Math.max(leftRows.length, rightRows.length);
  for (let i = 0; i < totalRows; i++) {
    const left = padVis(leftRows[i] ?? '', splitPos);
    const right = padVis(rightRows[i] ?? '', rightW);
    lines.push(`${bdr}│${R}${left}${bdr}│${R} ${right}${bdr}│${R}`);
  }

  // ╰──────...──╯
  lines.push(`${bdr}╰${'─'.repeat(innerW)}╯${R}`);

  return lines.join('\n');
}

// ─── Separator & Status ─────────────────────────────────

export function renderSeparator(): string {
  const w = process.stdout.columns ?? 120;
  return `${GRAY}${'─'.repeat(w)}${R}`;
}

export function renderStatusLine(info: {
  model: string; project: string; branch?: string;
  contextPercent: number; contextUsed: number; contextTotal: number;
  costSession: number; costTotal: number; mode: string;
}): string {
  const usedK = Math.round(info.contextUsed / 1000);
  const totalK = Math.round(info.contextTotal / 1000);
  const ctxColor = info.contextPercent > 85 ? '\x1b[31m' : info.contextPercent > 60 ? '\x1b[33m' : '\x1b[32m';
  const branchStr = info.branch ? ` (${info.branch})` : '';

  const left = `  ${D}${shortModel(info.model)}${R} ${GRAY}|${R} ${CYAN}${info.project}${branchStr}${R} ${GRAY}|${R} ${ctxColor}${info.contextPercent}%${R} ${D}(${usedK}k/${totalK}k)${R} ${GRAY}|${R} ${D}$$${info.costSession.toFixed(2)} / $$${info.costTotal.toFixed(2)}${R}`;
  const modeColor = info.mode === 'bypass' ? '\x1b[31m' : info.mode === 'fullAuto' ? '\x1b[33m' : '\x1b[32m';
  const right = `${D}⏵⏵ ${modeColor}${info.mode}${R} ${D}permissions on${R}`;

  const w = process.stdout.columns ?? 120;
  const gap = Math.max(1, w - visLen(left) - visLen(right));
  return `${left}${' '.repeat(gap)}${right}`;
}

function shortModel(m: string): string {
  if (m.includes('M2.7-highspeed')) return 'M2.7-hs';
  if (m.includes('M2.7')) return 'M2.7';
  return m.slice(0, 10);
}

function visLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function padVis(s: string, w: number): string {
  const v = visLen(s);
  if (v >= w) return s;
  return s + ' '.repeat(w - v);
}
