/**
 * Tests for Layer 2 — Engine: Interrupt handling
 */

import { describe, it, expect } from 'vitest';
import { InterruptController, AbortError, isAbortError } from '../src/engine/interrupts.js';

describe('InterruptController', () => {
  it('starts in a clean state', () => {
    const controller = new InterruptController();
    expect(controller.aborted).toBe(false);
    expect(controller.paused).toBe(false);
  });

  it('abort sets the aborted state', () => {
    const controller = new InterruptController();
    controller.abort('test reason');
    expect(controller.aborted).toBe(true);
  });

  it('checkpoint throws on abort', async () => {
    const controller = new InterruptController();
    controller.abort();

    await expect(controller.checkpoint()).rejects.toThrow(AbortError);
  });

  it('checkpoint passes when not aborted', async () => {
    const controller = new InterruptController();
    await expect(controller.checkpoint()).resolves.toBeUndefined();
  });

  it('pause blocks checkpoint until resume', async () => {
    const controller = new InterruptController();
    controller.pause();
    expect(controller.paused).toBe(true);

    let resolved = false;
    const checkpointPromise = controller.checkpoint().then(() => { resolved = true; });

    // Should not resolve immediately
    await new Promise((r) => setTimeout(r, 50));
    expect(resolved).toBe(false);

    // Resume should unblock
    controller.resume();
    await checkpointPromise;
    expect(resolved).toBe(true);
  });

  it('abort unblocks a paused checkpoint', async () => {
    const controller = new InterruptController();
    controller.pause();

    const checkpointPromise = controller.checkpoint();
    controller.abort();

    await expect(checkpointPromise).rejects.toThrow(AbortError);
  });

  it('reset creates a fresh state', () => {
    const controller = new InterruptController();
    controller.abort();
    expect(controller.aborted).toBe(true);

    controller.reset();
    expect(controller.aborted).toBe(false);
    expect(controller.paused).toBe(false);
  });

  it('signal is an AbortSignal', () => {
    const controller = new InterruptController();
    expect(controller.signal).toBeInstanceOf(AbortSignal);
    expect(controller.signal.aborted).toBe(false);

    controller.abort();
    expect(controller.signal.aborted).toBe(true);
  });
});

describe('Error utilities', () => {
  it('isAbortError identifies AbortError instances', () => {
    expect(isAbortError(new AbortError())).toBe(true);
    expect(isAbortError(new AbortError('custom message'))).toBe(true);
  });

  it('isAbortError identifies DOMException AbortError', () => {
    const domErr = new DOMException('aborted', 'AbortError');
    expect(isAbortError(domErr)).toBe(true);
  });

  it('isAbortError rejects non-abort errors', () => {
    expect(isAbortError(new Error('something else'))).toBe(false);
    expect(isAbortError(new TypeError('type error'))).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });
});
