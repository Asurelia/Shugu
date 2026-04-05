/**
 * Layer 11 — UI: Startup banner
 *
 * PART 1: Free braille face + SHUGU ASCII (no frame, gradient colors)
 * PART 2: Claude Code-style ╭╯ frame with elf + info | tips
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

const OS = [160, 64, 0], OE = [255, 180, 64];
const PS = [64, 0, 64], PE = [200, 150, 255];

// ─── Art Data ───────────────────────────────────────────

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

// Elf — same braille chars as the PS script, same orange gradient as big face
const ELF_PLAIN = [
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
  const faceN = FACE.length;
  const shuguN = SHUGU.length;

  // ═══ PART 1: Free braille + SHUGU above the frame ═══
  lines.push('');
  for (let i = 0; i < faceN; i++) {
    const fc = grad(i, faceN, OS, OE);
    const fs = FACE[i]!;
    let line = `${fc}${fs}${R}`;

    if (i >= 1 && i - 1 < shuguN) {
      const si = i - 1;
      const sc = grad(si, shuguN, PS, PE);
      line += `  ${sc}${SHUGU[si]}${R}`;
    }
    lines.push(line);
  }
  lines.push('');

  // ═══ PART 2: Frame with elf + info | tips ═══
  const W = Math.min(process.stdout.columns ?? 120, 140);
  const innerW = W - 2; // inside │...│
  const leftW = Math.floor(innerW * 0.5);
  const rightW = innerW - leftW - 1; // -1 for middle │
  const bdr = GRAY;
  const title = ` Shugu v${info.version} `;

  // ── Top border ──
  lines.push(`${bdr}╭───${R}${B}${title}${R}${bdr}${'─'.repeat(Math.max(0, innerW - visL(`───${title}`)))}╮${R}`);

  // ── Build left rows: elf + info ──
  const toolStr = info.tools.slice(0, 6).join(', ') + (info.tools.length > 6 ? ` +${info.tools.length - 6}` : '');
  const cliStr = truncPlain(info.clis.join(', ') || 'none', leftW - 28);
  const vc = info.vaultStatus === 'unlocked' ? GREEN : YELLOW;

  // Pre-build info strings (plain text + colored version)
  const infoEntries = [
    { label: 'Provider', value: info.provider, color: GREEN },
    { label: 'Model   ', value: info.model, color: CYAN },
    { label: 'Endpoint', value: truncPlain(info.endpoint, leftW - 28), color: D },
    { label: 'Tools   ', value: truncPlain(toolStr, leftW - 28), color: '' },
    { label: 'CLIs    ', value: truncPlain(cliStr, leftW - 28), color: '' },
    { label: 'Vault   ', value: info.vaultStatus, color: vc },
    { label: 'Mode    ', value: info.mode, color: '' },
  ];

  const leftLines: string[] = [];
  for (let i = 0; i < Math.max(ELF_PLAIN.length, infoEntries.length + 3); i++) {
    const elfStr = ELF_PLAIN[i] ?? '';
    // Same orange gradient as the big braille face
    const elfColor = elfStr ? grad(i, ELF_PLAIN.length, OS, OE) : '';
    const elfPad = 20; // fixed column for elf

    let row = '';
    if (elfStr) {
      row = ` ${elfColor}${elfStr}${R}`;
      const elfVisW = visL(row);
      row += ' '.repeat(Math.max(1, elfPad - elfVisW));
    } else {
      row = ' '.repeat(elfPad + 1);
    }

    if (i < infoEntries.length) {
      const e = infoEntries[i]!;
      row += `${B}${e.label}${R}  ${e.color}${e.value}${R}`;
    } else if (i === infoEntries.length + 1) {
      row = `  ${GREEN}●${R} ${info.provider.toLowerCase()}  ${GREEN}Ready${R} — type ${B}/help${R} to begin`;
    } else if (i === infoEntries.length + 2) {
      row = `           ${D}${truncPlain(info.cwd, leftW - 12)}${R}`;
    }

    leftLines.push(row);
  }

  // ── Build right rows: tips + activity ──
  const rightLines: string[] = [];
  rightLines.push(`${B}${WHITE}Tips for getting started${R}`);
  rightLines.push(`Run ${B}/init${R} to create a CLAUDE.md with instructions`);
  rightLines.push(`${GRAY}${'─'.repeat(Math.max(10, rightW - 2))}${R}`);
  rightLines.push(`${B}${WHITE}Recent activity${R}`);
  if (info.recentActivity.length > 0) {
    for (const a of info.recentActivity.slice(0, 4)) {
      rightLines.push(`${GRAY}${truncPlain(a, rightW - 2)}${R}`);
    }
  } else {
    rightLines.push(`${GRAY}No recent activity${R}`);
  }
  while (rightLines.length < leftLines.length) rightLines.push('');

  // ── Combine left | right ──
  for (let i = 0; i < leftLines.length; i++) {
    const left = padV(leftLines[i]!, leftW);
    const right = padV(rightLines[i] ?? '', rightW);
    lines.push(`${bdr}│${R}${left}${bdr}│${R}${right}${bdr}│${R}`);
  }

  // ── Bottom border ──
  lines.push(`${bdr}╰${'─'.repeat(innerW)}╯${R}`);

  return lines.join('\n');
}

// ─── Separator & Status exports ─────────────────────────

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
  return `  ${D}M2.7-hs${R} ${GRAY}|${R} ${CYAN}${info.project}${br}${R} ${GRAY}|${R} ${cc}${info.contextPercent}%${R} ${D}(${uK}k/${tK}k)${R} ${GRAY}|${R} ${D}$$${info.costSession.toFixed(2)} / $$${info.costTotal.toFixed(2)}${R}`;
}

// ─── Helpers ────────────────────────────────────────────

function visL(s: string): number { return s.replace(/\x1b\[[0-9;]*m/g, '').length; }

function padV(s: string, w: number): string {
  const v = visL(s);
  if (v >= w) return s;
  return s + ' '.repeat(w - v);
}

function truncPlain(s: string, maxLen: number): string {
  if (maxLen <= 0) return s;
  return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
}
