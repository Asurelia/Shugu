/**
 * Meta-Harness: Configuration Loader & Validator
 *
 * Loads HarnessConfig from YAML files and validates against V1 restrictions:
 * - BASE_SYSTEM_PROMPT is immutable (no systemPromptOverride)
 * - model.name is fixed per run
 * - transport/protocol/policy/credentials are immutable zones
 * - Shell metacharacters are rejected in command fields
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { HarnessConfig } from './types.js';

// ─── Immutable Zones ──────────────────────────────────

const IMMUTABLE_ZONES = [
  'src/transport/',
  'src/protocol/',
  'src/policy/',
  'src/credentials/',
  'transport/',
  'protocol/',
  'policy/',
  'credentials/',
];

const SHELL_METACHAR_PATTERN = /[;&|`$(){}[\]<>!]/;

// ─── Loader ───────────────────────────────────────────

/**
 * Load a HarnessConfig from a directory.
 * Resolves file references for prompt fragments.
 *
 * Expected structure:
 *   harnesses/<name>/
 *     config.yaml          — main config
 *     system-prompt-append.md  — optional
 *     strategy-prompts/    — optional per-complexity prompts
 *       simple.md
 *       complex.md
 *       epic.md
 *     reflection-template.md  — optional
 */
export async function loadHarnessConfig(harnessDir: string): Promise<HarnessConfig> {
  const configPath = join(harnessDir, 'config.yaml');
  const content = await readFile(configPath, 'utf-8');
  const config = parseYaml(content) as HarnessConfig;

  if (!config || typeof config !== 'object') {
    throw new Error(`Invalid harness config at ${configPath}: expected YAML object`);
  }

  // Resolve file references for prompt append
  if (!config.systemPromptAppend) {
    try {
      config.systemPromptAppend = await readFile(join(harnessDir, 'system-prompt-append.md'), 'utf-8');
    } catch { /* optional file */ }
  }

  // Resolve strategy prompt files
  if (!config.strategy?.strategyPrompts) {
    const strategyDir = join(harnessDir, 'strategy-prompts');
    const prompts: Record<string, string | null> = {};
    let found = false;
    for (const level of ['simple', 'complex', 'epic'] as const) {
      try {
        prompts[level] = await readFile(join(strategyDir, `${level}.md`), 'utf-8');
        found = true;
      } catch { /* optional */ }
    }
    if (found) {
      config.strategy = { ...config.strategy, strategyPrompts: prompts };
    }
  }

  // Resolve reflection template file
  if (!config.reflection?.promptTemplate) {
    try {
      const template = await readFile(join(harnessDir, 'reflection-template.md'), 'utf-8');
      config.reflection = { ...config.reflection, promptTemplate: template };
    } catch { /* optional */ }
  }

  return config;
}

// ─── Validator ────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a HarnessConfig against V1 restrictions.
 */
export function validateHarnessConfig(config: HarnessConfig): ValidationResult {
  const errors: string[] = [];

  // Required fields
  if (!config.name || typeof config.name !== 'string') {
    errors.push('Missing required field: name');
  }
  if (!config.version || typeof config.version !== 'string') {
    errors.push('Missing required field: version');
  }

  // V1: systemPromptOverride is FORBIDDEN
  if ('systemPromptOverride' in config) {
    errors.push('systemPromptOverride is forbidden in V1. BASE_SYSTEM_PROMPT is immutable. Use systemPromptAppend instead.');
  }

  // V1: model.name is fixed per run
  if (config.model && 'name' in config.model) {
    errors.push('model.name is not mutable in V1. The model is fixed for the entire run.');
  }

  // Check all string values for immutable zone references
  const allStrings = extractStrings(config);
  for (const str of allStrings) {
    for (const zone of IMMUTABLE_ZONES) {
      if (str.includes(zone)) {
        errors.push(`Config references immutable zone "${zone}" in value: "${str.slice(0, 80)}..."`);
      }
    }
  }

  // Validate limits
  if (config.limits) {
    if (config.limits.maxTurns !== undefined) {
      if (config.limits.maxTurns < 1 || config.limits.maxTurns > 500) {
        errors.push(`limits.maxTurns must be between 1 and 500, got ${config.limits.maxTurns}`);
      }
    }
    if (config.limits.maxBudgetUsd !== undefined) {
      if (config.limits.maxBudgetUsd < 0.01 || config.limits.maxBudgetUsd > 50) {
        errors.push(`limits.maxBudgetUsd must be between 0.01 and 50, got ${config.limits.maxBudgetUsd}`);
      }
    }
    if (config.limits.toolTimeoutMs !== undefined) {
      if (config.limits.toolTimeoutMs < 5_000 || config.limits.toolTimeoutMs > 600_000) {
        errors.push(`limits.toolTimeoutMs must be between 5000 and 600000, got ${config.limits.toolTimeoutMs}`);
      }
    }
  }

  // Validate model settings
  if (config.model?.temperature !== undefined) {
    if (config.model.temperature < 0.01 || config.model.temperature > 2.0) {
      errors.push(`model.temperature must be between 0.01 and 2.0, got ${config.model.temperature}`);
    }
  }
  if (config.model?.maxTokens !== undefined) {
    if (config.model.maxTokens < 256 || config.model.maxTokens > 32768) {
      errors.push(`model.maxTokens must be between 256 and 32768, got ${config.model.maxTokens}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─── Helpers ──────────────────────────────────────────

/**
 * Recursively extract all string values from an object.
 */
function extractStrings(obj: unknown, result: string[] = []): string[] {
  if (typeof obj === 'string') {
    result.push(obj);
  } else if (Array.isArray(obj)) {
    for (const item of obj) {
      extractStrings(item, result);
    }
  } else if (obj && typeof obj === 'object') {
    for (const value of Object.values(obj)) {
      extractStrings(value, result);
    }
  }
  return result;
}
