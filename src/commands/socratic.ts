/**
 * /socratic — Rodin-style adversarial review (read-only).
 * Scopes: diff | feature | full
 */

import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command, CommandContext, CommandResult } from './registry.js';
import type { AgentOrchestrator } from '../agents/orchestrator.js';
import { git } from '../utils/git.js';
import {
  slugify,
  buildReportFilename,
  buildFrontmatter,
  extractFauxBlock,
  extractVerdictSection,
  detectHedge,
  countLabels,
  totalItems,
  formatTtySummary,
  type SocraticMetrics,
} from './socratic-report.js';

type Scope = 'diff' | 'feature' | 'full';

interface ScopeConfig {
  maxTurns: number;
  temperatureHint: number;
}

const SCOPE_CONFIG: Record<Scope, ScopeConfig> = {
  diff: { maxTurns: 12, temperatureHint: 0.3 },
  feature: { maxTurns: 18, temperatureHint: 0.3 },
  full: { maxTurns: 30, temperatureHint: 0.7 },
};

interface ParsedArgs {
  scope: Scope;
  topic: string | null;
  noSummary: boolean;
}

function parseArgs(raw: string): ParsedArgs | { error: string } {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  let scope: Scope = 'feature';
  let topic: string | null = null;
  let noSummary = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === '--scope') {
      const v = tokens[++i];
      if (v !== 'diff' && v !== 'feature' && v !== 'full') {
        return { error: `unknown scope "${v}". Expected diff | feature | full.` };
      }
      scope = v;
    } else if (t === '--topic') {
      topic = tokens[++i] ?? null;
    } else if (t === '--no-summary') {
      noSummary = true;
    } else if (t.startsWith('--')) {
      return { error: `unknown flag "${t}"` };
    }
  }
  if (scope === 'feature' && !topic) {
    return { error: '--topic <name> is required for --scope feature' };
  }
  return { scope, topic, noSummary };
}

export function createSocraticCommand(
  orchestrator: AgentOrchestrator,
  _cwdAtBoot: string,
): Command {
  return {
    name: 'socratic',
    description: 'Rodin-style adversarial review. Read-only, persisted to .pcc/rodin/.',
    usage: '/socratic [--scope diff|feature|full] [--topic <name>] [--no-summary]',
    async execute(args: string, ctx: CommandContext): Promise<CommandResult> {
      const parsed = parseArgs(args);
      if ('error' in parsed) return { type: 'error', message: parsed.error };
      const { scope, topic, noSummary } = parsed;
      const cfg = SCOPE_CONFIG[scope];

      let context: ScopeContext;
      try {
        context = await loadScopeContext(scope, topic, ctx.cwd);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { type: 'error', message: `socratic: ${msg}` };
      }

      if (scope === 'full') {
        ctx.info('⚠ Full audit — expected ~$0.80-2.00 and ~20-40 min. Spawning...');
      } else {
        ctx.info(`Socratic audit starting (scope=${scope}, budget=${cfg.maxTurns} turns)...`);
      }

      const taskPrompt = buildTaskPrompt(
        scope,
        topic ?? context.derivedTopic,
        context,
        cfg.temperatureHint,
      );

      const agentResult = await orchestrator.spawn(taskPrompt, 'socratic', {
        maxTurns: cfg.maxTurns,
        cwd: ctx.cwd,
      });

      if (!agentResult.success) {
        return {
          type: 'error',
          message: `socratic agent failed: ${agentResult.endReason}`,
        };
      }

      const report = agentResult.response;
      const verdict = extractVerdictSection(report);
      const hedge = detectHedge(verdict);
      const labels = countLabels(report);
      const { faux } = extractFauxBlock(report);
      const topicSlug = slugify(topic ?? context.derivedTopic);

      const now = new Date();
      const filename = buildReportFilename(now, scope, topicSlug);
      const rodinDir = join(ctx.cwd, '.pcc', 'rodin');
      mkdirSync(rodinDir, { recursive: true });
      const metrics: SocraticMetrics = {
        ts: now.toISOString(),
        scope,
        topic: topic ?? context.derivedTopic,
        turns: agentResult.turns,
        max_turns: cfg.maxTurns,
        cost: agentResult.costUsd,
        faux_count: faux.length,
        total_items: totalItems(labels),
        verdict_contains_hedge: hedge,
        files_read: context.filesLoaded,
        commits_reviewed: context.commits,
      };
      const reportPath = join(rodinDir, filename);
      writeFileSync(reportPath, buildFrontmatter(metrics) + report, 'utf8');
      appendFileSync(
        join(rodinDir, 'metrics.jsonl'),
        JSON.stringify({ ...metrics, topic_slug: topicSlug }) + '\n',
        'utf8',
      );

      if (!noSummary) {
        ctx.info(formatTtySummary({
          path: reportPath,
          metrics,
          fauxItems: faux,
          labelCounts: labels,
        }));
      }

      return { type: 'handled' };
    },
  };
}

interface ScopeContext {
  preloaded: string;
  filesLoaded: number;
  commits: string[];
  derivedTopic: string;
}

async function loadScopeContext(
  scope: Scope,
  topic: string | null,
  cwd: string,
): Promise<ScopeContext> {
  if (scope === 'diff') {
    let base = 'HEAD~1';
    try {
      const mergeBase = (await git(['merge-base', 'HEAD', 'main'], cwd)).trim();
      if (mergeBase) base = mergeBase;
    } catch {
      // main missing — keep HEAD~1 as fallback
    }
    const diff = await git(['diff', `${base}..HEAD`], cwd).catch(() => '');
    const commitsRaw = await git(['log', `${base}..HEAD`, '--pretty=%H'], cwd).catch(() => '');
    const commits = commitsRaw.split('\n').map(s => s.trim()).filter(Boolean);
    const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).catch(() => 'HEAD')).trim();
    const touched = await git(['diff', `${base}..HEAD`, '--name-only'], cwd).catch(() => '');
    const files = touched.split('\n').map(s => s.trim()).filter(Boolean);
    return {
      preloaded:
        `## Branch\n${branch}\n\n` +
        `## Commits covered\n${commits.join('\n') || '(none)'}\n\n` +
        `## Files touched\n${files.join('\n') || '(none)'}\n\n` +
        `## Diff\n\`\`\`diff\n${diff.slice(0, 40000)}\n\`\`\`\n`,
      filesLoaded: files.length,
      commits,
      derivedTopic: branch,
    };
  }

  if (scope === 'feature') {
    return {
      preloaded:
        `Topic: ${topic}\n\n` +
        `Use Glob and Grep to discover files related to this topic. ` +
        `Load their tests and their direct consumers (files that import from them).\n`,
      filesLoaded: 0,
      commits: [],
      derivedTopic: topic ?? 'feature',
    };
  }

  return {
    preloaded:
      `Full-scope audit. Start from docs/ARCHITECTURE.md if present, ` +
      `then list src/**/*.ts via Glob, read each src/**/index.ts barrel.\n`,
    filesLoaded: 0,
    commits: [],
    derivedTopic: 'full',
  };
}

function buildTaskPrompt(
  scope: Scope,
  topic: string,
  context: ScopeContext,
  temperatureHint: number,
): string {
  return [
    `Scope: ${scope}`,
    `Topic: ${topic}`,
    `Posture temperature (hint only): ${temperatureHint}`,
    '',
    '## Pre-loaded context',
    context.preloaded,
    '',
    '## Mission',
    `Produis la revue socratique complète selon le format imposé dans ton system prompt.`,
    `Ne produis QUE le rapport markdown (Préambule → Axes → Verdict → Annexe JSON).`,
  ].join('\n');
}
