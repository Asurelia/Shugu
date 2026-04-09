/**
 * Layer 5 — Context: Symbol extraction
 *
 * Regex-based symbol extraction from source files.
 * Supports TypeScript, JavaScript, Python, Go, and Rust.
 */

import type { SymbolEntry } from './store.js';

// ─── Extension → language mapping ───────────────────────

const EXT_TO_LANG: Record<string, string> = {
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.jsx': 'jsx',
  '.py': 'py',
  '.go': 'go',
  '.rs': 'rs',
};

export function extToLanguage(ext: string): string {
  return EXT_TO_LANG[ext] ?? 'unknown';
}

// ─── Pattern definitions ────────────────────────────────

interface SymbolPattern {
  regex: RegExp;
  kind: SymbolEntry['kind'];
  /** Index of the capture group containing the symbol name. */
  nameGroup: number;
  /** Optional: index of the capture group for the full signature. */
  signatureGroup?: number;
}

const TS_PATTERNS: SymbolPattern[] = [
  // Named function declarations: (export )?(async )?function name
  {
    regex: /^[ \t]*(export\s+)?(async\s+)?function\s+(\w+)/,
    kind: 'function',
    nameGroup: 3,
    signatureGroup: 0,
  },
  // Arrow / function-expression: const name = (async )?(
  {
    regex: /^[ \t]*(export\s+)?const\s+(\w+)\s*=\s*(async\s+)?\(/,
    kind: 'function',
    nameGroup: 2,
  },
  // Class declarations
  {
    regex: /^[ \t]*(export\s+)?class\s+(\w+)/,
    kind: 'class',
    nameGroup: 2,
  },
  // Interface declarations
  {
    regex: /^[ \t]*(export\s+)?interface\s+(\w+)/,
    kind: 'interface',
    nameGroup: 2,
  },
  // Type alias declarations
  {
    regex: /^[ \t]*(export\s+)?type\s+(\w+)\s*[=<{]/,
    kind: 'type',
    nameGroup: 2,
  },
  // Named exports: export (default )?identifier
  {
    regex: /^[ \t]*export\s+(default\s+)?(\w+)/,
    kind: 'export',
    nameGroup: 2,
  },
];

const PY_PATTERNS: SymbolPattern[] = [
  {
    regex: /^[ \t]*def\s+(\w+)\s*\(/,
    kind: 'function',
    nameGroup: 1,
    signatureGroup: 0,
  },
  {
    regex: /^[ \t]*class\s+(\w+)/,
    kind: 'class',
    nameGroup: 1,
  },
];

const GO_PATTERNS: SymbolPattern[] = [
  // Method: func (receiver *Type) Name(
  {
    regex: /^func\s+\(\w+\s+\*?\w+\)\s+(\w+)\s*\(/,
    kind: 'function',
    nameGroup: 1,
    signatureGroup: 0,
  },
  // Free function: func Name(
  {
    regex: /^func\s+(\w+)\s*\(/,
    kind: 'function',
    nameGroup: 1,
    signatureGroup: 0,
  },
  // Struct type
  {
    regex: /^type\s+(\w+)\s+struct/,
    kind: 'type',
    nameGroup: 1,
  },
];

const RS_PATTERNS: SymbolPattern[] = [
  {
    regex: /^[ \t]*(pub\s+)?fn\s+(\w+)/,
    kind: 'function',
    nameGroup: 2,
    signatureGroup: 0,
  },
  {
    regex: /^[ \t]*(pub\s+)?struct\s+(\w+)/,
    kind: 'class',    // map struct → class kind
    nameGroup: 2,
  },
  {
    regex: /^[ \t]*(pub\s+)?trait\s+(\w+)/,
    kind: 'interface', // map trait → interface kind
    nameGroup: 2,
  },
  {
    regex: /^[ \t]*(pub\s+)?enum\s+(\w+)/,
    kind: 'type',      // map enum → type kind
    nameGroup: 2,
  },
];

function patternsForLanguage(language: string): SymbolPattern[] {
  switch (language) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
      return TS_PATTERNS;
    case 'py':
      return PY_PATTERNS;
    case 'go':
      return GO_PATTERNS;
    case 'rs':
      return RS_PATTERNS;
    default:
      return [];
  }
}

// ─── Public API ─────────────────────────────────────────

/**
 * Extract symbols from source code using regex-based heuristics.
 * Returns an empty array for unsupported languages.
 */
export function extractSymbols(content: string, language: string): SymbolEntry[] {
  const patterns = patternsForLanguage(language);
  if (patterns.length === 0) return [];

  const lines = content.split('\n');
  const symbols: SymbolEntry[] = [];
  /** Track names we've already recorded to avoid duplicates from overlapping patterns. */
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const pattern of patterns) {
      const match = pattern.regex.exec(line);
      if (!match) continue;

      const name = match[pattern.nameGroup];
      if (!name) continue;

      // Deduplicate: same name+line means overlapping patterns matched
      const key = `${name}:${i + 1}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Skip common false positives for TS export pattern
      if (pattern.kind === 'export') {
        // "export default" with no identifier, or keywords matched by earlier patterns
        if (['function', 'class', 'interface', 'type', 'const', 'let', 'var', 'async', 'abstract', 'enum'].includes(name)) {
          continue;
        }
      }

      const entry: SymbolEntry = {
        name,
        kind: pattern.kind,
        line: i + 1,  // 1-based
      };

      if (pattern.signatureGroup !== undefined) {
        const sig = match[pattern.signatureGroup];
        if (sig) {
          entry.signature = sig.trim();
        }
      }

      symbols.push(entry);
    }
  }

  return symbols;
}
