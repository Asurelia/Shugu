/**
 * Meta-Harness: Report Generator
 *
 * Produces human-readable Markdown reports for runs,
 * candidates, and config diffs.
 */

import type {
  RunManifest,
  CandidateManifest,
  EvalResult,
  HarnessConfig,
  ScoredCandidate,
} from './types.js';

// ─── Run Report ───────────────────────────────────────

export function generateRunReport(
  manifest: RunManifest,
  candidates: CandidateManifest[],
  frontier: ScoredCandidate[],
): string {
  const lines: string[] = [
    `# Meta-Harness Run Report`,
    ``,
    `**Run ID:** ${manifest.runId}`,
    `**Status:** ${manifest.status}`,
    `**Generation:** ${manifest.generation}/${manifest.maxGenerations}`,
    `**Dataset:** ${manifest.dataset}`,
    `**Search set:** ${manifest.searchSetIds.length} tasks | **Holdout:** ${manifest.holdoutSetIds.length} tasks`,
    `**Total cost:** $${manifest.totalCostUsd.toFixed(4)}`,
    `**Started:** ${manifest.startedAt}`,
    ``,
    `## Candidates (${candidates.length})`,
    ``,
    `| # | ID | Gen | Score | Success | Cost | Turns | Pareto |`,
    `|---|---|----|-------|---------|------|-------|--------|`,
  ];

  // Sort by aggregate score descending
  const sorted = [...candidates].sort((a, b) => b.aggregateScore - a.aggregateScore);
  const frontierIds = new Set(frontier.map(f => f.candidateId));

  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i]!;
    const isPf = frontierIds.has(c.candidateId) ? 'yes' : '';
    lines.push(`| ${i + 1} | ${c.candidateId.slice(0, 8)} | ${c.generation} | ${c.aggregateScore.toFixed(3)} | ${(c.successRate * 100).toFixed(0)}% | $${c.costUsd.toFixed(4)} | ${c.avgTurns.toFixed(1)} | ${isPf} |`);
  }

  if (manifest.currentBest) {
    lines.push(``, `**Current best:** ${manifest.currentBest}`);
  }

  if (frontier.length > 0) {
    lines.push(``, `## Pareto Frontier (${frontier.length} candidates)`);
    for (const f of frontier) {
      const o = f.objectives;
      lines.push(`- **${f.candidateId.slice(0, 8)}**: accuracy=${o.accuracy.toFixed(2)}, cost=$${o.cost.toFixed(4)}, turns=${o.turns.toFixed(1)}, errorRate=${o.errorRate.toFixed(2)}`);
    }
  }

  return lines.join('\n');
}

// ─── Candidate Report ─────────────────────────────────

export function generateCandidateReport(
  candidate: CandidateManifest,
  results: EvalResult[],
): string {
  const lines: string[] = [
    `# Candidate Report: ${candidate.candidateId}`,
    ``,
    `**Generation:** ${candidate.generation}`,
    `**Parent:** ${candidate.parentId ?? 'baseline'}`,
    `**Aggregate Score:** ${candidate.aggregateScore.toFixed(3)}`,
    `**Success Rate:** ${(candidate.successRate * 100).toFixed(1)}%`,
    `**Total Cost:** $${candidate.costUsd.toFixed(4)}`,
    `**Avg Turns:** ${candidate.avgTurns.toFixed(1)}`,
    `**Avg Tokens:** ${Math.round(candidate.avgTokens)}`,
    ``,
    `## Per-Task Results`,
    ``,
    `| Task | Result | Score | Turns | Cost | End Reason |`,
    `|------|--------|-------|-------|------|------------|`,
  ];

  for (const r of results) {
    const status = r.success ? 'PASS' : 'FAIL';
    lines.push(`| ${r.taskId} | ${status} | ${r.score.toFixed(2)} | ${r.turns} | $${r.costUsd.toFixed(4)} | ${r.endReason} |`);
  }

  // Tool usage summary
  const toolTotals = new Map<string, { calls: number; errors: number }>();
  for (const r of results) {
    for (const [tool, stat] of Object.entries(r.toolStats)) {
      const existing = toolTotals.get(tool) ?? { calls: 0, errors: 0 };
      existing.calls += stat.calls;
      existing.errors += stat.errors;
      toolTotals.set(tool, existing);
    }
  }

  if (toolTotals.size > 0) {
    lines.push(``, `## Tool Usage`, ``);
    const sorted = [...toolTotals.entries()].sort((a, b) => b[1].calls - a[1].calls);
    for (const [tool, stat] of sorted) {
      const errRate = stat.calls > 0 ? ((stat.errors / stat.calls) * 100).toFixed(0) : '0';
      lines.push(`- **${tool}**: ${stat.calls} calls, ${stat.errors} errors (${errRate}%)`);
    }
  }

  // Failures detail
  const failures = results.filter(r => !r.success);
  if (failures.length > 0) {
    lines.push(``, `## Failures`);
    for (const f of failures) {
      lines.push(``, `### ${f.taskId}`);
      if (f.error) lines.push(`**Error:** ${f.error}`);
      lines.push(`End reason: ${f.endReason}, turns: ${f.turns}`);
      if (f.criteriaResults.length > 0) {
        for (const cr of f.criteriaResults) {
          const icon = cr.passed ? 'pass' : 'FAIL';
          lines.push(`- [${icon}] ${cr.criterion.type}: ${cr.criterion.value}`);
        }
      }
    }
  }

  return lines.join('\n');
}

// ─── Config Diff ──────────────────────────────────────

export function generateDiffReport(
  configA: HarnessConfig,
  configB: HarnessConfig,
): string {
  const lines: string[] = [
    `# Config Diff`,
    ``,
    `**A:** ${configA.name} v${configA.version}`,
    `**B:** ${configB.name} v${configB.version}`,
    ``,
  ];

  // Compare top-level fields
  const allKeys = new Set([...Object.keys(configA), ...Object.keys(configB)]);

  for (const key of allKeys) {
    const a = (configA as unknown as Record<string, unknown>)[key];
    const b = (configB as unknown as Record<string, unknown>)[key];
    const aStr = JSON.stringify(a, null, 2);
    const bStr = JSON.stringify(b, null, 2);

    if (aStr !== bStr) {
      lines.push(`## ${key}`);
      if (a === undefined) {
        lines.push(`Added in B:\n\`\`\`\n${bStr}\n\`\`\``);
      } else if (b === undefined) {
        lines.push(`Removed in B (was in A):\n\`\`\`\n${aStr}\n\`\`\``);
      } else {
        lines.push(`A:\n\`\`\`\n${aStr}\n\`\`\``);
        lines.push(`B:\n\`\`\`\n${bStr}\n\`\`\``);
      }
      lines.push(``);
    }
  }

  if (lines.length <= 5) {
    lines.push(`No differences found.`);
  }

  return lines.join('\n');
}
