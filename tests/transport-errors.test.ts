/**
 * Tests for Layer 1 — Transport: Error classification & retry logic
 */

import { describe, it, expect, vi } from 'vitest';
import {
  TransportError,
  RateLimitError,
  ContextTooLongError,
  AuthenticationError,
  StreamTimeoutError,
  ModelFallbackError,
  classifyHttpError,
  withRetry,
  DEFAULT_RETRY_CONFIG,
} from '../src/transport/errors.js';

// ─── classifyHttpError ───────────────────────────────────

describe('classifyHttpError', () => {
  it('401 → AuthenticationError, non-retryable', () => {
    const err = classifyHttpError(401, '');
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err.retryable).toBe(false);
    expect(err.statusCode).toBe(401);
  });

  it('403 → AuthenticationError, non-retryable', () => {
    const err = classifyHttpError(403, '');
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err.retryable).toBe(false);
    expect(err.statusCode).toBe(401); // AuthenticationError always uses 401
  });

  it('429 with {"retry_after":5} → RateLimitError, retryable, default 10s delay', () => {
    // Note: parseRetryAfter looks for body.headers['retry-after'], not top-level retry_after
    // So this body falls back to the default 10_000ms
    const err = classifyHttpError(429, '{"retry_after":5}');
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryable).toBe(true);
    expect(err.statusCode).toBe(429);
    expect(err.retryAfterMs).toBe(10_000);
  });

  it('429 with headers.retry-after → RateLimitError with correct delay', () => {
    const body = JSON.stringify({ headers: { 'retry-after': '30' } });
    const err = classifyHttpError(429, body);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(30_000);
  });

  it('400 with "prompt is too long" → ContextTooLongError, non-retryable', () => {
    const err = classifyHttpError(400, 'prompt is too long');
    expect(err).toBeInstanceOf(ContextTooLongError);
    expect(err.retryable).toBe(false);
    expect(err.statusCode).toBe(400);
  });

  it('400 with "context window exceeds limit" → ContextTooLongError, non-retryable', () => {
    const err = classifyHttpError(400, 'context window exceeds limit');
    expect(err).toBeInstanceOf(ContextTooLongError);
    expect(err.retryable).toBe(false);
  });

  it('400 with generic body → plain TransportError, non-retryable', () => {
    // "context too long" does NOT match the known patterns
    const err = classifyHttpError(400, 'context too long');
    expect(err).toBeInstanceOf(TransportError);
    expect(err).not.toBeInstanceOf(ContextTooLongError);
    expect(err.retryable).toBe(false);
  });

  it('500 → TransportError, retryable', () => {
    const err = classifyHttpError(500, 'server error');
    expect(err).toBeInstanceOf(TransportError);
    expect(err.retryable).toBe(true);
    expect(err.statusCode).toBe(500);
  });

  it('503 → TransportError, retryable', () => {
    const err = classifyHttpError(503, '');
    expect(err).toBeInstanceOf(TransportError);
    expect(err.retryable).toBe(true);
    expect(err.statusCode).toBe(503);
  });

  it('529 → TransportError, retryable', () => {
    const err = classifyHttpError(529, '');
    expect(err).toBeInstanceOf(TransportError);
    expect(err.retryable).toBe(true);
    expect(err.statusCode).toBe(529);
  });
});

// ─── Error class properties ──────────────────────────────

describe('Error classes', () => {
  it('TransportError stores all fields', () => {
    const err = new TransportError('test', 500, true, 2000);
    expect(err.message).toBe('test');
    expect(err.statusCode).toBe(500);
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(2000);
    expect(err.name).toBe('TransportError');
  });

  it('RateLimitError has correct name and fields', () => {
    const err = new RateLimitError(5000);
    expect(err.name).toBe('RateLimitError');
    expect(err.statusCode).toBe(429);
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(5000);
  });

  it('ContextTooLongError has correct name and fields', () => {
    const err = new ContextTooLongError('too long');
    expect(err.name).toBe('ContextTooLongError');
    expect(err.statusCode).toBe(400);
    expect(err.retryable).toBe(false);
  });

  it('AuthenticationError has correct name and fields', () => {
    const err = new AuthenticationError();
    expect(err.name).toBe('AuthenticationError');
    expect(err.statusCode).toBe(401);
    expect(err.retryable).toBe(false);
  });

  it('StreamTimeoutError has correct name and fields', () => {
    const err = new StreamTimeoutError(3000);
    expect(err.name).toBe('StreamTimeoutError');
    expect(err.message).toBe('Stream timed out after 3000ms');
    expect(err.statusCode).toBeNull();
    expect(err.retryable).toBe(true);
  });

  it('ModelFallbackError stores cause', () => {
    const cause = new Error('original');
    const err = new ModelFallbackError('fallback needed', cause);
    expect(err.name).toBe('ModelFallbackError');
    expect(err.cause).toBe(cause);
  });
});

// ─── withRetry backoff ───────────────────────────────────

describe('withRetry', () => {
  it('returns result immediately on first success', async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const result = await withRetry(fn);
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable error and eventually succeeds', async () => {
    const retryableError = new TransportError('server error', 500, true);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(retryableError)
      .mockRejectedValueOnce(retryableError)
      .mockResolvedValue('ok');

    const result = await withRetry(fn, { maxRetries: 5, baseDelayMs: 1, maxDelayMs: 10 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  }, 10_000);

  it('throws immediately on non-retryable error', async () => {
    const nonRetryable = new AuthenticationError();
    const fn = vi.fn().mockRejectedValue(nonRetryable);

    await expect(withRetry(fn, { maxRetries: 5, baseDelayMs: 1, maxDelayMs: 10 })).rejects.toBeInstanceOf(
      AuthenticationError,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting all retries', async () => {
    const retryableError = new TransportError('persistent', 500, true);
    const fn = vi.fn().mockRejectedValue(retryableError);

    await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 10 })).rejects.toBeInstanceOf(
      TransportError,
    );
    expect(fn).toHaveBeenCalledTimes(3); // attempt 0, 1, 2
  }, 10_000);

  it('calls onRetry callback with increasing attempt numbers', async () => {
    const retryableError = new TransportError('flaky', 500, true);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(retryableError)
      .mockRejectedValueOnce(retryableError)
      .mockResolvedValue('done');

    const attempts: number[] = [];
    const onRetry = vi.fn((attempt: number) => attempts.push(attempt));

    await withRetry(fn, { maxRetries: 5, baseDelayMs: 1, maxDelayMs: 10 }, onRetry);

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(attempts[0]).toBe(0);
    expect(attempts[1]).toBe(1);
  }, 10_000);

  it('delay increases with attempt number (backoff)', async () => {
    const retryableError = new TransportError('flaky', 500, true, undefined);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(retryableError)
      .mockRejectedValueOnce(retryableError)
      .mockRejectedValueOnce(retryableError)
      .mockResolvedValue('done');

    const delays: number[] = [];
    const onRetry = vi.fn((_attempt: number, _error: Error, delayMs: number) => delays.push(delayMs));

    await withRetry(fn, { maxRetries: 10, baseDelayMs: 100, maxDelayMs: 32_000 }, onRetry);

    // Delay should grow with each retry (exponential backoff)
    // delay[0] ≈ 100 * 2^0 = 100ms, delay[1] ≈ 100 * 2^1 = 200ms, etc.
    expect(delays.length).toBe(3);
    expect(delays[1]).toBeGreaterThan(delays[0]);
    expect(delays[2]).toBeGreaterThan(delays[1]);
  }, 10_000);

  it('delay is capped at maxDelayMs', async () => {
    const retryableError = new TransportError('flaky', 500, true, undefined);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(retryableError)
      .mockRejectedValueOnce(retryableError)
      .mockResolvedValue('done');

    const delays: number[] = [];
    const onRetry = vi.fn((_attempt: number, _error: Error, delayMs: number) => delays.push(delayMs));

    // Use a very low cap
    await withRetry(fn, { maxRetries: 5, baseDelayMs: 1000, maxDelayMs: 5 }, onRetry);

    for (const d of delays) {
      expect(d).toBeLessThanOrEqual(5);
    }
  }, 10_000);

  it('uses retryAfterMs from error when available', async () => {
    const errorWithRetryAfter = new TransportError('rate limited', 429, true, 50);
    const fn = vi.fn().mockRejectedValueOnce(errorWithRetryAfter).mockResolvedValue('ok');

    const delays: number[] = [];
    const onRetry = vi.fn((_attempt: number, _error: Error, delayMs: number) => delays.push(delayMs));

    await withRetry(fn, { maxRetries: 5, baseDelayMs: 1, maxDelayMs: 1000 }, onRetry);

    expect(delays[0]).toBe(50);
  }, 10_000);

  it('throws ModelFallbackError after 3 consecutive 529s', async () => {
    const overloadedError = classifyHttpError(529, '');
    const fn = vi.fn().mockRejectedValue(overloadedError);

    await expect(
      withRetry(fn, { maxRetries: 10, baseDelayMs: 1, maxDelayMs: 10 }),
    ).rejects.toBeInstanceOf(ModelFallbackError);

    // Should fail after MAX_529_RETRIES (3) consecutive 529s
    expect(fn).toHaveBeenCalledTimes(3);
  }, 10_000);

  it('DEFAULT_RETRY_CONFIG has expected shape', () => {
    expect(DEFAULT_RETRY_CONFIG.maxRetries).toBe(10);
    expect(DEFAULT_RETRY_CONFIG.baseDelayMs).toBe(500);
    expect(DEFAULT_RETRY_CONFIG.maxDelayMs).toBe(32_000);
  });
});
