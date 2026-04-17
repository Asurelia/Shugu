/**
 * Layer 1 — Transport: Circuit Breaker
 *
 * Hystrix-inspired breaker to stop hammering a failing endpoint.
 *
 * Why
 * ---
 * Without a breaker, the retry loop (transport/errors.ts::withRetry) will
 * happily retry 10 times with exponential backoff for every single turn.
 * When MiniMax is fully down, a 50-turn agent session burns 10 minutes of
 * real time × 50 failed calls = hours of useless retries before the user
 * notices. A breaker short-circuits this: after N failures, open the
 * circuit and fail fast until a cooldown passes.
 *
 * States
 * ------
 *   CLOSED     — normal operation, failures counted
 *   OPEN       — short-circuit: every execute() throws CircuitOpenError
 *                immediately until cooldown elapses
 *   HALF_OPEN  — let exactly one probe through; success → CLOSED, failure
 *                → back to OPEN with fresh cooldown
 *
 * Per-endpoint
 * ------------
 * One breaker per endpoint URL. MiniMaxClient currently hits only
 * /messages, but keeping the per-endpoint map is cheap and lets a future
 * multi-endpoint client (/embeddings, /images) observe each in isolation.
 *
 * Metrics
 * -------
 * Each breaker keeps a bounded ring buffer of recent latencies and a
 * success/failure tally. getStats() exposes this for the
 * scripts/analyze-traces harness to correlate breaker trips with
 * wasted retry budget.
 */

// ─── Types ──────────────────────────────────────────────

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerConfig {
  /** Failures within `windowMs` before opening. Default: 5. */
  failureThreshold: number;
  /** Rolling window the threshold applies to. Default: 60_000 (60s). */
  windowMs: number;
  /** How long OPEN lasts before a HALF_OPEN probe. Default: 30_000 (30s). */
  cooldownMs: number;
  /** Max latencies retained for p50/p95. Default: 100. */
  latencyBufferSize: number;
}

export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  failureThreshold: 5,
  windowMs: 60_000,
  cooldownMs: 30_000,
  latencyBufferSize: 100,
};

export interface BreakerStats {
  endpoint: string;
  state: BreakerState;
  successCount: number;
  failureCount: number;
  recentFailures: number;
  lastFailureAt: number | null;
  openedAt: number | null;
  p50LatencyMs: number;
  p95LatencyMs: number;
}

/** Error thrown when execute() is called while the circuit is OPEN. */
export class CircuitOpenError extends Error {
  constructor(public readonly endpoint: string, public readonly retryAfterMs: number) {
    super(`Circuit open for ${endpoint} — retry in ${Math.round(retryAfterMs / 1000)}s`);
    this.name = 'CircuitOpenError';
  }
}

// ─── Breaker ────────────────────────────────────────────

/**
 * A single breaker per endpoint.
 *
 * Time is read via an injected clock (`now()`) so tests can advance it
 * deterministically without fake timers.
 */
export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private readonly failureTimes: number[] = [];
  private openedAt: number | null = null;
  private lastFailureAt: number | null = null;
  private successCount = 0;
  private failureCount = 0;
  private readonly latencies: number[] = [];

  constructor(
    public readonly endpoint: string,
    private readonly config: BreakerConfig = DEFAULT_BREAKER_CONFIG,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Run `fn` under the breaker's protection.
   *
   * Transitions:
   *   CLOSED     — always run; record outcome
   *   OPEN       — if cooldown elapsed, promote to HALF_OPEN and run;
   *                otherwise throw CircuitOpenError
   *   HALF_OPEN  — run; outcome decides next state
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.maybePromoteFromOpen();

    if (this.state === 'open') {
      const cooldownRemaining = this.openedAt !== null
        ? this.config.cooldownMs - (this.now() - this.openedAt)
        : 0;
      throw new CircuitOpenError(this.endpoint, Math.max(0, cooldownRemaining));
    }

    const start = this.now();
    try {
      const result = await fn();
      this.recordSuccess(this.now() - start);
      return result;
    } catch (err) {
      this.recordFailure(this.now() - start);
      throw err;
    }
  }

  /**
   * Feed an externally-observed outcome (e.g. from retry logic) so the
   * breaker sees failures even when the caller doesn't wrap every attempt.
   */
  recordSuccess(latencyMs: number): void {
    this.pushLatency(latencyMs);
    this.successCount++;
    // Any success resets state to CLOSED and clears the failure window.
    this.state = 'closed';
    this.openedAt = null;
    this.failureTimes.length = 0;
  }

  recordFailure(latencyMs: number): void {
    this.pushLatency(latencyMs);
    this.failureCount++;
    const t = this.now();
    this.lastFailureAt = t;

    if (this.state === 'half_open') {
      // Probe failed — slam shut again with a fresh cooldown.
      this.state = 'open';
      this.openedAt = t;
      // Clear the window so the next probe cycle is clean.
      this.failureTimes.length = 0;
      return;
    }

    this.failureTimes.push(t);
    this.pruneFailureWindow(t);

    if (this.failureTimes.length >= this.config.failureThreshold) {
      this.state = 'open';
      this.openedAt = t;
    }
  }

  getState(): BreakerState {
    this.maybePromoteFromOpen();
    return this.state;
  }

  getStats(): BreakerStats {
    const latencies = [...this.latencies].sort((a, b) => a - b);
    return {
      endpoint: this.endpoint,
      state: this.state,
      successCount: this.successCount,
      failureCount: this.failureCount,
      recentFailures: this.failureTimes.length,
      lastFailureAt: this.lastFailureAt,
      openedAt: this.openedAt,
      p50LatencyMs: percentile(latencies, 0.5),
      p95LatencyMs: percentile(latencies, 0.95),
    };
  }

  /** For testing or operator override. */
  reset(): void {
    this.state = 'closed';
    this.failureTimes.length = 0;
    this.openedAt = null;
    this.lastFailureAt = null;
    this.successCount = 0;
    this.failureCount = 0;
    this.latencies.length = 0;
  }

  // ─── Internals ────────────────────────────────────────

  private maybePromoteFromOpen(): void {
    if (this.state === 'open' && this.openedAt !== null) {
      if (this.now() - this.openedAt >= this.config.cooldownMs) {
        this.state = 'half_open';
      }
    }
  }

  private pruneFailureWindow(now: number): void {
    const cutoff = now - this.config.windowMs;
    while (this.failureTimes.length > 0 && this.failureTimes[0]! < cutoff) {
      this.failureTimes.shift();
    }
  }

  private pushLatency(ms: number): void {
    this.latencies.push(ms);
    if (this.latencies.length > this.config.latencyBufferSize) {
      this.latencies.shift();
    }
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return Math.round(sorted[idx]!);
}

// ─── Registry ───────────────────────────────────────────

/**
 * Global per-endpoint registry. Callers get the same breaker instance
 * for a given endpoint URL across the whole process.
 */
const _breakers = new Map<string, CircuitBreaker>();

export function getBreaker(
  endpoint: string,
  config: BreakerConfig = DEFAULT_BREAKER_CONFIG,
): CircuitBreaker {
  let b = _breakers.get(endpoint);
  if (!b) {
    b = new CircuitBreaker(endpoint, config);
    _breakers.set(endpoint, b);
  }
  return b;
}

export function getAllBreakerStats(): BreakerStats[] {
  return Array.from(_breakers.values()).map((b) => b.getStats());
}

/** Reset all registered breakers — test helper. */
export function __resetBreakersForTests(): void {
  _breakers.clear();
}
