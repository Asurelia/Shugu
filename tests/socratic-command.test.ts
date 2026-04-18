/**
 * Tests for the /socratic command.
 * Part of the socratic-agent plan (Task 6).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createSocraticCommand } from '../src/commands/socratic.js';
import type { AgentOrchestrator } from '../src/agents/orchestrator.js';
import type { CommandContext } from '../src/commands/registry.js';

const SAMPLE_REPORT = [
  '# Revue Socratique — test',
  '',
  '## Préambule',
  'Periphery.',
  '',
  '## Axe 1 — X',
  '### A1.1 — ✗ Faux : truc cassé',
  'Voir `src/x.ts:42`.',
  '',
  '## Verdict',
  'Le point de pression : X.',
  '',
  '---',
  '',
  '## Annexe machine-readable',
  '',
  '```json',
  '{"faux":[{"id":"A1.1","file":"src/x.ts","line":42,"evidence":"e","suggestion":"s"}]}',
  '```',
].join('\n');

function makeOrchestrator(response = SAMPLE_REPORT): AgentOrchestrator {
  return {
    spawn: vi.fn().mockResolvedValue({
      response,
      events: [],
      success: true,
      endReason: 'end_turn',
      costUsd: 0.25,
      turns: 7,
    }),
  } as unknown as AgentOrchestrator;
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

function gitRun(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function setupRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'socratic-test-'));
  gitRun(['init', '-q'], root);
  gitRun(['config', 'user.email', 't@t'], root);
  gitRun(['config', 'user.name', 't'], root);
  writeFileSync(join(root, 'a.ts'), 'export const A = 1;\n');
  gitRun(['add', '.'], root);
  gitRun(['commit', '-qm', 'init'], root);
  return root;
}

describe('createSocraticCommand', () => {
  let root: string;
  beforeEach(() => { root = setupRepo(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('returns a Command with name "socratic"', () => {
    const cmd = createSocraticCommand(makeOrchestrator(), root);
    expect(cmd.name).toBe('socratic');
  });

  it('writes a report file in .pcc/rodin/ with correct frontmatter', async () => {
    const orch = makeOrchestrator();
    const cmd = createSocraticCommand(orch, root);
    const ctx = makeCtx(root);
    await cmd.execute('--scope feature --topic demo', ctx);
    const dir = join(root, '.pcc', 'rodin');
    expect(existsSync(dir)).toBe(true);
    const files = readdirSync(dir).filter(f => f.endsWith('.md'));
    expect(files.length).toBe(1);
    const content = readFileSync(join(dir, files[0]!), 'utf8');
    expect(content.startsWith('---\n')).toBe(true);
    expect(content).toMatch(/scope: feature/);
    expect(content).toMatch(/topic: "demo"/);
    expect(content).toContain('# Revue Socratique');
  });

  it('appends a metrics line to .pcc/rodin/metrics.jsonl', async () => {
    const cmd = createSocraticCommand(makeOrchestrator(), root);
    await cmd.execute('--scope feature --topic demo', makeCtx(root));
    const metricsPath = join(root, '.pcc', 'rodin', 'metrics.jsonl');
    expect(existsSync(metricsPath)).toBe(true);
    const line = readFileSync(metricsPath, 'utf8').trim();
    const parsed = JSON.parse(line);
    expect(parsed.scope).toBe('feature');
    expect(parsed.turns).toBe(7);
    expect(parsed.faux_count).toBe(1);
  });

  it('prints a TTY summary including faux items', async () => {
    const info = vi.fn();
    const cmd = createSocraticCommand(makeOrchestrator(), root);
    await cmd.execute('--scope feature --topic demo', makeCtx(root, { info }));
    const joined = info.mock.calls.map(c => c[0]).join('\n');
    expect(joined).toContain('src/x.ts:42');
    expect(joined).toMatch(/1 ✗/);
  });

  it('rejects unknown scope with a helpful error', async () => {
    const cmd = createSocraticCommand(makeOrchestrator(), root);
    const result = await cmd.execute('--scope bogus', makeCtx(root));
    expect(result.type).toBe('error');
    if (result.type === 'error') {
      expect(result.message).toMatch(/scope/i);
    }
  });

  it('requires --topic for scope feature', async () => {
    const cmd = createSocraticCommand(makeOrchestrator(), root);
    const result = await cmd.execute('--scope feature', makeCtx(root));
    expect(result.type).toBe('error');
  });

  it('passes scope-specific maxTurns to spawn', async () => {
    const orch = makeOrchestrator();
    const cmd = createSocraticCommand(orch, root);
    await cmd.execute('--scope diff', makeCtx(root));
    const spawn = orch.spawn as unknown as ReturnType<typeof vi.fn>;
    expect(spawn).toHaveBeenCalledTimes(1);
    const opts = spawn.mock.calls[0]![2];
    expect(opts.maxTurns).toBe(12);
  });
});
