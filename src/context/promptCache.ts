/**
 * Layer 5 — Context: System prompt caching
 *
 * Ported from OpenClaude src/constants/systemPromptSections.ts pattern.
 *
 * System prompt sections are expensive to build (git context, vault reads,
 * file discovery). Most don't change between turns. This module caches
 * memoized sections and only recomputes volatile ones.
 *
 * Token savings: ~5-15K tokens per turn (avoids re-reading vault, git, project files).
 */

// ─── Prompt Section ────────────────────────────────────

export interface PromptSection {
  /** Unique key for this section */
  key: string;
  /** Function that produces the section content */
  compute: () => Promise<string>;
  /** Whether this section changes between turns (breaks cache) */
  volatile: boolean;
}

// ─── Cached Prompt Builder ─────────────────────────────

export class CachedPromptBuilder {
  private sections: PromptSection[] = [];
  private cache = new Map<string, string>();
  private lastFullPrompt: string = '';

  /**
   * Register a memoized section (cached until invalidated).
   */
  addMemoized(key: string, compute: () => Promise<string>): void {
    this.sections.push({ key, compute, volatile: false });
  }

  /**
   * Register a volatile section (recomputed every turn — breaks prompt cache).
   * Use sparingly.
   */
  addVolatile(key: string, compute: () => Promise<string>): void {
    this.sections.push({ key, compute, volatile: true });
  }

  /**
   * Build the full system prompt.
   * Memoized sections are read from cache; volatile sections are recomputed.
   */
  async build(): Promise<string> {
    const parts: string[] = [];

    for (const section of this.sections) {
      if (!section.volatile && this.cache.has(section.key)) {
        parts.push(this.cache.get(section.key)!);
        continue;
      }

      try {
        const content = await section.compute();
        if (!section.volatile) {
          this.cache.set(section.key, content);
        }
        parts.push(content);
      } catch {
        // Section computation failure is non-critical
        if (this.cache.has(section.key)) {
          parts.push(this.cache.get(section.key)!);
        }
      }
    }

    this.lastFullPrompt = parts.filter(Boolean).join('\n');
    return this.lastFullPrompt;
  }

  /**
   * Get the last built prompt without recomputing.
   */
  getLast(): string {
    return this.lastFullPrompt;
  }

  /**
   * Invalidate all cached sections.
   * Called on /clear and /compact.
   */
  invalidateAll(): void {
    this.cache.clear();
  }

  /**
   * Invalidate a specific section.
   */
  invalidate(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Get stats about the cache.
   */
  getStats(): { total: number; cached: number; volatile: number; promptLength: number } {
    return {
      total: this.sections.length,
      cached: this.cache.size,
      volatile: this.sections.filter(s => s.volatile).length,
      promptLength: this.lastFullPrompt.length,
    };
  }
}
