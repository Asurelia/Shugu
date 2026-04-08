/**
 * Meta-Harness: Pareto Frontier Selection
 *
 * Multi-objective selection over candidate harnesses.
 * Uses standard Pareto dominance: candidate A dominates B if A is
 * no worse on all objectives and strictly better on at least one.
 *
 * 5 objectives:
 *  - accuracy    ↑ (higher is better)
 *  - cost        ↓ (lower is better)
 *  - tokens      ↓ (lower is better)
 *  - turns       ↓ (lower is better)
 *  - errorRate   ↓ (lower is better)
 */

import type { ScoredCandidate } from './types.js';

// ─── Pareto Dominance ─────────────────────────────────

/**
 * Check if candidate A dominates candidate B.
 * A dominates B if A is no worse on ALL objectives
 * and strictly better on at least one.
 */
function dominates(a: ScoredCandidate, b: ScoredCandidate): boolean {
  const ao = a.objectives;
  const bo = b.objectives;

  // For accuracy: higher is better → a >= b means a is no worse
  // For cost/tokens/turns/errorRate: lower is better → a <= b means a is no worse

  const noWorse =
    ao.accuracy >= bo.accuracy &&
    ao.cost <= bo.cost &&
    ao.tokens <= bo.tokens &&
    ao.turns <= bo.turns &&
    ao.errorRate <= bo.errorRate;

  if (!noWorse) return false;

  // Strictly better on at least one
  const strictlyBetter =
    ao.accuracy > bo.accuracy ||
    ao.cost < bo.cost ||
    ao.tokens < bo.tokens ||
    ao.turns < bo.turns ||
    ao.errorRate < bo.errorRate;

  return strictlyBetter;
}

// ─── Pareto Frontier ──────────────────────────────────

/**
 * Compute the Pareto frontier — the set of non-dominated candidates.
 * A candidate is on the frontier if no other candidate dominates it.
 */
export function computeParetoFrontier(candidates: ScoredCandidate[]): ScoredCandidate[] {
  if (candidates.length === 0) return [];

  const frontier: ScoredCandidate[] = [];

  for (const candidate of candidates) {
    let isDominated = false;

    for (const other of candidates) {
      if (other.candidateId === candidate.candidateId) continue;
      if (dominates(other, candidate)) {
        isDominated = true;
        break;
      }
    }

    if (!isDominated) {
      frontier.push(candidate);
    }
  }

  return frontier;
}

// ─── Weighted Score Ranking ───────────────────────────

const DEFAULT_WEIGHTS = {
  accuracy: 1.0,
  cost: 0.3,
  tokens: 0.1,
  turns: 0.2,
  errorRate: 0.4,
};

/**
 * Rank candidates by a weighted scalar score.
 * Normalizes each objective to [0, 1] across the population,
 * then computes a weighted sum.
 *
 * Returns candidates sorted from best to worst.
 */
export function rankByWeightedScore(
  candidates: ScoredCandidate[],
  weights: Partial<Record<keyof ScoredCandidate['objectives'], number>> = {},
): ScoredCandidate[] {
  if (candidates.length === 0) return [];

  const w = { ...DEFAULT_WEIGHTS, ...weights };

  // Find min/max for each objective
  const mins = { accuracy: Infinity, cost: Infinity, tokens: Infinity, turns: Infinity, errorRate: Infinity };
  const maxs = { accuracy: -Infinity, cost: -Infinity, tokens: -Infinity, turns: -Infinity, errorRate: -Infinity };

  for (const c of candidates) {
    for (const key of Object.keys(mins) as (keyof typeof mins)[]) {
      if (c.objectives[key] < mins[key]) mins[key] = c.objectives[key];
      if (c.objectives[key] > maxs[key]) maxs[key] = c.objectives[key];
    }
  }

  // Normalize to [0, 1] — for "higher is better" objectives, normalize directly;
  // for "lower is better" objectives, invert so that lower raw = higher normalized
  function normalize(value: number, min: number, max: number, higherIsBetter: boolean): number {
    if (max === min) return 1.0; // All equal → perfect score
    const norm = (value - min) / (max - min);
    return higherIsBetter ? norm : 1.0 - norm;
  }

  // Score each candidate
  const scored = candidates.map(c => {
    const o = c.objectives;
    const score =
      w.accuracy * normalize(o.accuracy, mins.accuracy, maxs.accuracy, true) +
      w.cost * normalize(o.cost, mins.cost, maxs.cost, false) +
      w.tokens * normalize(o.tokens, mins.tokens, maxs.tokens, false) +
      w.turns * normalize(o.turns, mins.turns, maxs.turns, false) +
      w.errorRate * normalize(o.errorRate, mins.errorRate, maxs.errorRate, false);

    return { candidate: c, score };
  });

  // Sort descending by score (best first)
  scored.sort((a, b) => b.score - a.score);

  return scored.map(s => s.candidate);
}

// ─── Parent Selection ─────────────────────────────────

/**
 * Select parent candidates for the proposer.
 * Picks from the Pareto frontier, prioritizing diversity.
 * If count > frontier size, fills with top-ranked non-frontier candidates.
 */
export function selectParents(
  candidates: ScoredCandidate[],
  count: number,
): ScoredCandidate[] {
  if (candidates.length === 0) return [];
  if (candidates.length <= count) return [...candidates];

  const frontier = computeParetoFrontier(candidates);

  if (frontier.length >= count) {
    // Pick evenly spaced candidates from frontier (ranked by weighted score)
    const ranked = rankByWeightedScore(frontier);
    const step = ranked.length / count;
    const selected: ScoredCandidate[] = [];
    for (let i = 0; i < count; i++) {
      selected.push(ranked[Math.floor(i * step)]!);
    }
    return selected;
  }

  // Frontier too small — supplement with best non-frontier candidates
  const frontierIds = new Set(frontier.map(c => c.candidateId));
  const nonFrontier = candidates.filter(c => !frontierIds.has(c.candidateId));
  const rankedNonFrontier = rankByWeightedScore(nonFrontier);

  return [...frontier, ...rankedNonFrontier.slice(0, count - frontier.length)];
}
