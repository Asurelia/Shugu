/**
 * Layer 6 — Integrations: CLI Adapter
 *
 * Parses adapter definitions (builtin YAML or pcc-tools.yaml)
 * and generates compact hint strings for system prompt injection.
 *
 * A hint is ~100-200 tokens — vs ~1300 tokens for a MCP tool schema.
 * The agent uses BashTool to execute CLI commands — no new protocol needed.
 *
 * Security: `pcc-tools.yaml` can ship in a cloned repo. Its strings
 * (description, commands, auth) are spliced into the system prompt, so
 * we sanitise them to strip role markers, XML tags, HTML comments, and
 * other prompt-injection vectors via `sanitizeUntrustedContent`.
 */

import { sanitizeUntrustedContent } from '../utils/security.js';

// ─── Adapter Types ──────────────────────────────────────

export interface CliAdapter {
  name: string;
  description: string;
  /** Command to run to detect if this CLI is installed (e.g., "git --version") */
  detect: string;
  /** Compact hint for the model — key commands, dos/don'ts */
  hint: string;
  /** Whether this CLI was detected as installed */
  installed?: boolean;
  /** Optional: auth command if the CLI needs login */
  auth?: string;
  /** Optional: example commands from pcc-tools.yaml */
  commands?: string[];
}

export interface ProjectToolConfig {
  name: string;
  description?: string;
  commands?: string[];
  auth?: string;
  type?: 'cli' | 'rest' | 'graphql';
  base_url?: string;
  endpoints?: string[];
}

// ─── Hint Generation ────────────────────────────────────

/**
 * Generate a compact system prompt section from discovered adapters.
 * Only includes adapters that are actually installed.
 */
export function generateHints(adapters: CliAdapter[]): string {
  const installed = adapters.filter((a) => a.installed);
  if (installed.length === 0) return '';

  const lines = ['\n# Available CLI tools (use via Bash)'];

  for (const adapter of installed) {
    lines.push(`\n## ${adapter.name}`);
    lines.push(adapter.hint.trim());

    if (adapter.commands && adapter.commands.length > 0) {
      lines.push('Project-specific commands:');
      for (const cmd of adapter.commands.slice(0, 5)) {
        lines.push(`  - ${cmd}`);
      }
    }

    if (adapter.auth) {
      lines.push(`Auth: ${adapter.auth}`);
    }
  }

  return lines.join('\n');
}

/**
 * Merge project-level tool configs with builtin adapters.
 * Project configs add commands/auth to existing adapters or create new ones.
 */
/**
 * Sanitise a project-sourced string before it is spliced into the system
 * prompt. No-op for non-strings (undefined, empty) so callers can forward
 * optional fields directly.
 */
function clean(str: string | undefined): string | undefined {
  if (!str) return str;
  return sanitizeUntrustedContent(str);
}

function cleanArr(arr: string[] | undefined): string[] | undefined {
  if (!arr) return arr;
  return arr.map((c) => sanitizeUntrustedContent(c));
}

export function mergeProjectTools(
  builtinAdapters: CliAdapter[],
  projectTools: ProjectToolConfig[],
): CliAdapter[] {
  const merged = new Map<string, CliAdapter>();

  // Start with builtins (trusted — shipped with Shugu)
  for (const adapter of builtinAdapters) {
    merged.set(adapter.name, { ...adapter });
  }

  // Overlay project tools — every string field passes through
  // sanitizeUntrustedContent to defuse role markers / XML / entities.
  for (const tool of projectTools) {
    const safeName = sanitizeUntrustedContent(tool.name);
    const safeDescription = clean(tool.description) ?? safeName;
    const safeCommands = cleanArr(tool.commands);
    const safeAuth = clean(tool.auth);

    if (tool.type === 'rest' || tool.type === 'graphql') {
      // API tools get their own adapter
      merged.set(safeName, {
        name: safeName,
        description: safeDescription,
        detect: 'true', // Always "installed"
        hint: generateApiHint({
          ...tool,
          name: safeName,
          description: safeDescription,
          commands: safeCommands,
          base_url: clean(tool.base_url),
          endpoints: cleanArr(tool.endpoints),
        }),
        installed: true,
        commands: safeCommands,
      });
      continue;
    }

    const existing = merged.get(safeName);
    if (existing) {
      // Merge commands into existing adapter
      if (safeCommands) {
        existing.commands = [...(existing.commands ?? []), ...safeCommands];
      }
      if (safeAuth) existing.auth = safeAuth;
      if (tool.description) existing.description = safeDescription;
    } else {
      // New CLI adapter from project config
      merged.set(safeName, {
        name: safeName,
        description: safeDescription,
        detect: `${safeName} --version`,
        hint: safeCommands
          ? `Use Bash to run ${safeName} commands:\n${safeCommands.map((c) => `  - ${c}`).join('\n')}`
          : `Use Bash to run ${safeName} commands.`,
        commands: safeCommands,
        auth: safeAuth,
      });
    }
  }

  return Array.from(merged.values());
}

function generateApiHint(tool: ProjectToolConfig): string {
  const lines = [`${tool.description ?? tool.name} (${tool.type} API at ${tool.base_url})`];
  if (tool.endpoints) {
    lines.push('Endpoints:');
    for (const ep of tool.endpoints) {
      lines.push(`  - ${ep}`);
    }
  }
  lines.push(`Use Bash with curl to call this API. Base URL: ${tool.base_url}`);
  return lines.join('\n');
}
