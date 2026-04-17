/**
 * Meta-Harness: Agentic Proposer
 *
 * Uses Shugu itself (via AgentOrchestrator.spawn()) to propose
 * new harness configurations by analyzing prior candidates'
 * configs, scores, and execution traces.
 *
 * The proposer receives the absolute path to the archive filesystem
 * and uses read-only tools (Read, Glob, Grep) plus Write to inspect it
 * and emit config.yaml. Bash is intentionally withheld.
 *
 * Key design: the proposer is a Shugu agent, not a separate system.
 * It runs in a worktree and writes new config.yaml files.
 */

import { parse as parseYaml } from 'yaml';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentOrchestrator } from '../agents/orchestrator.js';
import type { MiniMaxClient } from '../transport/client.js';
import type { MetaArchive } from './archive.js';
import type {
  HarnessConfig,
  CandidateManifest,
  ScoredCandidate,
} from './types.js';
import { computeParetoFrontier, rankByWeightedScore } from './selector.js';
import { validateHarnessConfig } from './config.js';
import { tracer } from '../utils/tracer.js';

// ─── Proposer ─────────────────────────────────────────

export class MetaProposer {
  constructor(
    private orchestrator: AgentOrchestrator,
    private archive: MetaArchive,
    private client: MiniMaxClient,
  ) {}

  /**
   * Propose new harness configurations based on prior candidates.
   *
   * @param runId - Current run ID
   * @param parents - Parent candidates to base proposals on
   * @param generation - Current generation number
   * @param count - Number of configs to propose
   * @returns Array of validated HarnessConfig proposals
   */
  async propose(
    runId: string,
    parents: CandidateManifest[],
    generation: number,
    count: number,
  ): Promise<HarnessConfig[]> {
    tracer.log('agent_spawn', { type: 'meta-proposer', generation, parentCount: parents.length });

    const archivePath = this.archive['basePath'];
    const prompt = await this.buildProposerPrompt(runId, parents, generation, count, archivePath);

    const result = await this.orchestrator.spawn(prompt, 'general', {
      maxTurns: 25,
      maxBudgetUsd: 0.50,
      isolation: 'worktree',
      // Intentionally no Bash: the proposer only needs to read the archive
      // and write config.yaml. Denying Bash removes a worktree-escape
      // surface if a hostile archive trace tries to steer it.
      allowedTools: ['Read', 'Write', 'Glob', 'Grep'],
    });

    tracer.log('agent_done', {
      type: 'meta-proposer',
      success: result.success,
      turns: result.turns,
      costUsd: result.costUsd,
    });

    if (!result.success) {
      tracer.log('error', { message: `Proposer failed: ${result.endReason}` });
      return [];
    }

    // Extract configs from the proposer's output
    return this.extractConfigs(result.response, result.worktree?.path, count);
  }

  /**
   * Build the proposer's task prompt with full archive context.
   */
  private async buildProposerPrompt(
    runId: string,
    parents: CandidateManifest[],
    generation: number,
    count: number,
    archivePath: string,
  ): Promise<string> {
    // Build parent summaries
    const parentSummaries = parents.map(p => {
      return `### Candidate ${p.candidateId} (gen ${p.generation})
- Score: ${p.aggregateScore.toFixed(3)} | Success: ${(p.successRate * 100).toFixed(1)}%
- Cost: $${p.costUsd.toFixed(4)} | Turns: ${p.avgTurns.toFixed(1)} | Tokens: ${Math.round(p.avgTokens)}
- Parent: ${p.parentId ?? 'baseline'}`;
    }).join('\n\n');

    // Load per-task results for parents
    const detailedResults: string[] = [];
    for (const parent of parents.slice(0, 3)) { // Limit to top 3 for context
      const results = await this.archive.loadResults(runId, parent.candidateId);
      const resultSummary = results.map(r =>
        `  - ${r.taskId}: ${r.success ? 'PASS' : 'FAIL'} (score=${r.score.toFixed(2)}, turns=${r.turns}, $${r.costUsd.toFixed(4)})`
      ).join('\n');
      detailedResults.push(`**${parent.candidateId}:**\n${resultSummary}`);
    }

    // Compute Pareto frontier for context
    const allCandidates = await this.archive.listCandidates(runId);
    const scored: ScoredCandidate[] = allCandidates.map(c => ({
      candidateId: c.candidateId,
      objectives: {
        accuracy: c.successRate,
        cost: c.costUsd / Math.max(c.taskCount, 1),
        tokens: c.avgTokens,
        turns: c.avgTurns,
        errorRate: 1 - c.successRate,
      },
    }));
    const frontier = computeParetoFrontier(scored);
    const ranked = rankByWeightedScore(scored);

    return `# Meta-Harness Proposer — Generation ${generation}

You are a Meta-Harness proposer. Your job is to analyze prior harness configurations,
their evaluation scores, and execution traces, then propose ${count} improved configuration(s).

## Archive Location
All prior candidates, results, and traces are at: ${archivePath}
Use Read/Glob/Grep to inspect them.

## Directory Structure
\`\`\`
${archivePath}/runs/${runId}/
  manifest.json
  candidates/<id>/
    config.yaml       — the harness config
    scores.json       — aggregate scores
    results/<task>.json — per-task results
    traces/<task>.jsonl — execution traces (REDACTED)
\`\`\`

## Current Parents (best candidates)
${parentSummaries}

## Per-Task Results
${detailedResults.join('\n\n')}

## Pareto Frontier (${frontier.length} candidates)
${frontier.map(f => `- ${f.candidateId}: acc=${f.objectives.accuracy.toFixed(2)}, cost=$${f.objectives.cost.toFixed(4)}, turns=${f.objectives.turns.toFixed(1)}`).join('\n')}

## Leaderboard (top 5)
${ranked.slice(0, 5).map((c, i) => `${i + 1}. ${c.candidateId}: acc=${c.objectives.accuracy.toFixed(2)}, cost=$${c.objectives.cost.toFixed(4)}`).join('\n')}

## Mutation Space (what you CAN change)
- systemPromptAppend: text appended after the immutable base prompt
- promptFragments: named text blocks injected into the prompt
- strategy.complexityOverride: force trivial/simple/complex/epic
- strategy.strategyPrompts: override per-complexity strategy hints
- strategy.reflectionIntervals: override reflection frequency
- reflection.promptTemplate: custom reflection prompt (use {{turnIndex}}, {{maxTurns}})
- reflection.forceInterval: force a specific reflection interval
- agents: override agent definitions (rolePrompt, maxTurns, allowedTools)
- limits.maxTurns, limits.maxBudgetUsd, limits.toolTimeoutMs
- model.temperature, model.maxTokens
- hooks.enable, hooks.disable

## What you CANNOT change
- The base system prompt (immutable)
- The model name (fixed for the run)
- transport, protocol, policy, credentials code
- The evaluation tasks themselves

## Your Task
1. Read the execution traces for FAILED tasks to understand WHY they failed
2. Compare configs of successful vs. unsuccessful candidates
3. Identify patterns: which config changes correlate with improvements?
4. Propose ${count} new config(s) as YAML, each as a complete config.yaml

Write each proposed config as a separate file:
- proposed-1.yaml, proposed-2.yaml, etc.

Each config MUST have: name, version (e.g., "0.${generation + 1}.N")
Each config SHOULD reference its parent: parent: "<candidateId>"

Focus on DIAGNOSTIC reasoning: don't just tweak numbers randomly.
Read the traces to understand causal relationships.`;
  }

  /**
   * Extract HarnessConfig objects from the proposer's output.
   */
  private async extractConfigs(
    response: string,
    worktreePath: string | undefined,
    maxCount: number,
  ): Promise<HarnessConfig[]> {
    const configs: HarnessConfig[] = [];

    // Try to read files from worktree if available
    if (worktreePath) {
      for (let i = 1; i <= maxCount; i++) {
        try {
          const content = await readFile(join(worktreePath, `proposed-${i}.yaml`), 'utf-8');
          const parsed = parseYaml(content) as HarnessConfig;
          const validation = validateHarnessConfig(parsed);
          if (validation.valid) {
            configs.push(parsed);
          } else {
            tracer.log('error', { message: `Proposed config ${i} invalid: ${validation.errors.join(', ')}` });
          }
        } catch { /* file not written */ }
      }
    }

    // Fallback: extract YAML from the response text
    if (configs.length === 0) {
      const yamlBlocks = response.match(/```yaml\s*\n([\s\S]*?)```/g);
      if (yamlBlocks) {
        for (const block of yamlBlocks.slice(0, maxCount)) {
          try {
            const content = block.replace(/```yaml\s*\n/, '').replace(/```$/, '');
            const parsed = parseYaml(content) as HarnessConfig;
            const validation = validateHarnessConfig(parsed);
            if (validation.valid) {
              configs.push(parsed);
            }
          } catch { continue; }
        }
      }
    }

    return configs;
  }
}
