/**
 * Layer 9 — Automation: KAIROS — Time Awareness Agent
 *
 * Ported from OpenClaude's KAIROS concept.
 * Tracks session time, suggests breaks, generates session summaries,
 * and provides "away summary" when user returns after idle.
 *
 * Features:
 * 1. Time tracking per turn (duration, cumulative)
 * 2. Break suggestion after 45min of deep work
 * 3. Away summary when user returns after >10min idle
 * 4. Session summary at /quit
 * 5. Time context injection into system prompt
 */

import type { Message } from '../protocol/messages.js';
import { isTextBlock } from '../protocol/messages.js';

// ─── Configuration ────────────────────────────────────

const DEEP_WORK_THRESHOLD_MS = 45 * 60 * 1000;  // 45 minutes
const AWAY_THRESHOLD_MS = 10 * 60 * 1000;        // 10 minutes
const TIME_INJECT_INTERVAL = 5;                    // Every 5 turns

// ─── Kairos State ─────────────────────────────────────

export interface KairosState {
  sessionStartTime: number;
  lastInputTime: number;
  turnCount: number;
  turnTimestamps: number[];
  breakSuggested: boolean;
  totalActiveMs: number;
}

export class Kairos {
  private state: KairosState;

  constructor() {
    const now = Date.now();
    this.state = {
      sessionStartTime: now,
      lastInputTime: now,
      turnCount: 0,
      turnTimestamps: [now],
      breakSuggested: false,
      totalActiveMs: 0,
    };
  }

  /**
   * Called when user submits input. Returns any notification to show.
   */
  onUserInput(): KairosNotification | null {
    const now = Date.now();
    const idleMs = now - this.state.lastInputTime;
    this.state.turnCount++;
    this.state.turnTimestamps.push(now);

    // Track active time (exclude idle periods > 2 min)
    if (idleMs < 2 * 60 * 1000) {
      this.state.totalActiveMs += idleMs;
    }

    const notification = this.checkNotifications(idleMs, now);
    this.state.lastInputTime = now;
    return notification;
  }

  /**
   * Check if any notification should be shown.
   */
  private checkNotifications(idleMs: number, now: number): KairosNotification | null {
    // Away summary: user was gone > 10 minutes
    if (idleMs > AWAY_THRESHOLD_MS && this.state.turnCount > 1) {
      const idleMin = Math.round(idleMs / 60_000);
      return {
        type: 'away_summary',
        message: `Welcome back! You were away for ${idleMin}m. Last activity: turn ${this.state.turnCount - 1}.`,
      };
    }

    // Break suggestion: 45+ minutes of deep work
    const activeMs = this.state.totalActiveMs;
    if (activeMs > DEEP_WORK_THRESHOLD_MS && !this.state.breakSuggested) {
      this.state.breakSuggested = true;
      const activeMin = Math.round(activeMs / 60_000);
      return {
        type: 'break_suggestion',
        message: `You've been working for ${activeMin} minutes. Consider a short break.`,
      };
    }

    return null;
  }

  /**
   * Generate time context for system prompt injection.
   * Injected every N turns to give the model time awareness.
   */
  shouldInjectTimeContext(): boolean {
    return this.state.turnCount > 0 && this.state.turnCount % TIME_INJECT_INTERVAL === 0;
  }

  getTimeContext(): string {
    const elapsed = Math.round((Date.now() - this.state.sessionStartTime) / 60_000);
    const active = Math.round(this.state.totalActiveMs / 60_000);
    return `[TIME: Session ${elapsed}m elapsed, ${active}m active, ${this.state.turnCount} turns]`;
  }

  /**
   * Generate a session summary for /quit.
   */
  getSessionSummary(messages: Message[]): string {
    const elapsed = Math.round((Date.now() - this.state.sessionStartTime) / 60_000);
    const active = Math.round(this.state.totalActiveMs / 60_000);

    // Extract key topics from user messages
    const userTopics = messages
      .filter(m => m.role === 'user')
      .map(m => typeof m.content === 'string' ? m.content : '')
      .filter(t => t.length > 10)
      .map(t => t.slice(0, 60))
      .slice(-5);

    const lines = [
      `Session Summary`,
      `  Duration: ${elapsed}m (${active}m active)`,
      `  Turns: ${this.state.turnCount}`,
    ];

    if (userTopics.length > 0) {
      lines.push(`  Topics:`);
      for (const topic of userTopics) {
        lines.push(`    - ${topic}...`);
      }
    }

    return lines.join('\n');
  }
}

// ─── Notification Types ───────────────────────────────

export interface KairosNotification {
  type: 'away_summary' | 'break_suggestion' | 'time_context';
  message: string;
}
