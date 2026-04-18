/**
 * Tests for the /finish-feature command.
 * Part of the socratic-agent plan (Task 7).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createFinishFeatureCommand } from '../src/commands/finish-feature.js';
import type { Command, CommandContext } from '../src/commands/registry.js';
import type { AgentOrchestrator } from '../src/agents/orchestrator.js';

function gitRun(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
}

function setupRepoOnBranch(): string {
  const root = mkdtempSync(join(tmpdir(), 'finish-feat-'));
  gitRun(['init', '-q', '-b', 'main'], root);
  gitRun(['config', 'user.email', 't@t'], root);
  gitRun(['config', 'user.name', 't'], root);
  writeFileSync(join(root, 'README.md'), '# x\n');
  gitRun(['add', '.'], root);
  gitRun(['commit', '-qm', 'init'], root);
  gitRun(['checkout', '-q', '-b', 'feature/x'], root);
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  gitRun(['add', '.'], root);
  gitRun(['commit', '-qm', 'feat: add a'], root);
  return root;
}

function makeCtx(cwd: string, overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    cwd,
    messages: [],
    info: vi.fn(),
    error: vi.fn(),
    ...overrides,
  };
}

function stubSocratic(fauxCount: number): Command {
  return {
    name: 'socratic',
    description: '',
    async execute(_args, ctx) {
      const dir = join(ctx.cwd, '.pcc', 'rodin');
      mkdirSync(dir, { recursive: true });
      appendFileSync(
        join(dir, 'metrics.jsonl'),
        JSON.stringify({ scope: 'diff', faux_count: fauxCount }) + '\n',
        'utf8',
      );
      ctx.info(`(stub) socratic run, faux_count=${fauxCount}`);
      return { type: 'handled' };
    },
  };
}

function makeOrchestrator(): AgentOrchestrator {
  return { spawn: vi.fn() } as unknown as AgentOrchestrator;
}

describe('createFinishFeatureCommand', () => {
  let root: string;
  beforeEach(() => { root = setupRepoOnBranch(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('returns a Command with name "finish-feature"', () => {
    const cmd = createFinishFeatureCommand(makeOrchestrator(), stubSocratic(0), root, async () => true);
    expect(cmd.name).toBe('finish-feature');
  });

  it('aborts if on main', async () => {
    gitRun(['checkout', '-q', 'main'], root);
    const cmd = createFinishFeatureCommand(makeOrchestrator(), stubSocratic(0), root, async () => true);
    const res = await cmd.execute('', makeCtx(root));
    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.message).toMatch(/main|master/i);
  });

  it('aborts if working tree is dirty', async () => {
    writeFileSync(join(root, 'dirty.txt'), 'nope');
    const cmd = createFinishFeatureCommand(makeOrchestrator(), stubSocratic(0), root, async () => true);
    const res = await cmd.execute('', makeCtx(root));
    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.message).toMatch(/working tree|clean/i);
  });

  it('aborts merge when socratic reports faux > 0', async () => {
    const socratic = stubSocratic(2);
    const cmd = createFinishFeatureCommand(makeOrchestrator(), socratic, root, async () => true);
    const res = await cmd.execute('', makeCtx(root));
    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.message).toMatch(/faux|bloc/i);
    const cur = gitRun(['rev-parse', '--abbrev-ref', 'HEAD'], root).trim();
    expect(cur).toBe('feature/x');
  });

  it('merges into main with --no-ff when socratic clean AND user confirms', async () => {
    const socratic = stubSocratic(0);
    const cmd = createFinishFeatureCommand(makeOrchestrator(), socratic, root, async () => true);
    const res = await cmd.execute('', makeCtx(root));
    expect(res.type).toBe('handled');
    const cur = gitRun(['rev-parse', '--abbrev-ref', 'HEAD'], root).trim();
    expect(cur).toBe('main');
    const log = gitRun(['log', '--oneline'], root);
    expect(log).toMatch(/feat: add a/);
    expect(log).toMatch(/Merge/i);
  });

  it('does not merge when user declines confirmation', async () => {
    const socratic = stubSocratic(0);
    const cmd = createFinishFeatureCommand(makeOrchestrator(), socratic, root, async () => false);
    const res = await cmd.execute('', makeCtx(root));
    expect(res.type).toBe('handled');
    const cur = gitRun(['rev-parse', '--abbrev-ref', 'HEAD'], root).trim();
    expect(cur).toBe('feature/x');
  });

  it('never pushes (no remote configured, command does not attempt push)', async () => {
    const socratic = stubSocratic(0);
    const cmd = createFinishFeatureCommand(makeOrchestrator(), socratic, root, async () => true);
    await cmd.execute('', makeCtx(root));
    const remotes = gitRun(['remote'], root).trim();
    expect(remotes).toBe('');
  });
});
