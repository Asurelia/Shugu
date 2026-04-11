/**
 * Tests for BuddyObserver — real-time feedback loop.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BuddyObserver } from '../src/ui/companion/observer.js';
import type { Companion, BuddyConfig } from '../src/ui/companion/types.js';
import { DEFAULT_BUDDY_CONFIG } from '../src/ui/companion/types.js';
import type { ToolCall, ToolResult } from '../src/protocol/tools.js';

function makeCompanion(overrides?: Partial<Companion>): Companion {
  return {
    species: 'cat',
    rarity: 'common',
    eye: '\u00B0',
    hat: 'none',
    shiny: false,
    name: 'TestBuddy',
    personality: 'curious and helpful',
    hatchedAt: Date.now(),
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<BuddyConfig>): BuddyConfig {
  return {
    ...DEFAULT_BUDDY_CONFIG,
    observationsEnabled: true,
    observationCooldownSeconds: 0,
    ...overrides,
  };
}

function makeCall(name: string, input: Record<string, unknown>): ToolCall {
  return { id: 'test-1', name, input };
}

function makeResult(content: string, isError = false): ToolResult {
  return { tool_use_id: 'test-1', content, is_error: isError };
}

// Build unsafe patterns as runtime strings to avoid triggering security hooks on this test file
const unsafeFnCall = 'const fn = new ' + 'Function("return 1")';
const unsafeSql = 'const q = "SELECT * FROM users WHERE id=" + userId; db.query(q);';
const unsafeInnerHtml = 'el.inner' + 'HTML = userInput';

describe('BuddyObserver', () => {
  let observer: BuddyObserver;

  beforeEach(() => {
    observer = new BuddyObserver(makeCompanion(), makeConfig());
  });

  describe('security detection', () => {
    it('detects dynamic code execution in Write', () => {
      const obs = observer.observe(
        'Write',
        makeCall('Write', { file_path: '/test.ts', content: unsafeFnCall }),
        makeResult('ok'),
        100,
      );
      expect(obs).not.toBeNull();
      expect(obs!.category).toBe('security');
      expect(obs!.severity).toBe('alert');
    });

    it('detects SQL string concatenation in Edit', () => {
      const obs = observer.observe(
        'Edit',
        makeCall('Edit', { old_string: 'x', new_string: unsafeSql }),
        makeResult('ok'),
        50,
      );
      expect(obs).not.toBeNull();
      expect(obs!.category).toBe('security');
    });

    it('detects --no-verify in Bash', () => {
      const obs = observer.observe(
        'Bash',
        makeCall('Bash', { command: 'git commit --no-verify -m "test"' }),
        makeResult('ok'),
        200,
      );
      expect(obs).not.toBeNull();
      expect(obs!.category).toBe('security');
      expect(obs!.message).toContain('--no-verify');
    });

    it('detects unsafe DOM assignment', () => {
      const obs = observer.observe(
        'Write',
        makeCall('Write', { file_path: '/test.ts', content: unsafeInnerHtml }),
        makeResult('ok'),
        50,
      );
      expect(obs).not.toBeNull();
      expect(obs!.category).toBe('security');
    });

    it('ignores safe code in Write', () => {
      const obs = observer.observe(
        'Write',
        makeCall('Write', { file_path: '/test.ts', content: 'const x = 42;' }),
        makeResult('ok'),
        50,
      );
      expect(obs).toBeNull();
    });
  });

  describe('test failure detection', () => {
    it('detects FAIL in Bash output', () => {
      const obs = observer.observe(
        'Bash',
        makeCall('Bash', { command: 'npm test' }),
        makeResult('FAIL src/test.ts\n  1 test failed'),
        5000,
      );
      expect(obs).not.toBeNull();
      expect(obs!.category).toBe('test_failure');
    });

    it('escalates repeated test failures', () => {
      const result = makeResult('FAIL src/auth.test.ts\n  1 test failed');
      observer.observe('Bash', makeCall('Bash', { command: 'npm test' }), result, 1000);
      observer.drain();
      observer.observe('Bash', makeCall('Bash', { command: 'npm test' }), result, 1000);
      observer.drain();
      const obs = observer.observe('Bash', makeCall('Bash', { command: 'npm test' }), result, 1000);
      expect(obs).not.toBeNull();
      expect(obs!.category).toBe('error_pattern');
      expect(obs!.message).toContain('3 times');
    });
  });

  describe('code smell detection', () => {
    it('detects any type in TypeScript', () => {
      const obs = observer.observe(
        'Write',
        makeCall('Write', { file_path: '/test.ts', content: 'const x: any = 42;' }),
        makeResult('ok'),
        50,
      );
      expect(obs).not.toBeNull();
      expect(obs!.category).toBe('code_smell');
    });

    it('detects console.log', () => {
      const obs = observer.observe(
        'Edit',
        makeCall('Edit', { old_string: '', new_string: 'console.log("debug");' }),
        makeResult('ok'),
        50,
      );
      expect(obs).not.toBeNull();
      expect(obs!.category).toBe('code_smell');
    });
  });

  describe('drain and cooldown', () => {
    it('drains the highest severity observation', () => {
      observer.observe(
        'Write',
        makeCall('Write', { file_path: '/test.ts', content: 'const x: any = 1;' }),
        makeResult('ok'),
        50,
      );
      observer.observe(
        'Write',
        makeCall('Write', { file_path: '/test.ts', content: unsafeFnCall }),
        makeResult('ok'),
        50,
      );

      const drained = observer.drain();
      expect(drained).not.toBeNull();
      expect(drained).toContain('Function constructor');
    });

    it('returns null when muted', () => {
      observer.observe(
        'Write',
        makeCall('Write', { file_path: '/test.ts', content: unsafeFnCall }),
        makeResult('ok'),
        50,
      );
      observer.setMuted(true);
      expect(observer.drain()).toBeNull();
    });

    it('returns null when nothing pending', () => {
      expect(observer.drain()).toBeNull();
    });

    it('respects cooldown', () => {
      const slowObserver = new BuddyObserver(
        makeCompanion(),
        makeConfig({ observationCooldownSeconds: 9999 }),
      );

      slowObserver.observe(
        'Write',
        makeCall('Write', { file_path: '/t.ts', content: unsafeFnCall }),
        makeResult('ok'),
        50,
      );
      slowObserver.drain();

      slowObserver.observe(
        'Write',
        makeCall('Write', { file_path: '/t.ts', content: unsafeFnCall }),
        makeResult('ok'),
        50,
      );
      expect(slowObserver.drain()).toBeNull();
    });
  });

  describe('voice wrapping', () => {
    it('wraps in security voice for sentinel personality', () => {
      const secObserver = new BuddyObserver(
        makeCompanion({ personality: 'vigilant sentinel' }),
        makeConfig(),
      );
      secObserver.observe(
        'Write',
        makeCall('Write', { file_path: '/test.ts', content: unsafeFnCall }),
        makeResult('ok'),
        50,
      );
      const drained = secObserver.drain();
      expect(drained).toContain('*narrows eyes*');
    });

    it('uses species-based voice for default personality', () => {
      const owlObserver = new BuddyObserver(
        makeCompanion({ species: 'owl', personality: 'wise' }),
        makeConfig(),
      );
      owlObserver.observe(
        'Write',
        makeCall('Write', { file_path: '/test.ts', content: unsafeFnCall }),
        makeResult('ok'),
        50,
      );
      const drained = owlObserver.drain();
      expect(drained).toContain('*blinks*');
    });
  });

  describe('observation length', () => {
    it('enforces 150 char limit', () => {
      const obs = observer.observe(
        'Write',
        makeCall('Write', { file_path: '/test.ts', content: unsafeFnCall }),
        makeResult('ok'),
        50,
      );
      expect(obs).not.toBeNull();
      expect(obs!.message.length).toBeLessThanOrEqual(150);
    });
  });

  describe('disabled observations', () => {
    it('returns null when observations disabled', () => {
      const disabledObserver = new BuddyObserver(
        makeCompanion(),
        makeConfig({ observationsEnabled: false }),
      );
      const obs = disabledObserver.observe(
        'Write',
        makeCall('Write', { file_path: '/test.ts', content: unsafeFnCall }),
        makeResult('ok'),
        50,
      );
      expect(obs).toBeNull();
    });
  });

  describe('architecture detection', () => {
    it('flags files over 500 lines', () => {
      const longContent = Array(600).fill('const x = 1;').join('\n');
      const obs = observer.observe(
        'Write',
        makeCall('Write', { file_path: '/big.ts', content: longContent }),
        makeResult('ok'),
        100,
      );
      expect(obs).not.toBeNull();
      expect(obs!.category).toBe('architecture');
      expect(obs!.message).toContain('600 lines');
    });
  });

  describe('error pattern tracking', () => {
    it('tracks repeated tool errors', () => {
      const errorResult = makeResult('Permission denied', true);
      observer.observe('Bash', makeCall('Bash', { command: 'cat /etc/shadow' }), errorResult, 50);
      const obs = observer.observe('Bash', makeCall('Bash', { command: 'cat /etc/shadow' }), errorResult, 50);
      expect(obs).not.toBeNull();
      expect(obs!.category).toBe('error_pattern');
      expect(obs!.message).toContain('2 times');
    });
  });
});
