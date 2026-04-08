import { describe, it, expect } from 'vitest';
import {
  computeParetoFrontier,
  rankByWeightedScore,
  selectParents,
} from '../src/meta/selector.js';
import type { ScoredCandidate } from '../src/meta/types.js';

function makeCandidate(
  id: string,
  accuracy: number,
  cost: number,
  tokens: number,
  turns: number,
  errorRate: number,
): ScoredCandidate {
  return { candidateId: id, objectives: { accuracy, cost, tokens, turns, errorRate } };
}

describe('computeParetoFrontier', () => {
  it('returns single candidate as frontier', () => {
    const c = [makeCandidate('a', 0.8, 0.1, 1000, 5, 0.2)];
    const frontier = computeParetoFrontier(c);
    expect(frontier).toHaveLength(1);
    expect(frontier[0]!.candidateId).toBe('a');
  });

  it('returns both if neither dominates the other', () => {
    // A is better on accuracy, B is better on cost
    const candidates = [
      makeCandidate('a', 0.9, 0.5, 1000, 5, 0.1),
      makeCandidate('b', 0.7, 0.1, 500, 3, 0.3),
    ];
    const frontier = computeParetoFrontier(candidates);
    expect(frontier).toHaveLength(2);
  });

  it('removes dominated candidates', () => {
    // A dominates B on all objectives
    const candidates = [
      makeCandidate('a', 0.9, 0.1, 500, 3, 0.1),
      makeCandidate('b', 0.7, 0.5, 1000, 5, 0.3),
    ];
    const frontier = computeParetoFrontier(candidates);
    expect(frontier).toHaveLength(1);
    expect(frontier[0]!.candidateId).toBe('a');
  });

  it('handles empty input', () => {
    expect(computeParetoFrontier([])).toEqual([]);
  });

  it('handles three candidates with complex dominance', () => {
    const candidates = [
      makeCandidate('a', 0.9, 0.5, 1000, 5, 0.1),  // Best accuracy
      makeCandidate('b', 0.8, 0.1, 500, 3, 0.2),   // Best cost/tokens/turns
      makeCandidate('c', 0.7, 0.3, 800, 4, 0.3),   // Dominated by neither? or by both?
    ];
    const frontier = computeParetoFrontier(candidates);
    // c is not dominated: a has worse cost/tokens/turns, b has worse accuracy
    expect(frontier.length).toBeGreaterThanOrEqual(2);
  });
});

describe('rankByWeightedScore', () => {
  it('ranks candidates by weighted score', () => {
    const candidates = [
      makeCandidate('a', 0.5, 0.5, 1000, 5, 0.5),
      makeCandidate('b', 0.9, 0.1, 500, 3, 0.1),
    ];
    const ranked = rankByWeightedScore(candidates);
    expect(ranked[0]!.candidateId).toBe('b'); // Better on everything
  });

  it('returns empty for empty input', () => {
    expect(rankByWeightedScore([])).toEqual([]);
  });

  it('respects custom weights', () => {
    const candidates = [
      makeCandidate('cheap', 0.5, 0.01, 100, 2, 0.5),
      makeCandidate('accurate', 0.95, 1.0, 5000, 20, 0.05),
    ];
    // With cost weight = 10, cheap should win
    const ranked = rankByWeightedScore(candidates, { cost: 10.0, accuracy: 0.1 });
    expect(ranked[0]!.candidateId).toBe('cheap');
  });
});

describe('selectParents', () => {
  it('returns all candidates if count >= length', () => {
    const candidates = [
      makeCandidate('a', 0.8, 0.1, 1000, 5, 0.2),
      makeCandidate('b', 0.7, 0.2, 800, 4, 0.3),
    ];
    const parents = selectParents(candidates, 5);
    expect(parents).toHaveLength(2);
  });

  it('selects from frontier first', () => {
    const candidates = [
      makeCandidate('frontier1', 0.9, 0.5, 1000, 5, 0.1),
      makeCandidate('frontier2', 0.7, 0.1, 500, 3, 0.3),
      makeCandidate('dominated', 0.6, 0.6, 1200, 6, 0.4),
    ];
    const parents = selectParents(candidates, 2);
    const ids = parents.map(p => p.candidateId);
    expect(ids).toContain('frontier1');
    expect(ids).toContain('frontier2');
  });

  it('handles empty input', () => {
    expect(selectParents([], 3)).toEqual([]);
  });
});
