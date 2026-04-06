/**
 * Layer 5 — Context: barrel export
 */

export { TokenBudgetTracker, estimateTokens, type TokenBudgetConfig, type TokenBudgetStatus } from './tokenBudget.js';
export { compactConversation, type CompactionConfig, type CompactionResult } from './compactor.js';
export { MemoryStore, type Memory, type MemoryType } from './memory/store.js';
export { detectMemoryHints, formatMemoriesForPrompt, type MemoryCandidate } from './memory/extract.js';
export { MemoryAgent, type MemoryItem } from './memory/agent.js';
export { SessionManager, type SessionData, type SessionSummary } from './session/persistence.js';
export { getGitContext, formatGitContext, type GitContext } from './workspace/git.js';
export { getProjectContext, formatProjectContext, type ProjectContext } from './workspace/project.js';
export { ObsidianVault, discoverVault, type ObsidianNote, type VaultConfig } from './memory/obsidian.js';
