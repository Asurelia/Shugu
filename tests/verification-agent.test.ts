/**
 * Tests for the verification agent type.
 */
import { describe, it, expect } from 'vitest';
import { BUILTIN_AGENTS } from '../src/agents/orchestrator.js';

describe('Verification agent type', () => {
  it('should exist in BUILTIN_AGENTS', () => {
    expect(BUILTIN_AGENTS['verify']).toBeDefined();
  });

  it('should have the correct name', () => {
    expect(BUILTIN_AGENTS['verify'].name).toBe('verify');
  });

  it('should have read-only + execution tools', () => {
    const tools = BUILTIN_AGENTS['verify'].allowedTools;
    expect(tools).toBeDefined();
    expect(tools).toContain('Read');
    expect(tools).toContain('Glob');
    expect(tools).toContain('Grep');
    expect(tools).toContain('Bash');
  });

  it('should not allow Write or Edit tools', () => {
    const tools = BUILTIN_AGENTS['verify'].allowedTools!;
    expect(tools).not.toContain('Write');
    expect(tools).not.toContain('Edit');
    expect(tools).not.toContain('Agent');
  });

  it('should have a budget limit', () => {
    expect(BUILTIN_AGENTS['verify'].maxBudgetUsd).toBeDefined();
    expect(BUILTIN_AGENTS['verify'].maxBudgetUsd!).toBeLessThanOrEqual(0.10);
  });

  it('should have max 10 turns', () => {
    expect(BUILTIN_AGENTS['verify'].maxTurns).toBe(10);
  });

  it('should mention VERDICT in rolePrompt', () => {
    expect(BUILTIN_AGENTS['verify'].rolePrompt).toContain('VERDICT');
  });

  it('should mention anti-rationalization in rolePrompt', () => {
    expect(BUILTIN_AGENTS['verify'].rolePrompt).toContain('ANTI-RATIONALIZATION');
  });

  it('should now have 6 builtin agent types', () => {
    expect(Object.keys(BUILTIN_AGENTS).length).toBe(6);
  });
});
