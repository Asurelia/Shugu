/**
 * Tests for the socratic builtin agent registration.
 * Part of the socratic-agent plan (Task 4).
 */

import { describe, it, expect } from 'vitest';
import { BUILTIN_AGENTS } from '../src/agents/orchestrator.js';

describe('BUILTIN_AGENTS["socratic"]', () => {
  it('is registered', () => {
    expect(BUILTIN_AGENTS['socratic']).toBeDefined();
  });

  it('is read-only (no Edit/Write/Agent in allowedTools)', () => {
    const def = BUILTIN_AGENTS['socratic']!;
    expect(def.allowedTools).toBeDefined();
    const forbidden = ['Edit', 'Write', 'MultiEdit', 'Agent', 'FileWrite', 'FileEdit'];
    for (const t of forbidden) {
      expect(def.allowedTools).not.toContain(t);
    }
  });

  it('has a bashDenylist covering git mutations and install commands', () => {
    const def = BUILTIN_AGENTS['socratic']!;
    expect(def.bashDenylist).toBeDefined();
    const matches = (cmd: string): boolean =>
      def.bashDenylist!.some((re) => re.test(cmd));
    expect(matches('git reset --hard HEAD')).toBe(true);
    expect(matches('git push origin main')).toBe(true);
    expect(matches('git checkout -- file.ts')).toBe(true);
    expect(matches('npm install lodash')).toBe(true);
    expect(matches('rm -rf /')).toBe(true);
    expect(matches('git log --oneline -10')).toBe(false);
    expect(matches('git diff HEAD~1')).toBe(false);
    expect(matches('git show abc123')).toBe(false);
  });

  it('has a high maxTurns default (>= 20)', () => {
    expect(BUILTIN_AGENTS['socratic']!.maxTurns).toBeGreaterThanOrEqual(20);
  });

  it('prompt bans centrist hedge phrases', () => {
    const prompt = BUILTIN_AGENTS['socratic']!.rolePrompt;
    expect(prompt).toMatch(/globalement/i);
    expect(prompt).toMatch(/cinq|5 étiquettes|labels/i);
    expect(prompt).toMatch(/✗|faux/i);
    // The five label symbols must all appear in the prompt.
    expect(prompt).toContain('✓');
    expect(prompt).toContain('~');
    expect(prompt).toContain('⚡');
    expect(prompt).toContain('◐');
    expect(prompt).toContain('✗');
  });
});
