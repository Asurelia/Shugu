/**
 * Layer 14 — Plugins: Policy
 *
 * Loads and resolves `.pcc/plugin-policy.json` for per-plugin capability
 * overrides, isolation mode, and enable/disable controls.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginManifest } from './loader.js';
import { logger } from '../utils/logger.js';

// ─── Policy Schema ─────────────────────────────────────

export interface PluginPolicy {
  version: 1;
  defaults?: {
    isolation?: 'trusted' | 'brokered';
    capabilities?: string[];
    permissions?: string[];
    maxAgentTurns?: number;
    timeoutMs?: number;
  };
  plugins?: Record<string, {
    enabled?: boolean;
    isolation?: 'trusted' | 'brokered';
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
  isolation: 'trusted' | 'brokered';
  capabilities: string[];
  permissions: string[];
  timeoutMs: number;
  maxAgentTurns: number;
}

// ─── Defaults ──────────────────────────────────────────

const DEFAULTS: ResolvedPluginConfig = {
  enabled: true,
  isolation: 'trusted',
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
  let isolation: 'trusted' | 'brokered' = manifest.isolation ?? DEFAULTS.isolation;
  let capabilities: string[] = manifest.capabilities ? [...manifest.capabilities] : [...DEFAULTS.capabilities];
  let permissions: string[] = manifest.permissions ? [...manifest.permissions] : [...DEFAULTS.permissions];
  let timeoutMs: number = DEFAULTS.timeoutMs;
  let maxAgentTurns: number = DEFAULTS.maxAgentTurns;
  let enabled: boolean = DEFAULTS.enabled;

  if (policy) {
    // Step 2: apply policy defaults
    const d = policy.defaults;
    if (d) {
      if (d.isolation !== undefined) isolation = d.isolation;
      if (d.capabilities !== undefined) capabilities = [...d.capabilities];
      if (d.permissions !== undefined) permissions = [...d.permissions];
      if (d.timeoutMs !== undefined) timeoutMs = d.timeoutMs;
      if (d.maxAgentTurns !== undefined) maxAgentTurns = d.maxAgentTurns;
    }

    // Step 3: apply per-plugin overrides
    const override = policy.plugins?.[manifest.name];
    if (override) {
      if (override.enabled === false) enabled = false;
      if (override.isolation !== undefined) isolation = override.isolation;
      if (override.capabilities !== undefined) capabilities = [...override.capabilities];
      if (override.permissions !== undefined) permissions = [...override.permissions];
      if (override.timeoutMs !== undefined) timeoutMs = override.timeoutMs;
      if (override.maxAgentTurns !== undefined) maxAgentTurns = override.maxAgentTurns;

      // capabilitiesDeny removes from final list (always wins)
      if (override.capabilitiesDeny && override.capabilitiesDeny.length > 0) {
        const denySet = new Set(override.capabilitiesDeny);
        capabilities = capabilities.filter((c) => !denySet.has(c));
      }

      // capabilitiesAdd adds to the final list
      if (override.capabilitiesAdd && override.capabilitiesAdd.length > 0) {
        for (const cap of override.capabilitiesAdd) {
          if (!capabilities.includes(cap)) {
            capabilities.push(cap);
          }
        }
      }
    }
  }

  return { enabled, isolation, capabilities, permissions, timeoutMs, maxAgentTurns };
}
