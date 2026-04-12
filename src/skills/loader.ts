/**
 * Layer 13 — Skills: Loader
 *
 * Skills are domain-specific workflows that extend the agent's capabilities.
 * They can be bundled (shipped with PCC) or external (loaded from disk).
 *
 * A skill is defined by:
 * - A name and description
 * - A trigger condition (when should this skill activate)
 * - An execute function that runs the skill's workflow
 * - Optional: tools it requires, rules it follows
 *
 * Skills are loaded at startup and matched against user prompts
 * to provide specialized behavior.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { EventEmitter } from 'node:events';
import type { Message } from '../protocol/messages.js';
import type { ToolContext, Tool } from '../protocol/tools.js';
import { sanitizeUntrustedContent } from '../utils/security.js';

// ─── Skill Definition ──────────────────────────────────

export interface Skill {
  /** Unique skill name */
  name: string;
  /** Human-readable description */
  description: string;
  /** Category for grouping */
  category: SkillCategory;
  /** Trigger phrases/patterns — when should this skill activate? */
  triggers: SkillTrigger[];
  /** The skill's main execution function */
  execute: (ctx: SkillContext) => Promise<SkillResult>;
  /** Tools this skill requires (names from the registry) */
  requiredTools?: string[];
  /** Whether this skill runs in the background */
  background?: boolean;
}

export type SkillCategory =
  | 'workflow'    // Multi-step generation pipelines (Vibe, etc.)
  | 'analysis'    // Code analysis, review, exploration
  | 'automation'  // Recurring/proactive tasks
  | 'knowledge'   // Second brain, Obsidian, memory
  | 'utility'     // One-shot utilities (loop, schedule)
  | 'custom';     // User-defined

// ─── Trigger Types ─────────────────────────────────────

export type SkillTrigger =
  | { type: 'command'; command: string }         // Matches /skillname or /command
  | { type: 'keyword'; keywords: string[] }      // Matches if any keyword present
  | { type: 'pattern'; regex: RegExp }           // Matches a regex
  | { type: 'always' };                          // Always active (injected into prompt)

// ─── Skill Context ─────────────────────────────────────

export interface SkillContext {
  /** The user's input that triggered this skill */
  input: string;
  /** Arguments extracted from the trigger match */
  args: string;
  /** Working directory */
  cwd: string;
  /** Conversation history */
  messages: Message[];
  /** Tool execution context */
  toolContext: ToolContext;
  /** Available tools */
  tools: Map<string, Tool>;
  /** Callback to display info to the user */
  info: (msg: string) => void;
  /** Callback to display errors */
  error: (msg: string) => void;
  /** Callback to query the model */
  query: (prompt: string) => Promise<string>;
  /** Run a full agentic loop with a prompt */
  runAgent: (prompt: string) => Promise<string>;
}

// ─── Skill Result ──────────────────────────────────────

export type SkillResult =
  | { type: 'handled' }                           // Skill handled everything
  | { type: 'prompt'; prompt: string }            // Inject as user message
  | { type: 'error'; message: string };

// ─── Skill Registry ────────────────────────────────────

export class SkillRegistry extends EventEmitter {
  private skills = new Map<string, Skill>();

  /**
   * Register a skill.
   */
  register(skill: Skill): void {
    this.skills.set(skill.name, skill);
    this.emit('registered', skill);
  }

  /**
   * Unregister a skill.
   */
  unregister(name: string): boolean {
    return this.skills.delete(name);
  }

  /**
   * Get a skill by name.
   */
  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /**
   * Get all registered skills.
   */
  getAll(): Skill[] {
    return Array.from(this.skills.values());
  }

  /**
   * Get skills by category.
   */
  getByCategory(category: SkillCategory): Skill[] {
    return this.getAll().filter((s) => s.category === category);
  }

  /**
   * Find the best matching skill for a given input.
   * Returns null if no skill matches.
   */
  match(input: string): { skill: Skill; args: string } | null {
    const trimmed = input.trim();

    // 1. Check command triggers (exact /command match)
    if (trimmed.startsWith('/')) {
      const spaceIdx = trimmed.indexOf(' ');
      const cmd = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
      const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

      for (const skill of this.skills.values()) {
        for (const trigger of skill.triggers) {
          if (trigger.type === 'command' && trigger.command === cmd) {
            return { skill, args };
          }
        }
      }
    }

    // 2. Check keyword triggers
    const lower = trimmed.toLowerCase();
    for (const skill of this.skills.values()) {
      for (const trigger of skill.triggers) {
        if (trigger.type === 'keyword') {
          if (trigger.keywords.some((kw) => lower.includes(kw.toLowerCase()))) {
            return { skill, args: trimmed };
          }
        }
      }
    }

    // 3. Check pattern triggers
    for (const skill of this.skills.values()) {
      for (const trigger of skill.triggers) {
        if (trigger.type === 'pattern') {
          const match = trimmed.match(trigger.regex);
          if (match) {
            return { skill, args: match[1] ?? trimmed };
          }
        }
      }
    }

    return null;
  }

  /**
   * Get skills that are always active (injected into context).
   */
  getAlwaysActive(): Skill[] {
    return this.getAll().filter((s) =>
      s.triggers.some((t) => t.type === 'always'),
    );
  }

  get size(): number {
    return this.skills.size;
  }
}

// ─── Loader Functions ──────────────────────────────────

/**
 * Load bundled skills (shipped with PCC).
 */
export function loadBundledSkills(registry: SkillRegistry): void {
  // Bundled skills are imported directly — no file scanning needed.
  // They are registered by the caller via registerBundledSkills().
}

/**
 * Load external skills from a directory.
 * Skills are .ts or .js files that export a `skill` object conforming to Skill.
 */
export async function loadExternalSkills(
  registry: SkillRegistry,
  directory: string,
): Promise<number> {
  if (!existsSync(directory)) return 0;

  let loaded = 0;
  const entries = readdirSync(directory);

  for (const entry of entries) {
    const fullPath = join(directory, entry);
    const ext = extname(entry);

    // Skip non-script files
    if (ext !== '.ts' && ext !== '.js' && ext !== '.mjs') continue;

    try {
      const mod = await import(fullPath);
      if (mod.skill && typeof mod.skill === 'object' && mod.skill.name) {
        registry.register(mod.skill as Skill);
        loaded++;
      }
    } catch (error) {
      // Skip files that fail to load
      console.error(`Failed to load skill from ${fullPath}:`, error);
    }
  }

  return loaded;
}

/**
 * Generate a prompt fragment describing available skills.
 * Injected into the system prompt so the model knows what skills exist.
 */
export function generateSkillsPrompt(registry: SkillRegistry): string {
  const skills = registry.getAll();
  if (skills.length === 0) return '';

  const lines = ['\n# Available Skills'];

  const byCategory = new Map<SkillCategory, Skill[]>();
  for (const skill of skills) {
    const list = byCategory.get(skill.category) ?? [];
    list.push(skill);
    byCategory.set(skill.category, list);
  }

  for (const [category, categorySkills] of byCategory) {
    lines.push(`\n## ${category}`);
    for (const skill of categorySkills) {
      const cmdTriggers = skill.triggers
        .filter((t) => t.type === 'command')
        .map((t) => `/${(t as { command: string }).command}`);

      const cmdStr = cmdTriggers.length > 0 ? ` (${cmdTriggers.join(', ')})` : '';
      // SECURITY: Skill descriptions may come from plugins/external sources.
      // Sanitize to prevent prompt injection via crafted skill metadata.
      const safeName = sanitizeUntrustedContent(skill.name);
      const safeDesc = sanitizeUntrustedContent(skill.description);
      lines.push(`- **${safeName}**${cmdStr}: ${safeDesc}`);
    }
  }

  return lines.join('\n');
}
