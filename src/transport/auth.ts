/**
 * Layer 1 — Transport: Authentication
 *
 * Resolves the API key from environment variables.
 * Priority: MINIMAX_API_KEY > ANTHROPIC_AUTH_TOKEN > ANTHROPIC_API_KEY
 */

export interface AuthConfig {
  apiKey: string;
  baseUrl: string;
}

const DEFAULT_BASE_URL = 'https://api.minimax.io/anthropic/v1';

export function resolveAuth(): AuthConfig {
  const apiKey =
    process.env['MINIMAX_API_KEY'] ??
    process.env['ANTHROPIC_AUTH_TOKEN'] ??
    process.env['ANTHROPIC_API_KEY'] ??
    '';

  if (!apiKey) {
    throw new Error(
      'No API key found. Set MINIMAX_API_KEY, ANTHROPIC_AUTH_TOKEN, or ANTHROPIC_API_KEY.',
    );
  }

  const baseUrl =
    process.env['MINIMAX_BASE_URL'] ??
    process.env['ANTHROPIC_BASE_URL'] ??
    DEFAULT_BASE_URL;

  return { apiKey, baseUrl };
}
