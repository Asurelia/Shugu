/**
 * Meta-Harness: Type Definitions
 *
 * All interfaces for the Meta-Harness outer-loop optimizer.
 * This module defines the vocabulary for harness configuration,
 * evaluation tasks, scoring, and the search archive.
 *
 * Reference: "Meta-Harness: End-to-End Optimization of Model Harnesses"
 * (Lee et al., arXiv 2603.28052)
 */

import type { Message, Usage } from '../protocol/messages.js';
import type { LoopEvent } from '../engine/loop.js';
import type { Complexity } from '../engine/strategy.js';
import type { AgentDefinition } from '../agents/orchestrator.js';

// ─── Harness Configuration ────────────────────────────

/**
 * A HarnessConfig captures all mutable knobs around the Shugu engine.
 * The proposer edits these; the evaluator applies them.
 *
 * V1 restrictions:
 * - BASE_SYSTEM_PROMPT is IMMUTABLE (no systemPromptOverride)
 * - model.name is fixed per run (not mutable by proposer)
 * - transport/protocol/policy/credentials are IMMUTABLE zones
 */
export interface HarnessConfig {
  /** Human-readable name for this configuration */
  name: string;
  /** Semantic version */
  version: string;
  /** candidateId of the parent config (for lineage tracking) */
  parent?: string;

  // ── Prompt mutations (BASE_SYSTEM_PROMPT is IMMUTABLE) ──

  /** Text appended AFTER the base system prompt */
  systemPromptAppend?: string;
  /** Named fragments injected at predefined positions in the prompt */
  promptFragments?: Record<string, string>;

  // ── Strategy mutations ──

  strategy?: {
    /** Override the LLM classification prompt */
    classifyPrompt?: string;
    /** Force a specific complexity level (skip classification) */
    complexityOverride?: Complexity;
    /** Override strategy prompts per complexity level */
    strategyPrompts?: Partial<Record<Complexity, string | null>>;
    /** Override reflection intervals per complexity level */
    reflectionIntervals?: Partial<Record<Complexity, number>>;
  };

  // ── Reflection mutations ──

  reflection?: {
    /** Override the reflection prompt template. Use {{turnIndex}} and {{maxTurns}} */
    promptTemplate?: string;
    /** Force a specific reflection interval for all complexities */
    forceInterval?: number;
  };

  // ── Agent profile mutations ──

  /** Override or add agent definitions (merged with BUILTIN_AGENTS) */
  agents?: Record<string, Partial<AgentDefinition>>;

  // ── Limits ──

  limits?: {
    maxTurns?: number;
    maxBudgetUsd?: number;
    toolTimeoutMs?: number;
  };

  // ── Model settings ──

  model?: {
    /** Temperature for the evaluated model (not the proposer) */
    temperature?: number;
    /** Max tokens per response */
    maxTokens?: number;
  };

  // ── Hook activation ──

  hooks?: {
    /** Names of builtin hooks to enable */
    enable?: string[];
    /** Names of builtin hooks to disable */
    disable?: string[];
  };
}

// ─── Harness Runtime Overrides ────────────────────────

/**
 * Runtime overrides threaded into the engine loop.
 * These are the values that loop.ts reads at specific points.
 */
export interface HarnessRuntime {
  /** Override TOOL_TIMEOUT_MS (default 300_000) */
  toolTimeoutMs?: number;
  /** Override reflection interval (per-complexity or forced) */
  reflectionInterval?: number;
  /** Override reflection prompt template */
  reflectionTemplate?: string;
  /** Override MAX_CONTINUATIONS */
  maxContinuations?: number;
}

// ─── Evaluation Tasks ─────────────────────────────────

/**
 * A task the evaluator runs against a candidate harness.
 */
export interface EvalTask {
  /** Unique identifier */
  id: string;
  /** The prompt sent to Shugu */
  prompt: string;
  /** Working directory (relative to repo root; resolved to worktree at eval time) */
  cwd?: string;
  /** Bash command to run before the task (e.g., git checkout, file setup) */
  setupCommand?: string;
  /** Max time for the entire task execution */
  timeoutMs?: number;
  /** Tags for filtering and grouping */
  tags?: string[];
  /** How to score this task */
  scorer: TaskScorer;
}

/**
 * Scorer for an evaluation task. Supports three modes:
 * - criteria: built-in multi-criteria scoring
 * - command: external scorer via shell command
 * - llm_judge: LLM-as-judge for subjective tasks
 */
export type TaskScorer =
  | { type: 'criteria'; criteria: SuccessCriterion[] }
  | { type: 'command'; command: string; parseScore: 'exit_code' | 'stdout_float' }
  | { type: 'llm_judge'; prompt: string; rubric: string };

/**
 * A single criterion for the built-in criteria scorer.
 */
export interface SuccessCriterion {
  type: 'file_exists' | 'file_contains' | 'command_succeeds' | 'output_contains' | 'cost_under' | 'turns_under';
  /** Expected value — path for file_exists, pattern for file_contains, etc. */
  value: string | number;
  /** Weight in the aggregate score (default: 1) */
  weight?: number;
}

/**
 * Result of evaluating a single criterion.
 */
export interface CriterionResult {
  criterion: SuccessCriterion;
  passed: boolean;
  actual?: string | number;
}

// ─── Evaluation Results ───────────────────────────────

/**
 * Result of evaluating a single task with a single candidate.
 */
export interface EvalResult {
  taskId: string;
  candidateId: string;
  runId: string;
  /** Which repetition this is (0-indexed) */
  repeatIndex: number;
  /** Whether the task succeeded per the scorer */
  success: boolean;
  /** Score from 0.0 to 1.0 */
  score: number;
  /** Per-criterion results (for criteria scorer) */
  criteriaResults: CriterionResult[];
  /** Total cost in USD */
  costUsd: number;
  /** Number of turns used */
  turns: number;
  /** Token usage */
  totalTokens: { input: number; output: number };
  /** How the loop ended */
  endReason: string;
  /** Wall-clock duration in ms */
  durationMs: number;
  /** Trace ID for correlation */
  traceId: string;
  /** Per-tool statistics */
  toolStats: Record<string, ToolStat>;
  /** Error message if the task errored */
  error?: string;
}

export interface ToolStat {
  calls: number;
  errors: number;
  totalMs: number;
}

// ─── Candidates ───────────────────────────────────────

/**
 * Aggregate manifest for a candidate harness after evaluation.
 */
export interface CandidateManifest {
  candidateId: string;
  runId: string;
  /** Generation in the search process */
  generation: number;
  /** Parent candidate ID (for lineage) */
  parentId?: string;
  /** The harness config snapshot */
  config: HarnessConfig;
  /** Aggregate score across all tasks */
  aggregateScore: number;
  /** Total cost of evaluation */
  costUsd: number;
  /** Average turns per task */
  avgTurns: number;
  /** Average tokens per task */
  avgTokens: number;
  /** Number of tasks evaluated */
  taskCount: number;
  /** Fraction of tasks that succeeded */
  successRate: number;
  /** Pareto rank (1 = frontier, higher = dominated) */
  paretoRank?: number;
  /** ISO timestamp */
  createdAt: string;
}

// ─── Runs ─────────────────────────────────────────────

/**
 * Manifest for an optimization run.
 */
export interface RunManifest {
  runId: string;
  status: 'running' | 'paused' | 'completed' | 'aborted';
  /** Current generation (0-indexed) */
  generation: number;
  /** Max generations before stopping */
  maxGenerations: number;
  /** Candidates proposed per generation */
  candidatesPerGeneration: number;
  /** Path to the dataset file */
  dataset: string;

  /** IDs of tasks in the search set (proposer sees these results) */
  searchSetIds: string[];
  /** IDs of tasks in the holdout set (proposer NEVER sees these) */
  holdoutSetIds: string[];

  /** ISO timestamp */
  startedAt: string;
  updatedAt: string;
  /** All candidate IDs in this run */
  candidates: string[];
  /** Current best candidate on search set */
  currentBest?: string;
  /** Total cost of the entire run */
  totalCostUsd: number;

  /** Holdout evaluation results for promoted candidates */
  holdoutResults?: Record<string, CandidateManifest>;
}

// ─── Structured Query Result ──────────────────────────

/**
 * The structured output of running a single task through the engine.
 * This is what runStructuredQuery() returns.
 */
export interface StructuredResult {
  /** Canonical conversation messages */
  messages: Message[];
  /** All loop events (for trace archival) */
  events: LoopEvent[];
  /** Total cost in USD */
  costUsd: number;
  /** Number of turns */
  turns: number;
  /** How the loop ended */
  endReason: string;
  /** Per-tool statistics */
  toolStats: Record<string, ToolStat>;
  /** Trace ID for correlation */
  traceId: string;
  /** Cumulative token usage */
  totalUsage: Usage;
  /** Wall-clock duration in ms */
  durationMs: number;
}

// ─── Scoring & Selection ──────────────────────────────

/**
 * A candidate with its multi-objective scores for Pareto selection.
 */
export interface ScoredCandidate {
  candidateId: string;
  objectives: {
    /** Higher is better (0-1) */
    accuracy: number;
    /** Lower is better (USD) */
    cost: number;
    /** Lower is better */
    tokens: number;
    /** Lower is better */
    turns: number;
    /** Lower is better (0-1) */
    errorRate: number;
  };
}

// ─── Evaluator Options ────────────────────────────────

/**
 * Configuration for the evaluation engine.
 */
export interface EvaluatorOptions {
  /** How many times to repeat each task (default: 1) */
  repeatCount: number;
  /** How to aggregate scores across repetitions */
  aggregation: 'median' | 'mean' | 'best' | 'worst';
  /** Temperature override for evaluation runs (default: 0.01) */
  temperature?: number;
  /** Max budget per candidate evaluation in USD */
  maxCandidateBudgetUsd?: number;
}

// ─── Meta Runtime ─────────────────────────────────────

/**
 * Config for bootstrapping a non-interactive Shugu runtime.
 */
export interface MetaRuntimeConfig {
  /** The harness configuration to apply */
  harnessConfig: HarnessConfig;
  /** Working directory (typically a worktree path) */
  cwd: string;
  /** Permission mode (default: 'fullAuto') */
  permissionMode?: 'fullAuto' | 'bypass';
  /** Absolute path to the meta archive (~/.pcc/meta/) */
  archivePath: string;
}

// ─── Dataset Split ────────────────────────────────────

/**
 * A dataset split into search and holdout sets.
 */
export interface DatasetSplit {
  searchSet: EvalTask[];
  holdoutSet: EvalTask[];
}
