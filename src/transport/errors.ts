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
  maxRetries: 10,          // OpenClaude uses 10
  baseDelayMs: 500,        // OpenClaude uses 500ms base
  maxDelayMs: 32_000,      // OpenClaude caps at 32s
};

/** Max retries specifically for 529 (overloaded) before model fallback */
export const MAX_529_RETRIES = 3;

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  onRetry?: (attempt: number, error: Error, delayMs: number) => void,
): Promise<T> {
  let lastError: Error | null = null;
  let consecutive529s = 0;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const result = await fn(attempt);
      consecutive529s = 0; // Reset on success
      return result;
    } catch (error) {
      lastError = error as Error;

      if (error instanceof TransportError && !error.retryable) {
        throw error;
      }

      // Track consecutive 529s for model fallback signal
      if (error instanceof TransportError && error.statusCode === 529) {
        consecutive529s++;
        if (consecutive529s >= MAX_529_RETRIES) {
          // Signal that model fallback should be attempted
          throw new ModelFallbackError(
            `Server overloaded after ${MAX_529_RETRIES} consecutive 529 errors`,
            lastError,
          );
        }
      } else {
        consecutive529s = 0;
      }

      if (attempt === config.maxRetries) {
        throw error;
      }

      const delay = calculateBackoff(attempt, config, error as TransportError);
      onRetry?.(attempt, error as Error, delay);
      await sleep(delay);
    }
  }

  throw lastError;
}

// ─── Model Fallback Error ──────────────────────────────

export class ModelFallbackError extends Error {
  constructor(message: string, public readonly cause: Error) {
    super(message);
    this.name = 'ModelFallbackError';
  }
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

  // Exponential backoff with 25% jitter (OpenClaude pattern)
  const exponential = config.baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * config.baseDelayMs * 0.25;
  return Math.min(exponential + jitter, config.maxDelayMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
