/**
 * End-to-end smoke test for /socratic + /finish-feature.
 * The agent response is mocked; the rest of the pipeline is real.
 * Part of the socratic-agent plan (Task 10).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createSocraticCommand } from '../src/commands/socratic.js';
import { createFinishFeatureCommand } from '../src/commands/finish-feature.js';
import type { AgentOrchestrator } from '../src/agents/orchestrator.js';
import type { CommandContext } from '../src/commands/registry.js';

const CLEAN_REPORT = [
  '# Revue Socratique — smoke',
  '## Préambule', 'p.',
  '## Axe 1 — X',
  '### A1.1 — ✓ Correct : ok',
  'src/a.ts:1',
  '## Verdict',
  'Le point de pression : rien de bloquant.',
  '---',
  '## Annexe machine-readable',
  '```json',
  '{"faux":[]}',
  '```',
].join('\n');

function gitRun(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
}

function setupRepoOnBranch(): string {
  const root = mkdtempSync(join(tmpdir(), 'socratic-e2e-'));
  gitRun(['init', '-q', '-b', 'main'], root);
  gitRun(['config', 'user.email', 't@t'], root);
  gitRun(['config', 'user.name', 't'], root);
  writeFileSync(join(root, 'README.md'), '#x');
  gitRun(['add', '.'], root);
  gitRun(['commit', '-qm', 'init'], root);
  gitRun(['checkout', '-q', '-b', 'feature/x'], root);
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  gitRun(['add', '.'], root);
  gitRun(['commit', '-qm', 'feat'], root);
  return root;
}

describe('socratic + finish-feature e2e (mocked orchestrator)', () => {
  let root: string;
  beforeEach(() => { root = setupRepoOnBranch(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('clean audit leads to successful merge', async () => {
    const orch = {
      spawn: vi.fn().mockResolvedValue({
        response: CLEAN_REPORT, events: [], success: true,
        endReason: 'end_turn', costUsd: 0.1, turns: 5,
      }),
    } as unknown as AgentOrchestrator;
    const socratic = createSocraticCommand(orch, root);
    const finish = createFinishFeatureCommand(orch, socratic, root, async () => true);
    const info = vi.fn();
    const ctx: CommandContext = { cwd: root, messages: [], info, error: vi.fn() };
    const res = await finish.execute('', ctx);
    expect(res.type).toBe('handled');
    const log = gitRun(['log', '--oneline'], root);
    expect(log).toMatch(/Merge/i);
    const dir = join(root, '.pcc', 'rodin');
    expect(existsSync(dir)).toBe(true);
    const reports = readdirSync(dir).filter(f => f.endsWith('.md'));
    expect(reports.length).toBe(1);
    const content = readFileSync(join(dir, reports[0]!), 'utf8');
    expect(content).toMatch(/scope: diff/);
  });
});
