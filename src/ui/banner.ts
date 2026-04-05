/**
 * Layer 11 — UI: Startup banner
 *
 * Faithful port of the PowerShell banner with:
 * - Full 13-line braille face art (left) with orange gradient
 * - SHUGU ASCII logo (right) with purple gradient
 * - Info box with provider/model/endpoint
 * - Separator lines + prompt
 */

// ─── ANSI RGB Helper ────────────────────────────────────

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

// ─── Gradient Colors ────────────────────────────────────

// Braille face: dark orange → light orange
const ORANGE_START = [160, 64, 0];
const ORANGE_END = [255, 180, 64];

// SHUGU text: deep purple → lavender
const PURPLE_START = [64, 0, 64];
const PURPLE_END = [200, 150, 255];

// ─── Art Data ───────────────────────────────────────────

const FACE_ROWS = [
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

const SHUGU_ROWS = [
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
  tips: string[];
  recentActivity: string[];
}

// ─── Render ─────────────────────────────────────────────

export function renderBanner(info: BannerInfo): string {
  const lines: string[] = [];
  const faceSteps = FACE_ROWS.length;
  const shuguSteps = SHUGU_ROWS.length;
  const faceColWidth = 65;

  // ═══ BRAILLE FACE + SHUGU LOGO ═══
  lines.push('');
  for (let i = 0; i < faceSteps; i++) {
    let line = '';

    // Braille face with orange gradient
    const faceColor = gradient(i, faceSteps, ORANGE_START, ORANGE_END);
    const faceStr = FACE_ROWS[i]!;
    const padLen = Math.max(0, faceColWidth - [...faceStr].length);
    line += `${faceColor}${faceStr}${' '.repeat(padLen)}${R}`;

    // SHUGU text with purple gradient (starts at face row 1, spans 10 rows)
    if (i >= 1 && i < 1 + shuguSteps) {
      const shuguIdx = i - 1;
      const shuguColor = gradient(shuguIdx, shuguSteps, PURPLE_START, PURPLE_END);
      line += `${shuguColor}${SHUGU_ROWS[shuguIdx]}${R}`;
    }

    lines.push(line);
  }

  // ═══ TAGLINE ═══
  lines.push('');
  lines.push(`  ${MAGENTA}✦ Any model. Every tool. Zero limits. ✦${R}`);

  // ═══ INFO BOX ═══
  const boxWidth = 60;
  const toolStr = info.tools.slice(0, 6).join(', ') + (info.tools.length > 6 ? ` +${info.tools.length - 6}` : '');
  const cliStr = info.clis.join(', ') || 'none detected';
  const vaultColor = info.vaultStatus === 'unlocked' ? GREEN : YELLOW;

  lines.push(`${CYAN}╔${'═'.repeat(boxWidth)}╗${R}`);
  lines.push(`${CYAN}║${R} ${B}Provider${R}  ${GREEN}${pad(info.provider, boxWidth - 12)}${R}${CYAN}║${R}`);
  lines.push(`${CYAN}║${R} ${B}Model${R}     ${pad(info.model, boxWidth - 12)}${CYAN}║${R}`);
  lines.push(`${CYAN}║${R} ${B}Endpoint${R}  ${GRAY}${pad(info.endpoint, boxWidth - 12)}${R}${CYAN}║${R}`);
  lines.push(`${CYAN}║${R} ${B}Tools${R}     ${pad(toolStr, boxWidth - 12)}${CYAN}║${R}`);
  lines.push(`${CYAN}║${R} ${B}CLIs${R}      ${pad(cliStr, boxWidth - 12)}${CYAN}║${R}`);
  lines.push(`${CYAN}║${R} ${B}Vault${R}     ${vaultColor}${pad(info.vaultStatus, boxWidth - 12)}${R}${CYAN}║${R}`);
  lines.push(`${CYAN}╠${'═'.repeat(boxWidth)}╣${R}`);
  lines.push(`${CYAN}║${R} ${GREEN}●${R} ${info.provider.toLowerCase()}  ${GREEN}Ready${R} — type ${B}/help${R} to begin${' '.repeat(Math.max(0, boxWidth - 42))}${CYAN}║${R}`);
  lines.push(`${CYAN}╚${'═'.repeat(boxWidth)}╝${R}`);
  lines.push(`${GRAY}  shugu v${info.version}${R}`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Render the separator line between interactions.
 */
export function renderSeparator(): string {
  const w = process.stdout.columns ?? 120;
  return `${GRAY}${'─'.repeat(w)}${R}`;
}

/**
 * Render the bottom status line.
 */
export function renderStatusLine(info: {
  model: string;
  project: string;
  branch?: string;
  contextPercent: number;
  contextUsed: number;
  contextTotal: number;
  costSession: number;
  costTotal: number;
  mode: string;
}): string {
  const usedK = Math.round(info.contextUsed / 1000);
  const totalK = Math.round(info.contextTotal / 1000);
  const ctxColor = info.contextPercent > 85 ? '\x1b[31m' : info.contextPercent > 60 ? '\x1b[33m' : '\x1b[32m';
  const branchStr = info.branch ? ` (${info.branch})` : '';

  const parts = [
    `${D}${info.model}${R}`,
    `${CYAN}${info.project}${branchStr}${R}`,
    `${ctxColor}${info.contextPercent}%${R} ${D}(${usedK}k/${totalK}k)${R}`,
    `${D}$$${info.costSession.toFixed(2)} / $$${info.costTotal.toFixed(2)}${R}`,
  ];

  const left = `  ${parts.join(` ${GRAY}|${R} `)}`;

  const modeColor = info.mode === 'bypass' ? '\x1b[31m' : info.mode === 'fullAuto' ? '\x1b[33m' : '\x1b[32m';
  const right = `${D}⏵⏵ ${modeColor}${info.mode}${R} ${D}permissions on${R}`;

  const w = process.stdout.columns ?? 120;
  const gap = Math.max(1, w - visibleLen(left) - visibleLen(right));

  return `${left}${' '.repeat(gap)}${right}`;
}

// ─── Helpers ────────────────────────────────────────────

function pad(str: string, width: number): string {
  if (str.length >= width) return str.slice(0, width);
  return str + ' '.repeat(width - str.length);
}

function visibleLen(str: string): number {
  return str.replace(/\x1b\[[0-9;]*m/g, '').length;
}
