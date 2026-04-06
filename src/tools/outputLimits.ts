/**
 * Layer 3 — Tools: Output limits & disk spill
 *
 * Ported from OpenClaude src/constants/toolLimits.ts + src/utils/shell/outputLimits.ts
 *
 * Prevents token explosion from large tool outputs:
 * - Per-tool result: 50K chars max
 * - Per-message aggregate: 200K chars max
 * - Bash output: 30K chars max
 *
 * When a result exceeds limits, it's truncated with a clear marker.
 * For very large results, the full content is written to a temp file
 * and replaced with a preview + file path.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolResult } from '../protocol/tools.js';

// ─── Limits (from OpenClaude toolLimits.ts) ────────────

/** Max chars per individual tool result */
export const MAX_RESULT_CHARS = 50_000;

/** Max aggregate chars across all tool results in one message */
export const MAX_RESULTS_PER_MESSAGE_CHARS = 200_000;

/** Max chars for Bash stdout/stderr */
export const BASH_MAX_OUTPUT_CHARS = 30_000;

/** Max chars for Bash stderr specifically */
export const BASH_MAX_STDERR_CHARS = 5_000;

/** Preview size when spilling to disk */
const SPILL_PREVIEW_CHARS = 2_000;

// ─── Single Result Truncation ──────────────────────────

/**
 * Truncate a single tool result if it exceeds MAX_RESULT_CHARS.
 * Returns the (potentially truncated) result.
 */
export function truncateToolResult(result: ToolResult): ToolResult {
  const content = typeof result.content === 'string'
    ? result.content
    : JSON.stringify(result.content);

  if (content.length <= MAX_RESULT_CHARS) return result;

  const truncated = content.slice(0, MAX_RESULT_CHARS);
  const droppedChars = content.length - MAX_RESULT_CHARS;

  return {
    ...result,
    content: `${truncated}\n\n[TRUNCATED — ${droppedChars.toLocaleString()} chars omitted. Full output: ${content.length.toLocaleString()} chars total]`,
  };
}

// ─── Message-Level Aggregate Limiting ──────────────────

/**
 * Enforce the per-message aggregate limit on a batch of tool results.
 * If the total exceeds MAX_RESULTS_PER_MESSAGE_CHARS, the largest results
 * are spilled to temp files and replaced with previews.
 *
 * Returns the (potentially modified) results array.
 */
export async function enforceMessageLimit(results: ToolResult[]): Promise<ToolResult[]> {
  // First, truncate each individual result
  let processed = results.map(truncateToolResult);

  // Check aggregate
  let totalChars = processed.reduce((sum, r) => {
    const content = typeof r.content === 'string' ? r.content : JSON.stringify(r.content);
    return sum + content.length;
  }, 0);

  if (totalChars <= MAX_RESULTS_PER_MESSAGE_CHARS) return processed;

  // Need to spill — sort by size descending, spill largest first
  const indexed = processed.map((r, i) => {
    const content = typeof r.content === 'string' ? r.content : JSON.stringify(r.content);
    return { result: r, index: i, size: content.length };
  });
  indexed.sort((a, b) => b.size - a.size);

  for (const entry of indexed) {
    if (totalChars <= MAX_RESULTS_PER_MESSAGE_CHARS) break;

    const content = typeof entry.result.content === 'string'
      ? entry.result.content
      : JSON.stringify(entry.result.content);

    if (content.length < 1000) continue; // Don't spill tiny results

    // Spill to temp file
    const spillPath = await spillToDisk(content, entry.result.tool_use_id);
    const preview = content.slice(0, SPILL_PREVIEW_CHARS);

    const replacement: ToolResult = {
      ...entry.result,
      content: `${preview}\n\n[OUTPUT SPILLED TO DISK — ${content.length.toLocaleString()} chars total]\nFull output saved to: ${spillPath}\nUse Read tool to access the full content.`,
    };

    totalChars -= content.length;
    totalChars += (typeof replacement.content === 'string' ? replacement.content : JSON.stringify(replacement.content)).length;

    processed[entry.index] = replacement;
  }

  return processed;
}

// ─── Bash-specific limits ──────────────────────────────

/**
 * Truncate bash stdout and stderr to their respective limits.
 * Returns truncated strings with markers.
 */
export function truncateBashOutput(
  stdout: string,
  stderr: string,
): { stdout: string; stderr: string; stdoutTruncated: boolean; stderrTruncated: boolean } {
  let stdoutTruncated = false;
  let stderrTruncated = false;

  let out = stdout;
  if (out.length > BASH_MAX_OUTPUT_CHARS) {
    out = out.slice(0, BASH_MAX_OUTPUT_CHARS);
    stdoutTruncated = true;
  }

  let err = stderr;
  if (err.length > BASH_MAX_STDERR_CHARS) {
    err = err.slice(0, BASH_MAX_STDERR_CHARS);
    stderrTruncated = true;
  }

  return { stdout: out, stderr: err, stdoutTruncated, stderrTruncated };
}

// ─── Disk Spill ────────────────────────────────────────

let spillDir: string | null = null;

async function getSpillDir(): Promise<string> {
  if (!spillDir) {
    spillDir = join(tmpdir(), 'pcc-spill');
    await mkdir(spillDir, { recursive: true });
  }
  return spillDir;
}

async function spillToDisk(content: string, toolId: string): Promise<string> {
  const dir = await getSpillDir();
  const filename = `${toolId}-${Date.now()}.txt`;
  const filePath = join(dir, filename);
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}
