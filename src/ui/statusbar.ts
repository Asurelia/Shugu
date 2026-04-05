/**
 * Layer 11 — UI: Status bar (autonomous bottom component)
 *
 * Draws a fixed block at the very bottom of the terminal:
 *
 *   [buddy right-aligned]     ← lines row-7 to row-2
 *   M2.7-hs | Project | ...  ← row-1 (status line)
 *   ⏵⏵ mode permissions on   ← row   (last line)
 *
 * Uses absolute ANSI positioning. Never interferes with readline.
 * Only redraws when state changes (diff check).
 */

const R = '\x1b[0m';
const B = '\x1b[1m';
const D = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
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
  private lastHash = '';
  private running = false;
  private resizeHandler: (() => void) | null = null;
  private buddyLines: string[] = [];

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

  /** Set buddy ASCII lines to draw right-aligned above status */
  setBuddy(lines: string[]): void {
    this.buddyLines = lines;
    if (this.running) this.drawAll();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.drawAll();
    this.resizeHandler = () => { this.lastHash = ''; this.drawAll(); };
    process.stdout.on('resize', this.resizeHandler);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.resizeHandler) {
      process.stdout.removeListener('resize', this.resizeHandler);
      this.resizeHandler = null;
    }
  }

  update(partial: Partial<StatusBarState>): void {
    Object.assign(this.state, partial);
    if (this.running) this.drawAll();
  }

  redraw(): void {
    this.lastHash = '';
    this.drawAll();
  }

  // ─── Drawing ──────────────────────────────────────────

  private drawAll(): void {
    const s = this.state;
    const hash = `${s.contextPercent}|${s.costUsd}|${s.mode}|${s.isStreaming}|${this.buddyLines.length}`;
    if (hash === this.lastHash) return;
    this.lastHash = hash;

    const rows = process.stdout.rows ?? 24;
    const w = process.stdout.columns ?? 120;

    process.stdout.write('\x1b7'); // save cursor

    // ── Buddy (right-aligned, above status) ──
    const buddyW = 14;
    const buddyCol = Math.max(1, w - buddyW);
    const buddyCount = this.buddyLines.length;

    // Buddy starts at: row - 2 - buddyCount (status=2 lines at bottom)
    for (let i = 0; i < buddyCount; i++) {
      const r = rows - 2 - buddyCount + i;
      if (r < 1) continue;
      process.stdout.write(`\x1b[${r};${buddyCol}H\x1b[K${this.buddyLines[i]}`);
    }

    // ── Status line (row - 1) ──
    const statusStr = this.renderStatusLine(w);
    process.stdout.write(`\x1b[${rows - 1};1H\x1b[2K${statusStr}`);

    // ── Mode line (last row) ──
    const mc = s.mode === 'bypass' ? RED : s.mode === 'fullAuto' ? YELLOW : GREEN;
    process.stdout.write(`\x1b[${rows};1H\x1b[2K  ${D}⏵⏵ ${mc}${s.mode}${R} ${D}permissions on (shift+tab to cycle)${R}`);

    process.stdout.write('\x1b8'); // restore cursor
  }

  private renderStatusLine(w: number): string {
    const s = this.state;
    const ctxColor = s.contextPercent > 85 ? RED : s.contextPercent > 60 ? YELLOW : GREEN;
    const uK = Math.round(s.contextUsed / 1000);
    const tK = Math.round(s.contextTotal / 1000);
    const uptime = fmtUp(Date.now() - s.sessionStartTime);
    const cost = s.budgetUsd
      ? `$$${s.costUsd.toFixed(2)} / $$${s.budgetUsd.toFixed(2)}`
      : `$$${s.costUsd.toFixed(4)}`;
    const br = s.branch ? ` (${s.branch})` : '';

    const left = `${BG}${FG}  ${shortM(s.model)} ${GRAY}│${FG} ${CYAN}${s.project}${br}${FG} ${GRAY}│${FG} ${ctxColor}${s.contextPercent}%${FG} (${uK}k/${tK}k) ${GRAY}│${FG} ${cost} ${GRAY}│${FG} ${uptime}${R}`;
    return left + BG + ' '.repeat(Math.max(0, w - visL(left))) + R;
  }
}

// ─── Helpers ────────────────────────────────────────────

function shortM(m: string): string {
  return m.includes('M2.7-highspeed') ? 'M2.7-hs' : m.includes('M2.7') ? 'M2.7' : m.slice(0, 10);
}
function fmtUp(ms: number): string {
  const s = Math.floor(ms / 1000); const m = Math.floor(s / 60); const h = Math.floor(m / 60);
  return h > 0 ? `${h}h${m % 60}m` : m > 0 ? `${m}m${s % 60}s` : `${s}s`;
}
function visL(s: string): number { return s.replace(/\x1b\[[0-9;]*m/g, '').length; }
