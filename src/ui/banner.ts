/**
 * Layer 11 — UI: Startup banner
 *
 * Full-width ASCII art banner with live info panels.
 * Box-drawing characters, color-coded status, tips panel.
 */

// ─── ANSI ───────────────────────────────────────────────

const R = '\x1b[0m';
const B = '\x1b[1m';
const D = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const MAGENTA = '\x1b[35m';
const BLUE = '\x1b[34m';
const WHITE = '\x1b[37m';
const GRAY = '\x1b[90m';
const BG_DARK = '\x1b[48;5;235m';

// ─── ASCII Art ──────────────────────────────────────────

const SHUGU_ART = [
  `${CYAN}          ⣿⠛⠛⠛⠛⠻⡆${R}`,
  `${CYAN}          ⠛⢛⣿⠋⢀⡾⠃${R}`,
  `${CYAN}          ⢠⡟⠁⣴⣿⢤⡄${R}`,
  `${CYAN}          ⠸⢷⣴⣤⡤⠾⠇${R}`,
];

const LOGO_TEXT = [
  `${B}${CYAN}   @@@@@@   @@@  @@@   @@@  @@@    @@@@@@@@   @@@  @@@${R}`,
  `${B}${CYAN}  @@@@@@@   @@@  @@@   @@@  @@@   @@@@@@@@@   @@@  @@@${R}`,
  `${CYAN}  !@@       @@!  @@@   @@!  @@@   !@@         @@!  @@@${R}`,
  `${CYAN}  !@!       !@!  @!@   !@!  @!@   !@!         !@!  @!@${R}`,
  `${B}${MAGENTA}  !!@@!!    @!@!@!@!   @!@  !@!   !@! @!@!@   @!@  !@!${R}`,
  `${B}${MAGENTA}   !!@!!!   !!!@!!!!   !@!  !!!   !!! !!@!!   !@!  !!!${R}`,
  `${YELLOW}       !:!  !!:  !!!   !!:  !!!   :!!   !!:   !!:  !!!${R}`,
  `${YELLOW}      !:!   :!:  !:!   :!:  !:!   :!:   !::   :!:  !:!${R}`,
  `${RED}  :::: ::   ::   :::   ::::: ::   ::: ::::    ::::: ::${R}`,
  `${RED}  :: : :     :   : :    : :  :    :: :: :      : :  :${R}`,
];

// ─── Banner Builder ─────────────────────────────────────

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

export function renderBanner(info: BannerInfo): string {
  const termWidth = process.stdout.columns ?? 120;
  const midPoint = Math.floor(termWidth * 0.55);
  const rightWidth = termWidth - midPoint - 3;
  const lines: string[] = [];

  // Top border
  lines.push(`${GRAY}╔${'═'.repeat(midPoint)}╦${'═'.repeat(rightWidth)}╗${R}`);

  // Logo + right panel header
  const rightHeader = `${B}${WHITE}Tips for getting started${R}`;
  for (let i = 0; i < LOGO_TEXT.length; i++) {
    const left = padVisible(LOGO_TEXT[i] ?? '', midPoint);
    let right = '';
    if (i === 0) {
      right = rightHeader;
    } else if (i === 1) {
      right = `${CYAN}Run /help to see all commands${R}`;
    } else if (i === 2) {
      right = `${GRAY}${'─'.repeat(rightWidth - 2)}${R}`;
    } else if (i === 3) {
      right = `${B}${WHITE}Recent activity${R}`;
    } else if (i >= 4 && i - 4 < info.recentActivity.length) {
      right = `${GRAY}${info.recentActivity[i - 4]!.slice(0, rightWidth - 2)}${R}`;
    } else if (i >= 4 && info.recentActivity.length === 0 && i === 4) {
      right = `${GRAY}No recent activity${R}`;
    }
    right = padVisible(right, rightWidth);
    lines.push(`${GRAY}║${R}${left}${GRAY}║${R}${right}${GRAY}║${R}`);
  }

  // Info section
  const infoLines = [
    `${B} Provider${R}  ${GREEN}${info.provider}${R}`,
    `${B} Model${R}     ${CYAN}${info.model}${R}`,
    `${B} Endpoint${R}  ${GRAY}${info.endpoint}${R}`,
    `${B} Tools${R}     ${info.tools.slice(0, 8).join(', ')}${info.tools.length > 8 ? ` +${info.tools.length - 8}` : ''}`,
    `${B} CLIs${R}      ${info.clis.join(', ') || 'none detected'}`,
    `${B} Vault${R}     ${info.vaultStatus}`,
    '',
    `  ${GREEN}●${R} ${info.provider.toLowerCase()}  ${GREEN}Ready${R} — type ${B}/help${R} to begin`,
  ];

  // Tips for right panel
  const tipLines = info.tips.length > 0 ? info.tips : [
    '/commit — auto-generate commit message',
    '/memory — search Obsidian vault',
    '/compact — compress conversation',
    '/mode auto — enable auto-approve mode',
    '/context — check token usage',
  ];

  for (let i = 0; i < Math.max(infoLines.length, tipLines.length + 2); i++) {
    const left = padVisible(infoLines[i] ?? '', midPoint);
    let right = '';
    if (i < tipLines.length) {
      right = `${GRAY}${tipLines[i]!.slice(0, rightWidth - 2)}${R}`;
    }
    right = padVisible(right, rightWidth);
    lines.push(`${GRAY}║${R}${left}${GRAY}║${R}${right}${GRAY}║${R}`);
  }

  // Bottom border
  lines.push(`${GRAY}╚${'═'.repeat(midPoint)}╩${'═'.repeat(rightWidth)}╝${R}`);

  return lines.join('\n');
}

// ─── Visible Length Calculation ──────────────────────────

function visibleLength(str: string): number {
  // Strip ANSI escape codes for length calculation
  return str.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function padVisible(str: string, width: number): string {
  const visible = visibleLength(str);
  if (visible >= width) return str;
  return str + ' '.repeat(width - visible);
}
