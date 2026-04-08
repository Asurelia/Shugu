import { describe, it, expect } from 'vitest';
import { validateHarnessConfig } from '../src/meta/config.js';
import type { HarnessConfig } from '../src/meta/types.js';

describe('validateHarnessConfig', () => {
  it('accepts a minimal valid config', () => {
    const config: HarnessConfig = { name: 'test', version: '0.1.0' };
    const result = validateHarnessConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects missing name', () => {
    const config = { version: '0.1.0' } as HarnessConfig;
    const result = validateHarnessConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('name'))).toBe(true);
  });

  it('rejects missing version', () => {
    const config = { name: 'test' } as HarnessConfig;
    const result = validateHarnessConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('version'))).toBe(true);
  });

  it('rejects systemPromptOverride', () => {
    const config = {
      name: 'test',
      version: '0.1.0',
      systemPromptOverride: 'custom prompt',
    } as HarnessConfig & { systemPromptOverride: string };
    const result = validateHarnessConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('systemPromptOverride'))).toBe(true);
  });

  it('rejects model.name', () => {
    const config = {
      name: 'test',
      version: '0.1.0',
      model: { name: 'MiniMax-M2.5' } as any,
    } as HarnessConfig;
    const result = validateHarnessConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('model.name'))).toBe(true);
  });

  it('rejects references to immutable zones', () => {
    const config: HarnessConfig = {
      name: 'test',
      version: '0.1.0',
      systemPromptAppend: 'Read src/transport/client.ts for details',
    };
    const result = validateHarnessConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('immutable zone'))).toBe(true);
  });

  it('rejects out-of-range maxTurns', () => {
    const config: HarnessConfig = {
      name: 'test',
      version: '0.1.0',
      limits: { maxTurns: 1000 },
    };
    const result = validateHarnessConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('maxTurns'))).toBe(true);
  });

  it('rejects out-of-range temperature', () => {
    const config: HarnessConfig = {
      name: 'test',
      version: '0.1.0',
      model: { temperature: 0.001 },
    };
    const result = validateHarnessConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('temperature'))).toBe(true);
  });

  it('accepts valid limits and model settings', () => {
    const config: HarnessConfig = {
      name: 'test',
      version: '0.1.0',
      limits: { maxTurns: 50, maxBudgetUsd: 5.0, toolTimeoutMs: 60_000 },
      model: { temperature: 0.5, maxTokens: 8192 },
    };
    const result = validateHarnessConfig(config);
    expect(result.valid).toBe(true);
  });

  it('accepts config with strategy overrides', () => {
    const config: HarnessConfig = {
      name: 'test',
      version: '0.1.0',
      strategy: {
        complexityOverride: 'complex',
        reflectionIntervals: { complex: 2, simple: 4 },
      },
    };
    const result = validateHarnessConfig(config);
    expect(result.valid).toBe(true);
  });

  it('accepts config with prompt fragments', () => {
    const config: HarnessConfig = {
      name: 'test',
      version: '0.1.0',
      systemPromptAppend: 'Always be thorough in your analysis.',
      promptFragments: { 'coding-style': 'Prefer functional patterns.' },
    };
    const result = validateHarnessConfig(config);
    expect(result.valid).toBe(true);
  });
});
