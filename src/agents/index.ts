/**
 * Layer 8 — Agents: barrel export
 */

export {
  AgentOrchestrator,
  BUILTIN_AGENTS,
  type AgentDefinition,
  type AgentResult,
  type SpawnOptions,
} from './orchestrator.js';

export {
  delegateParallel,
  delegateChain,
  formatParallelResults,
  type ParallelTask,
  type ParallelResults,
  type ChainStep,
} from './delegation.js';

export {
  createWorktree,
  removeWorktree,
  worktreeHasChanges,
  mergeWorktree,
  type Worktree,
} from './worktree.js';
