/**
 * BuddyObserver — Real-time code analysis feedback loop.
 *
 * Observes tool results via PostToolUse hooks and generates
 * terse, actionable observations injected into the model's context.
 * Uses pure pattern matching — zero LLM calls, zero token cost.
 */

import type { Companion, BuddyConfig, BuddyObservation, ObservationCategory } from './types.js';
import type { ToolCall, ToolResult } from '../../protocol/tools.js';
import { SECRET_PATTERNS } from '../../plugins/builtin/behavior-hooks.js';

// ─── Security Patterns ────────────────────────────────

const UNSAFE_CODE_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /\bFunction\s*\(/, message: 'Dynamic code execution via Function constructor' },
  { pattern: /\.innerHTML\s*=/, message: 'Unsafe innerHTML assignment — risk of XSS' },
  { pattern: /\bsetTimeout\s*\(\s*['"`]/, message: 'String passed to setTimeout — implicit code execution' },
  { pattern: /\bsetInterval\s*\(\s*['"`]/, message: 'String passed to setInterval — implicit code execution' },
];

const SQL_INJECTION_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /['"`]\s*\+\s*\w+.*(?:SELECT|INSERT|UPDATE|DELETE|DROP)/i, message: 'SQL string concatenation detected — use parameterized queries' },
  { pattern: /(?:SELECT|INSERT|UPDATE|DELETE|DROP)\b[^;]*['"`]\s*\+/i, message: 'SQL string concatenation detected — use parameterized queries' },
  { pattern: /\$\{.*\}.*(?:SELECT|INSERT|UPDATE|DELETE|DROP)/i, message: 'Template literal in SQL query — use parameterized queries' },
  { pattern: /f['"].*(?:SELECT|INSERT|UPDATE|DELETE|DROP)/i, message: 'f-string SQL query detected — use parameterized queries' },
];

const BASH_DANGER_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /--no-verify/, message: 'Skipping git hooks with --no-verify' },
  { pattern: /push\s+--force(?!\s+--force-with-lease)/, message: 'Force push without lease — risk of overwriting remote' },
  { pattern: /rm\s+-rf\s+\/(?!\w)/, message: 'Recursive delete at root — extremely dangerous' },
  { pattern: /git\s+reset\s+--hard/, message: 'Hard reset — uncommitted changes will be lost' },
];

// ─── Performance Patterns ─────────────────────────────

const PERF_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /for\s*\([^)]*\)\s*\{[^}]*await\b/s, message: 'Await inside loop — consider Promise.all for parallel execution' },
  { pattern: /SELECT\s+\*(?!\s+FROM\s+\w+\s+(?:WHERE|LIMIT))/i, message: 'SELECT * without WHERE/LIMIT — consider narrowing the query' },
];

// ─── Code Smell Patterns ──────────────────────────────

const SMELL_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /:\s*any\b(?!\s*\/\/)/, message: 'TypeScript `any` type — consider using a specific type' },
  { pattern: /console\.log\s*\(/, message: 'console.log in code — remove before production' },
  { pattern: /catch\s*(?:\([^)]*\))?\s*\{\s*\}/, message: 'Empty catch block — errors are silently swallowed' },
];

// ─── Test Failure Patterns ────────────────────────────

const TEST_FAIL_PATTERNS = [
  /FAIL\s/,
  /Tests?:\s*\d+\s+failed/i,
  /AssertionError/,
  /Expected.*Received/i,
  /\d+\s+(?:failing|failed)/,
  /error\s+TS\d+/i,        // TypeScript compilation errors
];

// ─── BuddyObserver Class ──────────────────────────────

export class BuddyObserver {
  private companion: Companion;
  private config: BuddyConfig;
  private lastInjectionTime: number = 0;
  private pendingObservations: BuddyObservation[] = [];
  private errorTracker: Map<string, number> = new Map();
  private muted: boolean = false;

  constructor(companion: Companion, config: BuddyConfig) {
    this.companion = companion;
    this.config = config;
  }

  /**
   * Analyze a tool result. Called by PostToolUse hook.
   * Returns an observation if something noteworthy was found, null otherwise.
   */
  observe(
    toolName: string,
    call: ToolCall,
    result: ToolResult,
    _durationMs: number,
  ): BuddyObservation | null {
    if (this.muted || !this.config.observationsEnabled) return null;

    const content = typeof result.content === 'string'
      ? result.content
      : JSON.stringify(result.content);

    // Extract the most meaningful text from tool input
    const rawInput = call.input as Record<string, unknown>;
    const input = typeof call.input === 'string'
      ? call.input
      : (rawInput['content'] as string)
        ?? (rawInput['new_string'] as string)
        ?? (rawInput['command'] as string)
        ?? JSON.stringify(call.input);

    // Try each category of analysis
    const observation =
      this.checkSecurity(toolName, input, content) ??
      this.checkTestFailure(toolName, content) ??
      this.checkPerformance(toolName, input) ??
      this.checkCodeSmells(toolName, input) ??
      this.checkErrorPatterns(toolName, result) ??
      this.checkArchitecture(toolName, input);

    if (observation) {
      this.pendingObservations.push(observation);
    }

    return observation;
  }

  /**
   * Drain pending observations as a formatted string for context injection.
   * Returns null if nothing pending, cooldown not elapsed, or muted.
   */
  drain(): string | null {
    if (this.muted || !this.config.observationsEnabled) return null;
    if (this.pendingObservations.length === 0) return null;

    const now = Date.now();
    const cooldownMs = this.config.observationCooldownSeconds * 1000;
    if (now - this.lastInjectionTime < cooldownMs) return null;

    // Take the highest-severity pending observation
    const sorted = this.pendingObservations.sort((a, b) => {
      const severityOrder = { alert: 0, warn: 1, info: 2 };
      return severityOrder[a.severity] - severityOrder[b.severity];
    });

    const best = sorted[0]!;
    this.pendingObservations = [];
    this.lastInjectionTime = now;

    return this.voiceWrap(best.message);
  }

  /** Reset state (on companion switch). */
  reset(): void {
    this.pendingObservations = [];
    this.errorTracker.clear();
    this.lastInjectionTime = 0;
  }

  /** Update companion reference. */
  setCompanion(companion: Companion): void {
    this.companion = companion;
    this.reset();
  }

  /** Set mute state. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.pendingObservations = [];
  }

  // ─── Analysis Methods ─────────────────────────────────

  private checkSecurity(
    toolName: string,
    input: string,
    content: string,
  ): BuddyObservation | null {
    // Check Write/Edit content for unsafe code
    if (toolName === 'Write' || toolName === 'Edit') {
      for (const { pattern, message } of UNSAFE_CODE_PATTERNS) {
        if (pattern.test(input)) {
          return this.makeObservation('security', message, toolName, 'alert');
        }
      }
      for (const { pattern, message } of SQL_INJECTION_PATTERNS) {
        if (pattern.test(input)) {
          return this.makeObservation('security', message, toolName, 'alert');
        }
      }
      // Check for hardcoded secrets
      for (const secretPattern of SECRET_PATTERNS) {
        if (secretPattern.test(input)) {
          return this.makeObservation('security', 'Possible hardcoded credential detected', toolName, 'alert');
        }
      }
    }

    // Check Bash commands for dangerous patterns
    if (toolName === 'Bash') {
      for (const { pattern, message } of BASH_DANGER_PATTERNS) {
        if (pattern.test(input)) {
          return this.makeObservation('security', message, toolName, 'warn');
        }
      }
    }

    return null;
  }

  private checkTestFailure(
    toolName: string,
    content: string,
  ): BuddyObservation | null {
    if (toolName !== 'Bash') return null;

    for (const pattern of TEST_FAIL_PATTERNS) {
      if (pattern.test(content)) {
        // Track repeated failures
        const testMatch = content.match(/(?:FAIL|failing)\s+(\S+)/i);
        const testKey = testMatch?.[1] ?? 'unknown';
        const count = (this.errorTracker.get(testKey) ?? 0) + 1;
        this.errorTracker.set(testKey, count);

        if (count >= 3) {
          return this.makeObservation(
            'error_pattern',
            `${testKey} has failed ${count} times — investigate root cause`,
            toolName,
            'warn',
          );
        }

        return this.makeObservation('test_failure', 'Test failure detected', toolName, 'info');
      }
    }

    return null;
  }

  private checkPerformance(
    toolName: string,
    input: string,
  ): BuddyObservation | null {
    if (toolName !== 'Write' && toolName !== 'Edit') return null;

    for (const { pattern, message } of PERF_PATTERNS) {
      if (pattern.test(input)) {
        return this.makeObservation('performance', message, toolName, 'info');
      }
    }

    return null;
  }

  private checkCodeSmells(
    toolName: string,
    input: string,
  ): BuddyObservation | null {
    if (toolName !== 'Write' && toolName !== 'Edit') return null;

    for (const { pattern, message } of SMELL_PATTERNS) {
      if (pattern.test(input)) {
        return this.makeObservation('code_smell', message, toolName, 'info');
      }
    }

    return null;
  }

  private checkErrorPatterns(
    toolName: string,
    result: ToolResult,
  ): BuddyObservation | null {
    if (!result.is_error) return null;

    const content = typeof result.content === 'string' ? result.content : '';
    const errorKey = `${toolName}:${content.slice(0, 50)}`;
    const count = (this.errorTracker.get(errorKey) ?? 0) + 1;
    this.errorTracker.set(errorKey, count);

    if (count >= 2) {
      return this.makeObservation(
        'error_pattern',
        `${toolName} failing repeatedly — same error ${count} times`,
        toolName,
        'warn',
      );
    }

    return null;
  }

  private checkArchitecture(
    toolName: string,
    input: string,
  ): BuddyObservation | null {
    if (toolName !== 'Write') return null;

    // Check for excessively long files
    const lineCount = input.split('\n').length;
    if (lineCount > 500) {
      return this.makeObservation(
        'architecture',
        `File is ${lineCount} lines — consider splitting into modules`,
        toolName,
        'info',
      );
    }

    return null;
  }

  // ─── Helpers ──────────────────────────────────────────

  private makeObservation(
    category: ObservationCategory,
    message: string,
    toolName: string,
    severity: BuddyObservation['severity'],
  ): BuddyObservation {
    // Enforce 150 char limit
    const truncated = message.length > 150 ? message.slice(0, 147) + '...' : message;
    return {
      category,
      message: truncated,
      timestamp: Date.now(),
      toolName,
      severity,
    };
  }

  /**
   * Wrap an observation message in the companion's voice/personality.
   */
  private voiceWrap(raw: string): string {
    const personality = this.companion.personality.toLowerCase();

    if (personality.includes('security') || personality.includes('vigilant') || personality.includes('sentinel')) {
      return `*narrows eyes* ${raw}`;
    }
    if (personality.includes('chill') || personality.includes('zen') || personality.includes('calm')) {
      return `Worth noting: ${raw}`;
    }
    if (personality.includes('snarky') || personality.includes('sarcastic')) {
      return `Just saying: ${raw}`;
    }

    // Species-based defaults
    switch (this.companion.species) {
      case 'cat': return `*flicks ear* ${raw}`;
      case 'owl': return `*blinks* ${raw}`;
      case 'dragon': return `*smoke puff* ${raw}`;
      case 'robot': return `[OBSERVATION] ${raw}`;
      case 'ghost': return `*whispers* ${raw}`;
      case 'capybara': return `*calmly* ${raw}`;
      default: return raw;
    }
  }
}
