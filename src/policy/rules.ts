/**
 * Layer 4 — Policy: Permission rules
 *
 * Rule-based permission overrides. Rules take precedence over mode defaults.
 * Users can configure allow/deny/ask rules that match on tool name,
 * command patterns, or file paths.
 *
 * Rules are checked in order: deny first, then allow, then ask.
 * If no rule matches, fall back to mode default.
 *
 * SECURITY: Regex in commandPattern is pre-compiled and validated at load time
 * via validateAndCompileRules. Invalid regexes are rejected fail-closed with
 * a logged warning — an invalid rule never silently disables security.
 */

import type { ToolCall } from '../protocol/tools.js';
import type { PermissionDecision } from './modes.js';
import { validateRegexSafety } from '../utils/security.js';
import { logger } from '../utils/logger.js';

// ─── Rule Types ─────────────────────────────────────────

export interface PermissionRule {
  /** Unique rule ID for display */
  id: string;

  /** Which tools this rule applies to (glob pattern or exact name) */
  toolPattern: string;

  /** What the rule decides */
  decision: PermissionDecision;

  /** Optional: match on specific input patterns */
  inputMatch?: {
    /** For Bash: regex pattern against the command string */
    commandPattern?: string;
    /** For file tools: glob pattern against file_path */
    filePattern?: string;
  };

  /** Source of this rule (user config, session, built-in) */
  source: 'builtin' | 'user' | 'session';

  /** Human-readable reason for this rule */
  reason?: string;
}

// ─── Compiled Rule (internal, pre-validated at load time) ──

/**
 * A rule whose regex patterns have been pre-compiled and validated.
 * Match functions use only pre-built RegExp objects — no dynamic RegExp
 * construction at request time, so an invalid pattern cannot cause fail-open.
 */
export interface CompiledRule extends PermissionRule {
  readonly _compiled: {
    toolPattern: RegExp | string;  // string = literal equality, RegExp = glob
    commandRegex?: RegExp;         // compiled commandPattern if present
    filePattern?: RegExp | string; // compiled glob of filePattern if present
  };
}

// ─── Compilation & Validation ───────────────────────────

/**
 * Compile and validate a set of rules at load time.
 *
 * SECURITY: any rule with an invalid or dangerous pattern is REJECTED
 * (logged and dropped). A rule that fails to compile MUST NOT be silently
 * treated as "no match" — that would disable security via typo.
 *
 * Builtin rules are trusted and skip regex-safety validation (they're
 * authored by us, not from user input), but still must compile.
 *
 * @returns Only the rules that compiled successfully.
 */
export function compileRules(rules: PermissionRule[]): CompiledRule[] {
  const compiled: CompiledRule[] = [];
  for (const rule of rules) {
    const result = compileRule(rule);
    if (result) {
      compiled.push(result);
    }
    // On failure, compileRule already logged the reason — rule is dropped.
  }
  return compiled;
}

function compileRule(rule: PermissionRule): CompiledRule | null {
  const _compiled: CompiledRule['_compiled'] = {
    toolPattern: rule.toolPattern,
  };

  // Compile toolPattern (can be glob or exact)
  const toolCompiled = compileGlobPattern(rule.toolPattern, `rule ${rule.id} toolPattern`);
  if (toolCompiled === null) return null;
  _compiled.toolPattern = toolCompiled;

  // Compile commandPattern (regex) if present
  if (rule.inputMatch?.commandPattern) {
    const pattern = rule.inputMatch.commandPattern;
    // Builtin rules are authored by us — trusted source — skip ReDoS validation
    // but still require compile success. User/session rules must pass the
    // full safety check.
    if (rule.source !== 'builtin') {
      const safety = validateRegexSafety(pattern, 500);
      if (!safety.safe) {
        logger.warn(
          `policy: rule "${rule.id}" commandPattern rejected (fail-closed): ${safety.reason}`,
        );
        return null;
      }
    }
    try {
      _compiled.commandRegex = new RegExp(pattern); // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    } catch (err) {
      logger.warn(
        `policy: rule "${rule.id}" commandPattern invalid (fail-closed): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  // Compile filePattern (glob) if present
  if (rule.inputMatch?.filePattern) {
    const fileCompiled = compileGlobPattern(
      rule.inputMatch.filePattern,
      `rule ${rule.id} filePattern`,
    );
    if (fileCompiled === null) return null;
    _compiled.filePattern = fileCompiled;
  }

  return { ...rule, _compiled };
}

// ─── Rule Matching ──────────────────────────────────────

/**
 * Check if a compiled rule matches a tool call.
 * Uses only pre-built RegExp objects — no dynamic compilation at match time.
 */
export function ruleMatches(rule: CompiledRule, call: ToolCall): boolean {
  // Match tool name
  if (!matchCompiledPattern(rule._compiled.toolPattern, call.name)) {
    return false;
  }

  // Match input patterns if specified
  if (rule._compiled.commandRegex && call.name === 'Bash') {
    const command = call.input['command'] as string;
    if (!command) return false;
    if (!rule._compiled.commandRegex.test(command)) return false;
  }

  if (rule._compiled.filePattern !== undefined) {
    const filePath = (call.input['file_path'] as string) ?? '';
    if (!matchCompiledPattern(rule._compiled.filePattern, filePath)) return false;
  }

  return true;
}

/**
 * Evaluate compiled rules against a tool call.
 * Returns the first matching rule's decision, or null if no rule matches.
 */
export function evaluateRules(
  rules: CompiledRule[],
  call: ToolCall,
): { decision: PermissionDecision; rule: CompiledRule } | null {
  // Check deny rules first (highest priority)
  for (const rule of rules) {
    if (rule.decision === 'deny' && ruleMatches(rule, call)) {
      return { decision: 'deny', rule };
    }
  }

  // Then allow rules
  for (const rule of rules) {
    if (rule.decision === 'allow' && ruleMatches(rule, call)) {
      return { decision: 'allow', rule };
    }
  }

  // Then ask rules
  for (const rule of rules) {
    if (rule.decision === 'ask' && ruleMatches(rule, call)) {
      return { decision: 'ask', rule };
    }
  }

  return null;
}

// ─── Built-in Rules ─────────────────────────────────────

const BUILTIN_RULES_RAW: PermissionRule[] = [
  // Always deny obviously destructive commands
  {
    id: 'deny-rm-rf',
    toolPattern: 'Bash',
    decision: 'deny',
    inputMatch: { commandPattern: 'rm\\s+-rf\\s+/' },
    source: 'builtin',
    reason: 'Prevents recursive deletion from root',
  },
  {
    id: 'deny-format',
    toolPattern: 'Bash',
    decision: 'deny',
    inputMatch: { commandPattern: 'mkfs\\.' },
    source: 'builtin',
    reason: 'Prevents filesystem formatting',
  },
  {
    id: 'deny-dd',
    toolPattern: 'Bash',
    decision: 'deny',
    inputMatch: { commandPattern: '\\bdd\\b.*of=/dev/' },
    source: 'builtin',
    reason: 'Prevents raw disk writes',
  },
  // Always deny writing/editing sensitive paths
  {
    id: 'deny-env-write',
    toolPattern: 'Write',
    decision: 'deny',
    inputMatch: { filePattern: '**/.env*' },
    source: 'builtin',
    reason: 'Prevents overwriting environment files',
  },
  {
    id: 'deny-env-edit',
    toolPattern: 'Edit',
    decision: 'deny',
    inputMatch: { filePattern: '**/.env*' },
    source: 'builtin',
    reason: 'Prevents editing environment files',
  },
];

/**
 * Pre-compiled builtin rules — compiled once at module load.
 * Safe to share across all PermissionResolver instances.
 */
export const BUILTIN_RULES: CompiledRule[] = compileRules(BUILTIN_RULES_RAW);

// ─── Helpers (load-time glob compilation) ──────────────

/**
 * Compile a glob pattern once at load time.
 *
 * Returns:
 *  - '*' sentinel: a literal '*' string for "match anything"
 *  - An exact string for patterns without wildcards
 *  - A pre-built RegExp for patterns with wildcards
 *  - null on compilation failure (rule will be rejected fail-closed)
 *
 * SECURITY: the generated regex is bounded — '*' maps to [^/]* and '**'
 * maps to .* — both are linear in input length and cannot cause ReDoS.
 * validateRegexSafety is still called as a defense-in-depth for user input.
 */
function compileGlobPattern(pattern: string, contextLabel: string): RegExp | string | null {
  if (pattern === '*') return '*';
  if (!pattern.includes('*')) return pattern; // Literal equality

  // Translate glob → regex source with bounded, linear-time operators only.
  const regexSrc =
    '^' +
    pattern
      .replace(/\./g, '\\.')
      .replace(/\*\*\//g, '(?:.*/)?') // **/ → zero or more dir segments
      .replace(/\*\*/g, '.*')         // standalone ** → anything
      .replace(/\*/g, '[^/]*')        // * → single segment wildcard
    + '$';

  // Defense in depth: even though our generator produces safe patterns,
  // a crafted input (e.g. thousands of * chars) could inflate the source.
  const safety = validateRegexSafety(regexSrc, 2000);
  if (!safety.safe) {
    logger.warn(`policy: ${contextLabel} rejected (fail-closed): ${safety.reason}`);
    return null;
  }

  try {
    return new RegExp(regexSrc); // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  } catch (err) {
    logger.warn(
      `policy: ${contextLabel} failed to compile (fail-closed): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/**
 * Match a pre-compiled glob pattern against a value.
 */
function matchCompiledPattern(pattern: RegExp | string, value: string): boolean {
  if (pattern === '*') return true;
  const normalized = value.replace(/\\/g, '/');
  if (typeof pattern === 'string') return pattern === normalized;
  return pattern.test(normalized);
}
