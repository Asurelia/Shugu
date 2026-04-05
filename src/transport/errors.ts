/**
 * Layer 1 — Transport: Error handling & retry
 *
 * Exponential backoff with jitter, retry classification,
 * and structured error types.
 */

// ─── Error Types ────────────────────────────────────────

export class TransportError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number | null,
    public readonly retryable: boolean,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

export class RateLimitError extends TransportError {
  constructor(retryAfterMs: number) {
    super('Rate limited by API', 429, true, retryAfterMs);
    this.name = 'RateLimitError';
  }
}

export class ContextTooLongError extends TransportError {
  constructor(message: string) {
    super(message, 400, false);
    this.name = 'ContextTooLongError';
  }
}

export class AuthenticationError extends TransportError {
  constructor() {
    super('Invalid API key or authentication failed', 401, false);
    this.name = 'AuthenticationError';
  }
}

export class StreamTimeoutError extends TransportError {
  constructor(timeoutMs: number) {
    super(`Stream timed out after ${timeoutMs}ms`, null, true);
    this.name = 'StreamTimeoutError';
  }
}

// ─── Error Classification ───────────────────────────────

export function classifyHttpError(status: number, body: string): TransportError {
  if (status === 401 || status === 403) {
    return new AuthenticationError();
  }

  if (status === 429) {
    const retryAfter = parseRetryAfter(body);
    return new RateLimitError(retryAfter);
  }

  if (status === 400 && body.includes('prompt is too long')) {
    return new ContextTooLongError(body);
  }

  if (status === 529 || status === 503) {
    return new TransportError('Server overloaded', status, true, 5000);
  }

  if (status >= 500) {
    return new TransportError(`Server error: ${status}`, status, true, 2000);
  }

  return new TransportError(`API error ${status}: ${body}`, status, false);
}

function parseRetryAfter(body: string): number {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const headers = parsed['headers'] as Record<string, string> | undefined;
    if (headers?.['retry-after']) {
      return parseInt(headers['retry-after'], 10) * 1000;
    }
  } catch {
    // ignore
  }
  return 10_000; // Default 10s
}

// ─── Retry Logic ────────────────────────────────────────

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (error instanceof TransportError && !error.retryable) {
        throw error;
      }

      if (attempt === config.maxRetries) {
        throw error;
      }

      const delay = calculateBackoff(attempt, config, error as TransportError);
      await sleep(delay);
    }
  }

  throw lastError;
}

function calculateBackoff(
  attempt: number,
  config: RetryConfig,
  error?: TransportError,
): number {
  // Use server-specified retry-after if available
  if (error?.retryAfterMs) {
    return Math.min(error.retryAfterMs, config.maxDelayMs);
  }

  // Exponential backoff with jitter
  const exponential = config.baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * config.baseDelayMs;
  return Math.min(exponential + jitter, config.maxDelayMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
