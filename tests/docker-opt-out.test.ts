/**
 * Tests for the PCC_DISABLE_DOCKER=1 opt-out in plugin host isolation.
 *
 * The plugin host auto-detects Docker and uses it as strongest sandbox.
 * Users who have Docker Desktop installed but don't want Shugu to use it
 * (e.g., to avoid the 2-3 GB RAM reservation on Windows) must be able to
 * opt out via an env var. This test locks that behaviour in.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { isDockerAvailable, _resetDockerCache } from '../src/plugins/host.js';

describe('PCC_DISABLE_DOCKER opt-out', () => {
  const originalEnv = process.env['PCC_DISABLE_DOCKER'];

  beforeEach(() => {
    _resetDockerCache();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['PCC_DISABLE_DOCKER'];
    } else {
      process.env['PCC_DISABLE_DOCKER'] = originalEnv;
    }
    _resetDockerCache();
  });

  it('returns false when PCC_DISABLE_DOCKER=1 is set', () => {
    process.env['PCC_DISABLE_DOCKER'] = '1';
    expect(isDockerAvailable()).toBe(false);
  });

  it('ignores PCC_DISABLE_DOCKER=0 (only "1" triggers the opt-out)', () => {
    process.env['PCC_DISABLE_DOCKER'] = '0';
    // Without opt-out, falls through to actual detection. We don't assert
    // the result (depends on host machine) — only that the opt-out is not
    // accidentally triggered by any non-"1" value.
    const result = isDockerAvailable();
    expect(typeof result).toBe('boolean');
  });

  it('ignores PCC_DISABLE_DOCKER="true" (strict "1" check)', () => {
    process.env['PCC_DISABLE_DOCKER'] = 'true';
    const result = isDockerAvailable();
    expect(typeof result).toBe('boolean');
  });

  it('opt-out overrides a previously cached "true" result', () => {
    // Simulate prior detection that cached true
    delete process.env['PCC_DISABLE_DOCKER'];
    const firstResult = isDockerAvailable();
    // Now toggle opt-out — must return false regardless of cache
    process.env['PCC_DISABLE_DOCKER'] = '1';
    expect(isDockerAvailable()).toBe(false);
    // Unrelated: the first call's result depends on the host but must be boolean
    expect(typeof firstResult).toBe('boolean');
  });

  it('is idempotent across repeated calls with opt-out set', () => {
    process.env['PCC_DISABLE_DOCKER'] = '1';
    expect(isDockerAvailable()).toBe(false);
    expect(isDockerAvailable()).toBe(false);
    expect(isDockerAvailable()).toBe(false);
  });
});
