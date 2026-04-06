/**
 * Tests for Layer 2 — Engine: Budget tracker
 */

import { describe, it, expect } from 'vitest';
import { BudgetTracker, calculateCost, getContextWindow, MINIMAX_PRICING } from '../src/engine/budget.js';
import type { Usage } from '../src/protocol/messages.js';

describe('Budget: calculateCost', () => {
  it('calculates cost for MiniMax model', () => {
    const usage: Usage = { input_tokens: 1000, output_tokens: 500 };
    const cost = calculateCost(usage, 'MiniMax-M2.7-highspeed');
    expect(cost).toBeGreaterThan(0);
    expect(typeof cost).toBe('number');
  });

  it('returns 0 for zero tokens', () => {
    const usage: Usage = { input_tokens: 0, output_tokens: 0 };
    const cost = calculateCost(usage, 'MiniMax-M2.7-highspeed');
    expect(cost).toBe(0);
  });

  it('output tokens cost more than input tokens', () => {
    const inputOnly: Usage = { input_tokens: 1000, output_tokens: 0 };
    const outputOnly: Usage = { input_tokens: 0, output_tokens: 1000 };
    const inputCost = calculateCost(inputOnly, 'MiniMax-M2.7-highspeed');
    const outputCost = calculateCost(outputOnly, 'MiniMax-M2.7-highspeed');
    expect(outputCost).toBeGreaterThan(inputCost);
  });

  it('falls back to M2.7-highspeed pricing for unknown models', () => {
    const usage: Usage = { input_tokens: 1000000, output_tokens: 0 };
    const knownCost = calculateCost(usage, 'MiniMax-M2.7-highspeed');
    const unknownCost = calculateCost(usage, 'unknown-model');
    expect(unknownCost).toBe(knownCost);
  });
});

describe('Budget: getContextWindow', () => {
  it('returns context window for known models', () => {
    const window = getContextWindow('MiniMax-M2.7-highspeed');
    expect(window).toBe(204800);
  });

  it('returns default for unknown models', () => {
    const window = getContextWindow('unknown-model');
    expect(window).toBe(204800);
  });
});

describe('BudgetTracker', () => {
  it('tracks usage across turns', () => {
    const tracker = new BudgetTracker('MiniMax-M2.7-highspeed');

    tracker.addTurnUsage({ input_tokens: 100, output_tokens: 50 });
    tracker.addTurnUsage({ input_tokens: 200, output_tokens: 100 });

    const total = tracker.getTotalUsage();
    expect(total.input_tokens).toBe(300);
    expect(total.output_tokens).toBe(150);
  });

  it('calculates total cost', () => {
    const tracker = new BudgetTracker('MiniMax-M2.7-highspeed');
    tracker.addTurnUsage({ input_tokens: 10000, output_tokens: 5000 });

    const cost = tracker.getTotalCostUsd();
    expect(cost).toBeGreaterThan(0);
  });

  it('respects budget limits', () => {
    const tracker = new BudgetTracker('MiniMax-M2.7-highspeed', 0.001);
    tracker.addTurnUsage({ input_tokens: 1000000, output_tokens: 1000000 });

    expect(tracker.isOverBudget()).toBe(true);
  });

  it('is not over budget by default (no limit)', () => {
    const tracker = new BudgetTracker('MiniMax-M2.7-highspeed');
    tracker.addTurnUsage({ input_tokens: 100000, output_tokens: 50000 });

    expect(tracker.isOverBudget()).toBe(false);
  });

  it('tracks turn count', () => {
    const tracker = new BudgetTracker('MiniMax-M2.7-highspeed');
    expect(tracker.getTurnCount()).toBe(0);

    tracker.addTurnUsage({ input_tokens: 100, output_tokens: 50 });
    expect(tracker.getTurnCount()).toBe(1);

    tracker.addTurnUsage({ input_tokens: 100, output_tokens: 50 });
    expect(tracker.getTurnCount()).toBe(2);
  });

  it('generates readable summary', () => {
    const tracker = new BudgetTracker('MiniMax-M2.7-highspeed');
    tracker.addTurnUsage({ input_tokens: 1000, output_tokens: 500 });

    const summary = tracker.getSummary();
    expect(summary).toContain('1 turns');
    expect(summary).toContain('$');
  });
});
