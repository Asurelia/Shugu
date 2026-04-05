/**
 * Layer 8 — Agents: Task delegation
 *
 * Higher-level patterns for delegating work to sub-agents.
 * Supports parallel execution, sequential chains, and result aggregation.
 */

import { AgentOrchestrator, type AgentResult, type SpawnOptions } from './orchestrator.js';

// ─── Parallel Delegation ────────────────────────────────

export interface ParallelTask {
  id: string;
  prompt: string;
  agentType?: string;
  options?: SpawnOptions;
}

export interface ParallelResults {
  results: Map<string, AgentResult>;
  totalCostUsd: number;
  allSucceeded: boolean;
}

/**
 * Run multiple sub-agents in parallel and collect all results.
 */
export async function delegateParallel(
  orchestrator: AgentOrchestrator,
  tasks: ParallelTask[],
): Promise<ParallelResults> {
  const promises = tasks.map(async (task) => {
    const result = await orchestrator.spawn(
      task.prompt,
      task.agentType ?? 'general',
      task.options,
    );
    return { id: task.id, result };
  });

  const completed = await Promise.all(promises);

  const results = new Map<string, AgentResult>();
  let totalCostUsd = 0;
  let allSucceeded = true;

  for (const { id, result } of completed) {
    results.set(id, result);
    totalCostUsd += result.costUsd;
    if (!result.success) allSucceeded = false;
  }

  return { results, totalCostUsd, allSucceeded };
}

// ─── Sequential Chain ───────────────────────────────────

export interface ChainStep {
  id: string;
  prompt: string | ((previousResult: string) => string);
  agentType?: string;
  options?: SpawnOptions;
}

/**
 * Run sub-agents sequentially, feeding each result into the next step.
 */
export async function delegateChain(
  orchestrator: AgentOrchestrator,
  steps: ChainStep[],
): Promise<AgentResult[]> {
  const results: AgentResult[] = [];
  let previousResult = '';

  for (const step of steps) {
    const prompt = typeof step.prompt === 'function'
      ? step.prompt(previousResult)
      : step.prompt;

    const result = await orchestrator.spawn(
      prompt,
      step.agentType ?? 'general',
      {
        ...step.options,
        context: previousResult
          ? `Previous step result:\n${previousResult.slice(0, 2000)}`
          : undefined,
      },
    );

    results.push(result);
    previousResult = result.response;

    // Stop chain if a step fails
    if (!result.success) break;
  }

  return results;
}

// ─── Result Formatting ──────────────────────────────────

/**
 * Format parallel results into a readable summary.
 */
export function formatParallelResults(results: ParallelResults): string {
  const lines: string[] = [];
  lines.push(`Parallel execution: ${results.results.size} agents, $${results.totalCostUsd.toFixed(4)}`);

  for (const [id, result] of results.results) {
    const status = result.success ? 'OK' : 'FAILED';
    const preview = result.response.slice(0, 200).replace(/\n/g, ' ');
    lines.push(`\n[${id}] ${status} (${result.turns} turns, $${result.costUsd.toFixed(4)})`);
    lines.push(`  ${preview}${result.response.length > 200 ? '...' : ''}`);
  }

  return lines.join('\n');
}
