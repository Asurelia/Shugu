/**
 * Layer 5 — Context: File revert stack
 *
 * Tracks file changes made by tools (Write/Edit) so they can be
 * reverted per-turn via /file-revert.
 *
 * Architecture:
 *  - Hooks capture raw file content in the plugin layer (no session awareness)
 *  - The REPL layer groups changes by turn and pushes to this stack
 *  - /file-revert pops entries and restores files
 */

import { readFile, writeFile, unlink } from 'node:fs/promises';
import { logger } from '../../utils/logger.js';

// ─── Types ──────────────────────────────────────────────

export interface FileChange {
  path: string;
  type: 'create' | 'edit';
  /** Content before the tool ran. Null for newly created files. */
  previousContent: string | null;
}

export interface FileRevertEntry {
  turnIndex: number;
  timestamp: string;
  changes: FileChange[];
}

// ─── FileRevertStack ────────────────────────────────────

export class FileRevertStack {
  private entries: FileRevertEntry[] = [];
  private maxEntries: number;

  constructor(maxEntries: number = 50) {
    this.maxEntries = maxEntries;
  }

  push(entry: FileRevertEntry): void {
    this.entries.push(entry);
    // Evict oldest entries if over limit
    while (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
  }

  pop(): FileRevertEntry | undefined {
    return this.entries.pop();
  }

  peek(): FileRevertEntry | undefined {
    return this.entries[this.entries.length - 1];
  }

  list(limit: number = 10): FileRevertEntry[] {
    return this.entries.slice(-limit).reverse();
  }

  get size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
  }
}

// ─── Revert Logic ───────────────────────────────────────

export interface RevertResult {
  reverted: string[];
  failed: Array<{ path: string; error: string }>;
}

/**
 * Revert a single entry by restoring all files to their previous state.
 * For newly created files (previousContent === null), the file is deleted.
 */
export async function revertEntry(entry: FileRevertEntry): Promise<RevertResult> {
  const reverted: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];

  // Process in reverse order so nested edits are undone correctly
  for (const change of [...entry.changes].reverse()) {
    try {
      if (change.previousContent === null) {
        // File was created — delete it
        await unlink(change.path);
      } else {
        // File was edited — restore previous content
        await writeFile(change.path, change.previousContent, 'utf-8');
      }
      reverted.push(change.path);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to revert ${change.path}`, msg);
      failed.push({ path: change.path, error: msg });
    }
  }

  return { reverted, failed };
}

// ─── Pending Change Accumulator ─────────────────────────

/**
 * Accumulates file changes within a single turn.
 * The REPL creates one per turn and flushes it to the stack when the turn ends.
 */
export class TurnChangeAccumulator {
  private changes = new Map<string, FileChange>();

  /**
   * Record that a file is about to be modified.
   * Call this from the PreToolUse hook.
   */
  recordBefore(path: string, previousContent: string | null): void {
    // Only record the FIRST state — subsequent edits in the same turn
    // should still revert to the original state
    if (!this.changes.has(path)) {
      this.changes.set(path, {
        path,
        type: previousContent === null ? 'create' : 'edit',
        previousContent,
      });
    }
  }

  /**
   * Flush accumulated changes into a FileRevertEntry.
   * Returns null if no changes were recorded.
   */
  flush(turnIndex: number): FileRevertEntry | null {
    if (this.changes.size === 0) return null;

    const entry: FileRevertEntry = {
      turnIndex,
      timestamp: new Date().toISOString(),
      changes: Array.from(this.changes.values()),
    };

    this.changes.clear();
    return entry;
  }

  /** Whether any changes have been recorded this turn. */
  get hasChanges(): boolean {
    return this.changes.size > 0;
  }
}
