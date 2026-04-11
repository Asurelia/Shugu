/**
 * Layer 5 — Context: Workspace indexer
 *
 * Walks the file tree, computes content hashes, extracts symbols,
 * chunks files, and persists everything to `.pcc/index/` via IndexStore.
 */

import { readdir, readFile, stat, lstat, realpath } from 'node:fs/promises';
import { join, relative, extname, normalize } from 'node:path';
import { createHash } from 'node:crypto';
import { IndexStore } from './store.js';
import type { IndexedFile, IndexMeta } from './store.js';
import { extractSymbols } from './symbols.js';
import { extToLanguage } from './symbols.js';
import { chunkFile } from './chunker.js';

// ─── Configuration ──────────────────────────────────────

export interface IndexStats {
  totalFiles: number;
  indexed: number;
  skipped: number;
  updated: number;
  durationMs: number;
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.pcc',
  '.next', '__pycache__', 'target', 'vendor',
]);

const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico',
  '.woff', '.woff2', '.ttf', '.eot',
  '.mp3', '.mp4', '.zip', '.tar', '.gz',
  '.lock', '.min.js', '.min.css',
  // Sensitive key material — never index
  '.pem', '.key', '.pfx', '.p12', '.jks',
  // Binaries
  '.exe', '.dll', '.so', '.dylib', '.o', '.a',
]);

const MAX_FILE_SIZE = 1_000_000; // 1MB

// ─── WorkspaceIndexer ───────────────────────────────────

export class WorkspaceIndexer {
  private store: IndexStore;
  private root: string;

  constructor(root: string) {
    this.root = root;
    this.store = new IndexStore(root);
  }

  /**
   * Full index of workspace. Compares hashes to skip unchanged files.
   */
  async indexWorkspace(): Promise<IndexStats> {
    const startTime = Date.now();

    // 1. Ensure .pcc/index/ exists
    await this.store.init();

    // 2. Load existing index
    const existing = await this.store.loadAll();

    // 3. Walk the file tree
    const discoveredPaths: string[] = [];
    await this.walkDirectory(this.root, discoveredPaths);

    // 4. Process files
    const newIndex = new Map<string, IndexedFile>();
    let indexed = 0;
    let skipped = 0;
    let updated = 0;

    for (const absPath of discoveredPaths) {
      const relPath = relative(this.root, absPath).replace(/\\/g, '/');

      try {
        const content = await readFile(absPath, 'utf-8');
        const hash = contentHash(content);

        // Check if unchanged
        const prev = existing.get(relPath);
        if (prev && prev.hash === hash) {
          // Reuse existing entry
          newIndex.set(relPath, prev);
          skipped++;
          continue;
        }

        // New or changed file — index it
        const fileStat = await stat(absPath);
        const ext = extname(absPath).toLowerCase();
        const language = extToLanguage(ext);
        const symbols = extractSymbols(content, language);
        const chunks = chunkFile(content);

        const entry: IndexedFile = {
          path: relPath,
          hash,
          mtime: fileStat.mtimeMs,
          size: fileStat.size,
          language,
          symbols,
          chunks,
        };

        newIndex.set(relPath, entry);
        if (prev) {
          updated++;
        } else {
          indexed++;
        }
      } catch {
        // Skip files that can't be read (binary, encoding issues, etc.)
        skipped++;
      }
    }

    // 5. Save the new index
    await this.store.saveAll(newIndex);
    await this.store.saveSymbols(newIndex);

    // 6. Save meta
    const meta: IndexMeta = {
      version: 1,
      lastSync: new Date().toISOString(),
      fileCount: newIndex.size,
      workspaceRoot: this.root,
    };
    await this.store.saveMeta(meta);

    return {
      totalFiles: discoveredPaths.length,
      indexed,
      skipped,
      updated,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Incremental update for specific paths (relative to workspace root).
   */
  async updatePaths(paths: string[]): Promise<void> {
    await this.store.init();
    const index = await this.store.loadAll();

    for (const relPath of paths) {
      const absPath = join(this.root, relPath);
      const ext = extname(absPath).toLowerCase();

      if (SKIP_EXTENSIONS.has(ext)) continue;
      if (shouldSkipByCompoundExtension(absPath)) continue;

      try {
        const fileStat = await stat(absPath);
        if (fileStat.size > MAX_FILE_SIZE) continue;

        const content = await readFile(absPath, 'utf-8');
        const hash = contentHash(content);

        const prev = index.get(relPath);
        if (prev && prev.hash === hash) continue;

        const language = extToLanguage(ext);
        const symbols = extractSymbols(content, language);
        const chunks = chunkFile(content);

        index.set(relPath, {
          path: relPath,
          hash,
          mtime: fileStat.mtimeMs,
          size: fileStat.size,
          language,
          symbols,
          chunks,
        });
      } catch {
        // If the file was deleted or unreadable, remove from index
        index.delete(relPath);
      }
    }

    await this.store.saveAll(index);
    await this.store.saveSymbols(index);

    const meta: IndexMeta = {
      version: 1,
      lastSync: new Date().toISOString(),
      fileCount: index.size,
      workspaceRoot: this.root,
    };
    await this.store.saveMeta(meta);
  }

  /**
   * Get the index store for querying.
   */
  getStore(): IndexStore {
    return this.store;
  }

  // ─── Private helpers ────────────────────────────────────

  private async walkDirectory(dir: string, out: string[]): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return; // Unreadable directory
    }

    const normalizedRoot = normalize(this.root).toLowerCase();

    for (const entry of entries) {
      // Skip hidden directories (except those we explicitly handle)
      if (SKIP_DIRS.has(entry)) continue;

      const absPath = join(dir, entry);

      // Check for symlinks first — use lstat() which doesn't follow symlinks
      let linkStat;
      try {
        linkStat = await lstat(absPath);
      } catch {
        continue; // Permission issue
      }

      // If it's a symlink, resolve its real target and verify it stays within workspace
      if (linkStat.isSymbolicLink()) {
        try {
          const realTarget = await realpath(absPath);
          const normalizedTarget = normalize(realTarget).toLowerCase();
          if (!normalizedTarget.startsWith(normalizedRoot)) {
            continue; // Symlink points outside workspace — skip
          }
        } catch {
          continue; // Broken symlink
        }
      }

      let fileStat;
      try {
        fileStat = await stat(absPath);
      } catch {
        continue; // Broken symlink or permission issue
      }

      if (fileStat.isDirectory()) {
        await this.walkDirectory(absPath, out);
      } else if (fileStat.isFile()) {
        // Skip large files
        if (fileStat.size > MAX_FILE_SIZE) continue;

        // Skip binary/asset extensions
        const ext = extname(entry).toLowerCase();
        if (SKIP_EXTENSIONS.has(ext)) continue;
        if (shouldSkipByCompoundExtension(entry)) continue;

        out.push(absPath);
      }
    }
  }
}

// ─── Utility functions ──────────────────────────────────

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Check for compound extensions like `.min.js`, `.min.css` that
 * aren't caught by the single-extension check.
 */
function shouldSkipByCompoundExtension(filename: string): boolean {
  return filename.endsWith('.min.js') || filename.endsWith('.min.css');
}
