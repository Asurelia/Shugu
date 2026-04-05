/**
 * Layer 11 — UI: Status bar (autonomous component)
 *
 * Self-contained status bar pinned to the terminal bottom.
 * Completely independent from readline and the REPL loop.
 *
 * Usage:
 *   const bar = new StatusBar({ model: '...', project: '...' });
 *   bar.start();               // begin drawing at terminal bottom
 *   bar.update({ costUsd: 0.05 }); // update state → auto-redraws
 *   bar.stop();                // cleanup on exit
 *
 * Draws itself at absolute position (last row) using save/restore cursor.
 * Only redraws when state actually changes (no flicker).
 */

const R = '\x1b[0m';
const B = '\x1b[1m';
const D = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const MAGENTA = '\x1b[35m';
const GRAY = '\x1b[90m';
const BG = '\x1b[48;5;236m';
const FG = '\x1b[38;5;252m';

// ─── State ──────────────────────────────────────────────

export interface StatusBarState {
  model: string;
  project: string;
  branch?: string;
  contextPercent: number;
  contextUsed: number;
  contextTotal: number;
  costUsd: number;
  budgetUsd?: number;
  sessionStartTime: number;
  mode: string;
  isStreaming: boolean;
}

// ─── Component ──────────────────────────────────────────

export class StatusBar {
  private state: StatusBarState;
  private lastRendered = '';
  private running = false;
  private resizeHandler: (() => void) | null = null;
  private buddyLines: string[] = [];

  /** Set buddy lines to draw above status bar (right-aligned) */
  setBuddy(lines: string[]): void {
    this.buddyLines = lines;
    if (this.running) this.drawBuddy();
  }

  constructor(initial: Partial<StatusBarState> = {}) {
    this.state = {
      model: 'MiniMax-M2.7-highspeed',
      project: '',
      contextPercent: 0,
      contextUsed: 0,
      contextTotal: 204800,
      costUsd: 0,
      sessionStartTime: Date.now(),
      mode: 'default',
      isStreaming: false,
      ...initial,
    };
  }

  /**
   * Start the status bar — draw it and listen for resize.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.draw();
    this.resizeHandler = () => this.draw();
    process.stdout.on('resize', this.resizeHandler);
  }

  /**
   * Stop the status bar — clear it and remove listeners.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.resizeHandler) {
      process.stdout.removeListener('resize', this.resizeHandler);
      this.resizeHandler = null;
    }
    this.clear();
  }

  /**
   * Update state and redraw if changed.
   */
  update(partial: Partial<StatusBarState>): void {
    Object.assign(this.state, partial);
    if (this.running) this.draw();
  }

  /**
   * Force redraw (e.g., after backspace erases bottom).
   */
  redraw(): void {
    this.lastRendered = ''; // force
    this.draw();
  }

  // ─── Rendering ────────────────────────────────────────

  private draw(): void {
    const rendered = this.renderLine();
    if (rendered === this.lastRendered) return;
    this.lastRendered = rendered;

    const row = process.stdout.rows ?? 24;
    process.stdout.write(`\x1b7\x1b[${row};1H\x1b[2K${rendered}\x1b8`);

    // Also redraw buddy above
    this.drawBuddy();
  }

  private drawBuddy(): void {
    if (this.buddyLines.length === 0) return;
    const row = process.stdout.rows ?? 24;
    const w = process.stdout.columns ?? 120;
    const buddyW = 14;
    const col = w - buddyW;

    process.stdout.write('\x1b7'); // save cursor
    for (let i = 0; i < this.buddyLines.length; i++) {
      const r = row - this.buddyLines.length + i;
      if (r < 1) continue;
      // Position at right side of that row
      process.stdout.write(`\x1b[${r};${col}H${this.buddyLines[i]}`);
    }
    process.stdout.write('\x1b8'); // restore cursor
  }

  private clear(): void {
    const row = process.stdout.rows ?? 24;
    const w = process.stdout.columns ?? 120;
    process.stdout.write(`\x1b7\x1b[${row};1H\x1b[2K${' '.repeat(w)}\x1b8`);
    this.lastRendered = '';
  }

  private renderLine(): string {
    const s = this.state;
    const w = process.stdout.columns ?? 120;

    // Left side: model | project | context | cost | uptime
    const ctxColor = s.contextPercent > 85 ? RED : s.contextPercent > 60 ? YELLOW : GREEN;
    const uK = Math.round(s.contextUsed / 1000);
    const tK = Math.round(s.contextTotal / 1000);
    const uptime = fmtUptime(Date.now() - s.sessionStartTime);
    const cost = s.budgetUsd
      ? `$$${s.costUsd.toFixed(2)} / $$${s.budgetUsd.toFixed(2)}`
      : `$$${s.costUsd.toFixed(4)}`;

    const left = `${BG}${FG}  ${shortModel(s.model)} ${GRAY}│${FG} ${CYAN}${s.project}${s.branch ? ` (${s.branch})` : ''}${FG} ${GRAY}│${FG} ${ctxColor}${s.contextPercent}%${FG} (${uK}k/${tK}k) ${GRAY}│${FG} ${cost} ${GRAY}│${FG} ${uptime}${R}`;

    // Right side: mode
    const modeColor = s.mode === 'bypass' ? RED : s.mode === 'fullAuto' ? YELLOW : GREEN;
    const stream = s.isStreaming ? `${CYAN}⏵⏵${R}${BG} ` : '  ';
    const right = `${BG}${stream}${modeColor}${s.mode}${FG} permissions on${R}`;

    // Pad middle
    const leftVis = visLen(left);
    const rightVis = visLen(right);
    const gap = Math.max(1, w - leftVis - rightVis);

    return `${left}${BG}${' '.repeat(gap)}${right}`;
  }
}

// ─── Helpers ────────────────────────────────────────────

function shortModel(m: string): string {
  if (m.includes('M2.7-highspeed')) return 'M2.7-hs';
  if (m.includes('M2.7')) return 'M2.7';
  return m.slice(0, 10);
}

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h${m % 60}m`;
  if (m > 0) return `${m}m${s % 60}s`;
  return `${s}s`;
}

function visLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}
