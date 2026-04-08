/**
 * Layer 5 — Context: Unified Memory Agent
 *
 * Single coordinator for ALL memory operations in Shugu.
 * Replaces the fragmented system of MemoryStore + ObsidianVault + knowledge-hook + intelligence extraction.
 *
 * Architecture:
 * - Obsidian vault = source of truth (if available)
 * - index.json = fast local cache for prompt injection
 * - Extraction pipeline: regex hints (high confidence) + LLM extraction (medium confidence)
 * - Deduplication before save
 * - Per-turn relevance search (not just startup)
 *
 * Absorbs:
 * - context/memory/store.ts (MemoryStore) → replaced by index.json cache
 * - plugins/builtin/knowledge-hook.ts → regex detection integrated here
 * - automation/obsidian-agent.ts → maintenance() method
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ObsidianVault } from './obsidian.js';
import { detectMemoryHints, type MemoryCandidate } from './extract.js';
import { logger } from '../../utils/logger.js';
import { slugify } from '../../utils/strings.js';

// ─── Types ────────────────────────────────────────────

export interface MemoryItem {
  title: string;
  content: string;
  type: 'decision' | 'preference' | 'project_fact' | 'error_solution' | 'reference' | 'user_role';
  confidence: number;
  source: 'hint' | 'llm' | 'manual';
  tags: string[];
  timestamp: string;
  /** Path in Obsidian vault (if saved there) */
  vaultPath?: string;
}

interface MemoryIndex {
  version: number;
  lastSync: string;
  items: MemoryItem[];
}

// ─── Query Expansion (synonym/concept mapping) ──────

/**
 * Expand query terms with related concepts so "database" also matches
 * "postgresql", "mongodb", etc. Bidirectional: if query contains "postgres",
 * it also searches for "database".
 */
const TERM_GROUPS: string[][] = [
  ['database', 'db', 'sql', 'postgresql', 'postgres', 'mongodb', 'mongo', 'mysql', 'sqlite', 'supabase', 'prisma', 'drizzle'],
  ['auth', 'authentication', 'login', 'jwt', 'oauth', 'session', 'token', 'password', 'credential'],
  ['deploy', 'deployment', 'hosting', 'vercel', 'railway', 'netlify', 'aws', 'docker', 'ci/cd', 'pipeline'],
  ['test', 'testing', 'vitest', 'jest', 'playwright', 'cypress', 'e2e', 'unit test', 'coverage'],
  ['style', 'css', 'styling', 'tailwind', 'sass', 'scss', 'styled-components', 'design system'],
  ['cache', 'caching', 'redis', 'memcached', 'ttl', 'cdn', 'cloudfront'],
  ['search', 'searching', 'meilisearch', 'elasticsearch', 'algolia', 'full-text', 'fuzzy'],
  ['state', 'state management', 'zustand', 'redux', 'jotai', 'recoil', 'tanstack', 'context'],
  ['api', 'endpoint', 'rest', 'graphql', 'route', 'versioning', 'rate limit'],
  ['monitor', 'monitoring', 'logging', 'sentry', 'datadog', 'pino', 'observability', 'error tracking'],
  ['email', 'mail', 'resend', 'sendgrid', 'mailchimp', 'smtp', 'transactional'],
  ['upload', 'file upload', 'storage', 's3', 'blob', 'sharp', 'image processing'],
  ['feature flag', 'feature toggle', 'launchdarkly', 'unleash', 'rollout'],
  ['git', 'branch', 'commit', 'merge', 'pr', 'pull request', 'workflow'],
  ['format', 'formatting', 'indent', 'indentation', 'tabs', 'spaces', 'prettier', 'eslint', 'linter'],
  ['timezone', 'date', 'time', 'utc', 'date-fns', 'dayjs', 'moment'],
];

function expandQueryTerms(queryWords: string[]): string[] {
  const expanded = new Set(queryWords);

  for (const word of queryWords) {
    for (const group of TERM_GROUPS) {
      if (group.some(term => term.includes(word) || word.includes(term))) {
        // Add all terms from this group
        for (const term of group) {
          expanded.add(term);
        }
      }
    }
  }

  return [...expanded];
}

// ─── Sensitive Data Redaction ────────────────────────

const SECRET_PATTERNS: RegExp[] = [
  /\b(sk-[a-zA-Z0-9]{20,})/g,
  /\b(ghp_[a-zA-Z0-9]{36})/g,
  /\b(ghu_[a-zA-Z0-9]{36})/g,
  /\b(glpat-[a-zA-Z0-9\-]{20,})/g,
  /\b(xoxb-[a-zA-Z0-9\-]{20,})/g,
  /\b(AKIA[A-Z0-9]{16})/g,
  /Bearer\s+[a-zA-Z0-9._\-]{20,}/gi,
  /(?:mongodb|postgres|mysql|redis):\/\/[^\s"']+/gi,
  /(?:password|passwd|pwd|secret|token)\s*[=:]\s*['"]?[^\s'"]{8,}/gi,
];

export function redactSensitive(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(new RegExp(pattern.source, pattern.flags), '[REDACTED]');
  }
  return result;
}

export function isSuspiciousMemory(content: string): boolean {
  return redactSensitive(content) !== content;
}

// ─── Memory Agent ─────────────────────────────────────

export class MemoryAgent {
  private vault: ObsidianVault | null;
  private indexPath: string;
  private index: MemoryIndex;
  private dirty = false;

  constructor(vault: ObsidianVault | null, projectDir: string) {
    this.vault = vault;
    const pccDir = join(projectDir, '.pcc', 'memory');
    this.indexPath = join(pccDir, 'index.json');
    this.index = { version: 1, lastSync: new Date().toISOString(), items: [] };
  }

  // ─── Lifecycle ──────────────────────────────────────

  /** Load the index cache at startup. */
  async loadIndex(): Promise<void> {
    try {
      const raw = await readFile(this.indexPath, 'utf-8');
      const parsed = JSON.parse(raw) as MemoryIndex;
      if (parsed.version === 1 && Array.isArray(parsed.items)) {
        this.index = parsed;
      }
    } catch {
      // No index yet — start fresh
    }

    // Also load old MemoryStore .md files for migration
    await this.migrateOldMemories();
  }

  /** Persist the index to disk. */
  async flushIndex(): Promise<void> {
    if (!this.dirty) return;
    try {
      const dir = join(this.indexPath, '..');
      await mkdir(dir, { recursive: true });
      this.index.lastSync = new Date().toISOString();
      await writeFile(this.indexPath, JSON.stringify(this.index, null, 2), 'utf-8');
      this.dirty = false;
    } catch (err) {
      logger.debug('memory index flush failed', err instanceof Error ? err.message : String(err));
    }
  }

  // ─── Unified Extraction ─────────────────────────────

  /**
   * Extract memories from a user message using regex hints.
   * Called inline (synchronous, no LLM). For LLM extraction, use saveLLMExtracted().
   */
  extractHints(userMessage: string): MemoryItem[] {
    const candidates = detectMemoryHints(userMessage);
    return candidates.map(c => this.candidateToItem(c, 'hint'));
  }

  /**
   * Save memories extracted by the LLM intelligence layer.
   * Called from the post-turn intelligence callback.
   */
  async saveLLMExtracted(memories: Array<{ title: string; content: string }>): Promise<number> {
    let saved = 0;
    for (const mem of memories) {
      const item: MemoryItem = {
        title: mem.title,
        content: mem.content,
        type: this.classifyType(mem.content),
        confidence: 0.7,
        source: 'llm',
        tags: ['auto-extracted'],
        timestamp: new Date().toISOString(),
      };

      // Guard: reject memories containing secrets/PII
      if (isSuspiciousMemory(mem.content)) {
        logger.warn(`memory rejected — contains sensitive data: "${mem.title}"`);
        continue;
      }

      if (await this.save(item)) saved++;
    }
    return saved;
  }

  // ─── Unified Save (Obsidian-first + index cache) ────

  /**
   * Save a memory item. Deduplicates, saves to vault (if available), updates index.
   */
  async save(item: MemoryItem): Promise<boolean> {
    // Deduplicate: check if a similar memory already exists
    const existing = this.findSimilar(item.title, item.content);
    if (existing) {
      // Update existing if new confidence is higher
      if (item.confidence > existing.confidence) {
        existing.content = item.content;
        existing.confidence = item.confidence;
        existing.timestamp = item.timestamp;
        this.dirty = true;

        // Update in vault if it has a path
        if (this.vault && existing.vaultPath) {
          this.vault.updateNote(existing.vaultPath, {
            body: item.content,
            frontmatter: { confidence: item.confidence, updated: item.timestamp },
          }).catch(err => {
            logger.debug('vault update failed', err instanceof Error ? err.message : String(err));
          });
        }
      }
      return false; // Not a new memory
    }

    // Save to Obsidian vault (source of truth)
    if (this.vault) {
      try {
        const vaultPath = await this.vault.saveAgentNote(item.title,
          `${item.content}\n\n---\nconfidence: ${item.confidence} | source: ${item.source}`,
          { tags: item.tags, type: item.type },
        );
        item.vaultPath = vaultPath;
      } catch (err) {
        logger.debug('vault save failed', err instanceof Error ? err.message : String(err));
      }
    }

    // Add to index cache
    this.index.items.push(item);
    this.dirty = true;

    // Auto-flush (debounced — flush at end of turn via flushIndex())
    return true;
  }

  // ─── Contextual Search ──────────────────────────────

  /**
   * Get memories relevant to a query. Used for per-turn context injection.
   * Returns formatted string ready for system prompt.
   */
  async getRelevantContext(query: string, limit: number = 5): Promise<string> {
    const items = this.searchIndex(query, limit);

    // Also search vault if available (may have notes not in index)
    if (this.vault && query.length > 3) {
      try {
        const vaultResults = await this.vault.searchContent(query, limit);
        // Merge vault results that aren't already in our index
        for (const note of vaultResults) {
          const alreadyInIndex = items.some(i =>
            i.title === note.title || i.vaultPath === note.path
          );
          if (!alreadyInIndex && items.length < limit) {
            items.push({
              title: note.title,
              content: note.body.slice(0, 200),
              type: 'project_fact',
              confidence: 0.5,
              source: 'manual',
              tags: note.tags,
              timestamp: (note.frontmatter['created'] as string) ?? new Date().toISOString(),
              vaultPath: note.path,
            });
          }
        }
      } catch {
        // Vault search failure is non-critical
      }
    }

    if (items.length === 0) return '';

    const lines = items.map(m =>
      `- [${m.type}] ${m.title}: ${m.content.slice(0, 150)}`
    );
    return `\n\n# Relevant memories\n${lines.join('\n')}`;
  }

  /**
   * Get ALL memories formatted for startup injection (no query filter).
   */
  getStartupContext(): string {
    if (this.index.items.length === 0) return '';
    // Return top 10 most recent, sorted by timestamp
    const recent = [...this.index.items]
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, 10);
    const lines = recent.map(m =>
      `- [${m.type}] ${m.title}: ${m.content.slice(0, 150)}`
    );
    return `\n\n# Memories from previous sessions\n${lines.join('\n')}`;
  }

  // ─── Maintenance (absorbs obsidian-agent.ts) ────────

  /**
   * Run vault maintenance: schema, archive stale, generate digest.
   * Safe to call frequently — idempotent.
   */
  async maintenance(): Promise<{ archived: number; digestCreated: boolean }> {
    if (!this.vault) return { archived: 0, digestCreated: false };

    let archived = 0;
    let digestCreated = false;

    try {
      // Archive stale notes (>30 days)
      const staleNotes = await this.vault.getStaleNotes(30);
      for (const note of staleNotes) {
        try {
          await this.vault.archiveNote(note.path);
          // Remove from index
          this.index.items = this.index.items.filter(i => i.vaultPath !== note.path);
          this.dirty = true;
          archived++;
        } catch {
          // Skip individual archive failures
        }
      }

      if (archived > 0) {
        logger.debug(`memory agent: archived ${archived} stale notes`);
      }
    } catch (err) {
      logger.debug('maintenance archive failed', err instanceof Error ? err.message : String(err));
    }

    // Flush index after maintenance
    await this.flushIndex();

    return { archived, digestCreated };
  }

  /** Get the number of memories in the index. */
  get count(): number {
    return this.index.items.length;
  }

  // ─── Private Helpers ────────────────────────────────

  private candidateToItem(c: MemoryCandidate, source: 'hint' | 'llm'): MemoryItem {
    const typeMap: Record<string, MemoryItem['type']> = {
      user: 'user_role',
      feedback: 'preference',
      project: 'project_fact',
      reference: 'reference',
    };
    return {
      title: c.name,
      content: c.content,
      type: typeMap[c.type] ?? 'project_fact',
      confidence: c.confidence,
      source,
      tags: [c.type, 'auto-extracted'],
      timestamp: new Date().toISOString(),
    };
  }

  private classifyType(content: string): MemoryItem['type'] {
    const lower = content.toLowerCase();
    if (lower.includes('decided') || lower.includes('chose') || lower.includes('because')) return 'decision';
    if (lower.includes('prefer') || lower.includes("don't") || lower.includes('always') || lower.includes('never')) return 'preference';
    if (lower.includes('error') || lower.includes('fix') || lower.includes('bug')) return 'error_solution';
    if (lower.includes('http') || lower.includes('url') || lower.includes('docs') || lower.includes('api')) return 'reference';
    return 'project_fact';
  }

  private findSimilar(title: string, content: string): MemoryItem | undefined {
    const titleSlug = slugify(title);
    return this.index.items.find(item => {
      // Exact title match
      if (slugify(item.title) === titleSlug) return true;
      // High content overlap (first 100 chars)
      if (item.content.slice(0, 100) === content.slice(0, 100)) return true;
      return false;
    });
  }

  private searchIndex(query: string, limit: number): MemoryItem[] {
    if (!query || this.index.items.length === 0) {
      return this.index.items.slice(0, limit);
    }

    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (queryWords.length === 0) return this.index.items.slice(0, limit);

    // Expand query with related terms (synonyms, tools, concepts)
    const expanded = expandQueryTerms(queryWords);

    const scored = this.index.items.map(item => {
      const titleLower = item.title.toLowerCase();
      const contentLower = item.content.toLowerCase();
      const tagsLower = item.tags.join(' ').toLowerCase();
      let score = 0;

      for (const word of expanded) {
        // Title match (strongest signal — title IS the summary)
        if (titleLower.includes(word)) score += 3;
        // Tag match (structured metadata)
        if (tagsLower.includes(word)) score += 2;
        // Content match
        if (contentLower.includes(word)) score += 1;
      }

      // Prefix/substring matching: "auth" matches "authentication", "db" matches "database"
      for (const word of queryWords) {
        if (word.length >= 3) {
          if (titleLower.includes(word) || contentLower.includes(word)) {
            // Already counted above, but boost partial matches in content
          }
          // Check if any content word STARTS with the query word (prefix match)
          const contentWords = contentLower.split(/\s+/);
          for (const cw of contentWords) {
            if (cw.startsWith(word) && cw !== word) score += 0.5;
          }
        }
      }

      // Boost recent items
      const ageMs = Date.now() - new Date(item.timestamp).getTime();
      const recencyBoost = Math.max(0, 1 - ageMs / (30 * 86_400_000));
      score += recencyBoost * 0.5;

      return { item, score };
    });

    return scored
      .filter(s => s.score > 0.5) // Require meaningful match
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.item);
  }

  /**
   * Migrate old MemoryStore .md files into the index (one-time).
   */
  private async migrateOldMemories(): Promise<void> {
    const oldDir = join(this.indexPath, '..');
    try {
      const { readdir } = await import('node:fs/promises');
      const files = await readdir(oldDir);
      for (const file of files) {
        if (!file.endsWith('.md') || file === 'MEMORY.md') continue;
        try {
          const content = await readFile(join(oldDir, file), 'utf-8');
          // Parse YAML frontmatter
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
          if (!fmMatch) continue;

          const fm = fmMatch[1] ?? '';
          const body = (fmMatch[2] ?? '').trim();
          const nameMatch = fm.match(/name:\s*(.+)/);
          const typeMatch = fm.match(/type:\s*(.+)/);

          if (nameMatch && body) {
            const alreadyExists = this.index.items.some(i => slugify(i.title) === slugify(nameMatch[1]!.trim()));
            if (!alreadyExists) {
              this.index.items.push({
                title: nameMatch[1]!.trim(),
                content: body.slice(0, 500),
                type: (typeMatch?.[1]?.trim() as MemoryItem['type']) ?? 'project_fact',
                confidence: 0.6,
                source: 'manual',
                tags: ['migrated'],
                timestamp: new Date().toISOString(),
              });
              this.dirty = true;
            }
          }
        } catch {
          // Skip unparseable files
        }
      }
    } catch {
      // Old dir doesn't exist — nothing to migrate
    }
  }
}
