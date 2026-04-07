/**
 * Layer 4 — Policy: Permission rules
 *
 * Rule-based permission overrides. Rules take precedence over mode defaults.
 * Users can configure allow/deny/ask rules that match on tool name,
 * command patterns, or file paths.
 *
 * Rules are checked in order: deny first, then allow, then ask.
 * If no rule matches, fall back to mode default.
 */

import type { ToolCall } from '../protocol/tools.js';
import type { PermissionDecision } from './modes.js';

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

// ─── Rule Matching ──────────────────────────────────────

/**
 * Check if a rule matches a tool call.
 */
export function ruleMatches(rule: PermissionRule, call: ToolCall): boolean {
  // Match tool name
  if (!matchPattern(rule.toolPattern, call.name)) {
    return false;
  }

  // Match input patterns if specified
  if (rule.inputMatch) {
    if (rule.inputMatch.commandPattern && call.name === 'Bash') {
      const command = call.input['command'] as string;
      if (!command) return false;
      try {
        const regex = new RegExp(rule.inputMatch.commandPattern);
        if (!regex.test(command)) return false;
      } catch {
        return false;
      }
    }

    if (rule.inputMatch.filePattern) {
      const filePath = (call.input['file_path'] as string) ?? '';
      if (!matchPattern(rule.inputMatch.filePattern, filePath)) return false;
    }
  }

  return true;
}

/**
 * Evaluate rules against a tool call.
 * Returns the first matching rule's decision, or null if no rule matches.
 */
export function evaluateRules(
  rules: PermissionRule[],
  call: ToolCall,
): { decision: PermissionDecision; rule: PermissionRule } | null {
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

export const BUILTIN_RULES: PermissionRule[] = [
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

// ─── Helpers ────────────────────────────────────────────

function matchPattern(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (pattern === value) return true;

  // Simple glob matching
  if (pattern.includes('*')) {
    const regex = new RegExp(
      '^' + pattern.replace(/\./g, '\\.').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$',
    );
    return regex.test(value);
  }

  return false;
}
