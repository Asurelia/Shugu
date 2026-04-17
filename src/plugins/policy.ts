/**
 * Layer 14 — Plugins: Policy
 *
 * Loads and resolves `.pcc/plugin-policy.json` for per-plugin capability
 * overrides, isolation mode, and enable/disable controls.
 *
 * Isolation modes:
 *   - 'unrestricted' — plugin runs in the host process with full runtime
 *     access. No sandbox, no broker. Use only for plugins you author or
 *     fully trust. (Legacy name: 'trusted', accepted with a deprecation
 *     warning. 'trusted' was renamed because it implied "safe" when the
 *     real semantics are "not sandboxed".)
 *   - 'brokered' — plugin runs in a child process with capability-based
 *     IPC. Filesystem, network, and agent access are mediated by the
 *     broker. Default for anything you did not author.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginManifest } from './loader.js';
import { logger } from '../utils/logger.js';

// ─── Isolation Mode ────────────────────────────────────

/**
 * Canonical isolation mode. `trusted` is accepted as an input alias for
 * backward compatibility but normalized to `unrestricted` at load time.
 */
export type IsolationMode = 'unrestricted' | 'brokered';

/** Input type accepted from user config (still allows legacy 'trusted'). */
export type IsolationInput = IsolationMode | 'trusted';

/**
 * Normalize an isolation input, warning on legacy names.
 * Returns `undefined` when input is `undefined` (caller applies its own default).
 */
export function normalizeIsolation(
  value: IsolationInput | undefined,
  contextLabel: string,
): IsolationMode | undefined {
  if (value === undefined) return undefined;
  if (value === 'trusted') {
    logger.warn(
      `plugin-policy: "${contextLabel}" uses isolation: "trusted" — rename to "unrestricted". ` +
        `"trusted" was misleading (it does NOT imply sandboxing); supported until next major.`,
    );
    return 'unrestricted';
  }
  return value;
}

// ─── Policy Schema ─────────────────────────────────────

export interface PluginPolicy {
  version: 1;
  defaults?: {
    isolation?: IsolationInput;
    capabilities?: string[];
    permissions?: string[];
    maxAgentTurns?: number;
    timeoutMs?: number;
  };
  plugins?: Record<string, {
    enabled?: boolean;
    isolation?: IsolationInput;
    capabilities?: string[];
    capabilitiesAdd?: string[];
    capabilitiesDeny?: string[];
    permissions?: string[];
    hooks?: { allow?: string[]; deny?: string[] };
    maxAgentTurns?: number;
    timeoutMs?: number;
  }>;
}

// ─── Resolved Config ───────────────────────────────────

export interface ResolvedPluginConfig {
  enabled: boolean;
  isolation: IsolationMode;
  capabilities: string[];
  permissions: string[];
  timeoutMs: number;
  maxAgentTurns: number;
}

// ─── Defaults ──────────────────────────────────────────

const DEFAULTS: ResolvedPluginConfig = {
  enabled: true,
  isolation: 'unrestricted',
  capabilities: ['fs.read'],
  permissions: [],
  timeoutMs: 30_000,
  maxAgentTurns: 10,
};

// ─── loadPolicy ────────────────────────────────────────

/**
 * Read `.pcc/plugin-policy.json` from projectDir.
 * Returns null if the file does not exist or is invalid JSON.
 */
export async function loadPolicy(projectDir: string): Promise<PluginPolicy | null> {
  const policyPath = join(projectDir, '.pcc', 'plugin-policy.json');
  let raw: string;
  try {
    raw = await readFile(policyPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    logger.warn(`plugin-policy: failed to read ${policyPath}`, err instanceof Error ? err.message : String(err));
    return null;
  }

  try {
    return JSON.parse(raw) as PluginPolicy;
  } catch (err) {
    logger.warn(`plugin-policy: invalid JSON in ${policyPath}`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ─── resolvePluginConfig ───────────────────────────────

/**
 * Resolve the effective config for a plugin by merging:
 *   1. Hard-coded defaults
 *   2. Manifest values
 *   3. Policy defaults (if set)
 *   4. Per-plugin overrides (if set)
 *
 * `capabilitiesDeny` always removes from the final list.
 * `capabilitiesAdd` adds to the final list (after deny is applied).
 */
export function resolvePluginConfig(
  manifest: PluginManifest,
  policy: PluginPolicy | null,
): ResolvedPluginConfig {
  // Step 1: start from defaults, then apply manifest
  let isolation: IsolationMode =
    normalizeIsolation(manifest.isolation, `manifest ${manifest.name}`) ?? DEFAULTS.isolation;
  let capabilities: string[] = manifest.capabilities ? [...manifest.capabilities] : [...DEFAULTS.capabilities];
  let permissions: string[] = manifest.permissions ? [...manifest.permissions] : [...DEFAULTS.permissions];
  let timeoutMs: number = DEFAULTS.timeoutMs;
  let maxAgentTurns: number = DEFAULTS.maxAgentTurns;
  let enabled: boolean = DEFAULTS.enabled;

  if (policy) {
    // Step 2: apply policy defaults
    const d = policy.defaults;
    if (d) {
      const norm = normalizeIsolation(d.isolation, 'policy defaults');
      if (norm !== undefined) isolation = norm;
      if (d.capabilities !== undefined) capabilities = [...d.capabilities];
      if (d.permissions !== undefined) permissions = [...d.permissions];
      if (d.timeoutMs !== undefined) timeoutMs = d.timeoutMs;
      if (d.maxAgentTurns !== undefined) maxAgentTurns = d.maxAgentTurns;
    }

    // Step 3: apply per-plugin overrides
    const override = policy.plugins?.[manifest.name];
    if (override) {
      if (override.enabled === false) enabled = false;
      const norm = normalizeIsolation(override.isolation, `policy override ${manifest.name}`);
      if (norm !== undefined) isolation = norm;
      if (override.capabilities !== undefined) capabilities = [...override.capabilities];
      if (override.permissions !== undefined) permissions = [...override.permissions];
      if (override.timeoutMs !== undefined) timeoutMs = override.timeoutMs;
      if (override.maxAgentTurns !== undefined) maxAgentTurns = override.maxAgentTurns;

      // capabilitiesAdd adds to the final list
      if (override.capabilitiesAdd && override.capabilitiesAdd.length > 0) {
        for (const cap of override.capabilitiesAdd) {
          if (!capabilities.includes(cap)) {
            capabilities.push(cap);
          }
        }
      }

      // capabilitiesDeny removes from final list (AFTER add — always wins)
      if (override.capabilitiesDeny && override.capabilitiesDeny.length > 0) {
        const denySet = new Set(override.capabilitiesDeny);
        capabilities = capabilities.filter((c) => !denySet.has(c));
      }
    }
  }

  return { enabled, isolation, capabilities, permissions, timeoutMs, maxAgentTurns };
}
