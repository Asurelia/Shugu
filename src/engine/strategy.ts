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
 * ─── Choix de langue : FR/EN-first (assumé) ───────────────────────
 *
 * Le classifier heuristique est volontairement **bilingue français/anglais**.
 * Les regex `ACTION_VERBS`, `EPIC_KEYWORDS`, `EXPLORE_KEYWORDS` et `MULTI_STEP`
 * contiennent à la fois les mots-clés anglais (fix, add, build…) et français
 * (corriger, ajouter, développer…) — c'est cohérent avec l'usage actuel
 * (mono-utilisateur francophone, pas de distribution tierce).
 *
 * Un prompt dans une autre langue (portugais, allemand, etc.) ne matchera
 * aucune des regex et tombera dans le fallback LLM (~256 tokens, MiniMax fast).
 * Ce coût est **négligeable pour un usage perso** — pas un bug, un compromis assumé.
 *
 * Si l'usage évolue (distribution publique, multi-locuteurs non FR/EN), les
 * listes de regex sont conçues pour être **étendues trivialement** : ajouter
 * des synonymes dans la chaîne alternative est suffisant, aucun refactor requis.
 *
 * ─── Coût ──────────────────────────────────────────────────────────
 *
 * - Heuristique (FR/EN) : 0 token, ~0.1 ms.
 * - Fallback LLM (autres langues ou ambigu) : ~256 tokens sur MiniMax fast.
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
const ACTION_VERBS = /\b(fix|add|create|update|remove|refactor|test|search|find|implement|build|write|check|migrate|deploy|design|optimize|debug|review|analyze|analyse|analyser|développer|ajouter|créer|corriger|tester)\b/gi;

/** Keywords that strongly signal epic-scale work */
const EPIC_KEYWORDS = /\b(application|app|système|system|platform|from scratch|entire|full[- ]stack|complet|architecture|projet|project)\b/i;

/** Keywords that signal exploration, not execution */
const EXPLORE_KEYWORDS = /\b(explain|what is|how does|show me|list|describe|help me understand|explique|qu'est-ce que|montre-moi|c'est quoi)\b/i;

/** Multi-step connectors */
const MULTI_STEP = /\b(and then|then|also|additionally|after that|ensuite|puis|et aussi)\b/i;

export function classifyByHeuristics(input: string): Complexity | null {
  const words = input.split(/\s+/).length;
  const lower = input.toLowerCase();

  // Questions and exploration → trivial (model just answers)
  if (EXPLORE_KEYWORDS.test(lower) && words < 20) return 'trivial';

  // Very short, no complex verbs → trivial
  if (words < 8 && !lower.match(/build|create|implement|refactor|migrate|design|develop|analy[sz]e|analyser|développer/)) return 'trivial';

  // Epic-scale keywords → epic
  if (EPIC_KEYWORDS.test(lower) && words > 8) return 'epic';

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
- trivial: Simple question, explanation, or tiny change (< 1 file). Examples: "what does this function do?", "rename this variable"
- simple: Clear single task (1-2 files, straightforward). Examples: "fix this bug", "add a field to this interface"
- complex: Multi-step task requiring planning (3+ files or multiple operations). Examples: "refactor the auth system", "add a new API endpoint with tests"
- epic: Large-scale work requiring task breakdown and sub-agents. Examples: "build the entire feature", "migrate from X to Y across the codebase"

Signals that increase complexity:
- References to multiple systems (API + database + UI)
- Words like "and then", "also", "additionally" chaining distinct operations
- Mentions of testing, reviewing, or deploying alongside implementation
- References to Obsidian vault, memory, or cross-session knowledge (requires context gathering)
- Requests involving agent delegation or parallel work

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
      { maxTokens: 256, model: MINIMAX_MODELS.fast, temperature: 0.1 },
    );

    const text = result.message.content
      .filter(isTextBlock)
      .map(b => b.text)
      .join('')
      .trim();

    // If model produced only thinking (no visible text), fall back to heuristic
    if (!text) {
      tracer.log('strategy', { action: 'llm_empty_response', stopReason: result.stopReason });
      return { complexity: classifyByHeuristics(input) ?? 'simple', toolHints: '' };
    }

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
Consider using the Agent tool to delegate exploration or parallel work.
Before reporting completion, verify your work: run tests, check for TypeScript errors, confirm output matches expectations. If you can't verify, say so explicitly.${AGENT_ROUTING_HINT}${toolHints ? `\nRecommended tools: ${toolHints}` : ''}`;

    case 'epic':
      return `[STRATEGY] This is a large-scale task. You MUST plan first:
1. Create a task breakdown with concrete steps (use your thinking)
2. For each step, decide: execute directly OR delegate to a sub-agent
3. Execute step by step, verifying after each
4. Periodically check: "Am I making progress toward the goal?"
Do NOT try to do everything in one turn — methodical progress > rushing.
Before reporting completion, verify each step's result: run tests, check for TypeScript errors, confirm output matches expectations. The implementer is an LLM too — verify independently.${AGENT_ROUTING_HINT}${toolHints ? `\nRecommended tools: ${toolHints}` : ''}`;
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
/** Overrides for Meta-Harness config injection */
export interface StrategyOverrides {
  complexityOverride?: Complexity;
  strategyPrompts?: Partial<Record<Complexity, string | null>>;
  reflectionIntervals?: Partial<Record<Complexity, number>>;
}

export async function analyzeTask(
  input: string,
  _messages: Message[],
  client: MiniMaxClient,
  overrides?: StrategyOverrides,
): Promise<TaskStrategy> {
  // If complexity is forced via overrides, skip classification
  if (overrides?.complexityOverride) {
    const c = overrides.complexityOverride;
    const strategyPrompt = overrides.strategyPrompts?.[c] !== undefined
      ? overrides.strategyPrompts[c]!
      : buildStrategyPrompt(c);
    const reflectionInterval = overrides.reflectionIntervals?.[c] ?? getReflectionInterval(c);
    tracer.log('strategy', { complexity: c, classifiedBy: 'override', input: input.slice(0, 100) });
    return { complexity: c, strategyPrompt, reflectionInterval, classifiedBy: 'heuristic' };
  }

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
    const sp = overrides?.strategyPrompts?.[heuristic] !== undefined
      ? overrides.strategyPrompts[heuristic]!
      : buildStrategyPrompt(heuristic);
    const ri = overrides?.reflectionIntervals?.[heuristic] ?? getReflectionInterval(heuristic);
    const strategy: TaskStrategy = {
      complexity: heuristic,
      strategyPrompt: sp,
      reflectionInterval: ri,
      classifiedBy: 'heuristic',
    };
    logger.debug(`strategy: ${heuristic} (heuristic)`, input.slice(0, 80));
    tracer.log('strategy', { complexity: heuristic, classifiedBy: 'heuristic', input: input.slice(0, 100) });
    return strategy;
  }

  // LLM fallback for ambiguous tasks
  const { complexity, toolHints } = await classifyByLLM(client, input);
  const sp2 = overrides?.strategyPrompts?.[complexity] !== undefined
    ? overrides.strategyPrompts[complexity]!
    : buildStrategyPrompt(complexity, toolHints);
  const ri2 = overrides?.reflectionIntervals?.[complexity] ?? getReflectionInterval(complexity);
  const strategy: TaskStrategy = {
    complexity,
    strategyPrompt: sp2,
    reflectionInterval: ri2,
    classifiedBy: 'llm',
  };
  logger.debug(`strategy: ${complexity} (llm)`, input.slice(0, 80));
  tracer.log('strategy', { complexity, classifiedBy: 'llm', toolHints, input: input.slice(0, 100) });
  return strategy;
}
