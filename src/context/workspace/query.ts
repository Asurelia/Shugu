/**
 * Layer 5 — Context: Workspace query engine
 *
 * Hybrid search over the workspace index: filename + symbol + content matching.
 * Scores results and deduplicates by file+line.
 *
 * This is a SEPARATE tool from GrepTool. GrepTool does live lexical search;
 * this queries the pre-built index for faster, broader discovery.
 */

import type { IndexedFile, SymbolEntry, Chunk, IndexStore } from './store.js';

// ─── Query Types ────────────────────────────────────────

export interface SearchOpts {
  maxResults?: number;    // default 20
  fileGlob?: string;      // e.g. "*.ts"
  language?: string;       // e.g. "ts", "py"
  symbolOnly?: boolean;    // only search symbols, skip content
}

export interface SearchHit {
  path: string;
  line: number;
  score: number;
  matchType: 'symbol' | 'content' | 'filename';
  snippet: string;
}

// ─── Score Weights ──────────────────────────────────────

const WEIGHT_FILENAME = 3.0;
const WEIGHT_SYMBOL = 2.0;
const WEIGHT_CONTENT = 1.0;

// ─── Query Engine ───────────────────────────────────────

export class WorkspaceQueryEngine {
  private store: IndexStore;

  constructor(store: IndexStore) {
    this.store = store;
  }

  /**
   * Search the workspace index with a natural-language or keyword query.
   */
  async search(query: string, opts?: SearchOpts): Promise<SearchHit[]> {
    const maxResults = opts?.maxResults ?? 20;
    const terms = tokenize(query);
    if (terms.length === 0) return [];

    const files = await this.store.loadAll();
    const hits: SearchHit[] = [];

    for (const [filePath, file] of files) {
      // Language filter
      if (opts?.language && file.language !== opts.language) continue;

      // Glob filter (simple: check if filename matches pattern)
      if (opts?.fileGlob && !simpleGlobMatch(filePath, opts.fileGlob)) continue;

      // 1. Filename matching
      const filenameScore = scoreTermsAgainst(terms, filePath.toLowerCase());
      if (filenameScore > 0) {
        hits.push({
          path: filePath,
          line: 1,
          score: filenameScore * WEIGHT_FILENAME,
          matchType: 'filename',
          snippet: filePath,
        });
      }

      // 2. Symbol matching
      for (const sym of file.symbols) {
        const symScore = scoreTermsAgainst(terms, sym.name.toLowerCase());
        if (symScore > 0) {
          hits.push({
            path: filePath,
            line: sym.line,
            score: symScore * WEIGHT_SYMBOL,
            matchType: 'symbol',
            snippet: sym.signature ?? `${sym.kind} ${sym.name}`,
          });
        }
      }

      // 3. Content matching (skip if symbolOnly)
      if (!opts?.symbolOnly) {
        for (const chunk of file.chunks) {
          const contentScore = scoreTermsAgainst(terms, chunk.content.toLowerCase());
          if (contentScore > 0) {
            const snippetLine = findBestSnippetLine(chunk.content, terms);
            hits.push({
              path: filePath,
              line: chunk.startLine + snippetLine,
              score: contentScore * WEIGHT_CONTENT,
              matchType: 'content',
              snippet: extractSnippet(chunk.content, snippetLine, 3),
            });
          }
        }
      }
    }

    // Deduplicate: keep highest score per file+line
    const deduped = deduplicateHits(hits);

    // Sort by score descending, take top N
    return deduped
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  }

  /**
   * Find symbols by name (exact or prefix match).
   */
  async getSymbol(name: string): Promise<(SymbolEntry & { path: string })[]> {
    const files = await this.store.loadAll();
    const results: (SymbolEntry & { path: string })[] = [];
    const lowerName = name.toLowerCase();

    for (const [filePath, file] of files) {
      for (const sym of file.symbols) {
        if (sym.name.toLowerCase() === lowerName ||
            sym.name.toLowerCase().startsWith(lowerName)) {
          results.push({ ...sym, path: filePath });
        }
      }
    }

    // Exact matches first, then prefix matches
    return results.sort((a, b) => {
      const aExact = a.name.toLowerCase() === lowerName ? 0 : 1;
      const bExact = b.name.toLowerCase() === lowerName ? 0 : 1;
      return aExact - bExact;
    });
  }

  /**
   * Get info about a specific file from the index.
   */
  async getFileInfo(path: string): Promise<IndexedFile | null> {
    const files = await this.store.loadAll();
    return files.get(path) ?? null;
  }
}

// ─── Scoring Helpers ────────────────────────────────────

/**
 * Tokenize a query string into lowercase terms.
 */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s_\-./\\]+/)
    .filter((t) => t.length >= 2);
}

/**
 * Score how well terms match a target string.
 * Returns 0 if no terms match. Higher = better.
 */
function scoreTermsAgainst(terms: string[], target: string): number {
  let matched = 0;
  let totalScore = 0;

  for (const term of terms) {
    const idx = target.indexOf(term);
    if (idx !== -1) {
      matched++;
      // Bonus for matching at word boundary
      const prevChar = target[idx - 1] ?? '';
      const atBoundary = idx === 0 || /[\s_\-./\\]/.test(prevChar);
      totalScore += atBoundary ? 1.5 : 1.0;
    }
  }

  // Require at least one term to match
  if (matched === 0) return 0;

  // Bonus for matching more terms
  const coverage = matched / terms.length;
  return totalScore * (0.5 + 0.5 * coverage);
}

/**
 * Find the line in content that best matches the query terms.
 */
function findBestSnippetLine(content: string, terms: string[]): number {
  const lines = content.split('\n');
  let bestLine = 0;
  let bestScore = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const score = scoreTermsAgainst(terms, line.toLowerCase());
    if (score > bestScore) {
      bestScore = score;
      bestLine = i;
    }
  }

  return bestLine;
}

/**
 * Extract a snippet of context lines around a target line.
 */
function extractSnippet(content: string, targetLine: number, contextLines: number): string {
  const lines = content.split('\n');
  const start = Math.max(0, targetLine - contextLines);
  const end = Math.min(lines.length, targetLine + contextLines + 1);
  return lines.slice(start, end).join('\n').trim();
}

/**
 * Simple glob match for file paths.
 */
function simpleGlobMatch(path: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    return path.endsWith(pattern.slice(1));
  }
  if (pattern.startsWith('**/')) {
    return path.includes(pattern.slice(3));
  }
  return path.includes(pattern);
}

/**
 * Deduplicate hits: keep highest score per file+line combination.
 */
function deduplicateHits(hits: SearchHit[]): SearchHit[] {
  const seen = new Map<string, SearchHit>();

  for (const hit of hits) {
    const key = `${hit.path}:${hit.line}`;
    const existing = seen.get(key);
    if (!existing || hit.score > existing.score) {
      seen.set(key, hit);
    }
  }

  return Array.from(seen.values());
}
