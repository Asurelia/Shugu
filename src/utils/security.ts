/**
 * Shared security utilities — constant-time comparisons, environment isolation,
 * regex safety validation, and IPv6 normalization.
 *
 * These consolidate patterns already proven in the codebase:
 * - timingSafeEqual from vault.ts
 * - env allowlist from plugins/host.ts
 * - workspace boundary checks from policy/workspace.ts
 *
 * Used by: triggers.ts, gateway.ts, daemon.ts, BashTool.ts, evaluator.ts,
 *          network.ts, host.ts
 */

import { timingSafeEqual, randomBytes } from 'node:crypto';

// ─── Constant-Time String Comparison ───────────────────

/**
 * Compare two strings in constant time to prevent timing attacks.
 *
 * Handles the length-mismatch pitfall: Node's crypto.timingSafeEqual throws
 * when buffers differ in length, which itself leaks information. This wrapper
 * pads the shorter buffer so the comparison always runs in O(max(a.length, b.length)),
 * then checks lengths separately.
 */
export function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');

  // Pad shorter buffer to match length of longer one.
  // The padding value doesn't matter — we check lengths afterward.
  const maxLen = Math.max(bufA.length, bufB.length);
  if (maxLen === 0) return true; // both empty

  const paddedA = Buffer.alloc(maxLen);
  const paddedB = Buffer.alloc(maxLen);
  bufA.copy(paddedA);
  bufB.copy(paddedB);

  // Constant-time content comparison + length check
  const contentsEqual = timingSafeEqual(paddedA, paddedB);
  const lengthsEqual = bufA.length === bufB.length;

  return contentsEqual && lengthsEqual;
}

// ─── Environment Variable Isolation ────────────────────

/**
 * Allowlist of environment variables safe to pass to child processes.
 * Intentionally excludes API keys, tokens, vault passwords, and secrets.
 */
const ENV_ALLOWLIST = [
  // System paths
  'PATH',
  'PATHEXT',
  // Home directories
  'HOME',
  'USERPROFILE',
  // Windows system
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'COMSPEC',
  // Temp directories
  'TMPDIR',
  'TEMP',
  'TMP',
  // Locale & terminal
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'TERM',
  'COLORTERM',
  // Node
  'NODE_OPTIONS',
  // Shell
  'SHELL',
] as const;

/**
 * Build a sanitized environment for child processes.
 * Only passes safe variables from process.env, plus optional extras.
 *
 * Pattern from: src/plugins/host.ts:202-208
 */
export function buildSafeEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of ENV_ALLOWLIST) {
    const val = process.env[key];
    if (val !== undefined) {
      env[key] = val;
    }
  }

  // Merge caller-specified extras (e.g., PCC_DAEMON=1)
  if (extra) {
    for (const [key, val] of Object.entries(extra)) {
      env[key] = val;
    }
  }

  return env;
}

// ─── Regex Safety Validation ───────────────────────────

/**
 * Patterns that indicate catastrophic backtracking risk:
 * - Nested quantifiers: (a+)+, (a*)+, (a+)*, (a?)+, etc.
 * - Quantified alternation with overlap: (a|a)+, (.|\s)+
 */
const REDOS_PATTERNS = [
  // Nested quantifiers: (x+)+, (x*)+, (x+)*, (x?)+, (x?)* etc.
  /\([^)]*[+*?]\)[+*]/,
  // Nested quantifiers with {n,m}: (x+){2,}, (x*){1,}, (x?){2,}
  /\([^)]*[+*?]\)\{/,
  // Quantified groups containing alternation where branches overlap
  /\([^)]*\|[^)]*\)[+*]/,
  // Backreferences (complex evaluation, potential for polynomial blowup)
  /\\[1-9]/,
];

/**
 * Check if a regex pattern is safe from catastrophic backtracking (ReDoS).
 * Returns { safe: true } or { safe: false, reason: string }.
 *
 * This is a structural heuristic, not a full analysis.
 * For untrusted input, prefer a strict length cap + this check.
 */
export function validateRegexSafety(
  pattern: string,
  maxLength = 200,
): { safe: boolean; reason?: string } {
  if (pattern.length > maxLength) {
    return { safe: false, reason: `Pattern exceeds max length (${pattern.length} > ${maxLength})` };
  }

  for (const dangerous of REDOS_PATTERNS) {
    if (dangerous.test(pattern)) {
      return { safe: false, reason: `Pattern contains potentially catastrophic construct: ${dangerous.source}` };
    }
  }

  // Try compiling to catch invalid regex syntax
  try {
    new RegExp(pattern);
  } catch (e) {
    return { safe: false, reason: `Invalid regex: ${(e as Error).message}` };
  }

  return { safe: true };
}

// ─── Prompt Injection Sanitization ────────────────────

/**
 * Zero-width and invisible Unicode characters that can be inserted
 * between letters to bypass text-matching sanitization.
 *
 * E.g., "System\u200B:" (zero-width space) visually looks like "System:"
 * but wouldn't match /System:/. Stripping these before matching prevents bypass.
 */
const INVISIBLE_CHARS = /[\u200B\u200C\u200D\u200E\u200F\uFEFF\u061C\u2060\u2061\u2062\u2063\u2064\u00AD]/g;

/**
 * Cyrillic homoglyphs that look identical to ASCII letters commonly used
 * in role markers. E.g., Cyrillic 'А' (U+0410) looks like ASCII 'A'.
 *
 * Map: Cyrillic → ASCII equivalent (for detection only, not display).
 */
const CYRILLIC_HOMOGLYPHS: Record<string, string> = {
  '\u0410': 'A', // А → A
  '\u0412': 'B', // В → B
  '\u0421': 'C', // С → C
  '\u0415': 'E', // Е → E
  '\u041D': 'H', // Н → H
  '\u041C': 'M', // М → M
  '\u041E': 'O', // О → O
  '\u0420': 'P', // Р → P
  '\u0422': 'T', // Т → T
  '\u0423': 'U', // У → U (close enough)
  '\u0405': 'S', // Ѕ → S (Cyrillic Komi)
  '\u0430': 'a', // а → a
  '\u0435': 'e', // е → e
  '\u043E': 'o', // о → o
  '\u0440': 'p', // р → p
  '\u0441': 'c', // с → c
  '\u0443': 'u', // у → u
  '\u0455': 's', // ѕ → s
  '\u0456': 'i', // і → i
  '\u04BB': 'h', // һ → h
};

const CYRILLIC_REGEX = new RegExp(`[${Object.keys(CYRILLIC_HOMOGLYPHS).join('')}]`, 'g');

/**
 * Strip role-switching patterns from untrusted content before it enters
 * the LLM context. Prevents prompt injection via:
 * - Role markers (Human:, User:, System:, Assistant:)
 * - XML role tags (<system>, </user>, etc.)
 * - HTML comments containing directives
 * - Numeric HTML entities (&#72; etc.)
 * - Zero-width Unicode characters inserted to break pattern matching
 * - Cyrillic homoglyphs that visually mimic ASCII role markers
 * - CRLF line endings (\r\n) normalized before matching
 *
 * Used by: project.ts, git.ts, outputLimits.ts, compactor.ts, obsidian.ts,
 *          prompt-builder.ts, loop.ts, skills/loader.ts, WebSearchTool.ts,
 *          memory/agent.ts
 */
export function sanitizeUntrustedContent(content: string): string {
  // Phase 1: Normalize line endings (Windows \r\n → \n) so \n-based patterns work
  let s = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Phase 2: Strip invisible/zero-width characters that break pattern matching
  s = s.replace(INVISIBLE_CHARS, '');

  // Phase 3: Replace Cyrillic homoglyphs with ASCII equivalents (for matching only)
  // We replace in a copy for detection, then remove the Cyrillic chars from the original
  // if they would form a role marker.
  // Simpler approach: just replace all Cyrillic homoglyphs in the actual content,
  // since they have no legitimate use in code/docs where they visually mimic ASCII.
  s = s.replace(CYRILLIC_REGEX, (ch) => CYRILLIC_HOMOGLYPHS[ch] ?? ch);

  // Phase 4: Strip HTML entities BEFORE role-marker checks (prevents &#72;uman: → Human:)
  s = s.replace(/&#x?[0-9a-f]+;/gi, '');

  // Phase 5: Role-switching markers at line start and string start
  s = s
    .replace(/\n(?:Human|User|Assistant|System):/gi, '\n[role-marker-removed]:')
    .replace(/^(?:Human|User|Assistant|System):/gi, '[role-marker-removed]:');

  // Phase 6: XML-style role tags (opening and closing)
  s = s.replace(/<\/?(?:system|user|assistant|human)[^>]*>/gi, '[role-tag-removed]');

  // Phase 7: HTML comments that could contain directives
  s = s.replace(/<!--[\s\S]*?-->/g, '[comment-removed]');

  return s;
}

// ─── IPv6-Mapped IPv4 Normalization ────────────────────

/**
 * Normalize IPv6-mapped IPv4 addresses to their bare IPv4 form.
 *
 * Examples:
 *   "::ffff:127.0.0.1" → "127.0.0.1"
 *   "::ffff:7f00:1"    → "127.0.0.1"  (hex-encoded form)
 *   "[::ffff:10.0.0.1]" → "10.0.0.1"
 *   "192.168.1.1"      → "192.168.1.1" (pass-through)
 *   "::1"              → "::1"          (pass-through)
 */
export function normalizeIPv6MappedIPv4(hostname: string): string {
  // Strip surrounding brackets from IPv6 addresses
  let h = hostname;
  if (h.startsWith('[') && h.endsWith(']')) {
    h = h.slice(1, -1);
  }

  // Check for ::ffff: prefix (dotted decimal form, e.g. ::ffff:127.0.0.1)
  const dottedMatch = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (dottedMatch) {
    return dottedMatch[1]!;
  }

  // Check for hex-encoded form: ::ffff:XXXX:XXXX (e.g. ::ffff:7f00:1)
  const hexMatch = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hexMatch) {
    const high = parseInt(hexMatch[1]!, 16);
    const low = parseInt(hexMatch[2]!, 16);
    return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
  }

  return h;
}

/**
 * Parse alternative IP representations to standard dotted-decimal form.
 * Detects: hex (0x7f000001), decimal (2130706433), octal (0177.0.0.1).
 * Returns the normalized IP or the original string if not a special encoding.
 */
export function normalizeIPNotation(hostname: string): string {
  // Hex IP: 0x7f000001 or 0x7F000001
  const hexIpMatch = hostname.match(/^0x([0-9a-f]{1,8})$/i);
  if (hexIpMatch) {
    const num = parseInt(hexIpMatch[1]!, 16);
    return `${(num >> 24) & 0xff}.${(num >> 16) & 0xff}.${(num >> 8) & 0xff}.${num & 0xff}`;
  }

  // Pure decimal IP: 2130706433
  if (/^\d{1,10}$/.test(hostname)) {
    const num = parseInt(hostname, 10);
    if (num >= 0 && num <= 0xffffffff) {
      return `${(num >> 24) & 0xff}.${(num >> 16) & 0xff}.${(num >> 8) & 0xff}.${num & 0xff}`;
    }
  }

  // Octal dotted notation: 0177.0.0.1
  if (/^0\d+(\.\d+){3}$/.test(hostname)) {
    const parts = hostname.split('.').map(p => parseInt(p, 8));
    if (parts.every(p => p >= 0 && p <= 255)) {
      return parts.join('.');
    }
  }

  return hostname;
}
