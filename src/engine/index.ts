/**
 * Layer 2 — Engine: barrel export
 */

export { runLoop, query, type LoopConfig, type LoopEvent } from './loop.js';
export { analyzeTurn, buildToolResultMessage, ensureToolResultPairing, shouldContinue, DEFAULT_MAX_TURNS, ContinuationTracker, type TurnResult } from './turns.js';
export { BudgetTracker, calculateCost, getContextWindow, MINIMAX_PRICING } from './budget.js';
export { InterruptController, AbortError, isAbortError } from './interrupts.js';
export {
  runPostTurnIntelligence,
  generatePromptSuggestion,
  speculate,
  extractMemories,
  type IntelligenceConfig,
  type IntelligenceResult,
  type SpeculationResult,
  type ExtractedMemory,
} from './intelligence.js';
