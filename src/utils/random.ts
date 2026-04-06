/**
 * Shared random utilities.
 */

/** Pick a random element from a non-empty array. */
export function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}
