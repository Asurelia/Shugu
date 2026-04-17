/**
 * Layer 4 — Policy: Permission resolver
 *
 * Central decision point: given a tool call, the current mode, and active rules,
 * determine if the call is allowed, denied, or needs user confirmation.
 *
 * Resolution order:
 * 1. Built-in deny rules (always checked first)
 * 2. User rules (allow/deny/ask)
 * 3. Risk classifier (for fullAuto + execute category)
 * 4. Mode default matrix
 */

import type { ToolCall } from '../protocol/tools.js';
import type { PermissionMode } from '../protocol/tools.js';
import { getToolCategory, getDefaultDecision, type PermissionDecision } from './modes.js';
import { evaluateRules, BUILTIN_RULES, compileRules, type PermissionRule, type CompiledRule } from './rules.js';
import { classifyBashRisk, type RiskLevel } from './classifier.js';

// ─── Permission Result ──────────────────────────────────

export interface PermissionResult {
  decision: PermissionDecision;
  reason: string;
  source: 'builtin' | 'user' | 'classifier' | 'mode';
  riskLevel?: RiskLevel;
}

// ─── Resolver ───────────────────────────────────────────

export class PermissionResolver {
  private mode: PermissionMode;
  private userRules: CompiledRule[];
  private sessionAllows: Set<string> = new Set();

  /**
   * @param mode Initial permission mode
   * @param userRules Raw user rules — will be validated & compiled. Rules
   *   with invalid patterns are rejected fail-closed (logged, dropped).
   */
  constructor(mode: PermissionMode, userRules: PermissionRule[] = []) {
    this.mode = mode;
    this.userRules = compileRules(userRules);
  }

  /**
   * Resolve the permission for a tool call.
   */
  resolve(call: ToolCall): PermissionResult {
    // 1. Check built-in deny rules
    const builtinResult = evaluateRules(BUILTIN_RULES, call);
    if (builtinResult && builtinResult.decision === 'deny') {
      return {
        decision: 'deny',
        reason: builtinResult.rule.reason ?? 'Blocked by built-in safety rule',
        source: 'builtin',
      };
    }

    // 2. Check user rules
    const userResult = evaluateRules(this.userRules, call);
    if (userResult) {
      return {
        decision: userResult.decision,
        reason: userResult.rule.reason ?? `Matched user rule: ${userResult.rule.id}`,
        source: 'user',
      };
    }

    // 3. Check session-level "always allow" (user said "yes, always" during session)
    const sessionKey = this.getSessionKey(call);
    if (this.sessionAllows.has(sessionKey)) {
      return {
        decision: 'allow',
        reason: 'Allowed for this session',
        source: 'user',
      };
    }

    // 4. Get category and mode default
    const category = getToolCategory(call.name);
    const modeDefault = getDefaultDecision(this.mode, category);

    // 5. For fullAuto + execute, defer to risk classifier
    if (this.mode === 'fullAuto' && category === 'execute') {
      const command = (call.input['command'] as string) ?? '';
      const risk = classifyBashRisk(command);

      if (risk.level === 'low') {
        return {
          decision: 'allow',
          reason: `Low risk: ${risk.reason}`,
          source: 'classifier',
          riskLevel: risk.level,
        };
      }

      if (risk.level === 'high') {
        return {
          decision: 'ask',
          reason: `High risk: ${risk.reason}`,
          source: 'classifier',
          riskLevel: risk.level,
        };
      }

      // Medium risk — prompt
      return {
        decision: 'ask',
        reason: `Medium risk: ${risk.reason}`,
        source: 'classifier',
        riskLevel: risk.level,
      };
    }

    // 6. Return mode default
    return {
      decision: modeDefault,
      reason: `Mode "${this.mode}" default for ${category} tools`,
      source: 'mode',
    };
  }

  /**
   * Record that the user approved a tool call for this session.
   */
  allowForSession(call: ToolCall): void {
    this.sessionAllows.add(this.getSessionKey(call));
  }

  /**
   * Change the permission mode.
   */
  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  private getSessionKey(call: ToolCall): string {
    // SECURITY: For bash, key on the first TWO tokens to prevent approval
    // cascade. Previously keyed on first word only: approving "npm install"
    // auto-approved ALL npm commands including "npm run evil-script".
    // Now: "npm install" → Bash:npm:install, "git push" → Bash:git:push.
    //
    // Also normalizes:
    // - Path prefixes: /usr/bin/npm → npm (prevents key mismatch)
    // - Env var prefixes: NODE_ENV=prod npm → npm (strips KEY=val tokens)
    if (call.name === 'Bash') {
      const cmd = (call.input['command'] as string) ?? '';
      let tokens = cmd.trim().split(/\s+/);

      // Strip leading env var assignments (KEY=value patterns)
      while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) {
        tokens = tokens.slice(1);
      }

      let first = tokens[0] ?? '';
      const second = tokens[1] ?? '';

      // Strip path prefix: /usr/bin/npm → npm, ./node_modules/.bin/tsc → tsc
      const slashIdx = first.lastIndexOf('/');
      const backslashIdx = first.lastIndexOf('\\');
      const pathSep = Math.max(slashIdx, backslashIdx);
      if (pathSep >= 0) {
        first = first.slice(pathSep + 1);
      }

      // Include second token if it's a subcommand (not a flag)
      if (second && !second.startsWith('-')) {
        return `Bash:${first}:${second}`;
      }
      return `Bash:${first}`;
    }
    // For file tools, key on tool name (allow all file reads, etc.)
    return call.name;
  }
}
