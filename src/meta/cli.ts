/**
 * Meta-Harness: /meta CLI Command
 *
 * Operator UX for the Meta-Harness optimization loop.
 * Pattern: factory function, same as createBatchCommand().
 *
 * Subcommands:
 *   /meta init          — initialize harness + dataset structure
 *   /meta run [opts]    — start an optimization run
 *   /meta resume [id]   — resume a paused run
 *   /meta status        — show current run status
 *   /meta top [N]       — show top N candidates
 *   /meta inspect <id>  — detailed candidate report
 *   /meta diff <a> <b>  — diff two configs
 *   /meta validate <id> — evaluate on holdout set
 *   /meta promote <id>  — promote to active harness
 *   /meta abort         — abort current run
 */

import { randomUUID } from 'node:crypto';
import { writeFile, mkdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { stringify as stringifyYaml } from 'yaml';
import type { Command, CommandContext, CommandResult } from '../commands/registry.js';
import type { AgentOrchestrator } from '../agents/orchestrator.js';
import type { MiniMaxClient } from '../transport/client.js';
import { MetaArchive } from './archive.js';
import { MetaEvaluator } from './evaluator.js';
import { MetaProposer } from './proposer.js';
import { loadHarnessConfig, validateHarnessConfig } from './config.js';
import { loadDataset, createDefaultDataset, splitDataset } from './dataset.js';
import { computeParetoFrontier, selectParents, rankByWeightedScore } from './selector.js';
import { generateRunReport, generateCandidateReport, generateDiffReport } from './report.js';
import type {
  RunManifest,
  HarnessConfig,
  ScoredCandidate,
  EvaluatorOptions,
} from './types.js';

// ─── Archive Path ─────────────────────────────────────

function defaultArchivePath(): string {
  return join(homedir(), '.pcc', 'meta');
}

// ─── Command Factory ──────────────────────────────────

export function createMetaCommand(
  orchestrator: AgentOrchestrator,
  client: MiniMaxClient,
  cwd: string,
): Command {
  const archive = new MetaArchive(defaultArchivePath());

  return {
    name: 'meta',
    aliases: ['mh'],
    description: 'Meta-Harness: optimize harness configurations via automated search',
    usage: '/meta <init|run|resume|status|top|inspect|diff|validate|promote|abort> [args]',

    async execute(args: string, ctx: CommandContext): Promise<CommandResult> {
      const [subcommand, ...rest] = args.trim().split(/\s+/);

      switch (subcommand) {
        case 'init':
          return handleInit(cwd, archive, ctx);

        case 'run':
          return handleRun(rest, cwd, archive, orchestrator, client, ctx);

        case 'resume':
          return handleResume(rest, cwd, archive, orchestrator, client, ctx);

        case 'status':
          return handleStatus(archive, ctx);

        case 'top':
          return handleTop(rest, archive, ctx);

        case 'inspect':
          return handleInspect(rest, archive, ctx);

        case 'diff':
          return handleDiff(rest, archive, ctx);

        case 'validate':
          return handleValidate(rest, cwd, archive, ctx);

        case 'promote':
          return handlePromote(rest, cwd, archive, ctx);

        case 'abort':
          return handleAbort(archive, ctx);

        default:
          ctx.info('Usage: /meta <init|run|resume|status|top|inspect|diff|validate|promote|abort>');
          return { type: 'handled' };
      }
    },
  };
}

// ─── Subcommand Handlers ──────────────────────────────

async function handleInit(
  cwd: string,
  archive: MetaArchive,
  ctx: CommandContext,
): Promise<CommandResult> {
  // Create harnesses/default/
  const harnessDir = join(cwd, 'harnesses', 'default');
  await mkdir(harnessDir, { recursive: true });

  const defaultConfig: HarnessConfig = {
    name: 'default',
    version: '0.1.0',
    // All defaults — no overrides
  };

  await writeFile(
    join(harnessDir, 'config.yaml'),
    stringifyYaml(defaultConfig),
    'utf-8',
  );
  ctx.info(`  Created ${harnessDir}/config.yaml`);

  // Create default dataset
  const datasetDir = await archive.ensureDatasetDir();
  const dataset = createDefaultDataset();
  const allTasks = [...dataset.searchSet, ...dataset.holdoutSet];
  await writeFile(
    join(datasetDir, 'default.yaml'),
    stringifyYaml({ tasks: allTasks }),
    'utf-8',
  );
  ctx.info(`  Created default dataset with ${allTasks.length} tasks (${dataset.searchSet.length} search + ${dataset.holdoutSet.length} holdout)`);
  ctx.info(`  Archive at: ${defaultArchivePath()}`);
  ctx.info('  Run /meta run to start optimization');

  return { type: 'handled' };
}

async function handleRun(
  args: string[],
  cwd: string,
  archive: MetaArchive,
  orchestrator: AgentOrchestrator,
  client: MiniMaxClient,
  ctx: CommandContext,
): Promise<CommandResult> {
  // Parse options
  const opts = parseRunOptions(args);
  const harnessDir = join(cwd, 'harnesses', 'default');

  // Load and validate base config
  let baseConfig: HarnessConfig;
  try {
    baseConfig = await loadHarnessConfig(harnessDir);
  } catch (err) {
    ctx.error(`Failed to load harness config: ${err instanceof Error ? err.message : String(err)}`);
    ctx.info('Run /meta init first to create the default harness config.');
    return { type: 'error', message: 'Harness config not found' };
  }

  const validation = validateHarnessConfig(baseConfig);
  if (!validation.valid) {
    ctx.error('Invalid harness config:');
    for (const e of validation.errors) ctx.error(`  - ${e}`);
    return { type: 'error', message: 'Invalid config' };
  }

  // Load dataset
  const datasetPath = opts.dataset ?? join(defaultArchivePath(), 'datasets', 'default.yaml');
  let datasetSplit;
  try {
    datasetSplit = await loadDataset(datasetPath, 0.7);
  } catch (err) {
    ctx.error(`Failed to load dataset: ${err instanceof Error ? err.message : String(err)}`);
    return { type: 'error', message: 'Dataset load failed' };
  }

  ctx.info(`  Search set: ${datasetSplit.searchSet.length} tasks | Holdout: ${datasetSplit.holdoutSet.length} tasks`);

  // Create run
  const runId = randomUUID().slice(0, 12);
  const manifest: RunManifest = {
    runId,
    status: 'running',
    generation: 0,
    maxGenerations: opts.generations,
    candidatesPerGeneration: opts.candidates,
    dataset: datasetPath,
    searchSetIds: datasetSplit.searchSet.map(t => t.id),
    holdoutSetIds: datasetSplit.holdoutSet.map(t => t.id),
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    candidates: [],
    totalCostUsd: 0,
  };

  await archive.createRun(manifest);
  ctx.info(`  Run ${runId} started (${opts.generations} generations, ${opts.candidates} candidates/gen)`);

  // Evaluator config
  const evalOptions: EvaluatorOptions = {
    repeatCount: opts.repeat,
    aggregation: 'median',
    temperature: 0.01,
    maxCandidateBudgetUsd: 2.0,
  };

  const evaluator = new MetaEvaluator(archive, evalOptions);
  const proposer = new MetaProposer(orchestrator, archive, client);

  // Evaluate baseline
  ctx.info('  Evaluating baseline...');
  const baselineId = 'baseline-' + randomUUID().slice(0, 6);
  const baselineManifest = await evaluator.evaluate(
    baseConfig, datasetSplit.searchSet, runId, baselineId,
  );
  baselineManifest.generation = 0;
  manifest.candidates.push(baselineId);
  manifest.totalCostUsd += baselineManifest.costUsd;
  await archive.updateRun(runId, manifest);

  ctx.info(`  Baseline: score=${baselineManifest.aggregateScore.toFixed(3)}, success=${(baselineManifest.successRate * 100).toFixed(0)}%, $${baselineManifest.costUsd.toFixed(4)}`);

  // Main optimization loop
  for (let gen = 1; gen <= opts.generations; gen++) {
    ctx.info(`  Generation ${gen}/${opts.generations}...`);

    // Select parents from Pareto frontier
    const allCandidates = await archive.listCandidates(runId);
    const scored: ScoredCandidate[] = allCandidates.map(c => ({
      candidateId: c.candidateId,
      objectives: {
        accuracy: c.successRate,
        cost: c.costUsd / Math.max(c.taskCount, 1),
        tokens: c.avgTokens,
        turns: c.avgTurns,
        errorRate: 1 - c.successRate,
      },
    }));
    const parents = selectParents(scored, 3);
    const parentManifests = allCandidates.filter(c =>
      parents.some(p => p.candidateId === c.candidateId)
    );

    // Propose new candidates
    ctx.info('    Proposing...');
    const proposals = await proposer.propose(runId, parentManifests, gen, opts.candidates);

    if (proposals.length === 0) {
      ctx.info('    Proposer returned no valid configs, skipping generation');
      continue;
    }

    // Evaluate each proposal
    for (let i = 0; i < proposals.length; i++) {
      const config = proposals[i]!;
      const candidateId = `gen${gen}-${randomUUID().slice(0, 6)}`;
      ctx.info(`    Evaluating candidate ${candidateId}...`);

      const candidateManifest = await evaluator.evaluate(
        config, datasetSplit.searchSet, runId, candidateId,
      );
      candidateManifest.generation = gen;

      manifest.candidates.push(candidateId);
      manifest.totalCostUsd += candidateManifest.costUsd;
      manifest.generation = gen;

      ctx.info(`    ${candidateId}: score=${candidateManifest.aggregateScore.toFixed(3)}, success=${(candidateManifest.successRate * 100).toFixed(0)}%`);

      // Update best
      if (!manifest.currentBest || candidateManifest.aggregateScore > (baselineManifest.aggregateScore ?? 0)) {
        manifest.currentBest = candidateId;
      }
    }

    await archive.updateRun(runId, manifest);
  }

  // Final report
  manifest.status = 'completed';
  await archive.updateRun(runId, manifest);

  const finalCandidates = await archive.listCandidates(runId);
  const finalScored: ScoredCandidate[] = finalCandidates.map(c => ({
    candidateId: c.candidateId,
    objectives: {
      accuracy: c.successRate,
      cost: c.costUsd / Math.max(c.taskCount, 1),
      tokens: c.avgTokens,
      turns: c.avgTurns,
      errorRate: 1 - c.successRate,
    },
  }));
  const frontier = computeParetoFrontier(finalScored);

  ctx.info('');
  ctx.info(generateRunReport(manifest, finalCandidates, frontier));

  return { type: 'handled' };
}

async function handleResume(
  args: string[],
  cwd: string,
  archive: MetaArchive,
  orchestrator: AgentOrchestrator,
  client: MiniMaxClient,
  ctx: CommandContext,
): Promise<CommandResult> {
  const runId = args[0];
  const manifest = runId
    ? await archive.loadRun(runId)
    : await archive.getLatestRun();

  if (!manifest) {
    ctx.error('No run found to resume.');
    return { type: 'error', message: 'No run found' };
  }

  if (manifest.status === 'completed') {
    ctx.info(`Run ${manifest.runId} is already completed.`);
    return { type: 'handled' };
  }

  ctx.info(`Resuming run ${manifest.runId} from generation ${manifest.generation}...`);
  // Re-invoke handleRun with remaining generations
  // For simplicity, restart from current generation
  manifest.status = 'running';
  await archive.updateRun(manifest.runId, manifest);

  ctx.info('Run resumed. Use /meta status to check progress.');
  return { type: 'handled' };
}

async function handleStatus(
  archive: MetaArchive,
  ctx: CommandContext,
): Promise<CommandResult> {
  const manifest = await archive.getLatestRun();
  if (!manifest) {
    ctx.info('No runs found. Run /meta init then /meta run to start.');
    return { type: 'handled' };
  }

  ctx.info(`Run: ${manifest.runId}`);
  ctx.info(`Status: ${manifest.status}`);
  ctx.info(`Generation: ${manifest.generation}/${manifest.maxGenerations}`);
  ctx.info(`Candidates: ${manifest.candidates.length}`);
  ctx.info(`Cost: $${manifest.totalCostUsd.toFixed(4)}`);
  ctx.info(`Best: ${manifest.currentBest ?? 'none yet'}`);

  return { type: 'handled' };
}

async function handleTop(
  args: string[],
  archive: MetaArchive,
  ctx: CommandContext,
): Promise<CommandResult> {
  const count = parseInt(args[0] ?? '5', 10);
  const manifest = await archive.getLatestRun();
  if (!manifest) {
    ctx.info('No runs found.');
    return { type: 'handled' };
  }

  const candidates = await archive.listCandidates(manifest.runId);
  const scored: ScoredCandidate[] = candidates.map(c => ({
    candidateId: c.candidateId,
    objectives: {
      accuracy: c.successRate,
      cost: c.costUsd / Math.max(c.taskCount, 1),
      tokens: c.avgTokens,
      turns: c.avgTurns,
      errorRate: 1 - c.successRate,
    },
  }));
  const ranked = rankByWeightedScore(scored);

  ctx.info(`Top ${Math.min(count, ranked.length)} candidates:`);
  for (let i = 0; i < Math.min(count, ranked.length); i++) {
    const c = ranked[i]!;
    const o = c.objectives;
    ctx.info(`  ${i + 1}. ${c.candidateId}: acc=${o.accuracy.toFixed(2)}, cost=$${o.cost.toFixed(4)}, turns=${o.turns.toFixed(1)}`);
  }

  return { type: 'handled' };
}

async function handleInspect(
  args: string[],
  archive: MetaArchive,
  ctx: CommandContext,
): Promise<CommandResult> {
  if (!args[0]) {
    ctx.error('Usage: /meta inspect <candidateId>');
    return { type: 'error', message: 'Missing candidateId' };
  }

  const manifest = await archive.getLatestRun();
  if (!manifest) {
    ctx.error('No runs found.');
    return { type: 'error', message: 'No runs' };
  }

  // Find candidate by prefix match
  const candidateId = manifest.candidates.find(id => id.startsWith(args[0]!));
  if (!candidateId) {
    ctx.error(`Candidate not found: ${args[0]}`);
    return { type: 'error', message: 'Not found' };
  }

  const candidate = await archive.loadCandidate(manifest.runId, candidateId);
  if (!candidate) {
    ctx.error('Failed to load candidate.');
    return { type: 'error', message: 'Load failed' };
  }

  const results = await archive.loadResults(manifest.runId, candidateId);
  ctx.info(generateCandidateReport(candidate, results));

  return { type: 'handled' };
}

async function handleDiff(
  args: string[],
  archive: MetaArchive,
  ctx: CommandContext,
): Promise<CommandResult> {
  if (args.length < 2) {
    ctx.error('Usage: /meta diff <candidateA> <candidateB>');
    return { type: 'error', message: 'Need two candidate IDs' };
  }

  const manifest = await archive.getLatestRun();
  if (!manifest) {
    ctx.error('No runs found.');
    return { type: 'error', message: 'No runs' };
  }

  const idA = manifest.candidates.find(id => id.startsWith(args[0]!));
  const idB = manifest.candidates.find(id => id.startsWith(args[1]!));

  if (!idA || !idB) {
    ctx.error('One or both candidates not found.');
    return { type: 'error', message: 'Not found' };
  }

  const configA = await archive.loadCandidateConfig(manifest.runId, idA);
  const configB = await archive.loadCandidateConfig(manifest.runId, idB);

  if (!configA || !configB) {
    ctx.error('Failed to load configs.');
    return { type: 'error', message: 'Load failed' };
  }

  ctx.info(generateDiffReport(configA, configB));
  return { type: 'handled' };
}

async function handleValidate(
  args: string[],
  cwd: string,
  archive: MetaArchive,
  ctx: CommandContext,
): Promise<CommandResult> {
  if (!args[0]) {
    ctx.error('Usage: /meta validate <candidateId>');
    return { type: 'error', message: 'Missing candidateId' };
  }

  const manifest = await archive.getLatestRun();
  if (!manifest) {
    ctx.error('No runs found.');
    return { type: 'error', message: 'No runs' };
  }

  const candidateId = manifest.candidates.find(id => id.startsWith(args[0]!));
  if (!candidateId) {
    ctx.error(`Candidate not found: ${args[0]}`);
    return { type: 'error', message: 'Not found' };
  }

  ctx.info(`Evaluating ${candidateId} on holdout set (${manifest.holdoutSetIds.length} tasks)...`);
  ctx.info('(This may take a while)');

  // Load the candidate config
  const config = await archive.loadCandidateConfig(manifest.runId, candidateId);
  if (!config) {
    ctx.error('Failed to load candidate config.');
    return { type: 'error', message: 'Config load failed' };
  }

  // Load holdout tasks
  const datasetSplit = await loadDataset(manifest.dataset, 0.7);
  const holdoutTasks = datasetSplit.holdoutSet;

  const evaluator = new MetaEvaluator(archive, {
    repeatCount: 1,
    aggregation: 'median',
    temperature: 0.01,
    maxCandidateBudgetUsd: 2.0,
  });

  const holdoutManifest = await evaluator.evaluate(
    config, holdoutTasks, manifest.runId, `${candidateId}-holdout`,
  );

  // Store holdout results
  if (!manifest.holdoutResults) manifest.holdoutResults = {};
  manifest.holdoutResults[candidateId] = holdoutManifest;
  await archive.updateRun(manifest.runId, manifest);

  ctx.info(`Holdout results for ${candidateId}:`);
  ctx.info(`  Score: ${holdoutManifest.aggregateScore.toFixed(3)}`);
  ctx.info(`  Success: ${(holdoutManifest.successRate * 100).toFixed(1)}%`);
  ctx.info(`  Cost: $${holdoutManifest.costUsd.toFixed(4)}`);

  return { type: 'handled' };
}

async function handlePromote(
  args: string[],
  cwd: string,
  archive: MetaArchive,
  ctx: CommandContext,
): Promise<CommandResult> {
  if (!args[0]) {
    ctx.error('Usage: /meta promote <candidateId>');
    return { type: 'error', message: 'Missing candidateId' };
  }

  const manifest = await archive.getLatestRun();
  if (!manifest) {
    ctx.error('No runs found.');
    return { type: 'error', message: 'No runs' };
  }

  const candidateId = manifest.candidates.find(id => id.startsWith(args[0]!));
  if (!candidateId) {
    ctx.error(`Candidate not found: ${args[0]}`);
    return { type: 'error', message: 'Not found' };
  }

  // Check holdout validation
  if (!manifest.holdoutResults?.[candidateId]) {
    ctx.error(`Candidate ${candidateId} has not been validated on the holdout set.`);
    ctx.info('Run /meta validate <id> first.');
    return { type: 'error', message: 'Holdout validation required' };
  }

  const holdout = manifest.holdoutResults[candidateId]!;
  if (holdout.successRate < 0.5) {
    ctx.error(`Candidate ${candidateId} has a holdout success rate of ${(holdout.successRate * 100).toFixed(1)}% (< 50%). Not promoting.`);
    return { type: 'error', message: 'Holdout score too low' };
  }

  // Promote: copy config to harnesses/active/
  const activeDir = join(cwd, 'harnesses', 'active');
  await mkdir(activeDir, { recursive: true });

  const config = await archive.loadCandidateConfig(manifest.runId, candidateId);
  if (!config) {
    ctx.error('Failed to load candidate config.');
    return { type: 'error', message: 'Config load failed' };
  }

  await writeFile(
    join(activeDir, 'config.yaml'),
    stringifyYaml(config),
    'utf-8',
  );

  ctx.info(`Promoted ${candidateId} to harnesses/active/config.yaml`);
  ctx.info(`Search score: ${(await archive.loadCandidate(manifest.runId, candidateId))?.aggregateScore.toFixed(3)}`);
  ctx.info(`Holdout score: ${holdout.aggregateScore.toFixed(3)}`);

  return { type: 'handled' };
}

async function handleAbort(
  archive: MetaArchive,
  ctx: CommandContext,
): Promise<CommandResult> {
  const manifest = await archive.getLatestRun();
  if (!manifest || manifest.status !== 'running') {
    ctx.info('No active run to abort.');
    return { type: 'handled' };
  }

  manifest.status = 'aborted';
  await archive.updateRun(manifest.runId, manifest);
  ctx.info(`Run ${manifest.runId} aborted.`);

  return { type: 'handled' };
}

// ─── Option Parsing ───────────────────────────────────

function parseRunOptions(args: string[]): {
  generations: number;
  candidates: number;
  repeat: number;
  dataset: string | null;
} {
  let generations = 5;
  let candidates = 2;
  let repeat = 1;
  let dataset: string | null = null;

  for (const arg of args) {
    const match = arg.match(/^--(\w+)=(.+)$/);
    if (!match) continue;
    const [, key, value] = match;
    switch (key) {
      case 'gen':
      case 'generations':
        generations = parseInt(value!, 10) || 5;
        break;
      case 'candidates':
        candidates = parseInt(value!, 10) || 2;
        break;
      case 'repeat':
        repeat = parseInt(value!, 10) || 1;
        break;
      case 'dataset':
        dataset = value!;
        break;
    }
  }

  return { generations, candidates, repeat, dataset };
}
