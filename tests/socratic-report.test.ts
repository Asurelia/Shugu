/**
 * Unit tests for socratic-report helpers (pure, no I/O).
 * Part of the socratic-agent plan (Task 5).
 */

import { describe, it, expect } from 'vitest';
import {
  slugify,
  extractFauxBlock,
  detectHedge,
  buildReportFilename,
  formatTtySummary,
  buildFrontmatter,
  countLabels,
  totalItems,
  extractVerdictSection,
  type SocraticMetrics,
} from '../src/commands/socratic-report.js';

describe('slugify', () => {
  it('lowercases and replaces non-alphanum with hyphens', () => {
    expect(slugify('My Feature/Branch 01')).toBe('my-feature-branch-01');
  });
  it('collapses runs of hyphens and trims', () => {
    expect(slugify('--- hello --- world ---')).toBe('hello-world');
  });
  it('truncates to 60 chars max', () => {
    expect(slugify('a'.repeat(200)).length).toBeLessThanOrEqual(60);
  });
  it('falls back to "audit" for empty input', () => {
    expect(slugify('')).toBe('audit');
    expect(slugify('   ')).toBe('audit');
  });
});

describe('buildReportFilename', () => {
  it('uses ISO-like compact timestamp and kebab slug', () => {
    const ts = new Date('2026-04-17T14:32:05Z');
    const name = buildReportFilename(ts, 'diff', 'my-branch');
    expect(name).toBe('2026-04-17-143205-diff-my-branch.md');
  });
});

describe('extractFauxBlock', () => {
  it('returns the parsed JSON for a valid faux block', () => {
    const report = [
      '# Revue',
      '## Annexe machine-readable',
      '```json',
      '{"faux":[{"id":"A1.1","file":"src/a.ts","line":12,"evidence":"x","suggestion":"y"}]}',
      '```',
    ].join('\n');
    const parsed = extractFauxBlock(report);
    expect(parsed.faux).toHaveLength(1);
    expect(parsed.faux[0]!.file).toBe('src/a.ts');
  });

  it('returns empty faux when no JSON block present', () => {
    expect(extractFauxBlock('# Just prose, no annex')).toEqual({ faux: [] });
  });

  it('returns empty faux when JSON is malformed', () => {
    const report = [
      '## Annexe machine-readable',
      '```json',
      '{not valid}',
      '```',
    ].join('\n');
    expect(extractFauxBlock(report)).toEqual({ faux: [] });
  });

  it('ignores JSON blocks outside the Annexe section', () => {
    const report = [
      '```json',
      '{"faux":[{"id":"X","file":"a","line":1,"evidence":"","suggestion":""}]}',
      '```',
      '## Annexe machine-readable',
      '```json',
      '{"faux":[]}',
      '```',
    ].join('\n');
    expect(extractFauxBlock(report).faux).toHaveLength(0);
  });
});

describe('detectHedge', () => {
  it('returns true for banned hedge phrases in a verdict', () => {
    const verdict = '## Verdict\nGlobalement, le code est sain.';
    expect(detectHedge(verdict)).toBe(true);
  });
  it('detects 7/10 notation', () => {
    expect(detectHedge('## Verdict\nJe donnerais 7/10.')).toBe(true);
  });
  it('returns false for a sharp verdict', () => {
    expect(detectHedge('## Verdict\nLe point de pression : SHELL_METACHAR_PATTERN mort.')).toBe(false);
  });
  it('is case-insensitive', () => {
    expect(detectHedge("## Verdict\nDans L'ensemble, ça tient.")).toBe(true);
  });
});

describe('buildFrontmatter', () => {
  it('produces YAML with all required fields', () => {
    const m: SocraticMetrics = {
      ts: '2026-04-17T14:32:00Z',
      scope: 'diff',
      topic: 'my-branch',
      turns: 11,
      max_turns: 12,
      cost: 0.34,
      faux_count: 2,
      total_items: 9,
      verdict_contains_hedge: false,
      files_read: 14,
      commits_reviewed: ['abc123', 'def456'],
    };
    const yml = buildFrontmatter(m);
    expect(yml.startsWith('---\n')).toBe(true);
    expect(yml).toContain('scope: diff');
    expect(yml).toContain('turns_used: 11');
    expect(yml).toContain('cost_usd: 0.3400');
    expect(yml).toContain('commits_reviewed: [abc123, def456]');
  });
});

describe('countLabels + totalItems', () => {
  it('counts each label family from ### headings', () => {
    const report = [
      '### A1 — ✓ Correct : ok',
      '### A2 — ~ Contestable : hmm',
      '### A3 — ⚡ Simplification : bof',
      '### A4 — ◐ Angle mort : caché',
      '### A5 — ✗ Faux : broken',
    ].join('\n');
    const counts = countLabels(report);
    expect(counts.correct).toBe(1);
    expect(counts.contestable).toBe(1);
    expect(counts.simplification).toBe(1);
    expect(counts.angle_mort).toBe(1);
    expect(counts.faux).toBe(1);
    expect(totalItems(counts)).toBe(5);
  });
});

describe('extractVerdictSection', () => {
  it('extracts content between "## Verdict" and the next H2 or ---', () => {
    const report = [
      '## Axe 1', 'stuff',
      '## Verdict',
      'Sharp thing.',
      '---',
      '## Annexe machine-readable',
    ].join('\n');
    const v = extractVerdictSection(report);
    expect(v.trim()).toBe('Sharp thing.');
  });
});

describe('formatTtySummary', () => {
  it('lists faux items with file:line', () => {
    const out = formatTtySummary({
      path: '.pcc/rodin/file.md',
      metrics: {
        ts: '', scope: 'diff', topic: 't',
        turns: 5, max_turns: 12, cost: 0.12,
        faux_count: 2, total_items: 4,
        verdict_contains_hedge: false, files_read: 3, commits_reviewed: [],
      },
      fauxItems: [
        { id: 'A1', file: 'src/a.ts', line: 10, evidence: '', suggestion: 'fix' },
        { id: 'A2', file: 'src/b.ts', line: 20, evidence: '', suggestion: 'fix' },
      ],
      labelCounts: { faux: 2, contestable: 1, simplification: 0, angle_mort: 1, correct: 0 },
    });
    expect(out).toContain('src/a.ts:10');
    expect(out).toContain('src/b.ts:20');
    expect(out).toContain('2 ✗');
  });

  it('omits the faux block when faux_count === 0', () => {
    const out = formatTtySummary({
      path: 'x.md',
      metrics: {
        ts: '', scope: 'diff', topic: 't', turns: 5, max_turns: 12, cost: 0.1,
        faux_count: 0, total_items: 3, verdict_contains_hedge: false, files_read: 2, commits_reviewed: [],
      },
      fauxItems: [],
      labelCounts: { faux: 0, contestable: 1, simplification: 1, angle_mort: 1, correct: 0 },
    });
    expect(out).not.toContain('✗ Faux identified');
  });

  it('prints hedge warning when verdict_contains_hedge', () => {
    const out = formatTtySummary({
      path: 'x.md',
      metrics: {
        ts: '', scope: 'full', topic: 't', turns: 20, max_turns: 30, cost: 1.2,
        faux_count: 0, total_items: 8, verdict_contains_hedge: true, files_read: 40, commits_reviewed: [],
      },
      fauxItems: [],
      labelCounts: { faux: 0, contestable: 2, simplification: 1, angle_mort: 1, correct: 4 },
    });
    expect(out).toMatch(/verdict hedges|hedge/i);
  });
});
