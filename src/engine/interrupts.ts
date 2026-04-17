/**
 * Layer 2 — Engine: Interrupt handling
 *
 * Manages abort, pause, and resume for the agentic loop.
 * Uses AbortController as the primary cancellation mechanism.
 */

// ─── Interrupt Controller ───────────────────────────────

export class InterruptController {
  private controller: AbortController;
  private _paused = false;
  private _pauseResolve: (() => void) | null = null;

  constructor() {
    this.controller = new AbortController();
  }

  /**
   * Get the abort signal for passing to async operations.
   */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /**
   * Whether the loop is currently paused.
   */
  get paused(): boolean {
    return this._paused;
  }

  /**
   * Whether the loop has been aborted.
   */
  get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  /**
   * Abort the current operation. Cannot be resumed.
   */
  abort(reason?: string): void {
    this.controller.abort(reason ?? 'User abort');
    this.resume(); // Unblock any paused state
  }

  /**
   * Pause the loop. The next await point in the loop will block.
   */
  pause(): void {
    this._paused = true;
  }

  /**
   * Resume a paused loop.
   */
  resume(): void {
    this._paused = false;
    if (this._pauseResolve) {
      this._pauseResolve();
      this._pauseResolve = null;
    }
  }

  /**
   * Call this at await points in the loop to respect pause state.
   * Returns immediately if not paused, blocks if paused.
   * Throws if aborted.
   */
  async checkpoint(): Promise<void> {
    if (this.controller.signal.aborted) {
      throw new AbortError('Operation aborted');
    }

    if (this._paused) {
      await new Promise<void>((resolve) => {
        this._pauseResolve = resolve;
      });
    }

    if (this.controller.signal.aborted) {
      throw new AbortError('Operation aborted');
    }
  }

  /**
   * Reset the controller for a new operation.
   */
  reset(): void {
    this.controller = new AbortController();
    this._paused = false;
    this._pauseResolve = null;
  }
}

// ─── Error Types ────────────────────────────────────────

export class AbortError extends Error {
  constructor(message = 'Operation aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

export function isAbortError(error: unknown): error is AbortError {
  if (error instanceof AbortError) return true;
  // Duck-type on `name === 'AbortError'`. Covers Node's internal AbortError,
  // the synthetic DOMException thrown by AbortController, and any other
  // Error-like with the conventional name — without depending on the
  // DOMException global being available (older Node) or on the specific
  // Error constructor identity.
  return typeof error === 'object' && error !== null &&
    (error as { name?: unknown }).name === 'AbortError';
}
