/**
 * Layer 5 — Context: inline @file tag parser and expander.
 *
 * Users type  `Fix the bug in @src/foo.ts`  and this module
 * resolves the reference, reads the file, and injects content
 * into the conversation as `<file>` blocks.
 *
 * Supports optional line-range syntax:
 *   @src/foo.ts          → first N lines (tagLineLimit)
 *   @src/foo.ts:42       → line 42 only
 *   @src/foo.ts:10-20    → lines 10–20 inclusive
 */

import { readFile, stat, realpath } from 'node:fs/promises';
import { resolve, isAbsolute, relative, normalize } from 'node:path';
import { READ_LIMITS } from './read-limits.js';

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

export interface FileTag {
  /** Original text as it appeared in the user input, e.g. "@src/foo.ts:10-20" */
  raw: string;
  /** Absolute path after resolution against cwd */
  resolvedPath: string;
  /** Whether the file exists on disk */
  exists: boolean;
  /** Whether this tag was blocked (path outside workspace boundary) */
  blocked?: boolean;
  /** Optional line range parsed from the `:START-END` suffix */
  lineRange?: { start: number; end: number };
}

export interface FileTagOptions {
  /** Max lines to include per file when no explicit range is given */
  lineLimit: number;
  /** Hard cap on total lines across every @file in a single message */
  maxTotalLines: number;
}

/* ------------------------------------------------------------------ */
/*  Defaults & regex                                                   */
/* ------------------------------------------------------------------ */

const DEFAULT_OPTS: FileTagOptions = {
  lineLimit: READ_LIMITS.tagLineLimit,
  maxTotalLines: READ_LIMITS.tagMaxTotalLines,
};

/**
 * Regex: `@` followed by a path-like string that contains a dot-extension,
 * with an optional `:LINE` or `:LINE-LINE` suffix.
 *
 * Constraints:
 * - Must start with `.`, `/`, or a letter (avoids matching `@user` handles)
 * - Must contain at least one `.ext` segment (file extension)
 * - Stops at whitespace or another `@`
 */
const FILE_TAG_REGEX = /@(?=[./a-zA-Z])([^\s@]+\.[a-zA-Z0-9]+(?::\d+(?:-\d+)?)?)/g;

/* ------------------------------------------------------------------ */
/*  parseFileTags                                                      */
/* ------------------------------------------------------------------ */

/**
 * Synchronously extract every `@file` reference from `input`.
 *
 * Each match is resolved against `cwd` but existence is **not** checked
 * here (the caller or `expandFileTags` handles that).
 */
export function parseFileTags(input: string, cwd: string = process.cwd()): FileTag[] {
  const tags: FileTag[] = [];
  const seen = new Set<string>();

  // Reset regex state (global flag)
  FILE_TAG_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = FILE_TAG_REGEX.exec(input)) !== null) {
    const raw = match[0]!; // includes the leading @
    const body = match[1]!; // everything after @

    // Deduplicate identical raw references
    if (seen.has(raw)) continue;
    seen.add(raw);

    // Separate path from optional :LINE or :LINE-LINE
    let filePart = body;
    let lineRange: FileTag['lineRange'];

    const colonIdx = body.lastIndexOf(':');
    if (colonIdx !== -1) {
      const suffix = body.slice(colonIdx + 1);
      const rangeMatch = /^(\d+)(?:-(\d+))?$/.exec(suffix);
      if (rangeMatch) {
        filePart = body.slice(0, colonIdx);
        const start = Number(rangeMatch[1]);
        const end = rangeMatch[2] !== undefined ? Number(rangeMatch[2]) : start;
        lineRange = { start, end };
      }
    }

    const resolvedPath = isAbsolute(filePart) ? filePart : resolve(cwd, filePart);

    // Workspace boundary check: block paths that resolve outside cwd.
    // Normalizes backslashes on Windows and does case-insensitive check.
    const normalizedResolved = normalize(resolvedPath).toLowerCase();
    const normalizedCwd = normalize(cwd).toLowerCase();
    const isWithinBoundary = normalizedResolved.startsWith(normalizedCwd + (normalizedCwd.endsWith('/') || normalizedCwd.endsWith('\\') ? '' : '/'))
      || normalizedResolved.startsWith(normalizedCwd + '\\')
      || normalizedResolved === normalizedCwd;

    tags.push({
      raw,
      resolvedPath,
      exists: false, // caller or expandFileTags will fill this in
      blocked: !isWithinBoundary,
      lineRange,
    });
  }

  return tags;
}

/* ------------------------------------------------------------------ */
/*  expandFileTags                                                     */
/* ------------------------------------------------------------------ */

export interface ExpandResult {
  /** The user input with every @file replaced by a `<file>` block */
  expandedContent: string;
  /** Metadata for every tag found (includes non-existent files) */
  taggedFiles: FileTag[];
  /** True if any file's content was capped or skipped due to limits */
  truncated: boolean;
}

/**
 * Parse, read, and inline-expand every `@file` reference in `input`.
 *
 * For each existing file:
 *  - If a line range is given, extract exactly those lines (no cap).
 *  - Otherwise, take up to `opts.lineLimit` lines.
 *  - Track cumulative lines; once `opts.maxTotalLines` is reached the
 *    remaining files receive metadata-only placeholders.
 *  - Truncated files get a helpful hint about using `:START-END`.
 *
 * Non-existent files are replaced with an error note.
 */
export async function expandFileTags(
  input: string,
  cwd: string,
  opts?: Partial<FileTagOptions>,
): Promise<ExpandResult> {
  const merged: FileTagOptions = { ...DEFAULT_OPTS, ...opts };
  const tags = parseFileTags(input, cwd);

  // Fast path — nothing to expand
  if (tags.length === 0) {
    return { expandedContent: input, taggedFiles: [], truncated: false };
  }

  // Check existence for every tag
  await Promise.all(
    tags.map(async (tag) => {
      try {
        const s = await stat(tag.resolvedPath);
        tag.exists = s.isFile();
      } catch {
        tag.exists = false;
      }
    }),
  );

  let totalLinesUsed = 0;
  let truncated = false;

  // Build replacement map:  raw -> replacement string
  const replacements = new Map<string, string>();

  for (const tag of tags) {
    const relPath = relative(cwd, tag.resolvedPath);

    // Block paths outside workspace boundary
    if (tag.blocked) {
      replacements.set(tag.raw, `<file path="${relPath}">[blocked: path resolves outside workspace]</file>`);
      continue;
    }

    if (!tag.exists) {
      replacements.set(tag.raw, `<file path="${relPath}">[file not found: ${tag.resolvedPath}]</file>`);
      continue;
    }

    // Budget exhausted — metadata only
    if (totalLinesUsed >= merged.maxTotalLines) {
      truncated = true;
      replacements.set(
        tag.raw,
        `<file path="${relPath}">[skipped: total line budget (${merged.maxTotalLines}) reached]</file>`,
      );
      continue;
    }

    // Read file
    const content = await readFile(tag.resolvedPath, 'utf-8');
    const allLines = content.split('\n');
    const totalFileLines = allLines.length;

    let selected: string[];
    let fileWasTruncated = false;

    if (tag.lineRange) {
      // Explicit range — 1-based inclusive, but still subject to total budget
      const start = Math.max(0, tag.lineRange.start - 1);
      const end = Math.min(totalFileLines, tag.lineRange.end);
      const rangeLines = allLines.slice(start, end);
      const remainingBudget = merged.maxTotalLines - totalLinesUsed;
      if (remainingBudget <= 0) {
        truncated = true;
        replacements.set(
          tag.raw,
          `<file path="${relPath}">[skipped: total line budget (${merged.maxTotalLines}) reached]</file>`,
        );
        continue;
      }
      if (rangeLines.length > remainingBudget) {
        selected = rangeLines.slice(0, remainingBudget);
        fileWasTruncated = true;
        truncated = true;
      } else {
        selected = rangeLines;
      }
    } else {
      // Auto-limit
      const budget = Math.min(merged.lineLimit, merged.maxTotalLines - totalLinesUsed);
      if (budget <= 0) {
        truncated = true;
        replacements.set(
          tag.raw,
          `<file path="${relPath}">[skipped: total line budget (${merged.maxTotalLines}) reached]</file>`,
        );
        continue;
      }
      selected = allLines.slice(0, budget);
      if (selected.length < totalFileLines) {
        fileWasTruncated = true;
        truncated = true;
      }
    }

    totalLinesUsed += selected.length;

    let block = selected.join('\n');
    if (fileWasTruncated) {
      block += `\n[truncated: showing ${selected.length}/${totalFileLines} lines. Use @file:START-END for specific range]`;
    }

    replacements.set(tag.raw, `<file path="${relPath}">\n${block}\n</file>`);
  }

  // Apply replacements to the original input
  let expandedContent = input;
  for (const [raw, replacement] of replacements) {
    // Replace all occurrences (a user might reference the same file twice)
    expandedContent = expandedContent.split(raw).join(replacement);
  }

  return { expandedContent, taggedFiles: tags, truncated };
}
