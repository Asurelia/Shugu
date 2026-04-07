/**
 * Brand Constants
 *
 * Single source of truth for the project identity.
 * Import from here instead of hardcoding strings.
 */

export const BRAND = {
  /** Display name */
  name: 'Shugu',

  /** CLI binary name */
  cli: 'shugu',

  /** npm package name */
  packageName: 'shugu',

  /** Config directory name under home (~/.shugu/) */
  configDir: '.pcc',  // Keep .pcc for backward compat, migrate later

  /** Current version */
  version: '0.2.0',

  /** Provider */
  provider: 'MiniMax',
} as const;
