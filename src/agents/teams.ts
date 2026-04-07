/**
 * Layer 8 — Agents: Team coordination (swarms)
 */

import { type AgentOrchestrator, type AgentResult, type SpawnOptions, MAX_ACTIVE_AGENTS } from './orchestrator.js';
import { delegateParallel, delegateChain, formatParallelResults, type ParallelTask, type ChainStep } from './delegation.js';

export interface TeamMember {
  role: string;
  agentType: string;
  roleContext?: string;
  options?: Partial<SpawnOptions>;
}

export interface TeamConfig {
  name: string;
  members: TeamMember[];
  maxBudgetUsd?: number;
  isolation?: 'worktree';
  /** 'parallel' runs all members at once, 'chain' runs sequentially feeding results */
  mode?: 'parallel' | 'chain';
}

export interface TeamResult {
  results: Map<string, AgentResult>;
  summary: string;
  totalCostUsd: number;
  allSucceeded: boolean;
  cleanupWarnings: string[];
}

// Predefined team templates
export const TEAM_TEMPLATES: Record<string, TeamConfig> = {
  default: {
    name: 'Default',
    mode: 'chain',
    members: [
      { role: 'explorer', agentType: 'explore', roleContext: 'Understand the codebase and identify relevant files first.' },
      { role: 'coder', agentType: 'code', roleContext: 'Implement the changes based on the exploration findings.' },
      { role: 'reviewer', agentType: 'review', roleContext: 'Review the implementation for bugs, security issues, and quality.' },
    ],
  },
  parallel: {
    name: 'Parallel Workers',
    mode: 'parallel',
    members: [
      { role: 'worker-1', agentType: 'general', roleContext: 'Handle the first portion of the task.' },
      { role: 'worker-2', agentType: 'general', roleContext: 'Handle the second portion of the task.' },
      { role: 'worker-3', agentType: 'general', roleContext: 'Handle the third portion of the task.' },
    ],
  },
  review: {
    name: 'Review Team',
    mode: 'parallel',
    members: [
      { role: 'security', agentType: 'review', roleContext: 'Focus exclusively on security vulnerabilities, injection risks, credential exposure, and OWASP issues.' },
      { role: 'logic', agentType: 'review', roleContext: 'Focus exclusively on logic bugs, edge cases, error handling gaps, race conditions, and silent failures.' },
      { role: 'architecture', agentType: 'review', roleContext: 'Focus exclusively on design patterns, naming, dead code, coupling, and architectural issues.' },
    ],
  },
};

export class AgentTeam {
  constructor(
    private orchestrator: AgentOrchestrator,
    private config: TeamConfig,
  ) {}

  get name(): string { return this.config.name; }
  get members(): TeamMember[] { return this.config.members; }

  async dispatch(
    task: string,
    onProgress?: (role: string, event: string) => void,
  ): Promise<TeamResult> {
    const memberCount = this.config.members.length;
    const perMemberBudget = this.config.maxBudgetUsd
      ? this.config.maxBudgetUsd / memberCount
      : undefined;

    // Fan-out awareness check
    if (this.orchestrator.activeCount + memberCount > MAX_ACTIVE_AGENTS) {
      return {
        results: new Map(),
        summary: `Team dispatch rejected: would exceed agent limit (${this.orchestrator.activeCount} active + ${memberCount} members > ${MAX_ACTIVE_AGENTS} max).`,
        totalCostUsd: 0,
        allSucceeded: false,
        cleanupWarnings: [],
      };
    }

    const mode = this.config.mode ?? 'parallel';

    if (mode === 'chain') {
      return this.dispatchChain(task, perMemberBudget, onProgress);
    }
    return this.dispatchParallel(task, perMemberBudget, onProgress);
  }

  private async dispatchParallel(
    task: string,
    perMemberBudget: number | undefined,
    onProgress?: (role: string, event: string) => void,
  ): Promise<TeamResult> {
    const tasks: ParallelTask[] = this.config.members.map((member) => {
      const prompt = member.roleContext
        ? `${member.roleContext}\n\n${task}`
        : task;

      const options: SpawnOptions = {
        depth: 1,
        isolation: this.config.isolation,
        maxBudgetUsd: perMemberBudget,
        onEvent: onProgress
          ? (event) => {
              if (event.type === 'turn_end' || event.type === 'loop_end') {
                onProgress(member.role, event.type);
              }
            }
          : undefined,
        ...member.options,
      };

      return {
        id: member.role,
        prompt,
        agentType: member.agentType,
        options,
      };
    });

    const parallelResults = await delegateParallel(this.orchestrator, tasks);

    const cleanupWarnings: string[] = [];
    for (const result of parallelResults.results.values()) {
      if (result.cleanupWarnings) {
        cleanupWarnings.push(...result.cleanupWarnings);
      }
    }

    return {
      results: parallelResults.results,
      summary: formatParallelResults(parallelResults),
      totalCostUsd: parallelResults.totalCostUsd,
      allSucceeded: parallelResults.allSucceeded,
      cleanupWarnings,
    };
  }

  private async dispatchChain(
    task: string,
    perMemberBudget: number | undefined,
    onProgress?: (role: string, event: string) => void,
  ): Promise<TeamResult> {
    const steps: ChainStep[] = this.config.members.map((member, index) => {
      const buildPrompt = (previousResult: string): string => {
        const base = member.roleContext
          ? `${member.roleContext}\n\n${task}`
          : task;
        if (index === 0 || !previousResult) {
          return base;
        }
        return `${base}\n\nPrevious step findings:\n${previousResult.slice(0, 2000)}`;
      };

      const options: SpawnOptions = {
        depth: 1,
        isolation: this.config.isolation,
        maxBudgetUsd: perMemberBudget,
        onEvent: onProgress
          ? (event) => {
              if (event.type === 'turn_end' || event.type === 'loop_end') {
                onProgress(member.role, event.type);
              }
            }
          : undefined,
        ...member.options,
      };

      return {
        id: member.role,
        prompt: index === 0
          ? (member.roleContext ? `${member.roleContext}\n\n${task}` : task)
          : buildPrompt,
        agentType: member.agentType,
        options,
      };
    });

    const chainResults = await delegateChain(this.orchestrator, steps);

    const results = new Map<string, AgentResult>();
    let totalCostUsd = 0;
    let allSucceeded = true;
    const cleanupWarnings: string[] = [];

    for (let i = 0; i < chainResults.length; i++) {
      const member = this.config.members[i]!;
      const result = chainResults[i]!;
      results.set(member.role, result);
      totalCostUsd += result.costUsd;
      if (!result.success) allSucceeded = false;
      if (result.cleanupWarnings) {
        cleanupWarnings.push(...result.cleanupWarnings);
      }
    }

    // Build summary in the same format as formatParallelResults
    const lines: string[] = [];
    lines.push(`Chain execution: ${results.size} agents, $${totalCostUsd.toFixed(4)}`);
    for (const [id, result] of results) {
      const status = result.success ? 'OK' : 'FAILED';
      const preview = result.response.slice(0, 200).replace(/\n/g, ' ');
      lines.push(`\n[${id}] ${status} (${result.turns} turns, $${result.costUsd.toFixed(4)})`);
      lines.push(`  ${preview}${result.response.length > 200 ? '...' : ''}`);
    }

    return {
      results,
      summary: lines.join('\n'),
      totalCostUsd,
      allSucceeded,
      cleanupWarnings,
    };
  }
}
