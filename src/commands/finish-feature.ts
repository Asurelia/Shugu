/**
 * /finish-feature — ritual command: verify branch state, run /socratic diff,
 * then (if clean and user confirms) merge --no-ff into main.
 * Never pushes. Never resets. Never rebases.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Command, CommandContext, CommandResult } from './registry.js';
import type { AgentOrchestrator } from '../agents/orchestrator.js';
import { git } from '../utils/git.js';

export type ConfirmFn = (question: string) => Promise<boolean>;

const PROTECTED_BRANCHES = new Set(['main', 'master']);

export function createFinishFeatureCommand(
  _orchestrator: AgentOrchestrator,
  socraticCommand: Command,
  _cwdAtBoot: string,
  confirm: ConfirmFn,
): Command {
  return {
    name: 'finish-feature',
    description: 'Verify branch is clean, run /socratic --scope diff, then merge --no-ff into main.',
    usage: '/finish-feature',
    async execute(_args: string, ctx: CommandContext): Promise<CommandResult> {
      const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], ctx.cwd).catch(() => 'HEAD')).trim();
      if (PROTECTED_BRANCHES.has(branch)) {
        return { type: 'error', message: `cannot finish from "${branch}" — switch to a feature branch first.` };
      }

      const status = (await git(['status', '--porcelain'], ctx.cwd).catch(() => '')).trim();
      if (status.length > 0) {
        return { type: 'error', message: 'working tree is not clean — commit or stash changes before /finish-feature.' };
      }

      let mergeBase = '';
      try {
        mergeBase = (await git(['merge-base', 'HEAD', 'main'], ctx.cwd)).trim();
      } catch {
        return { type: 'error', message: 'cannot locate merge-base with main — is main present?' };
      }
      const commitsRaw = await git(['log', `${mergeBase}..HEAD`, '--pretty=%H'], ctx.cwd).catch(() => '');
      const commits = commitsRaw.split('\n').map(s => s.trim()).filter(Boolean);
      if (commits.length === 0) {
        return { type: 'error', message: 'no commits since main — nothing to finish.' };
      }

      ctx.info(`/finish-feature: running socratic audit on ${commits.length} commit(s)...`);
      const socraticResult = await socraticCommand.execute(`--scope diff`, ctx);
      if (socraticResult.type === 'error') {
        return socraticResult;
      }

      const fauxCount = readLastFauxCount(ctx.cwd);
      if (fauxCount > 0) {
        return {
          type: 'error',
          message:
            `socratic identified ${fauxCount} ✗ Faux item(s). Merge blocked. ` +
            `Review .pcc/rodin/ and address the items before retrying.`,
        };
      }

      const ok = await confirm(`Merge ${branch} into main with --no-ff? (socratic: clean)`);
      if (!ok) {
        ctx.info('Merge cancelled. Branch unchanged.');
        return { type: 'handled' };
      }

      try {
        await git(['checkout', 'main'], ctx.cwd);
        await git(['merge', '--no-ff', '--no-edit', branch], ctx.cwd);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { type: 'error', message: `merge failed: ${msg}` };
      }

      ctx.info(`✓ Merged ${branch} into main (no push).`);
      return { type: 'handled' };
    },
  };
}

function readLastFauxCount(cwd: string): number {
  const path = join(cwd, '.pcc', 'rodin', 'metrics.jsonl');
  if (!existsSync(path)) return 0;
  const content = readFileSync(path, 'utf8').trim();
  if (!content) return 0;
  const lines = content.split('\n');
  const last = lines[lines.length - 1]!;
  try {
    const parsed = JSON.parse(last) as { faux_count?: unknown };
    return typeof parsed.faux_count === 'number' ? parsed.faux_count : 0;
  } catch {
    return 0;
  }
}
