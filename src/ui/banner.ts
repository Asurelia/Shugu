/**
 * Layer 11 — UI: Startup banner
 *
 * PART 1: Free braille face + SHUGU ASCII (gradient, no frame)
 * PART 2: Simple ╭╯ frame — elf centered, then minimal info below
 *
 * No side-by-side layout = no wrapping/breaking on narrow terminals.
 */

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
const GRAY = '\x1b[90m';

const OS = [160, 64, 0], OE = [255, 180, 64];
const PS = [64, 0, 64], PE = [200, 150, 255];

// ─── Art ────────────────────────────────────────────────

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

const ELF = [
  '⠀⠀⠀⠀⣀⣀⣀⣀⡀⠀⠀⠀⠀',
  '⠀⢀⡤⠤⡤⠞⠁⠀⡀⠀⠨⡙⠦⡠⠤',
  '⠀⡛⢐⠉⡠⠂⠀⡰⠣⣀⠀⠑⠄⠈⡄⢃',
  '⠀⡇⡸⠀⡄⣀⡾⠀⠀⢠⣽⢄⢀⠢⠸⠸⡀',
  '⠲⣒⢞⢺⡁⢸⠊⣠⡄⠀⠀⢠⣄⠈⡇⠰⣾⠚⢖',
  '⠀⢑⡶⣙⣦⢣⠀⠀⡀⡀⡀⠀⠀⣅⢤⣜⠕',
  '⠀⡇⠃⢺⠞⠛⢧⣀⣉⣉⢀⣀⠭⠿⢬⣄⢘',
  '⢸⠁⢀⢻⠀⠀⡎⠀⠐⠒⠓⡄⠀⠹⠀⢸⢟⠿',
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

  // ═══ PART 1: Free braille + SHUGU ═══
  lines.push('');
  for (let i = 0; i < FACE.length; i++) {
    const fc = grad(i, FACE.length, OS, OE);
    let line = `${fc}${FACE[i]}${R}`;
    if (i >= 1 && i - 1 < SHUGU.length) {
      const si = i - 1;
      line += `  ${grad(si, SHUGU.length, PS, PE)}${SHUGU[si]}${R}`;
    }
    lines.push(line);
  }
  lines.push('');

  // ═══ PART 2: Simple frame — elf on top, info below ═══
  const W = Math.min(process.stdout.columns ?? 120, 120);
  const innerW = W - 2;
  const title = ` Shugu v${info.version} `;
  const vc = info.vaultStatus === 'unlocked' ? GREEN : YELLOW;

  lines.push(`${GRAY}╭───${R}${B}${title}${R}${GRAY}${'─'.repeat(Math.max(0, innerW - title.length - 3))}╮${R}`);

  // Elf lines (centered-ish, each on its own line, orange gradient)
  for (let i = 0; i < ELF.length; i++) {
    const elfColor = grad(i, ELF.length, OS, OE);
    const content = `    ${elfColor}${ELF[i]}${R}`;
    lines.push(`${GRAY}│${R}${padV(content, innerW)}${GRAY}│${R}`);
  }

  // Blank line
  lines.push(`${GRAY}│${R}${' '.repeat(innerW)}${GRAY}│${R}`);

  // Info lines (simple, no side-by-side)
  const infoRows = [
    `   ${B}Provider${R}  ${GREEN}${info.provider}${R}`,
    `   ${B}Model${R}     ${CYAN}${info.model}${R}`,
    `   ${B}Vault${R}     ${vc}${info.vaultStatus}${R}`,
    '',
    `   ${GREEN}●${R} ${info.provider.toLowerCase()}  ${GREEN}Ready${R} — type ${B}/help${R} to begin`,
    `              ${D}${info.cwd}${R}`,
  ];

  for (const row of infoRows) {
    lines.push(`${GRAY}│${R}${padV(row, innerW)}${GRAY}│${R}`);
  }

  lines.push(`${GRAY}╰${'─'.repeat(innerW)}╯${R}`);

  return lines.join('\n');
}

// ─── Exports for status bar ─────────────────────────────

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
  return `  ${D}M2.7-hs${R} ${GRAY}|${R} ${CYAN}${info.project}${br}${R} ${GRAY}|${R} ${cc}${info.contextPercent}%${R} ${D}(${uK}k/${tK}k)${R} ${GRAY}|${R} ${D}$$${info.costSession.toFixed(2)} / $$${info.costTotal.toFixed(2)}${R}`;
}

// ─── Helpers ────────────────────────────────────────────

function visL(s: string): number { return s.replace(/\x1b\[[0-9;]*m/g, '').length; }
function padV(s: string, w: number): string { const v = visL(s); return v >= w ? s : s + ' '.repeat(w - v); }
