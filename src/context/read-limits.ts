/**
 * Layer 5 — Context: shared constants for file reading limits.
 *
 * Centralises every line-cap so FileReadTool and the @file-tag
 * expander stay in sync without magic numbers.
 */

export const READ_LIMITS = {
  /** Default line limit for the Read tool (FileReadTool) */
  defaultLineLimit: 2000,
  /** Default line limit per @file tag (tighter for multi-file) */
  tagLineLimit: 500,
  /** Maximum total lines across all @file tags in one message */
  tagMaxTotalLines: 3000,
} as const;
