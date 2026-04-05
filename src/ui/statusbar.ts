/**
 * Layer 11 — UI: Status bar
 *
 * ONE line pinned to the very last row of the terminal.
 * Nothing else — no buddy, no mode line. Just the status.
 *
 *   M2.7-hs │ Project │ 0% (0k/205k) │ $$0.00 │ 5s
 */

const R = '\x1b[0m';
const D = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const GRAY = '\x1b[90m';
const BG = '\x1b[48;5;236m';
const FG = '\x1b[38;5;252m';

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

export class StatusBar {
  private state: StatusBarState;
  private lastHash = '';
  private running = false;
  private resizeHandler: (() => void) | null = null;

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

  // Keep for compatibility but no-op now
  setBuddy(_lines: string[]): void {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.draw();
    this.resizeHandler = () => { this.lastHash = ''; this.draw(); };
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
    if (this.running) this.draw();
  }

  redraw(): void {
    this.lastHash = '';
    this.draw();
  }

  private draw(): void {
    const s = this.state;
    const hash = `${s.contextPercent}|${s.costUsd}|${s.mode}|${s.isStreaming}`;
    if (hash === this.lastHash) return;
    this.lastHash = hash;

    const row = process.stdout.rows ?? 24;
    const w = process.stdout.columns ?? 120;
    const line = this.renderLine(w);

    // Save cursor, jump to last row, write, restore
    process.stdout.write(`\x1b7\x1b[${row};1H\x1b[2K${line}\x1b8`);
  }

  private renderLine(w: number): string {
    const s = this.state;
    const cc = s.contextPercent > 85 ? RED : s.contextPercent > 60 ? YELLOW : GREEN;
    const uK = Math.round(s.contextUsed / 1000);
    const tK = Math.round(s.contextTotal / 1000);
    const up = fmtUp(Date.now() - s.sessionStartTime);
    const cost = s.budgetUsd
      ? `$$${s.costUsd.toFixed(2)} / $$${s.budgetUsd.toFixed(2)}`
      : `$$${s.costUsd.toFixed(4)}`;
    const br = s.branch ? ` (${s.branch})` : '';
    const mc = s.mode === 'bypass' ? RED : s.mode === 'fullAuto' ? YELLOW : GREEN;

    const left = `${BG}${FG}  ${shortM(s.model)} ${GRAY}│${FG} ${CYAN}${s.project}${br}${FG} ${GRAY}│${FG} ${cc}${s.contextPercent}%${FG} (${uK}k/${tK}k) ${GRAY}│${FG} ${cost} ${GRAY}│${FG} ${up}${R}`;
    const right = `${BG}  ${mc}⏵⏵ ${s.mode}${FG} permissions on${R}`;

    const lv = visL(left);
    const rv = visL(right);
    const gap = Math.max(1, w - lv - rv);

    return `${left}${BG}${' '.repeat(gap)}${right}`;
  }
}

function shortM(m: string): string {
  return m.includes('M2.7-highspeed') ? 'M2.7-hs' : m.includes('M2.7') ? 'M2.7' : m.slice(0, 10);
}
function fmtUp(ms: number): string {
  const s = Math.floor(ms / 1000); const m = Math.floor(s / 60); const h = Math.floor(m / 60);
  return h > 0 ? `${h}h${m % 60}m` : m > 0 ? `${m}m${s % 60}s` : `${s}s`;
}
function visL(s: string): number { return s.replace(/\x1b\[[0-9;]*m/g, '').length; }
