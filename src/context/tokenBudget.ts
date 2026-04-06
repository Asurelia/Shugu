/**
 * Layer 5 — Context: Token budget & estimation
 *
 * Tracks token usage against the model's context window.
 * Uses API-reported usage for accuracy and local estimation for pre-flight checks.
 *
 * MiniMax M2.7-highspeed: 204,800 token context window.
 * Compaction threshold: 75% of context window (~153K tokens).
 */

import type { Message, ContentBlock } from '../protocol/messages.js';
import type { Usage } from '../protocol/messages.js';
import { getContextWindow } from '../engine/budget.js';

// ─── Configuration ──────────────────────────────────────

export interface TokenBudgetConfig {
  model: string;
  /** Fraction of context window at which to trigger compaction (0-1). Default: 0.75 */
  compactionThreshold: number;
  /** Minimum tokens to reserve for the model's response. Default: 8192 */
  reserveForOutput: number;
}

export const DEFAULT_TOKEN_BUDGET_CONFIG: TokenBudgetConfig = {
  model: 'MiniMax-M2.7-highspeed',
  compactionThreshold: 0.75,
  reserveForOutput: 8192,
};

// ─── Auto-Compaction Constants (from OpenClaude) ───────

/** Buffer tokens before hitting hard limit — triggers auto-compact */
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;

/** Warning threshold — yellow zone */
export const WARNING_BUFFER_TOKENS = 20_000;

/** Max consecutive auto-compact failures before giving up */
export const MAX_COMPACT_FAILURES = 3;

// ─── Token Budget Tracker ───────────────────────────────

export class TokenBudgetTracker {
  private config: TokenBudgetConfig;
  private contextWindow: number;
  private lastKnownInputTokens: number = 0;
  private consecutiveCompactFailures: number = 0;

  constructor(config: Partial<TokenBudgetConfig> = {}) {
    this.config = { ...DEFAULT_TOKEN_BUDGET_CONFIG, ...config };
    this.contextWindow = getContextWindow(this.config.model);
  }

  /**
   * Update with actual token count from the API response.
   */
  updateFromUsage(usage: Usage): void {
    this.lastKnownInputTokens = usage.input_tokens;
  }

  /**
   * Check if compaction should be triggered.
   */
  shouldCompact(): boolean {
    const threshold = this.contextWindow * this.config.compactionThreshold;
    return this.lastKnownInputTokens > threshold;
  }

  /**
   * Check if we're dangerously close to the context limit.
   */
  isNearLimit(): boolean {
    const safeLimit = this.contextWindow - this.config.reserveForOutput;
    return this.lastKnownInputTokens > safeLimit * 0.95;
  }

  /**
   * Get the estimated available tokens for input.
   */
  getAvailableTokens(): number {
    return Math.max(0, this.contextWindow - this.config.reserveForOutput - this.lastKnownInputTokens);
  }

  /**
   * Get a status summary.
   */
  getStatus(): TokenBudgetStatus {
    const used = this.lastKnownInputTokens;
    const total = this.contextWindow;
    const percent = total > 0 ? Math.round((used / total) * 100) : 0;

    return {
      usedTokens: used,
      totalTokens: total,
      availableTokens: this.getAvailableTokens(),
      percentUsed: percent,
      shouldCompact: this.shouldCompact(),
      isNearLimit: this.isNearLimit(),
    };
  }

  /**
   * Check if reactive auto-compaction should trigger.
   * Uses OpenClaude's buffer-based approach:
   * auto-compact when within AUTOCOMPACT_BUFFER_TOKENS of the limit.
   * Includes circuit breaker (stops after MAX_COMPACT_FAILURES consecutive failures).
   */
  shouldAutoCompact(): boolean {
    if (this.consecutiveCompactFailures >= MAX_COMPACT_FAILURES) return false;
    const autoCompactThreshold = this.contextWindow - this.config.reserveForOutput - AUTOCOMPACT_BUFFER_TOKENS;
    return this.lastKnownInputTokens >= autoCompactThreshold;
  }

  /**
   * Record a compaction success (resets circuit breaker).
   */
  recordCompactSuccess(): void {
    this.consecutiveCompactFailures = 0;
  }

  /**
   * Record a compaction failure (increments circuit breaker).
   */
  recordCompactFailure(): void {
    this.consecutiveCompactFailures++;
  }

  /**
   * Whether the circuit breaker has tripped.
   */
  get compactCircuitBroken(): boolean {
    return this.consecutiveCompactFailures >= MAX_COMPACT_FAILURES;
  }

  get lastInputTokens(): number {
    return this.lastKnownInputTokens;
  }
}

export interface TokenBudgetStatus {
  usedTokens: number;
  totalTokens: number;
  availableTokens: number;
  percentUsed: number;
  shouldCompact: boolean;
  isNearLimit: boolean;
}

// ─── Local Token Estimation ─────────────────────────────

/**
 * Rough local estimate of token count for a message array.
 * Used for pre-flight decisions before we have API feedback.
 *
 * Heuristic: ~4 chars per token for English/code, ~2 for CJK.
 * This is intentionally conservative (overestimates).
 */
export function estimateTokens(messages: Message[]): number {
  let totalChars = 0;

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      totalChars += msg.content.length;
    } else {
      for (const block of msg.content) {
        totalChars += estimateBlockChars(block);
      }
    }
    totalChars += 10; // Overhead per message (role, formatting)
  }

  // Conservative: ~3.5 chars per token average
  return Math.ceil(totalChars / 3.5);
}

function estimateBlockChars(block: ContentBlock): number {
  switch (block.type) {
    case 'text':
      return block.text.length;
    case 'tool_use':
      return block.name.length + JSON.stringify(block.input).length + 20;
    case 'tool_result': {
      const content = typeof block.content === 'string'
        ? block.content
        : JSON.stringify(block.content);
      return content.length + 20;
    }
    case 'thinking':
      return block.thinking.length;
    case 'image':
      return 1000; // Images are roughly 1000 tokens
    default:
      return 50;
  }
}
