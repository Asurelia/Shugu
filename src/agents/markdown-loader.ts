/**
 * Layer 8 — Agents: Markdown Agent Loader
 *
 * Loads custom agent definitions from `.pcc/agents/*.md` files.
 * Users create markdown files with YAML frontmatter to define
 * custom agent types that integrate with the orchestrator.
 *
 * Example file `.pcc/agents/security.md`:
 * ```
 * ---
 * name: security
 * maxTurns: 20
 * allowedTools: [Read, Glob, Grep, Bash]
 * ---
 * You are a security auditor. Analyze code for vulnerabilities...
 * ```
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AgentDefinition } from './orchestrator.js';
import { logger } from '../utils/logger.js';

// ─── Frontmatter Schema ───────────────────────────────

export interface MarkdownAgentFrontmatter {
  name: string;
  maxTurns?: number;         // default: 15
  maxBudgetUsd?: number;     // default: undefined (no limit)
  allowedTools?: string[];   // default: undefined (all tools)
  override?: boolean;        // default: false — required to override builtins
}

/** Builtin agent names that are protected by default */
const BUILTIN_AGENT_NAMES = new Set(['general', 'explore', 'code', 'review', 'test']);

// ─── Parse ─────────────────────────────────────────────

/**
 * Parse a markdown agent file into frontmatter + role prompt.
 * Returns null if parsing fails or required fields are missing.
 */
export function parseMarkdownAgent(content: string): {
  frontmatter: MarkdownAgentFrontmatter;
  rolePrompt: string;
} | null {
  // Frontmatter must start with `---` on the first line
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) {
    return null;
  }

  // Find the closing `---` delimiter (skip the opening one)
  const afterOpen = trimmed.indexOf('\n');
  if (afterOpen === -1) {
    return null;
  }

  const closingIdx = trimmed.indexOf('\n---', afterOpen);
  if (closingIdx === -1) {
    return null;
  }

  const yamlBlock = trimmed.slice(afterOpen + 1, closingIdx);
  const body = trimmed.slice(closingIdx + 4); // skip past `\n---`

  // Parse YAML frontmatter
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlBlock);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== 'object') {
    return null;
  }

  const record = parsed as Record<string, unknown>;

  // Validate required fields
  if (typeof record['name'] !== 'string' || record['name'].trim().length === 0) {
    return null;
  }

  // Build frontmatter with defaults
  const frontmatter: MarkdownAgentFrontmatter = {
    name: record['name'].trim(),
    maxTurns: typeof record['maxTurns'] === 'number' ? record['maxTurns'] : 15,
    override: typeof record['override'] === 'boolean' ? record['override'] : false,
  };

  if (typeof record['maxBudgetUsd'] === 'number') {
    frontmatter.maxBudgetUsd = record['maxBudgetUsd'];
  }

  if (Array.isArray(record['allowedTools'])) {
    const tools = record['allowedTools'].filter(
      (t): t is string => typeof t === 'string',
    );
    if (tools.length > 0) {
      frontmatter.allowedTools = tools;
    }
  }

  const rolePrompt = body.trim();

  return { frontmatter, rolePrompt };
}

// ─── Load ──────────────────────────────────────────────

/**
 * Load markdown agents from one or more directories.
 * Project-local dirs should come after global dirs (last-write-wins for same name).
 *
 * @param dirs - Directories to scan for *.md files
 * @returns Record mapping agent name to AgentDefinition
 */
export async function loadMarkdownAgents(
  dirs: string[],
): Promise<Record<string, AgentDefinition>> {
  const agents: Record<string, AgentDefinition> = {};

  for (const dir of dirs) {
    let entries: string[];
    try {
      const dirContents = await readdir(dir);
      entries = dirContents.filter((f) => f.endsWith('.md'));
    } catch {
      // Directory doesn't exist or isn't readable — skip silently
      continue;
    }

    for (const filename of entries) {
      const filePath = join(dir, filename);

      let content: string;
      try {
        content = await readFile(filePath, 'utf-8');
      } catch {
        logger.warn(`Failed to read markdown agent file: ${filePath}`);
        continue;
      }

      const result = parseMarkdownAgent(content);
      if (!result) {
        logger.warn(`Invalid markdown agent file (missing name or malformed frontmatter): ${filePath}`);
        continue;
      }

      const { frontmatter, rolePrompt } = result;
      const name = frontmatter.name;

      // Builtin protection
      if (BUILTIN_AGENT_NAMES.has(name)) {
        if (frontmatter.override !== true) {
          logger.warn(
            `Custom agent '${name}' collides with builtin — skipped (use override: true to force)`,
          );
          continue;
        }
        logger.warn(`Custom agent '${name}' overrides builtin`);
      }

      // Build AgentDefinition
      const definition: AgentDefinition = {
        name,
        rolePrompt,
        allowedTools: frontmatter.allowedTools,
        maxTurns: frontmatter.maxTurns ?? 15,
        maxBudgetUsd: frontmatter.maxBudgetUsd,
      };

      agents[name] = definition;
    }
  }

  return agents;
}
