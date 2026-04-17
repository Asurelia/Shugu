/**
 * Layer 7 — Commands: Markdown Loader
 *
 * Loads custom slash commands from `.pcc/commands/*.md` files.
 * Supports YAML frontmatter for metadata and hot-reloads on each invocation.
 *
 * Directory precedence: later dirs override earlier ones (project > global).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Command, CommandContext, CommandResult } from './registry.js';
import { logger } from '../utils/logger.js';
import { resolveTrust, type DiscoveredFile } from '../credentials/trust-store.js';

// ─── Types ─────────────────────────────────────────────

export interface MarkdownCommandFrontmatter {
  name: string;
  aliases?: string[];
  description: string;
  override?: boolean; // default false — required to override builtins
}

// ─── Frontmatter Parser ────────────────────────────────

/**
 * Parse a markdown command file into frontmatter + body.
 * Returns null if parsing fails or required fields are missing.
 */
export function parseMarkdownCommand(content: string): {
  frontmatter: MarkdownCommandFrontmatter;
  body: string;
} | null {
  // Must start with --- delimiter
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) return null;

  // Find second --- delimiter (skip the first one)
  const afterFirst = trimmed.indexOf('\n');
  if (afterFirst === -1) return null;

  const rest = trimmed.slice(afterFirst + 1);
  const closingIdx = rest.indexOf('\n---');
  if (closingIdx === -1) return null;

  const yamlBlock = rest.slice(0, closingIdx);
  const body = rest.slice(closingIdx + 4).replace(/^\r?\n/, ''); // strip leading newline after ---

  // Parse YAML
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlBlock);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;

  const obj = parsed as Record<string, unknown>;

  // Validate required fields
  if (typeof obj['name'] !== 'string' || obj['name'].length === 0) return null;
  if (typeof obj['description'] !== 'string' || obj['description'].length === 0) return null;

  // Build frontmatter with defaults
  const frontmatter: MarkdownCommandFrontmatter = {
    name: obj['name'],
    description: obj['description'],
    override: typeof obj['override'] === 'boolean' ? obj['override'] : false,
  };

  if (Array.isArray(obj['aliases'])) {
    frontmatter.aliases = obj['aliases'].filter(
      (a): a is string => typeof a === 'string',
    );
  }

  return { frontmatter, body };
}

// ─── Directory Scanner ─────────────────────────────────

/**
 * Load markdown commands from one or more directories.
 * Project-local dirs should come after global dirs (last-write-wins for same name).
 *
 * @param dirs - Directories to scan for *.md files
 * @param builtinNames - Set of builtin command names+aliases to protect
 * @returns Array of Command objects ready for registration
 */
export function loadMarkdownCommands(
  dirs: string[],
  builtinNames: Set<string>,
): Command[] {
  const commandMap = new Map<string, Command>();

  for (const dir of dirs) {
    // Check if directory exists (sync-safe: we catch and skip)
    let entries: string[];
    try {
      const dirEntries = readdirSync(dir, { withFileTypes: true });
      entries = dirEntries
        .filter((e) => e.isFile() && e.name.endsWith('.md'))
        .map((e) => e.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') {
        continue; // Directory doesn't exist — optional, skip silently
      }
      logger.warn(`Failed to load commands from directory: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    for (const fileName of entries) {
      const filePath = join(dir, fileName);

      let content: string;
      try {
        content = readFileSync(filePath, 'utf-8');
      } catch {
        logger.warn(`Failed to read command file: ${filePath}`);
        continue;
      }

      const parsed = parseMarkdownCommand(content);
      if (!parsed) {
        logger.warn(`Failed to parse command file: ${filePath}`);
        continue;
      }

      const { frontmatter } = parsed;

      // Collect all names this command claims (name + aliases)
      const allNames = [frontmatter.name, ...(frontmatter.aliases ?? [])];

      // Check builtin collisions
      const collidingNames = allNames.filter((n) => builtinNames.has(n));
      if (collidingNames.length > 0) {
        if (frontmatter.override !== true) {
          logger.warn(
            `Custom command '${frontmatter.name}' collides with builtin — skipped (use override: true to force)`,
          );
          continue;
        }
        logger.warn(
          `Custom command '${frontmatter.name}' overrides builtin`,
        );
      }

      const isOverride =
        collidingNames.length > 0 && frontmatter.override === true;
      const tag = isOverride ? '[override]' : '[custom]';

      const command: Command = {
        name: frontmatter.name,
        aliases: frontmatter.aliases,
        description: `${frontmatter.description} ${tag}`,
        execute: async (
          _args: string,
          _ctx: CommandContext,
        ): Promise<CommandResult> => {
          // Re-read file on each invocation for hot reload
          try {
            const fresh = await readFile(filePath, 'utf-8');
            const freshParsed = parseMarkdownCommand(fresh);
            if (!freshParsed) {
              return {
                type: 'error',
                message: `Failed to parse command file: ${filePath}`,
              };
            }
            return { type: 'prompt', prompt: freshParsed.body };
          } catch {
            return {
              type: 'error',
              message: `Failed to read command file: ${filePath}`,
            };
          }
        },
      };

      commandMap.set(frontmatter.name, command);
    }
  }

  return Array.from(commandMap.values());
}

// ─── Trust-gated Loader ─────────────────────────────────

/**
 * Same as loadMarkdownCommands but gates project-local files through the
 * TOFU trust store. Global (homedir) files load without prompting (they
 * are user-authored), project-local files prompt on first use or on
 * content change.
 *
 * @param globalDirs Dirs under homedir — trusted implicitly.
 * @param projectDirs Dirs under the repo — subject to TOFU.
 * @param projectRoot Absolute path to the repo root — used as trust key.
 * @param builtinNames Builtin names to protect.
 * @param onConfirm Called when pending files need approval. If omitted,
 *   pending files are silently skipped (for headless contexts).
 */
export async function loadMarkdownCommandsWithTrust(
  globalDirs: string[],
  projectDirs: string[],
  projectRoot: string,
  builtinNames: Set<string>,
  onConfirm?: (pending: DiscoveredFile[]) => Promise<boolean>,
): Promise<Command[]> {
  // Global dirs are loaded as before — they're under the user's homedir.
  const globalCommands = loadMarkdownCommands(globalDirs, builtinNames);

  // Collect project-local files for trust check.
  const discovered: DiscoveredFile[] = [];
  for (const dir of projectDirs) {
    for (const file of collectMarkdownFiles(dir)) {
      try {
        const content = readFileSync(file, 'utf8');
        discovered.push({
          absPath: file,
          relPath: relative(projectRoot, resolve(file)).replace(/\\/g, '/'),
          content,
        });
      } catch {
        // unreadable — skip silently (same behavior as loadMarkdownCommands)
      }
    }
  }

  const approved = await resolveTrust(projectRoot, discovered, onConfirm);

  if (approved.length === 0) {
    return globalCommands;
  }

  // Build commands from approved files only. We reuse loadMarkdownCommands
  // by feeding it a synthetic dir strategy would be awkward; instead parse
  // each approved file directly with the existing parser.
  const localCommandMap = new Map<string, Command>();
  for (const file of approved) {
    const parsed = parseMarkdownCommand(file.content);
    if (!parsed) {
      logger.warn(`Failed to parse command file: ${file.absPath}`);
      continue;
    }
    const { frontmatter } = parsed;
    const allNames = [frontmatter.name, ...(frontmatter.aliases ?? [])];
    const collidingNames = allNames.filter((n) => builtinNames.has(n));
    if (collidingNames.length > 0 && frontmatter.override !== true) {
      logger.warn(
        `Custom command '${frontmatter.name}' collides with builtin — skipped (use override: true to force)`,
      );
      continue;
    }
    const tag =
      collidingNames.length > 0 && frontmatter.override === true ? '[override]' : '[custom]';
    const filePath = file.absPath;
    const command: Command = {
      name: frontmatter.name,
      aliases: frontmatter.aliases,
      description: `${frontmatter.description} ${tag}`,
      execute: async () => {
        try {
          const fresh = await readFile(filePath, 'utf8');
          const freshParsed = parseMarkdownCommand(fresh);
          if (!freshParsed) {
            return { type: 'error', message: `Failed to parse command file: ${filePath}` } as CommandResult;
          }
          return { type: 'prompt', prompt: freshParsed.body } as CommandResult;
        } catch {
          return { type: 'error', message: `Failed to read command file: ${filePath}` } as CommandResult;
        }
      },
    };
    localCommandMap.set(frontmatter.name, command);
  }

  // Last-write-wins: project local overrides global same-name.
  const merged = new Map<string, Command>();
  for (const cmd of globalCommands) merged.set(cmd.name, cmd);
  for (const cmd of localCommandMap.values()) merged.set(cmd.name, cmd);
  return Array.from(merged.values());
}

function collectMarkdownFiles(dir: string): string[] {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => join(dir, e.name));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      logger.warn(`Failed to list ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return [];
  }
}

// Note on pending callback design: we deliberately ask the user once for
// the full set of new/changed files — a per-file prompt would train the
// user to mash "y" and defeat the purpose. The callback receives the
// full list so the UI can render it as a preview before the single
// confirm.

/** Re-export for callers that want to handle pending interactively. */
export type { DiscoveredFile } from '../credentials/trust-store.js';
