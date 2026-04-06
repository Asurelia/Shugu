/**
 * Shared ANSI utilities.
 */

/** Visible length of a string after stripping ANSI escape sequences. */
export function visL(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}
