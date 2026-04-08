import { describe, it, expect } from 'vitest';
import { splitDataset, createDefaultDataset } from '../src/meta/dataset.js';
import type { EvalTask } from '../src/meta/types.js';

function makeTask(id: string): EvalTask {
  return {
    id,
    prompt: `Task ${id}`,
    scorer: { type: 'criteria', criteria: [{ type: 'turns_under', value: 10 }] },
  };
}

describe('splitDataset', () => {
  it('splits deterministically (same input → same split)', () => {
    const tasks = Array.from({ length: 20 }, (_, i) => makeTask(`task-${i}`));
    const split1 = splitDataset(tasks, 0.7);
    const split2 = splitDataset(tasks, 0.7);

    expect(split1.searchSet.map(t => t.id)).toEqual(split2.searchSet.map(t => t.id));
    expect(split1.holdoutSet.map(t => t.id)).toEqual(split2.holdoutSet.map(t => t.id));
  });

  it('respects approximate split ratio', () => {
    const tasks = Array.from({ length: 100 }, (_, i) => makeTask(`task-${i}`));
    const split = splitDataset(tasks, 0.7);

    // Should be roughly 70/30 ± some variance
    expect(split.searchSet.length).toBeGreaterThan(50);
    expect(split.searchSet.length).toBeLessThan(90);
    expect(split.holdoutSet.length).toBeGreaterThan(10);
  });

  it('ensures both sets are non-empty', () => {
    const tasks = [makeTask('only-one')];
    // With 1 task, one set would be empty — the function should handle this
    // (though with 1 task the split is degenerate)
    const split = splitDataset(tasks, 0.7);
    expect(split.searchSet.length + split.holdoutSet.length).toBe(1);
  });

  it('ensures both sets non-empty with 2 tasks', () => {
    const tasks = [makeTask('a'), makeTask('b')];
    const split = splitDataset(tasks, 0.7);
    // Both sets should have at least 1 task
    expect(split.searchSet.length).toBeGreaterThanOrEqual(1);
    expect(split.holdoutSet.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects invalid split ratios', () => {
    const tasks = [makeTask('a')];
    expect(() => splitDataset(tasks, 0.05)).toThrow('splitRatio must be between');
    expect(() => splitDataset(tasks, 0.99)).toThrow('splitRatio must be between');
  });

  it('produces disjoint sets', () => {
    const tasks = Array.from({ length: 50 }, (_, i) => makeTask(`t-${i}`));
    const split = splitDataset(tasks, 0.7);
    const searchIds = new Set(split.searchSet.map(t => t.id));
    const holdoutIds = new Set(split.holdoutSet.map(t => t.id));
    for (const id of searchIds) {
      expect(holdoutIds.has(id)).toBe(false);
    }
    expect(searchIds.size + holdoutIds.size).toBe(tasks.length);
  });
});

describe('createDefaultDataset', () => {
  it('returns non-empty search and holdout sets', () => {
    const split = createDefaultDataset();
    expect(split.searchSet.length).toBeGreaterThan(0);
    expect(split.holdoutSet.length).toBeGreaterThan(0);
  });

  it('all tasks have valid scorers', () => {
    const split = createDefaultDataset();
    const allTasks = [...split.searchSet, ...split.holdoutSet];
    for (const task of allTasks) {
      expect(task.scorer).toBeDefined();
      expect(['criteria', 'command', 'llm_judge']).toContain(task.scorer.type);
    }
  });

  it('all tasks have unique IDs', () => {
    const split = createDefaultDataset();
    const allTasks = [...split.searchSet, ...split.holdoutSet];
    const ids = allTasks.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
