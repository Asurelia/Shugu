/**
 * Layer 5 — Context: File chunking
 *
 * Splits source files into overlapping chunks at natural code boundaries
 * (blank lines) for search scoring and context retrieval.
 */

import type { Chunk } from './store.js';

export interface ChunkOptions {
  maxChunkLines: number;   // default 50
  overlapLines: number;    // default 5
}

const DEFAULT_OPTIONS: ChunkOptions = {
  maxChunkLines: 50,
  overlapLines: 5,
};

/**
 * Chunk file content into overlapping segments.
 *
 * Strategy:
 * 1. Split at blank-line boundaries to respect natural code structure.
 * 2. Merge consecutive segments until they'd exceed maxChunkLines.
 * 3. If a single segment exceeds maxChunkLines, hard-split with overlap.
 * 4. Each chunk gets an ID: `${startLine}-${endLine}` (1-based).
 */
export function chunkFile(content: string, options?: Partial<ChunkOptions>): Chunk[] {
  const opts: ChunkOptions = { ...DEFAULT_OPTIONS, ...options };
  const lines = content.split('\n');

  if (lines.length === 0) return [];

  // Step 1: Find natural segments separated by blank lines
  const segments: Array<{ startLine: number; endLine: number }> = [];
  let segStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const isBlank = lines[i]!.trim().length === 0;
    const isLast = i === lines.length - 1;

    if (isBlank || isLast) {
      // End of a segment (include the current line)
      const endIdx = isLast ? i : i;
      if (endIdx >= segStart) {
        segments.push({ startLine: segStart, endLine: endIdx });
      }
      segStart = i + 1;
    }
  }

  // Handle edge case: no blank lines found
  if (segments.length === 0) {
    segments.push({ startLine: 0, endLine: lines.length - 1 });
  }

  // Step 2: Merge segments into chunks respecting maxChunkLines
  const chunks: Chunk[] = [];
  let chunkStartLine = segments[0]!.startLine;
  let chunkEndLine = segments[0]!.endLine;

  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i]!;
    const mergedLength = seg.endLine - chunkStartLine + 1;

    if (mergedLength <= opts.maxChunkLines) {
      // Merge this segment into the current chunk
      chunkEndLine = seg.endLine;
    } else {
      // Emit current chunk, start a new one
      emitChunk(chunks, lines, chunkStartLine, chunkEndLine, opts);
      // New chunk starts with overlap from the end of previous chunk
      const overlapStart = Math.max(seg.startLine, chunkEndLine - opts.overlapLines + 1);
      chunkStartLine = overlapStart;
      chunkEndLine = seg.endLine;
    }
  }

  // Emit the final chunk
  emitChunk(chunks, lines, chunkStartLine, chunkEndLine, opts);

  return chunks;
}

/**
 * Emit a chunk, hard-splitting if it exceeds maxChunkLines.
 */
function emitChunk(
  chunks: Chunk[],
  lines: string[],
  startLine: number,
  endLine: number,
  opts: ChunkOptions,
): void {
  const length = endLine - startLine + 1;

  if (length <= opts.maxChunkLines) {
    chunks.push(makeChunk(lines, startLine, endLine));
  } else {
    // Hard split with overlap
    let pos = startLine;
    while (pos <= endLine) {
      const chunkEnd = Math.min(pos + opts.maxChunkLines - 1, endLine);
      chunks.push(makeChunk(lines, pos, chunkEnd));

      if (chunkEnd >= endLine) break;
      pos = chunkEnd - opts.overlapLines + 1;
      // Prevent infinite loop if overlapLines >= maxChunkLines
      if (pos <= startLine + (chunks.length > 1 ? 0 : -1)) {
        pos = chunkEnd + 1;
      }
    }
  }
}

/**
 * Build a Chunk object from line range (0-based indices).
 * The chunk ID and reported lines are 1-based.
 */
function makeChunk(lines: string[], startLine: number, endLine: number): Chunk {
  const start1 = startLine + 1; // 1-based
  const end1 = endLine + 1;     // 1-based
  const content = lines.slice(startLine, endLine + 1).join('\n');

  return {
    id: `${start1}-${end1}`,
    startLine: start1,
    endLine: end1,
    content,
  };
}
