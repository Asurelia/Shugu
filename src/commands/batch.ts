/**
 * Layer 7 — Commands: /batch
 *
 * Decomposes a task into parallel worktree-isolated units via the model,
 * executes them concurrently, then lets the user merge or discard each result.
 */

import { resolve, sep } from 'node:path';
import type { Command, CommandContext, CommandResult } from './registry.js';
import type { AgentOrchestrator, AgentResult } from '../agents/orchestrator.js';
import type { Worktree } from '../agents/worktree.js';
import { mergeWorktree, removeWorktree } from '../agents/worktree.js';
import { resolveGitRoot } from '../utils/git.js';
import { delegateParallel, type ParallelTask } from '../agents/delegation.js';
import type { MiniMaxClient } from '../transport/client.js';
import { isTextBlock } from '../protocol/messages.js';

// ─── JSON Extraction ────────────────────────────────────

export function extractJSON<T>(text: string): { data: T | null; error?: string } {
  let lastError: string | undefined;

  // 1. Try full text as JSON
  try {
    return { data: JSON.parse(text) as T };
  } catch (e) { lastError = e instanceof Error ? e.message : String(e); }

  // 2. Strip markdown fences: ```json ... ``` or ``` ... ```
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return { data: JSON.parse(fenceMatch[1]!) as T };
    } catch (e) { lastError = e instanceof Error ? e.message : String(e); }
  }

  // 3. Find first { ... } block
  const braceMatch = text.match(/(\{[\s\S]*\})/);
  if (braceMatch) {
    try {
      return { data: JSON.parse(braceMatch[1]!) as T };
    } catch (e) { lastError = e instanceof Error ? e.message : String(e); }
  }

  // 4. Find first [ ... ] block
  const bracketMatch = text.match(/(\[[\s\S]*\])/);
  if (bracketMatch) {
    try {
      return { data: JSON.parse(bracketMatch[1]!) as T };
    } catch (e) { lastError = e instanceof Error ? e.message : String(e); }
  }

  return { data: null, error: `Could not extract JSON from model output (${lastError ?? 'no JSON found'}):\n${text.slice(0, 500)}` };
}

// ─── File Path Normalization ────────────────────────────

export function normalizeFilePaths(files: string[], cwd: string): string[] {
  return files.map((f) => {
    const resolved = resolve(cwd, f);
    let normalized = resolved.replace(/\\/g, '/');
    if (process.platform === 'win32') {
      normalized = normalized.toLowerCase();
    }
    return normalized;
  });
}

// ─── Overlap Detection ──────────────────────────────────

export function detectOverlap(units: BatchUnit[], cwd: string): string[] {
  const overlaps: string[] = [];
  const seen = new Map<string, string>(); // normalized path → unit name

  for (const unit of units) {
    const normalized = normalizeFilePaths(unit.files, cwd);
    for (const file of normalized) {
      const existingUnit = seen.get(file);
      if (existingUnit) {
        overlaps.push(`"${unit.name}" and "${existingUnit}" both touch: ${file}`);
      } else {
        seen.set(file, unit.name);
      }
    }
  }

  return overlaps;
}

// ─── Types ──────────────────────────────────────────────

export interface BatchUnit {
  name: string;
  description: string;
  files: string[];
}

interface DecompositionResult {
  units: BatchUnit[];
}

// ─── Module-level pending state ─────────────────────────

const pendingUnits = new Map<string, { worktree: Worktree; result: AgentResult }>();

// ─── Subcommand Handlers ─────────────────────────────────

function handleStatus(ctx: CommandContext): CommandResult {
  if (pendingUnits.size === 0) {
    ctx.info('No pending batch units.');
    return { type: 'handled' };
  }
  ctx.info(`Pending batch units (${pendingUnits.size}):`);
  for (const [name, { worktree, result }] of pendingUnits) {
    const cost = result.costUsd.toFixed(4);
    const turns = result.turns;
    ctx.info(`  ${name}  branch=${worktree.branch}  turns=${turns}  cost=$${cost}`);
  }
  ctx.info('');
  ctx.info('Use /batch merge <name> to merge or /batch discard <name> to discard.');
  return { type: 'handled' };
}

async function handleMerge(name: string, ctx: CommandContext, cwd: string): Promise<CommandResult> {
  if (!name) {
    return { type: 'error', message: 'Usage: /batch merge <unit-name>' };
  }

  const pending = pendingUnits.get(name);
  if (!pending) {
    const available = Array.from(pendingUnits.keys()).join(', ') || 'none';
    return { type: 'error', message: `No pending unit named "${name}". Available: ${available}` };
  }

  const { worktree } = pending;

  ctx.info(`Merging "${name}" (branch: ${worktree.branch}) into ${worktree.baseBranch}...`);

  let repoDir: string;
  try {
    repoDir = await resolveGitRoot(cwd);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { type: 'error', message: `Cannot resolve git root: ${msg}` };
  }

  const mergeResult = await mergeWorktree(repoDir, worktree, `batch: merge ${name}`);

  if (!mergeResult.merged) {
    if (mergeResult.conflicts && mergeResult.conflictFiles && mergeResult.conflictFiles.length > 0) {
      return {
        type: 'error',
        message: `Merge conflict in "${name}":\n${mergeResult.conflictFiles.map((f) => `  ${f}`).join('\n')}\nResolve conflicts, then retry.`,
      };
    }
    return { type: 'error', message: `Merge failed for "${name}": ${mergeResult.error ?? 'unknown error'}` };
  }

  // Cleanup worktree
  const cleanup = await removeWorktree(repoDir, worktree);
  pendingUnits.delete(name);

  if (cleanup.warnings.length > 0) {
    for (const w of cleanup.warnings) {
      ctx.error(`  Warning: ${w}`);
    }
  }

  ctx.info(`Merged "${name}" into ${worktree.baseBranch} successfully.`);
  return { type: 'handled' };
}

async function handleDiscard(name: string, ctx: CommandContext, cwd: string): Promise<CommandResult> {
  if (!name) {
    return { type: 'error', message: 'Usage: /batch discard <unit-name>' };
  }

  const pending = pendingUnits.get(name);
  if (!pending) {
    const available = Array.from(pendingUnits.keys()).join(', ') || 'none';
    return { type: 'error', message: `No pending unit named "${name}". Available: ${available}` };
  }

  const { worktree } = pending;

  ctx.info(`Discarding "${name}" (branch: ${worktree.branch})...`);

  let repoDir: string;
  try {
    repoDir = await resolveGitRoot(cwd);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { type: 'error', message: `Cannot resolve git root: ${msg}` };
  }

  const cleanup = await removeWorktree(repoDir, worktree);
  pendingUnits.delete(name);

  if (cleanup.warnings.length > 0) {
    for (const w of cleanup.warnings) {
      ctx.error(`  Warning: ${w}`);
    }
  }

  ctx.info(`Discarded "${name}".`);
  return { type: 'handled' };
}

async function handleBatch(
  task: string,
  orchestrator: AgentOrchestrator,
  client: MiniMaxClient,
  ctx: CommandContext,
  cwd: string,
): Promise<CommandResult> {
  ctx.info('Decomposing task with model...');

  // Ask the model to decompose into parallel units
  const decompositionPrompt = `Decompose this task into 2-15 independent units that can be executed in parallel by separate Shugu sub-agents.

Rules:
- Each unit MUST modify a non-overlapping set of files (agents run in parallel — file conflicts = data loss)
- Each unit must be self-contained: an agent with only Read/Edit/Write/Bash + the description should be able to complete it
- Order units by dependency: units that create interfaces/types BEFORE units that consume them
- If a unit needs context from another, list it in a "depends" field (these will run sequentially)
- Include test units separately — testing should verify the implementation units, not be mixed in

Consider the Shugu ecosystem:
- MemoryAgent may have relevant project facts (tech stack, patterns) — mention them in unit descriptions if relevant
- Git context: agents will share the same branch, so file overlap = merge conflicts
- Each agent gets its own conversation context but shares the filesystem

Return ONLY valid JSON:
{"units": [{"name": "short-kebab-name", "description": "What to do — be specific about which files and what changes", "files": ["src/path/to/file.ts"], "agentType": "code|test|general", "depends": ["other-unit-name"]}]}

Task: ${task}`;

  let rawResponse: string;
  try {
    const response = await client.complete([{ role: 'user', content: decompositionPrompt }]);
    rawResponse = response.message.content
      .filter(isTextBlock)
      .map((b) => b.text)
      .join('');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { type: 'error', message: `Model call failed: ${msg}` };
  }

  // Extract JSON from model output
  const { data, error: extractError } = extractJSON<DecompositionResult>(rawResponse);
  if (!data || !Array.isArray(data.units)) {
    return {
      type: 'error',
      message: extractError ?? 'Model did not return a valid decomposition.',
    };
  }

  const units = data.units;

  // Validate count
  if (units.length < 2 || units.length > 15) {
    return {
      type: 'error',
      message: `Expected 2-15 units, got ${units.length}.`,
    };
  }

  // Detect overlaps
  const overlaps = detectOverlap(units, cwd);
  if (overlaps.length > 0) {
    return {
      type: 'error',
      message: `File overlap detected:\n${overlaps.map((o) => `  ${o}`).join('\n')}\nCannot run overlapping units in parallel.`,
    };
  }

  // Display plan
  ctx.info(`\nBatch plan (${units.length} units):`);
  for (const unit of units) {
    ctx.info(`  ${unit.name}: ${unit.description}`);
    if (unit.files.length > 0) {
      ctx.info(`    files: ${unit.files.join(', ')}`);
    }
  }
  ctx.info('');
  ctx.info('Starting parallel execution...');

  // Build ParallelTask[]
  const parallelTasks: ParallelTask[] = units.map((unit) => ({
    id: unit.name,
    prompt: `${unit.description}\n\nFiles to modify:\n${unit.files.map((f) => `  - ${f}`).join('\n')}`,
    agentType: 'code',
    options: {
      isolation: 'worktree',
      depth: 1,
    },
  }));

  // Execute in parallel
  let parallelResults;
  try {
    parallelResults = await delegateParallel(orchestrator, parallelTasks);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { type: 'error', message: `Parallel execution failed: ${msg}` };
  }

  // Collect results
  let successCount = 0;
  let failCount = 0;

  ctx.info('\nResults:');
  for (const unit of units) {
    const result = parallelResults.results.get(unit.name);
    if (!result) continue;

    const status = result.success ? 'OK' : 'FAILED';
    const cost = result.costUsd.toFixed(4);
    ctx.info(`  [${status}] ${unit.name}  (${result.turns} turns, $${cost})`);

    if (result.success && result.worktree) {
      pendingUnits.set(unit.name, { worktree: result.worktree, result });
      successCount++;
    } else if (!result.success) {
      failCount++;
      if (result.response) {
        ctx.error(`    ${result.response.slice(0, 200)}`);
      }
    }
  }

  ctx.info('');
  ctx.info(`Total cost: $${parallelResults.totalCostUsd.toFixed(4)}`);
  ctx.info(`Units with pending changes: ${successCount}`);
  if (failCount > 0) {
    ctx.error(`Failed units: ${failCount}`);
  }

  if (successCount === 0) {
    return { type: 'handled' };
  }

  return {
    type: 'prompt',
    prompt: `Batch completed. ${successCount} unit(s) have pending worktree changes.\nUse /batch merge <name> to merge or /batch discard <name> to discard.\nUse /batch status to see all pending units.`,
  };
}

// ─── Factory ─────────────────────────────────────────────

export function createBatchCommand(
  orchestrator: AgentOrchestrator,
  client: MiniMaxClient,
  cwd: string,
): Command {
  return {
    name: 'batch',
    description: 'Decompose a task into parallel worktree-isolated units',
    usage: '/batch <task> | /batch status | /batch merge <unit> | /batch discard <unit>',
    async execute(args: string, ctx: CommandContext): Promise<CommandResult> {
      const trimmed = args.trim();
      if (!trimmed) return { type: 'error', message: 'Usage: /batch <task>' };

      if (trimmed === 'status') return handleStatus(ctx);
      if (trimmed.startsWith('merge ')) return handleMerge(trimmed.slice(6).trim(), ctx, cwd);
      if (trimmed.startsWith('discard ')) return handleDiscard(trimmed.slice(8).trim(), ctx, cwd);

      return handleBatch(trimmed, orchestrator, client, ctx, cwd);
    },
  };
}
