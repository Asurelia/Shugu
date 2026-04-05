/**
 * Layer 11 — UI: Status bar
 *
 * Simple state container + renderer. NOT positioned absolutely.
 * Just provides a render() method that returns a formatted string.
 * The CLI prints it in the normal flow where needed.
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

  // No-ops for compatibility
  setBuddy(_lines: string[]): void {}
  start(): void {}
  stop(): void {}
  redraw(): void {}

  update(partial: Partial<StatusBarState>): void {
    Object.assign(this.state, partial);
  }

  /** Render the status line as a string (caller prints it) */
  render(): string {
    const s = this.state;
    const w = process.stdout.columns ?? 120;
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
