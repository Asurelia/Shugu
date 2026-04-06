/**
 * Layer 2 — Engine: Strategic Task Analysis
 *
 * The "brain" layer that transforms Shugu from a reactive agent into a strategic one.
 * Runs BEFORE each model turn to:
 * 1. Classify task complexity (heuristic-first, LLM-fallback)
 * 2. Generate strategic hints injected into the system prompt
 * 3. Suggest agent routing for complex tasks
 *
 * Design principle: Guide M2.7's Interleaved Thinking with better context,
 * don't replace it. The model still makes all tool/agent decisions.
 *
 * Cost: 0 tokens for trivial/heuristic, ~150 tokens (M2.5) for ambiguous tasks.
 */

import type { MiniMaxClient } from '../transport/client.js';
import type { Message } from '../protocol/messages.js';
import { isTextBlock } from '../protocol/messages.js';
import { MINIMAX_MODELS } from '../transport/client.js';
import { logger } from '../utils/logger.js';
import { tracer } from '../utils/tracer.js';

// ─── Types ────────────────────────────────────────────

export type Complexity = 'trivial' | 'simple' | 'complex' | 'epic';

export interface TaskStrategy {
  /** Classified complexity level */
  complexity: Complexity;
  /** Strategy block to inject into system prompt (null = no injection) */
  strategyPrompt: string | null;
  /** How often to inject reflection prompts (0 = never) */
  reflectionInterval: number;
  /** Whether the heuristic or LLM classified this */
  classifiedBy: 'heuristic' | 'llm';
}

// ─── Heuristic Classifier (zero tokens) ──────────────

/** Action verbs that indicate work complexity */
const ACTION_VERBS = /\b(fix|add|create|update|remove|refactor|test|search|find|implement|build|write|check|migrate|deploy|design|optimize|debug|review|analyze)\b/gi;

/** Keywords that strongly signal epic-scale work */
const EPIC_KEYWORDS = /\b(application|app|système|system|platform|from scratch|entire|full[- ]stack|complet|architecture|projet|project)\b/i;

/** Keywords that signal exploration, not execution */
const EXPLORE_KEYWORDS = /\b(explain|what is|how does|show me|list|describe|help me understand)\b/i;

/** Multi-step connectors */
const MULTI_STEP = /\b(and then|then|also|additionally|after that|ensuite|puis|et aussi)\b/i;

export function classifyByHeuristics(input: string): Complexity | null {
  const words = input.split(/\s+/).length;
  const lower = input.toLowerCase();

  // Questions and exploration → trivial (model just answers)
  if (EXPLORE_KEYWORDS.test(lower) && words < 20) return 'trivial';

  // Very short, no complex verbs → trivial
  if (words < 8 && !lower.match(/build|create|implement|refactor|migrate|design|develop/)) return 'trivial';

  // Epic-scale keywords → epic
  if (EPIC_KEYWORDS.test(lower) && words > 15) return 'epic';

  // Count action verbs
  const actionMatches = lower.match(ACTION_VERBS);
  const actionCount = actionMatches ? new Set(actionMatches.map(v => v.toLowerCase())).size : 0;

  // 3+ distinct action verbs → complex
  if (actionCount >= 3) return 'complex';

  // Multi-step connectors with actions → complex
  if (MULTI_STEP.test(lower) && actionCount >= 2) return 'complex';

  // 1-2 actions, moderate length → simple
  if (actionCount >= 1 && words <= 30) return 'simple';

  // Long input with actions → probably complex
  if (words > 40 && actionCount >= 2) return 'complex';

  // Ambiguous → LLM fallback
  return null;
}

// ─── LLM Classifier (~150 tokens, M2.5) ──────────────

const CLASSIFY_PROMPT = `Classify this coding task into exactly ONE category:
- trivial: Simple question, explanation, or tiny change (< 1 file)
- simple: Clear single task (1-2 files, straightforward)
- complex: Multi-step task requiring planning (3+ files or multiple operations)
- epic: Large-scale work requiring task breakdown and sub-agents

Reply with ONLY the category word on the first line.
On the second line, write 1-2 recommended tools (e.g., "Grep, Read" or "Agent(explore), Edit").

Task: `;

async function classifyByLLM(
  client: MiniMaxClient,
  input: string,
): Promise<{ complexity: Complexity; toolHints: string }> {
  try {
    const result = await client.complete(
      [{ role: 'user', content: CLASSIFY_PROMPT + `"${input.slice(0, 300)}"` }],
      { maxTokens: 50, model: MINIMAX_MODELS.fast, temperature: 0.1 },
    );

    const text = result.message.content
      .filter(isTextBlock)
      .map(b => b.text)
      .join('')
      .trim();

    const lines = text.split('\n');
    const firstWord = (lines[0] ?? '').trim().toLowerCase();
    const toolHints = (lines[1] ?? '').trim();

    const valid: Complexity[] = ['trivial', 'simple', 'complex', 'epic'];
    const complexity = valid.includes(firstWord as Complexity)
      ? (firstWord as Complexity)
      : 'simple'; // safe default

    return { complexity, toolHints };
  } catch {
    return { complexity: 'simple', toolHints: '' }; // safe default on error
  }
}

// ─── Strategy Prompt Templates ────────────────────────

const AGENT_ROUTING_HINT = `
Available agents for delegation:
- Agent(explore): Search and understand code. Use FIRST for unfamiliar codebases.
- Agent(code): Write/edit code in isolation. Use for independent sub-tasks.
- Agent(review): Analyze code quality. Use after implementation.
- Agent(test): Write and run tests. Use after code changes.
Spawn agents when: task can be parallelized, or you need isolated context.`;

function buildStrategyPrompt(complexity: Complexity, toolHints?: string): string | null {
  switch (complexity) {
    case 'trivial':
      return null; // No injection — let model handle directly

    case 'simple':
      return `[STRATEGY] This is a focused task. Execute directly:
1. Read relevant files first to understand context
2. Make the change
3. Verify it works (run tests or check output)${toolHints ? `\nRecommended tools: ${toolHints}` : ''}`;

    case 'complex':
      return `[STRATEGY] This is a multi-step task. Plan before executing:
1. Use your thinking to break this into 3-5 concrete steps
2. Execute each step completely before moving to the next
3. After each step, verify the result before continuing
4. If a step fails, diagnose the root cause before retrying
Consider using the Agent tool to delegate exploration or parallel work.${AGENT_ROUTING_HINT}${toolHints ? `\nRecommended tools: ${toolHints}` : ''}`;

    case 'epic':
      return `[STRATEGY] This is a large-scale task. You MUST plan first:
1. Create a task breakdown with concrete steps (use your thinking)
2. For each step, decide: execute directly OR delegate to a sub-agent
3. Execute step by step, verifying after each
4. Periodically check: "Am I making progress toward the goal?"
Do NOT try to do everything in one turn — methodical progress > rushing.${AGENT_ROUTING_HINT}${toolHints ? `\nRecommended tools: ${toolHints}` : ''}`;
  }
}

/** Reflection interval per complexity (0 = no reflection) */
function getReflectionInterval(complexity: Complexity): number {
  switch (complexity) {
    case 'trivial': return 0;
    case 'simple': return 5;
    case 'complex': return 3;
    case 'epic': return 3;
  }
}

// ─── Main Analyzer ────────────────────────────────────

/**
 * Analyze a user task and produce strategic guidance.
 * Heuristic-first (0 tokens), LLM-fallback (~150 tokens M2.5) for ambiguous tasks.
 */
export async function analyzeTask(
  input: string,
  _messages: Message[],
  client: MiniMaxClient,
): Promise<TaskStrategy> {
  // Skip analysis for slash commands and very short inputs
  if (input.startsWith('/') || input.length < 5) {
    return {
      complexity: 'trivial',
      strategyPrompt: null,
      reflectionInterval: 0,
      classifiedBy: 'heuristic',
    };
  }

  // Try heuristic first (free)
  const heuristic = classifyByHeuristics(input);
  if (heuristic) {
    const strategy: TaskStrategy = {
      complexity: heuristic,
      strategyPrompt: buildStrategyPrompt(heuristic),
      reflectionInterval: getReflectionInterval(heuristic),
      classifiedBy: 'heuristic',
    };
    logger.debug(`strategy: ${heuristic} (heuristic)`, input.slice(0, 80));
    tracer.log('strategy', { complexity: heuristic, classifiedBy: 'heuristic', input: input.slice(0, 100) });
    return strategy;
  }

  // LLM fallback for ambiguous tasks
  const { complexity, toolHints } = await classifyByLLM(client, input);
  const strategy: TaskStrategy = {
    complexity,
    strategyPrompt: buildStrategyPrompt(complexity, toolHints),
    reflectionInterval: getReflectionInterval(complexity),
    classifiedBy: 'llm',
  };
  logger.debug(`strategy: ${complexity} (llm)`, input.slice(0, 80));
  tracer.log('strategy', { complexity, classifiedBy: 'llm', toolHints, input: input.slice(0, 100) });
  return strategy;
}
