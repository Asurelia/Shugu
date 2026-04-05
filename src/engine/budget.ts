/**
 * Layer 2 — Engine: Token budget & cost tracking
 *
 * Adapted from OpenClaude src/query/tokenBudget.ts (94 lines, clean module).
 * Tracks token usage across turns and enforces budget limits.
 *
 * MiniMax M2.7-highspeed pricing (as of 2026-04-05):
 * - Input: $0.30 / 1M tokens
 * - Output: $1.10 / 1M tokens
 */

import type { Usage } from '../protocol/messages.js';

// ─── Pricing ────────────────────────────────────────────

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheWritePerMillion?: number;
  cacheReadPerMillion?: number;
}

export const MINIMAX_PRICING: Record<string, ModelPricing> = {
  'MiniMax-M2.7-highspeed': {
    inputPerMillion: 0.30,
    outputPerMillion: 1.10,
  },
  'MiniMax-M2.7': {
    inputPerMillion: 0.30,
    outputPerMillion: 1.10,
  },
  'MiniMax-M2.5-highspeed': {
    inputPerMillion: 0.15,
    outputPerMillion: 0.55,
  },
};

// ─── Budget Tracker ─────────────────────────────────────

export class BudgetTracker {
  private totalUsage: Usage = { input_tokens: 0, output_tokens: 0 };
  private turnUsages: Usage[] = [];
  private maxBudgetUsd: number | null;
  private model: string;

  constructor(model: string, maxBudgetUsd?: number) {
    this.model = model;
    this.maxBudgetUsd = maxBudgetUsd ?? null;
  }

  /**
   * Record usage from a completed turn.
   */
  addTurnUsage(usage: Usage): void {
    this.turnUsages.push(usage);
    this.totalUsage = {
      input_tokens: this.totalUsage.input_tokens + usage.input_tokens,
      output_tokens: this.totalUsage.output_tokens + usage.output_tokens,
      cache_creation_input_tokens:
        (this.totalUsage.cache_creation_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0),
      cache_read_input_tokens:
        (this.totalUsage.cache_read_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0),
    };
  }

  /**
   * Check if we've exceeded the budget.
   */
  isOverBudget(): boolean {
    if (this.maxBudgetUsd === null) return false;
    return this.getTotalCostUsd() >= this.maxBudgetUsd;
  }

  /**
   * Get total cost in USD.
   */
  getTotalCostUsd(): number {
    return calculateCost(this.totalUsage, this.model);
  }

  /**
   * Get total usage across all turns.
   */
  getTotalUsage(): Usage {
    return { ...this.totalUsage };
  }

  /**
   * Get number of turns recorded.
   */
  getTurnCount(): number {
    return this.turnUsages.length;
  }

  /**
   * Get a summary string for display.
   */
  getSummary(): string {
    const cost = this.getTotalCostUsd();
    const { input_tokens, output_tokens } = this.totalUsage;
    return `${this.turnUsages.length} turns | ${input_tokens.toLocaleString()} in / ${output_tokens.toLocaleString()} out | $${cost.toFixed(4)}`;
  }
}

// ─── Cost Calculation ───────────────────────────────────

export function calculateCost(usage: Usage, model: string): number {
  const pricing = MINIMAX_PRICING[model];
  if (!pricing) {
    // Fallback to M2.7-highspeed pricing
    return calculateCost(usage, 'MiniMax-M2.7-highspeed');
  }

  const inputCost = (usage.input_tokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (usage.output_tokens / 1_000_000) * pricing.outputPerMillion;

  return inputCost + outputCost;
}

// ─── Context Window ─────────────────────────────────────

export const MINIMAX_CONTEXT_WINDOWS: Record<string, number> = {
  'MiniMax-M2.7-highspeed': 204_800,
  'MiniMax-M2.7': 204_800,
  'MiniMax-M2.5-highspeed': 204_800,
  'MiniMax-M2.5': 204_800,
};

export function getContextWindow(model: string): number {
  return MINIMAX_CONTEXT_WINDOWS[model] ?? 204_800;
}
