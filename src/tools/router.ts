/**
 * Layer 3 — Tools: Dynamic Tool Router
 *
 * Selects relevant tool definitions per model call based on:
 * 1. Task complexity (from strategy analysis)
 * 2. User intent keywords
 * 3. Recently used tools (prevents model confusion)
 *
 * Core tools (Bash, Read, Write, Edit, Glob, Grep) are always included.
 * Other categories are added based on keyword matching in the user's input.
 *
 * Design: routing is based on effectiveInput (the real human input),
 * NOT messages[last] which can be synthetic (reflection/continuation/loop-detect).
 */

import type { ToolDefinition } from '../protocol/tools.js';
import type { Complexity } from '../engine/strategy.js';

// ─── Keyword → Category Matchers ────────────────────────

const CATEGORY_KEYWORDS: Array<{ category: string; pattern: RegExp }> = [
  { category: 'web', pattern: /\b(search|google|fetch|url|http|web|scrape|browse|download)\b/i },
  { category: 'task', pattern: /\b(task|track|progress|todo|plan|checklist)\b/i },
  { category: 'agent', pattern: /\b(agent|delegate|parallel|team|spawn|sub-?agent)\b/i },
  { category: 'memory', pattern: /\b(obsidian|vault|note|memory|remember|brain)\b/i },
  { category: 'search', pattern: /\b(semsearch|symbol|index|workspace search)\b/i },
  { category: 'automation', pattern: /\b(automat|background|schedule|sleep|proactive|loop)\b/i },
];

// ─── ToolRouter ─────────────────────────────────────────

export class ToolRouter {
  constructor(private allDefinitions: ToolDefinition[]) {}

  /**
   * Select tool definitions based on context.
   *
   * @param input - The real human input (effectiveInput from REPL)
   * @param recentTools - Names of tools used in recent loop turns
   * @param complexity - Task complexity from strategy analysis
   */
  select(ctx: {
    input: string;
    recentTools: string[];
    complexity: Complexity;
  }): ToolDefinition[] {
    // Epic tasks get all tools — no filtering
    if (ctx.complexity === 'epic') return this.allDefinitions;

    const needed = new Set<string>(['core']);

    // Trivial tasks: core only (+ recently used)
    if (ctx.complexity !== 'trivial') {
      // Simple/complex: add keyword-matched categories
      for (const { category, pattern } of CATEGORY_KEYWORDS) {
        if (pattern.test(ctx.input)) {
          needed.add(category);
        }
      }
    }

    return this.filterByCategories(needed, ctx.recentTools);
  }

  private filterByCategories(needed: Set<string>, recentTools: string[]): ToolDefinition[] {
    return this.allDefinitions.filter(d => {
      // Include if any category matches needed set
      if (d.categories?.some(c => needed.has(c))) return true;
      // Include if recently used (prevent model confusion mid-loop)
      if (recentTools.includes(d.name)) return true;
      return false;
    });
  }

  /**
   * Boot-time validation: every registered tool must have categories.
   * Throws on missing categories — fail loud, not silent.
   */
  static validateCategories(definitions: ToolDefinition[]): void {
    const missing = definitions.filter(d => !d.categories || d.categories.length === 0);
    if (missing.length > 0) {
      throw new Error(
        `ToolRouter: missing categories on tools: ${missing.map(d => d.name).join(', ')}. ` +
        `Add categories to each tool's definition.`,
      );
    }
  }
}
