/**
 * Tests for Layer 1 — Transport: Circuit Breaker
 *
 * Uses a manually-advanced clock (injected into the constructor) so state
 * transitions are deterministic without vi.useFakeTimers().
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CircuitBreaker,
  CircuitOpenError,
  DEFAULT_BREAKER_CONFIG,
  getBreaker,
  getAllBreakerStats,
  __resetBreakersForTests,
} from '../src/transport/breaker.js';

function makeBreaker(overrides: Partial<typeof DEFAULT_BREAKER_CONFIG> = {}) {
  let time = 0;
  const now = () => time;
  const advance = (ms: number) => {
    time += ms;
  };
  const breaker = new CircuitBreaker(
    'https://example.test/messages',
    { ...DEFAULT_BREAKER_CONFIG, ...overrides },
    now,
  );
  return { breaker, advance };
}

describe('CircuitBreaker', () => {
  it('starts CLOSED and lets calls through', async () => {
    const { breaker } = makeBreaker();
    expect(breaker.getState()).toBe('closed');

    const result = await breaker.execute(async () => 42);
    expect(result).toBe(42);
    expect(breaker.getState()).toBe('closed');
  });

  it('stays CLOSED while failures stay under threshold', async () => {
    const { breaker } = makeBreaker({ failureThreshold: 5 });

    for (let i = 0; i < 4; i++) {
      await expect(breaker.execute(async () => {
        throw new Error('boom');
      })).rejects.toThrow('boom');
    }

    expect(breaker.getState()).toBe('closed');
  });

  it('trips OPEN after threshold failures within the window', async () => {
    const { breaker } = makeBreaker({ failureThreshold: 5, windowMs: 60_000 });

    for (let i = 0; i < 5; i++) {
      await expect(breaker.execute(async () => {
        throw new Error('boom');
      })).rejects.toThrow('boom');
    }

    expect(breaker.getState()).toBe('open');
  });

  it('throws CircuitOpenError immediately when OPEN, without calling fn', async () => {
    const { breaker } = makeBreaker({ failureThreshold: 2 });

    await expect(breaker.execute(async () => { throw new Error('a'); })).rejects.toThrow('a');
    await expect(breaker.execute(async () => { throw new Error('b'); })).rejects.toThrow('b');

    expect(breaker.getState()).toBe('open');

    let called = false;
    await expect(breaker.execute(async () => {
      called = true;
      return 1;
    })).rejects.toBeInstanceOf(CircuitOpenError);
    expect(called).toBe(false);
  });

  it('CircuitOpenError reports remaining cooldown', async () => {
    const { breaker, advance } = makeBreaker({ failureThreshold: 1, cooldownMs: 30_000 });

    await expect(breaker.execute(async () => { throw new Error('b'); })).rejects.toThrow('b');
    advance(10_000);

    try {
      await breaker.execute(async () => 1);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CircuitOpenError);
      expect((err as CircuitOpenError).retryAfterMs).toBe(20_000);
    }
  });

  it('promotes to HALF_OPEN after cooldown, and CLOSES on successful probe', async () => {
    const { breaker, advance } = makeBreaker({ failureThreshold: 2, cooldownMs: 30_000 });

    await expect(breaker.execute(async () => { throw new Error('a'); })).rejects.toThrow();
    await expect(breaker.execute(async () => { throw new Error('b'); })).rejects.toThrow();
    expect(breaker.getState()).toBe('open');

    advance(30_000);
    // getState() triggers promotion check
    expect(breaker.getState()).toBe('half_open');

    // Successful probe closes the circuit
    const result = await breaker.execute(async () => 'ok');
    expect(result).toBe('ok');
    expect(breaker.getState()).toBe('closed');
  });

  it('failing HALF_OPEN probe re-opens with fresh cooldown', async () => {
    const { breaker, advance } = makeBreaker({
      failureThreshold: 2,
      cooldownMs: 30_000,
    });

    // Open
    await expect(breaker.execute(async () => { throw new Error('x'); })).rejects.toThrow();
    await expect(breaker.execute(async () => { throw new Error('x'); })).rejects.toThrow();
    expect(breaker.getState()).toBe('open');

    advance(30_000);
    // Half-open probe fails
    await expect(breaker.execute(async () => { throw new Error('probe fail'); })).rejects.toThrow('probe fail');
    expect(breaker.getState()).toBe('open');

    // Cooldown reset — must wait the full cooldown again
    advance(29_000);
    expect(breaker.getState()).toBe('open');

    advance(1_000);
    expect(breaker.getState()).toBe('half_open');
  });

  it('drops old failures outside the window', async () => {
    const { breaker, advance } = makeBreaker({ failureThreshold: 3, windowMs: 10_000 });

    await expect(breaker.execute(async () => { throw new Error('a'); })).rejects.toThrow();
    advance(5_000);
    await expect(breaker.execute(async () => { throw new Error('b'); })).rejects.toThrow();
    advance(6_000); // first failure now outside window
    await expect(breaker.execute(async () => { throw new Error('c'); })).rejects.toThrow();

    // Only 2 failures within the last 10s → still CLOSED
    expect(breaker.getState()).toBe('closed');
  });

  it('success mid-stream resets the failure window', async () => {
    const { breaker } = makeBreaker({ failureThreshold: 3 });

    await expect(breaker.execute(async () => { throw new Error('a'); })).rejects.toThrow();
    await expect(breaker.execute(async () => { throw new Error('b'); })).rejects.toThrow();
    await breaker.execute(async () => 'ok'); // success
    await expect(breaker.execute(async () => { throw new Error('c'); })).rejects.toThrow();
    await expect(breaker.execute(async () => { throw new Error('d'); })).rejects.toThrow();

    // Only 2 failures since last success → CLOSED
    expect(breaker.getState()).toBe('closed');
  });

  it('tracks latency and computes p50/p95', async () => {
    const { breaker } = makeBreaker();

    // Feed known latencies directly
    breaker.recordSuccess(10);
    breaker.recordSuccess(20);
    breaker.recordSuccess(30);
    breaker.recordSuccess(40);
    breaker.recordSuccess(100);

    const stats = breaker.getStats();
    expect(stats.successCount).toBeGreaterThanOrEqual(5);
    expect(stats.p50LatencyMs).toBeGreaterThanOrEqual(10);
    expect(stats.p95LatencyMs).toBeGreaterThanOrEqual(stats.p50LatencyMs);
  });
});

describe('getBreaker registry', () => {
  beforeEach(() => {
    __resetBreakersForTests();
  });

  it('returns the same breaker for the same endpoint', () => {
    const a = getBreaker('https://api.test/messages');
    const b = getBreaker('https://api.test/messages');
    expect(a).toBe(b);
  });

  it('returns different breakers for different endpoints', () => {
    const a = getBreaker('https://api.test/messages');
    const b = getBreaker('https://api.test/embeddings');
    expect(a).not.toBe(b);
  });

  it('getAllBreakerStats returns all registered breakers', async () => {
    const a = getBreaker('https://x.test/a');
    const b = getBreaker('https://x.test/b');

    await a.execute(async () => 1);
    await expect(b.execute(async () => { throw new Error('b'); })).rejects.toThrow();

    const stats = getAllBreakerStats();
    expect(stats).toHaveLength(2);
    const endpoints = stats.map((s) => s.endpoint).sort();
    expect(endpoints).toEqual(['https://x.test/a', 'https://x.test/b']);
  });
});
