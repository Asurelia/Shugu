/**
 * Layer 11 — UI: Startup banner
 *
 * Layout:
 *   [braille face gradient]  [SHUGU ASCII gradient]    ← FREE, no frame
 *
 *   ╭─── Shugu v1.0.0 ───────────────────────────────────────────────────────╮
 *   │                                    │ Tips for getting started           │
 *   │   [cute elf]   Provider  MiniMax   │ Run /init to create a CLAUDE.md   │
 *   │                Model     M2.7-hs   │ ────────────────────────────────  │
 *   │                Endpoint  ...       │ Recent activity                    │
 *   │                ...                 │ No recent activity                 │
 *   │                                    │                                    │
 *   │   ● minimax  Ready                │                                    │
 *   │              F:\Dev\Project\...    │                                    │
 *   ╰────────────────────────────────────────────────────────────────────────╯
 */

// ─── ANSI ───────────────────────────────────────────────

function rgb(r: number, g: number, b: number): string {
  return `\x1b[38;2;${r};${g};${b}m`;
}

function grad(i: number, n: number, s: number[], e: number[]): string {
  const r = n > 1 ? i / (n - 1) : 0;
  return rgb(
    Math.round((e[0]! - s[0]!) * r + s[0]!),
    Math.round((e[1]! - s[1]!) * r + s[1]!),
    Math.round((e[2]! - s[2]!) * r + s[2]!),
  );
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

// Braille: dark orange → light orange
const OS = [160, 64, 0], OE = [255, 180, 64];
// SHUGU: deep purple → lavender
const PS = [64, 0, 64], PE = [200, 150, 255];

// ─── Full braille face (13 lines, 65 col fixed) ────────

const FACE = [
  '⣿⠛⠛⠛⠛⠻⡆⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
  '⠛⢛⣿⠋⢀⡾⠃⠀⠀⠀⠀⢀⣤⣤⠤⠤⣤⣤⣀⣀⣀⣠⠶⡶⣤⣀⣠⠾⡷⣦⣀⣤⣤⡤⠤⠦⢤⣤⣄⡀⠀⢠⡶⢶⡄⠀⠀',
  '⢠⡟⠁⣴⣿⢤⡄⣴⢶⠶⡆⠈⢷⡀⠀⠀⠀⠀⢀⣭⣫⠵⠥⠽⣄⣝⠵⢍⣘⣄⠳⣤⣀⠀⠀⢀⡤⠊⣽⠁⠀⠸⣇⠀⢿⠀⠀',
  '⠸⢷⣴⣤⡤⠾⠇⣽⠋⠼⣷⠀⠈⢷⡄⢀⣤⡶⠋⠀⣀⡄⠤⠀⡲⡆⠀⠀⠈⠙⡄⠘⢮⢳⡴⠯⣀⢠⡏⠀⠀⠀⢻⠀⢸⠇⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠙⠛⠋⠉⢀⣴⠟⠉⢯⡞⡠⢲⠉⣼⠀⠀⡰⠁⡇⢀⢷⠀⣄⢵⠀⠈⡟⢄⠀⠀⠙⢷⣤⣤⣤⡿⢢⡿⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣠⠟⠑⠊⠁⡼⣌⢠⢿⢸⢸⡀⢰⠁⡸⡇⡸⣸⢰⢈⠘⡄⠀⢸⠀⢣⡀⠀⠈⢮⢢⣏⣤⡾⠃⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⢰⣯⣴⠞⡠⣼⠁⡘⣾⠏⣿⢇⣳⣸⣞⣀⢱⣧⣋⣞⡜⢳⡇⠀⢸⠀⢆⢧⠀⠰⣄⢏⢧⣾⠁⠀⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⢹⡏⢰⠁⡻⠀⡟⡏⠉⠀⣀⠀⠀⠀⠀⣀⠁⠀⠉⠛⢽⠇⠀⣼⡆⠈⡆⠃⠀⡏⠻⣾⣽⣇⡀⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⠁⡇⠀⡇⡄⣿⠷⠿⠿⠛⠀⠀⠀⠀⠛⠻⠿⠿⠿⡜⢀⡴⡟⢸⣸⡼⠀⠀⡇⠀⡞⡆⢻⠙⢦⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⡶⢀⣼⣿⣬⣽⠧⠬⠇⠀⠀⠀⠀⠀⠀⢞⣯⣭⢺⣔⣪⣾⣤⠺⡇⢳⠀⢠⣧⡾⠛⠛⠻⠶⠞⠁',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠘⠷⢿⠟⠉⡀⠈⢦⡀⠀⠀⣠⠖⠒⠒⢤⡀⠀⢀⡼⠿⢇⡣⢬⣶⠷⢿⣤⡾⠁⠀⠀⠀⠀⠀⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠘⠷⠾⠷⠖⠛⠛⠲⠶⠿⠤⣤⠤⠤⢷⣶⠋⠀⠀⠀⣱⠞⠁⠀⠈⠉⠀⠀⠀⠀⠀⠀⠀⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠛⠓⠒⠚⠋⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
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

// ─── Cute elf for inside the frame ──────────────────────

const ELF = [
  `${D}   ⠀⠀⠀⣀⣀⣀⣀⡀⠀⠀⠀${R}`,
  `${D}  ⢀⡤⠤⡤⠞⠁⠀⡀⠀⠨⡙⠦⡠⠤${R}`,
  `${CYAN}  ⡛⢐⠉⡠⠂⠀⡰⠣⣀⠀⠑⠄⠈⡄⢃${R}`,
  `${CYAN}  ⡇⡸⠀⡄⣀⡾⠀⠀⢠⣽⢄⢀⠢⠸⠸${R}`,
  `${MAGENTA}  ⠲⣒⢞⢺⡁⢸⠊⣠⡄⠀⢠⣄⠈⡇⠰${R}`,
  `${MAGENTA}  ⢑⡶⣙⣦⢣⠀⠀⡀⡀⡀⠀⠀⣅⢤⣜${R}`,
  `${YELLOW}  ⡇⠃⢺⠞⠛⢧⣀⣉⣉⢀⣀⠭⠿⢬⣄${R}`,
  `${YELLOW}  ⢸⠁⢀⢻⠀⠀⡎⠀⠐⠒⠓⡄⠀⠹⠀${R}`,
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
  const lines: string[] = [];
  const faceN = FACE.length;
  const shuguN = SHUGU.length;
  const faceW = 65;

  // ═══ PART 1: Free braille + SHUGU (no frame) ═══
  lines.push('');
  for (let i = 0; i < faceN; i++) {
    let line = '';
    const fc = grad(i, faceN, OS, OE);
    const fs = FACE[i]!;
    const pad = Math.max(0, faceW - [...fs].length);
    line += `${fc}${fs}${' '.repeat(pad)}${R}`;

    if (i >= 1 && i - 1 < shuguN) {
      const si = i - 1;
      const sc = grad(si, shuguN, PS, PE);
      line += `${sc}${SHUGU[si]}${R}`;
    }
    lines.push(line);
  }
  lines.push('');

  // ═══ PART 2: Claude Code-style frame with elf + info ═══
  const W = process.stdout.columns ?? 120;
  const innerW = W - 2;
  const splitPos = Math.floor(innerW * 0.48);
  const rightW = innerW - splitPos - 1;
  const bdr = GRAY;
  const title = ` Shugu v${info.version} `;

  // Top border
  lines.push(`${bdr}╭───${R}${B}${title}${R}${bdr}${'─'.repeat(Math.max(0, innerW - title.length - 3))}╮${R}`);

  // Build left content: elf + info side by side
  const elfW = 18;
  const toolStr = info.tools.slice(0, 6).join(', ') + (info.tools.length > 6 ? ` +${info.tools.length - 6}` : '');
  const cliStr = info.clis.join(', ') || 'none detected';
  const vc = info.vaultStatus === 'unlocked' ? GREEN : YELLOW;

  const infoLines = [
    `${B}Provider${R}  ${GREEN}${info.provider}${R}`,
    `${B}Model${R}     ${CYAN}${info.model}${R}`,
    `${B}Endpoint${R}  ${D}${info.endpoint}${R}`,
    `${B}Tools${R}     ${toolStr}`,
    `${B}CLIs${R}      ${cliStr}`,
    `${B}Vault${R}     ${vc}${info.vaultStatus}${R}`,
    `${B}Mode${R}      ${info.mode}`,
    '',
  ];

  const leftRows: string[] = [];
  const maxRows = Math.max(ELF.length, infoLines.length + 2);
  for (let i = 0; i < maxRows; i++) {
    const elf = ELF[i] ?? '';
    const inf = infoLines[i] ?? '';
    if (elf) {
      leftRows.push(` ${elf}  ${inf}`);
    } else if (i === maxRows - 2) {
      leftRows.push(`  ${GREEN}●${R} ${info.provider.toLowerCase()}  ${GREEN}Ready${R} — type ${B}/help${R} to begin`);
    } else if (i === maxRows - 1) {
      leftRows.push(`           ${D}${info.cwd}${R}`);
    } else {
      leftRows.push(`${''.padEnd(elfW)} ${inf}`);
    }
  }

  // Build right content: tips + activity
  const rightRows: string[] = [];
  rightRows.push(`${B}${WHITE}Tips for getting started${R}`);
  rightRows.push(`Run ${B}/init${R} to create a CLAUDE.md with instructions`);
  rightRows.push(`${GRAY}${'─'.repeat(rightW - 1)}${R}`);
  rightRows.push(`${B}${WHITE}Recent activity${R}`);
  if (info.recentActivity.length > 0) {
    for (const a of info.recentActivity.slice(0, 4)) rightRows.push(`${GRAY}${a}${R}`);
  } else {
    rightRows.push(`${GRAY}No recent activity${R}`);
  }
  while (rightRows.length < leftRows.length) rightRows.push('');

  // Combine
  for (let i = 0; i < leftRows.length; i++) {
    const left = padV(leftRows[i]!, splitPos);
    const right = padV(rightRows[i] ?? '', rightW);
    lines.push(`${bdr}│${R}${left}${bdr}│${R} ${right}${bdr}│${R}`);
  }

  // Bottom border
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
  const uK = Math.round(info.contextUsed / 1000);
  const tK = Math.round(info.contextTotal / 1000);
  const cc = info.contextPercent > 85 ? '\x1b[31m' : info.contextPercent > 60 ? '\x1b[33m' : '\x1b[32m';
  const br = info.branch ? ` (${info.branch})` : '';
  const mc = info.mode === 'bypass' ? '\x1b[31m' : info.mode === 'fullAuto' ? '\x1b[33m' : '\x1b[32m';

  const left = `  ${D}${shortM(info.model)}${R} ${GRAY}|${R} ${CYAN}${info.project}${br}${R} ${GRAY}|${R} ${cc}${info.contextPercent}%${R} ${D}(${uK}k/${tK}k)${R} ${GRAY}|${R} ${D}$$${info.costSession.toFixed(2)} / $$${info.costTotal.toFixed(2)}${R}`;
  const right = `${D}⏵⏵ ${mc}${info.mode}${R} ${D}permissions on${R}`;
  const w = process.stdout.columns ?? 120;
  const g = Math.max(1, w - visL(left) - visL(right));
  return `${left}${' '.repeat(g)}${right}`;
}

function shortM(m: string): string {
  return m.includes('M2.7-highspeed') ? 'M2.7-hs' : m.includes('M2.7') ? 'M2.7' : m.slice(0, 10);
}
function visL(s: string): number { return s.replace(/\x1b\[[0-9;]*m/g, '').length; }
function padV(s: string, w: number): string { const v = visL(s); return v >= w ? s : s + ' '.repeat(w - v); }
