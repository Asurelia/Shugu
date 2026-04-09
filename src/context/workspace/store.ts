/**
 * Layer 5 — Context: Workspace index storage
 *
 * JSONL-based persistent storage for the workspace index.
 * Stores indexed files, symbols, and metadata in `.pcc/index/`.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

// ─── Types ──────────────────────────────────────────────

export interface SymbolEntry {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'export';
  line: number;
  signature?: string;
}

export interface Chunk {
  id: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface IndexedFile {
  path: string;           // relative to workspace root
  hash: string;           // content hash (SHA-256 hex, first 16 chars)
  mtime: number;
  size: number;
  language: string;
  symbols: SymbolEntry[];
  chunks: Chunk[];
}

export interface IndexMeta {
  version: number;        // 1
  lastSync: string;       // ISO timestamp
  fileCount: number;
  workspaceRoot: string;
}

/** Flat symbol entry with file path for symbols.jsonl */
interface FlatSymbol {
  path: string;
  name: string;
  kind: SymbolEntry['kind'];
  line: number;
  signature?: string;
}

// ─── IndexStore ─────────────────────────────────────────

export class IndexStore {
  private indexDir: string;

  constructor(workspaceRoot: string) {
    this.indexDir = join(workspaceRoot, '.pcc', 'index');
  }

  /** Create .pcc/index/ directory if it doesn't exist. */
  async init(): Promise<void> {
    await mkdir(this.indexDir, { recursive: true });
  }

  /** Read meta.json, or null if it doesn't exist. */
  async getMeta(): Promise<IndexMeta | null> {
    try {
      const raw = await readFile(join(this.indexDir, 'meta.json'), 'utf-8');
      return JSON.parse(raw) as IndexMeta;
    } catch {
      return null;
    }
  }

  /** Write meta.json. */
  async saveMeta(meta: IndexMeta): Promise<void> {
    await writeFile(
      join(this.indexDir, 'meta.json'),
      JSON.stringify(meta, null, 2),
      'utf-8',
    );
  }

  /** Read files.jsonl into a Map keyed by relative path. Memory-efficient streaming. */
  async loadAll(): Promise<Map<string, IndexedFile>> {
    const map = new Map<string, IndexedFile>();
    const filePath = join(this.indexDir, 'files.jsonl');

    try {
      const stream = createReadStream(filePath, { encoding: 'utf-8' });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });

      for await (const line of rl) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          const entry = JSON.parse(trimmed) as IndexedFile;
          map.set(entry.path, entry);
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // File doesn't exist yet — return empty map
    }

    return map;
  }

  /** Write all indexed files to files.jsonl (one JSON object per line). */
  async saveAll(files: Map<string, IndexedFile>): Promise<void> {
    const lines: string[] = [];
    for (const entry of files.values()) {
      lines.push(JSON.stringify(entry));
    }
    await writeFile(
      join(this.indexDir, 'files.jsonl'),
      lines.join('\n') + (lines.length > 0 ? '\n' : ''),
      'utf-8',
    );
  }

  /** Read symbols.jsonl as a flat list of symbol entries with path. */
  async loadSymbols(): Promise<SymbolEntry[]> {
    const symbols: SymbolEntry[] = [];
    const filePath = join(this.indexDir, 'symbols.jsonl');

    try {
      const stream = createReadStream(filePath, { encoding: 'utf-8' });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });

      for await (const line of rl) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          const entry = JSON.parse(trimmed) as FlatSymbol;
          symbols.push({
            name: entry.name,
            kind: entry.kind,
            line: entry.line,
            signature: entry.signature,
          });
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // File doesn't exist yet — return empty array
    }

    return symbols;
  }

  /** Extract symbols from all indexed files and write symbols.jsonl. */
  async saveSymbols(files: Map<string, IndexedFile>): Promise<void> {
    const lines: string[] = [];
    for (const entry of files.values()) {
      for (const sym of entry.symbols) {
        const flat: FlatSymbol = {
          path: entry.path,
          name: sym.name,
          kind: sym.kind,
          line: sym.line,
          ...(sym.signature !== undefined ? { signature: sym.signature } : {}),
        };
        lines.push(JSON.stringify(flat));
      }
    }
    await writeFile(
      join(this.indexDir, 'symbols.jsonl'),
      lines.join('\n') + (lines.length > 0 ? '\n' : ''),
      'utf-8',
    );
  }
}
