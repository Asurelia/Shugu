/**
 * Meta-Harness: Evaluation Engine
 *
 * Runs candidate harness configs against a task suite,
 * scoring each task and producing a CandidateManifest.
 *
 * Each task runs in a fresh git worktree for isolation.
 * Traces are redacted before archival.
 */

import { randomUUID } from 'node:crypto';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorktree, removeWorktree, type Worktree } from '../agents/worktree.js';
import { resolveGitRoot } from '../utils/git.js';
import { tracer } from '../utils/tracer.js';
import { bootstrapMeta } from './runtime.js';
import { runStructuredQuery } from './collect.js';
import { buildSafeEnv } from '../utils/security.js';
import { redactMessages, redactTraceEvents } from './redact.js';
import type { MetaArchive } from './archive.js';
import type {
  HarnessConfig,
  EvalTask,
  EvalResult,
  CandidateManifest,
  EvaluatorOptions,
  SuccessCriterion,
  CriterionResult,
  StructuredResult,
  ToolStat,
} from './types.js';

const execAsync = promisify(exec);

export class MetaEvaluator {
  constructor(
    private archive: MetaArchive,
    private options: EvaluatorOptions,
  ) {}

  /**
   * Evaluate a candidate harness config against a set of tasks.
   * Returns the aggregate manifest for this candidate.
   */
  async evaluate(
    config: HarnessConfig,
    tasks: EvalTask[],
    runId: string,
    candidateId: string,
  ): Promise<CandidateManifest> {
    const results: EvalResult[] = [];
    let totalCost = 0;

    for (const task of tasks) {
      for (let repeat = 0; repeat < this.options.repeatCount; repeat++) {
        const result = await this.evaluateTask(config, task, runId, candidateId, repeat);
        results.push(result);
        totalCost += result.costUsd;

        // Budget guard
        if (this.options.maxCandidateBudgetUsd && totalCost > this.options.maxCandidateBudgetUsd) {
          tracer.log('error', { message: `Candidate ${candidateId} exceeded budget at $${totalCost.toFixed(4)}` });
          break;
        }
      }

      if (this.options.maxCandidateBudgetUsd && totalCost > this.options.maxCandidateBudgetUsd) {
        break;
      }
    }

    // Aggregate scores
    const scores = this.aggregateScores(results);
    const manifest: CandidateManifest = {
      candidateId,
      runId,
      generation: 0, // Set by caller
      parentId: config.parent,
      config,
      aggregateScore: scores.aggregateScore,
      costUsd: totalCost,
      avgTurns: scores.avgTurns,
      avgTokens: scores.avgTokens,
      taskCount: tasks.length,
      successRate: scores.successRate,
      createdAt: new Date().toISOString(),
    };

    await this.archive.writeCandidate(runId, manifest, config);
    await this.archive.writeScores(runId, candidateId, scores);

    return manifest;
  }

  /**
   * Evaluate a single task in a fresh worktree.
   */
  private async evaluateTask(
    config: HarnessConfig,
    task: EvalTask,
    runId: string,
    candidateId: string,
    repeatIndex: number,
  ): Promise<EvalResult> {
    let worktree: Worktree | null = null;
    const startMs = Date.now();

    try {
      // Create isolated worktree
      const gitRoot = await resolveGitRoot(process.cwd());
      worktree = await createWorktree(gitRoot, 'pcc-meta-eval');
      const taskCwd = task.cwd ? join(worktree.path, task.cwd) : worktree.path;

      // Run setup command if provided
      if (task.setupCommand) {
        try {
          await execAsync(task.setupCommand, { cwd: taskCwd, timeout: 30_000, env: buildSafeEnv() });
        } catch (err) {
          return this.errorResult(task, candidateId, runId, repeatIndex, startMs,
            `Setup command failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Bootstrap a non-interactive runtime
      const archivePath = this.archive['basePath']; // access private for absolute path
      const runtime = await bootstrapMeta({
        harnessConfig: config,
        cwd: taskCwd,
        archivePath,
      });

      try {
        // Execute the task
        const structured = await runStructuredQuery(task.prompt, runtime, {
          timeoutMs: task.timeoutMs ?? 300_000,
        });

        // Score the result
        const { score, criteriaResults, success } = await this.scoreTask(task, structured, taskCwd);

        // Redact and archive
        const redactedMessages = redactMessages(structured.messages);
        const traceEvents = tracer.getTraceEvents(structured.traceId);
        const redactedTraces = redactTraceEvents(traceEvents);

        const result: EvalResult = {
          taskId: task.id,
          candidateId,
          runId,
          repeatIndex,
          success,
          score,
          criteriaResults,
          costUsd: structured.costUsd,
          turns: structured.turns,
          totalTokens: { input: structured.totalUsage.input_tokens, output: structured.totalUsage.output_tokens },
          endReason: structured.endReason,
          durationMs: Date.now() - startMs,
          traceId: structured.traceId,
          toolStats: structured.toolStats,
        };

        await this.archive.writeResult(runId, candidateId, result);
        await this.archive.writeTrace(runId, candidateId, task.id, redactedTraces);

        return result;
      } finally {
        await runtime.dispose();
      }
    } catch (err) {
      return this.errorResult(task, candidateId, runId, repeatIndex, startMs,
        err instanceof Error ? err.message : String(err));
    } finally {
      // Always cleanup worktree
      if (worktree) {
        try {
          const gitRoot = await resolveGitRoot(process.cwd());
          await removeWorktree(gitRoot, worktree);
        } catch { /* best effort cleanup */ }
      }
    }
  }

  /**
   * Score a task result using the task's scorer.
   */
  private async scoreTask(
    task: EvalTask,
    result: StructuredResult,
    cwd: string,
  ): Promise<{ score: number; criteriaResults: CriterionResult[]; success: boolean }> {
    switch (task.scorer.type) {
      case 'criteria':
        return this.scoreByCriteria(task.scorer.criteria, result, cwd);

      case 'command': {
        try {
          const { stdout } = await execAsync(task.scorer.command, { cwd, timeout: 30_000, env: buildSafeEnv() });
          if (task.scorer.parseScore === 'exit_code') {
            return { score: 1.0, criteriaResults: [], success: true };
          }
          // stdout_float
          const score = parseFloat(stdout.trim());
          return {
            score: isNaN(score) ? 0 : Math.max(0, Math.min(1, score)),
            criteriaResults: [],
            success: score > 0.5,
          };
        } catch {
          return { score: 0, criteriaResults: [], success: false };
        }
      }

      case 'llm_judge':
        // LLM-as-judge scoring — simplified for V1
        // TODO: implement with MiniMax call using rubric
        return { score: 0.5, criteriaResults: [], success: true };
    }
  }

  /**
   * Score by evaluating individual criteria.
   */
  private async scoreByCriteria(
    criteria: SuccessCriterion[],
    result: StructuredResult,
    cwd: string,
  ): Promise<{ score: number; criteriaResults: CriterionResult[]; success: boolean }> {
    const criteriaResults: CriterionResult[] = [];
    let weightedSum = 0;
    let totalWeight = 0;

    for (const criterion of criteria) {
      const weight = criterion.weight ?? 1;
      totalWeight += weight;

      const passed = await this.evaluateCriterion(criterion, result, cwd);
      criteriaResults.push({ criterion, passed });

      if (passed) weightedSum += weight;
    }

    const score = totalWeight > 0 ? weightedSum / totalWeight : 0;
    return { score, criteriaResults, success: score >= 0.5 };
  }

  /**
   * Evaluate a single criterion.
   */
  private async evaluateCriterion(
    criterion: SuccessCriterion,
    result: StructuredResult,
    cwd: string,
  ): Promise<boolean> {
    switch (criterion.type) {
      case 'file_exists': {
        try {
          await stat(join(cwd, String(criterion.value)));
          return true;
        } catch {
          return false;
        }
      }

      case 'file_contains': {
        try {
          // Find any file that contains the pattern
          const files = await this.findRecentFiles(cwd);
          for (const file of files) {
            try {
              const content = await readFile(file, 'utf-8');
              if (content.includes(String(criterion.value))) return true;
            } catch { continue; }
          }
          return false;
        } catch {
          return false;
        }
      }

      case 'command_succeeds': {
        try {
          await execAsync(String(criterion.value), { cwd, timeout: 30_000, env: buildSafeEnv() });
          return true;
        } catch {
          return false;
        }
      }

      case 'output_contains': {
        const text = result.messages
          .filter(m => m.role === 'assistant')
          .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
          .join('\n');
        return text.includes(String(criterion.value));
      }

      case 'cost_under':
        return result.costUsd < Number(criterion.value);

      case 'turns_under':
        return result.turns < Number(criterion.value);
    }
  }

  /**
   * Find recently modified files in the worktree (for file_contains checks).
   */
  private async findRecentFiles(cwd: string): Promise<string[]> {
    try {
      const { stdout } = await execAsync(
        'git diff --name-only HEAD 2>/dev/null || find . -name "*.ts" -o -name "*.js" -o -name "*.md" | head -20',
        { cwd, timeout: 5_000, env: buildSafeEnv() },
      );
      return stdout.trim().split('\n').filter(Boolean).map(f => join(cwd, f));
    } catch {
      return [];
    }
  }

  /**
   * Create an error result for a failed task.
   */
  private errorResult(
    task: EvalTask,
    candidateId: string,
    runId: string,
    repeatIndex: number,
    startMs: number,
    error: string,
  ): EvalResult {
    return {
      taskId: task.id,
      candidateId,
      runId,
      repeatIndex,
      success: false,
      score: 0,
      criteriaResults: [],
      costUsd: 0,
      turns: 0,
      totalTokens: { input: 0, output: 0 },
      endReason: 'error',
      durationMs: Date.now() - startMs,
      traceId: '',
      toolStats: {},
      error,
    };
  }

  /**
   * Aggregate scores across repeated runs.
   */
  private aggregateScores(results: EvalResult[]): {
    aggregateScore: number;
    successRate: number;
    avgTurns: number;
    avgTokens: number;
  } {
    if (results.length === 0) {
      return { aggregateScore: 0, successRate: 0, avgTurns: 0, avgTokens: 0 };
    }

    // Group by taskId and aggregate per-task
    const byTask = new Map<string, EvalResult[]>();
    for (const r of results) {
      const existing = byTask.get(r.taskId) ?? [];
      existing.push(r);
      byTask.set(r.taskId, existing);
    }

    const taskScores: number[] = [];
    for (const taskResults of byTask.values()) {
      const scores = taskResults.map(r => r.score);
      taskScores.push(this.aggregate(scores));
    }

    const aggregateScore = taskScores.reduce((a, b) => a + b, 0) / taskScores.length;
    const successRate = results.filter(r => r.success).length / results.length;
    const avgTurns = results.reduce((a, r) => a + r.turns, 0) / results.length;
    const avgTokens = results.reduce((a, r) => a + r.totalTokens.input + r.totalTokens.output, 0) / results.length;

    return { aggregateScore, successRate, avgTurns, avgTokens };
  }

  /**
   * Aggregate a list of scores using the configured strategy.
   */
  private aggregate(scores: number[]): number {
    if (scores.length === 0) return 0;

    switch (this.options.aggregation) {
      case 'mean':
        return scores.reduce((a, b) => a + b, 0) / scores.length;

      case 'median': {
        const sorted = [...scores].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 0
          ? (sorted[mid - 1]! + sorted[mid]!) / 2
          : sorted[mid]!;
      }

      case 'best':
        return Math.max(...scores);

      case 'worst':
        return Math.min(...scores);
    }
  }
}
