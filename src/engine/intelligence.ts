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

const SUGGESTION_PROMPT = `You are predicting what the user will type next in a coding CLI.
Look at the conversation — what would the user naturally ask or do next?
Reply with ONLY the suggested prompt (1 sentence). No quotes, no explanation.
If nothing obvious, reply with exactly: NONE`;

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

    if (!suggestion || suggestion === 'NONE' || suggestion.length < 5) return null;
    // Filter bad suggestions
    if (suggestion.toLowerCase().includes('nothing to suggest')) return null;
    if (suggestion.startsWith('(') && suggestion.endsWith(')')) return null;

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

const MEMORY_EXTRACTION_PROMPT = `Analyze this conversation turn and extract any knowledge worth remembering for future sessions.

Extract ONLY if the conversation contains:
- Decisions made (architecture choices, library selections, approach chosen)
- User preferences (coding style, tools they prefer, patterns they like)
- Project facts (tech stack discovered, API endpoints found, config details)
- Important errors and their solutions

For each item, output one line in this format:
MEMORY: <title> | <content>

If nothing worth remembering, output exactly: NONE

Be selective — only extract truly useful, non-obvious facts.`;

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
