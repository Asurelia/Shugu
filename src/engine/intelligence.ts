/**
 * Layer 2 — Engine: Intelligence layers
 *
 * Three background agent forks that run AFTER each model turn:
 *
 * 1. Prompt Suggestion — predicts what the user might type next
 * 2. Speculation — pre-executes the suggested prompt in a read-only sandbox
 * 3. Memory Extraction — extracts knowledge-worthy facts from the conversation
 *
 * All three run asynchronously (fire-and-forget) to avoid blocking the REPL.
 * Each uses a SHORT, focused prompt to minimize token cost.
 *
 * Ported from OpenClaude:
 * - services/PromptSuggestion/promptSuggestion.ts
 * - services/PromptSuggestion/speculation.ts
 * - services/extractMemories/extractMemories.ts
 */

import type { Message, AssistantMessage } from '../protocol/messages.js';
import { isTextBlock } from '../protocol/messages.js';
import type { MiniMaxClient } from '../transport/client.js';

// ─── 1. Prompt Suggestion ──────────────────────────────

const SUGGESTION_PROMPT = `[SUGGESTION MODE: Predict what the user would naturally type next.]

Look at the user's recent messages and the assistant's actions.
Your job is to predict what THEY would type — not what you think they should do.
THE TEST: Would they think "I was just about to type that"?

EXAMPLES:
- User asked "fix the bug and run tests", bug is fixed → "run the tests"
- After code written → "try it out" or "does it compile?"
- Task complete, obvious follow-up → "commit this" or "push it"
- After error → silence (let them assess)

NEVER SUGGEST:
- Evaluative ("looks good", "thanks")
- Questions ("what about...?")
- Assistant-voice ("Let me...", "I'll...")
- New ideas they didn't ask about
- Multiple sentences

Format: 2-12 words, match the user's style. Or reply NONE if nothing obvious.
Reply with ONLY the suggestion, no quotes.`;

/**
 * Generate a prompt suggestion based on conversation history.
 * Returns null if no good suggestion.
 */
export async function generatePromptSuggestion(
  client: MiniMaxClient,
  messages: Message[],
): Promise<string | null> {
  // Only use last 4 messages for context (token-efficient)
  const recentMessages = messages.slice(-4);
  const contextSummary = recentMessages.map(m => {
    const role = m.role;
    const text = typeof m.content === 'string'
      ? m.content.slice(0, 200)
      : (m.content as Array<{ type: string; text?: string }>)
          .filter(b => b.type === 'text')
          .map(b => b.text ?? '')
          .join(' ')
          .slice(0, 200);
    return `[${role}]: ${text}`;
  }).join('\n');

  try {
    const result = await client.complete(
      [{ role: 'user', content: `${SUGGESTION_PROMPT}\n\nRecent conversation:\n${contextSummary}` }],
      { maxTokens: 100 }, // Very short — just 1 line
    );

    const suggestion = result.message.content
      .filter(isTextBlock)
      .map(b => b.text)
      .join('')
      .trim();

    if (!suggestion || suggestion === 'NONE' || suggestion.length < 3) return null;

    // Multi-stage filters (ported from Claude Code's 13-filter pipeline)
    const lower = suggestion.toLowerCase();
    const words = suggestion.split(/\s+/);
    if (lower === 'done' || lower === 'yes' || lower === 'no') return null;                // done
    if (lower.includes('nothing to suggest') || lower.includes('silence')) return null;      // meta_text
    if (/^\(.*\)$|^\[.*\]$/.test(suggestion)) return null;                                  // meta_wrapped
    if (/^\w+:\s/.test(suggestion) && !suggestion.startsWith('/')) return null;               // prefixed_label
    if (words.length < 2) return null;                                                       // too_few_words
    if (words.length > 20) return null;                                                      // too_many_words
    if (suggestion.length > 150) return null;                                                // too_long
    if (suggestion.includes('\n')) return null;                                               // multiple_lines
    if (/[*_#`|]/.test(suggestion)) return null;                                             // has_formatting
    if (/^(looks good|great|nice|thanks|thank you|perfect)/i.test(suggestion)) return null;  // evaluative
    if (/^(let me|i'll|i will|here's|here is)/i.test(suggestion)) return null;               // claude_voice
    if (suggestion.endsWith('?')) return null;                                                // question

    return suggestion;
  } catch {
    return null;
  }
}

// ─── 2. Speculation (read-only pre-execution) ──────────

const SPECULATION_PROMPT = `You are pre-executing a user prompt in READ-ONLY mode.
Given this prompt, determine what the user wants and plan the first 2-3 tool calls.
ONLY use read-only tools (Read, Glob, Grep, WebSearch). Do NOT write or modify anything.
Output a brief analysis (2-3 lines) of what you would do, then stop.`;

export interface SpeculationResult {
  analysis: string;
  suggestedPrompt: string;
}

/**
 * Speculatively analyze a suggested prompt to pre-fetch context.
 * Only performs read-only analysis — never writes or modifies.
 */
export async function speculate(
  client: MiniMaxClient,
  suggestedPrompt: string,
  recentMessages: Message[],
): Promise<SpeculationResult | null> {
  const contextSummary = recentMessages.slice(-2).map(m => {
    const text = typeof m.content === 'string'
      ? m.content.slice(0, 150)
      : (m.content as Array<{ type: string; text?: string }>)
          .filter(b => b.type === 'text')
          .map(b => b.text ?? '')
          .join(' ')
          .slice(0, 150);
    return `[${m.role}]: ${text}`;
  }).join('\n');

  try {
    const result = await client.complete(
      [{
        role: 'user',
        content: `${SPECULATION_PROMPT}\n\nContext:\n${contextSummary}\n\nSuggested prompt: "${suggestedPrompt}"`,
      }],
      { maxTokens: 300 },
    );

    const analysis = result.message.content
      .filter(isTextBlock)
      .map(b => b.text)
      .join('')
      .trim();

    if (!analysis || analysis.length < 10) return null;

    return { analysis, suggestedPrompt };
  } catch {
    return null;
  }
}

// ─── 3. Memory Extraction Agent ────────────────────────

const MEMORY_EXTRACTION_PROMPT = `You are the memory extraction agent. Analyze the recent messages and extract knowledge worth persisting across sessions.

## What to extract
- Decisions made ("we chose X over Y because...")
- User preferences or corrections ("don't mock the database", "always use semicolons")
- Project facts discovered (tech stack, API endpoints, config details, file structure patterns)
- Error solutions (what broke + how it was fixed)
- Reference pointers (URLs, docs, external resources mentioned)

## What NOT to extract
- Code patterns or architecture derivable from reading the current codebase
- Git history or recent changes (git log is authoritative)
- Ephemeral task details or conversation flow
- Anything already documented in project files

## Format
For each item, output one line:
MEMORY: <short-title> | <content — include WHY so future sessions can judge edge cases>

If nothing worth remembering: NONE

Be highly selective. 0-3 items per turn. Quality > quantity.`;

export interface ExtractedMemory {
  title: string;
  content: string;
}

/**
 * Extract memories from a conversation turn.
 * Returns an array of extracted memories (may be empty).
 */
export async function extractMemories(
  client: MiniMaxClient,
  messages: Message[],
): Promise<ExtractedMemory[]> {
  // Use last 6 messages (current turn + context)
  const recentMessages = messages.slice(-6);
  const turnText = recentMessages.map(m => {
    const role = m.role;
    const text = typeof m.content === 'string'
      ? m.content.slice(0, 500)
      : (m.content as Array<{ type: string; text?: string }>)
          .filter(b => b.type === 'text')
          .map(b => b.text ?? '')
          .join(' ')
          .slice(0, 500);
    return `[${role}]: ${text}`;
  }).join('\n');

  try {
    const result = await client.complete(
      [{ role: 'user', content: `${MEMORY_EXTRACTION_PROMPT}\n\n---\n\n${turnText}` }],
      { maxTokens: 500 },
    );

    const response = result.message.content
      .filter(isTextBlock)
      .map(b => b.text)
      .join('')
      .trim();

    if (!response || response === 'NONE') return [];

    // Parse MEMORY: title | content lines
    const memories: ExtractedMemory[] = [];
    for (const line of response.split('\n')) {
      const match = line.match(/^MEMORY:\s*(.+?)\s*\|\s*(.+)$/);
      if (match) {
        memories.push({
          title: match[1]!.trim(),
          content: match[2]!.trim(),
        });
      }
    }

    return memories;
  } catch {
    return [];
  }
}

// ─── Orchestrator ──────────────────────────────────────

export interface IntelligenceConfig {
  client: MiniMaxClient;
  messages: Message[];
  enableSuggestion?: boolean;
  enableSpeculation?: boolean;
  enableMemoryExtraction?: boolean;
}

export interface IntelligenceResult {
  suggestion: string | null;
  speculation: SpeculationResult | null;
  memories: ExtractedMemory[];
}

/**
 * Run all intelligence layers in parallel after a model turn.
 * Fire-and-forget — results are delivered via callback.
 */
export async function runPostTurnIntelligence(
  config: IntelligenceConfig,
  onResult: (result: IntelligenceResult) => void,
): Promise<void> {
  const {
    client,
    messages,
    enableSuggestion = true,
    enableSpeculation = true,
    enableMemoryExtraction = true,
  } = config;

  // Run all 3 in parallel
  const [suggestion, memories] = await Promise.all([
    enableSuggestion
      ? generatePromptSuggestion(client, messages).catch(() => null)
      : Promise.resolve(null),
    enableMemoryExtraction
      ? extractMemories(client, messages).catch(() => [])
      : Promise.resolve([]),
  ]);

  // Speculation runs only if we got a suggestion
  let speculation: SpeculationResult | null = null;
  if (enableSpeculation && suggestion) {
    speculation = await speculate(client, suggestion, messages).catch(() => null);
  }

  onResult({ suggestion, speculation, memories });
}
