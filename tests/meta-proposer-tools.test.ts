/**
 * Regression lock: the Meta-Harness proposer must NOT have Bash in its allowedTools.
 *
 * This test reads the source file directly and asserts the string literal.
 * It is intentionally brittle — any future addition of Bash to the proposer
 * must be a deliberate decision that updates this test.
 */

import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

describe('Meta-Harness proposer allowedTools', () => {
  it('does not include Bash in allowedTools', async () => {
    const source = await readFile(resolve('src/meta/proposer.ts'), 'utf-8');

    // Locate the allowedTools array passed to orchestrator.spawn
    const match = source.match(/allowedTools:\s*\[([^\]]+)\]/);
    expect(match, 'allowedTools literal must exist in proposer.ts').toBeTruthy();

    const tools = match![1]!;
    expect(tools).not.toMatch(/'Bash'/);
    expect(tools).not.toMatch(/"Bash"/);
  });

  it('still grants Read, Write, Glob, Grep', async () => {
    const source = await readFile(resolve('src/meta/proposer.ts'), 'utf-8');
    const match = source.match(/allowedTools:\s*\[([^\]]+)\]/);
    const tools = match![1]!;
    expect(tools).toMatch(/'Read'/);
    expect(tools).toMatch(/'Write'/);
    expect(tools).toMatch(/'Glob'/);
    expect(tools).toMatch(/'Grep'/);
  });
});
