/**
 * Layer 11 — UI: Status bar
 *
 * Persistent bottom status bar with live info.
 * Updates in real-time during streaming.
 *
 * Format:
 *   Model | Project | Context% (used/total) | $cost / $budget | uptime | mode
 */

const R = '\x1b[0m';
const B = '\x1b[1m';
const D = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const MAGENTA = '\x1b[35m';
const WHITE = '\x1b[37m';
const GRAY = '\x1b[90m';
const BG_STATUS = '\x1b[48;5;236m';
const FG_STATUS = '\x1b[38;5;252m';

// ─── Status Bar State ───────────────────────────────────

export interface StatusBarState {
  model: string;
  project: string;
  contextPercent: number;
  contextUsed: number;
  contextTotal: number;
  costUsd: number;
  budgetUsd?: number;
  sessionStartTime: number;
  mode: string;
  isStreaming: boolean;
  brewStartTime?: number;
}

// ─── Rendering ──────────────────────────────────────────

export class StatusBar {
  private state: StatusBarState;
  private lastRender = '';

  constructor(initialState: Partial<StatusBarState> = {}) {
    this.state = {
      model: 'MiniMax-M2.7-highspeed',
      project: 'Project_cc',
      contextPercent: 0,
      contextUsed: 0,
      contextTotal: 204800,
      costUsd: 0,
      sessionStartTime: Date.now(),
      mode: 'default',
      isStreaming: false,
      ...initialState,
    };
  }

  update(partial: Partial<StatusBarState>): void {
    Object.assign(this.state, partial);
  }

  /**
   * Render the status bar string (without positioning).
   * Caller is responsible for placing it at the bottom.
   */
  render(): string {
    const s = this.state;
    const termWidth = process.stdout.columns ?? 120;

    // Context gauge
    const ctxColor = s.contextPercent > 85 ? RED : s.contextPercent > 60 ? YELLOW : GREEN;
    const ctxUsedK = Math.round(s.contextUsed / 1000);
    const ctxTotalK = Math.round(s.contextTotal / 1000);
    const contextStr = `${ctxColor}${s.contextPercent}%${R}${BG_STATUS} (${ctxUsedK}k/${ctxTotalK}k)`;

    // Cost
    const costStr = s.budgetUsd
      ? `$${s.costUsd.toFixed(2)} / $${s.budgetUsd.toFixed(2)}`
      : `$${s.costUsd.toFixed(4)}`;

    // Uptime
    const uptimeStr = formatUptime(Date.now() - s.sessionStartTime);

    // Brew timer
    const brewStr = s.brewStartTime
      ? ` ${MAGENTA}✻ ${formatBrewTime(Date.now() - s.brewStartTime)}${R}${BG_STATUS}`
      : '';

    // Mode with color
    const modeColor = s.mode === 'bypass' ? RED : s.mode === 'fullAuto' ? YELLOW : GREEN;
    const modeStr = `${modeColor}${s.mode}${R}${BG_STATUS}`;

    // Streaming indicator
    const streamIndicator = s.isStreaming ? `${CYAN}⏵⏵${R}${BG_STATUS} ` : '  ';

    // Compose
    const parts = [
      `${B}${WHITE}${shortModel(s.model)}${R}${BG_STATUS}`,
      `${CYAN}${s.project}${R}${BG_STATUS}`,
      contextStr,
      `${FG_STATUS}${costStr}`,
      `${GRAY}${uptimeStr}${R}${BG_STATUS}`,
    ];

    const mainContent = `${BG_STATUS}${FG_STATUS}  ${parts.join(`${GRAY} │ ${R}${BG_STATUS}`)}${brewStr}${R}`;
    const rightPart = `${BG_STATUS}${streamIndicator}${modeStr} permissions${R}`;

    // Pad to terminal width
    const mainVisible = visibleLength(mainContent);
    const rightVisible = visibleLength(rightPart);
    const gap = Math.max(1, termWidth - mainVisible - rightVisible);

    return `${mainContent}${BG_STATUS}${' '.repeat(gap)}${rightPart}${R}`;
  }

  /**
   * Write the status bar to the terminal bottom.
   */
  draw(): void {
    const rendered = this.render();
    if (rendered === this.lastRender) return;
    this.lastRender = rendered;

    const rows = process.stdout.rows ?? 24;
    // Save cursor, move to bottom, write, restore cursor
    process.stdout.write(`\x1b7\x1b[${rows};1H${rendered}\x1b8`);
  }

  /**
   * Clear the status bar.
   */
  clear(): void {
    const rows = process.stdout.rows ?? 24;
    const cols = process.stdout.columns ?? 120;
    process.stdout.write(`\x1b7\x1b[${rows};1H${' '.repeat(cols)}\x1b8`);
    this.lastRender = '';
  }
}

// ─── Helpers ────────────────────────────────────────────

function shortModel(model: string): string {
  if (model.includes('M2.7-highspeed')) return 'M2.7-hs';
  if (model.includes('M2.7')) return 'M2.7';
  if (model.includes('M2.5')) return 'M2.5';
  return model.slice(0, 10);
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m${seconds % 60}s`;
  return `${seconds}s`;
}

function formatBrewTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes > 0) return `Brewed for ${minutes}m ${seconds % 60}s`;
  return `Brewed for ${seconds}s`;
}

function visibleLength(str: string): number {
  return str.replace(/\x1b\[[0-9;]*m/g, '').length;
}
