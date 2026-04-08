/**
 * Meta-Harness: Filesystem Archive
 *
 * Stores all prior candidates, their configs, evaluation results,
 * and redacted execution traces in a structured filesystem.
 *
 * The archive lives at ~/.pcc/meta/ (absolute path) so it's
 * accessible from any git worktree. The proposer agent reads
 * this archive via standard filesystem tools (cat, grep, find).
 *
 * All operations are explicit about errors — no silent catches.
 *
 * Structure:
 *   ~/.pcc/meta/
 *     runs/<runId>/
 *       manifest.json
 *       candidates/<candidateId>/
 *         config.yaml
 *         scores.json
 *         results/<taskId>.json  (or <taskId>-run<N>.json)
 *         traces/<taskId>.jsonl  (redacted)
 *     datasets/
 *       default.yaml
 */

import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type {
  RunManifest,
  CandidateManifest,
  HarnessConfig,
  EvalResult,
} from './types.js';
import type { TraceEvent } from '../utils/tracer.js';

export class MetaArchive {
  constructor(private readonly basePath: string) {}

  // ─── Directory Helpers ────────────────────────────────

  private runDir(runId: string): string {
    return join(this.basePath, 'runs', runId);
  }

  private candidateDir(runId: string, candidateId: string): string {
    return join(this.runDir(runId), 'candidates', candidateId);
  }

  private resultsDir(runId: string, candidateId: string): string {
    return join(this.candidateDir(runId, candidateId), 'results');
  }

  private tracesDir(runId: string, candidateId: string): string {
    return join(this.candidateDir(runId, candidateId), 'traces');
  }

  private datasetsDir(): string {
    return join(this.basePath, 'datasets');
  }

  /**
   * Ensure a directory exists, creating it recursively if needed.
   */
  private async ensureDir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
  }

  // ─── Run Management ───────────────────────────────────

  /**
   * Create a new run with its manifest.
   */
  async createRun(manifest: RunManifest): Promise<void> {
    const dir = this.runDir(manifest.runId);
    await this.ensureDir(dir);
    await this.ensureDir(join(dir, 'candidates'));
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8',
    );
  }

  /**
   * Update an existing run manifest.
   */
  async updateRun(runId: string, updates: Partial<RunManifest>): Promise<void> {
    const manifest = await this.loadRun(runId);
    if (!manifest) {
      throw new Error(`Run not found: ${runId}`);
    }
    const updated = { ...manifest, ...updates, updatedAt: new Date().toISOString() };
    await writeFile(
      join(this.runDir(runId), 'manifest.json'),
      JSON.stringify(updated, null, 2),
      'utf-8',
    );
  }

  /**
   * Load a run manifest. Returns null if not found.
   */
  async loadRun(runId: string): Promise<RunManifest | null> {
    try {
      const content = await readFile(
        join(this.runDir(runId), 'manifest.json'),
        'utf-8',
      );
      return JSON.parse(content) as RunManifest;
    } catch (err: unknown) {
      if (isNotFoundError(err)) return null;
      throw err; // Re-throw non-ENOENT errors
    }
  }

  /**
   * List all runs, sorted by most recent first.
   */
  async listRuns(): Promise<RunManifest[]> {
    const runsDir = join(this.basePath, 'runs');
    try {
      const entries = await readdir(runsDir);
      const manifests: RunManifest[] = [];
      for (const entry of entries) {
        const manifest = await this.loadRun(entry);
        if (manifest) manifests.push(manifest);
      }
      manifests.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return manifests;
    } catch (err: unknown) {
      if (isNotFoundError(err)) return [];
      throw err;
    }
  }

  /**
   * Get the most recent run.
   */
  async getLatestRun(): Promise<RunManifest | null> {
    const runs = await this.listRuns();
    return runs[0] ?? null;
  }

  // ─── Candidate Management ─────────────────────────────

  /**
   * Write a candidate's manifest and config to the archive.
   */
  async writeCandidate(
    runId: string,
    manifest: CandidateManifest,
    config: HarnessConfig,
  ): Promise<void> {
    const dir = this.candidateDir(runId, manifest.candidateId);
    await this.ensureDir(dir);
    await this.ensureDir(this.resultsDir(runId, manifest.candidateId));
    await this.ensureDir(this.tracesDir(runId, manifest.candidateId));

    await Promise.all([
      writeFile(
        join(dir, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
        'utf-8',
      ),
      writeFile(
        join(dir, 'config.yaml'),
        stringifyYaml(config),
        'utf-8',
      ),
    ]);
  }

  /**
   * Load a candidate manifest. Returns null if not found.
   */
  async loadCandidate(runId: string, candidateId: string): Promise<CandidateManifest | null> {
    try {
      const content = await readFile(
        join(this.candidateDir(runId, candidateId), 'manifest.json'),
        'utf-8',
      );
      return JSON.parse(content) as CandidateManifest;
    } catch (err: unknown) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  /**
   * Load a candidate's harness config. Returns null if not found.
   */
  async loadCandidateConfig(runId: string, candidateId: string): Promise<HarnessConfig | null> {
    try {
      const { parse: parseYaml } = await import('yaml');
      const content = await readFile(
        join(this.candidateDir(runId, candidateId), 'config.yaml'),
        'utf-8',
      );
      return parseYaml(content) as HarnessConfig;
    } catch (err: unknown) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  /**
   * List all candidates in a run.
   */
  async listCandidates(runId: string): Promise<CandidateManifest[]> {
    const dir = join(this.runDir(runId), 'candidates');
    try {
      const entries = await readdir(dir);
      const candidates: CandidateManifest[] = [];
      for (const entry of entries) {
        const manifest = await this.loadCandidate(runId, entry);
        if (manifest) candidates.push(manifest);
      }
      return candidates;
    } catch (err: unknown) {
      if (isNotFoundError(err)) return [];
      throw err;
    }
  }

  // ─── Results ──────────────────────────────────────────

  /**
   * Write an evaluation result for a task.
   */
  async writeResult(
    runId: string,
    candidateId: string,
    result: EvalResult,
  ): Promise<void> {
    const dir = this.resultsDir(runId, candidateId);
    await this.ensureDir(dir);

    // Include repeat index in filename for multi-run support
    const filename = result.repeatIndex > 0
      ? `${result.taskId}-run${result.repeatIndex}.json`
      : `${result.taskId}.json`;

    await writeFile(
      join(dir, filename),
      JSON.stringify(result, null, 2),
      'utf-8',
    );
  }

  /**
   * Load all results for a candidate.
   */
  async loadResults(runId: string, candidateId: string): Promise<EvalResult[]> {
    const dir = this.resultsDir(runId, candidateId);
    try {
      const entries = await readdir(dir);
      const results: EvalResult[] = [];
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const content = await readFile(join(dir, entry), 'utf-8');
        results.push(JSON.parse(content) as EvalResult);
      }
      return results;
    } catch (err: unknown) {
      if (isNotFoundError(err)) return [];
      throw err;
    }
  }

  // ─── Traces ───────────────────────────────────────────

  /**
   * Write redacted trace events for a task (JSONL format).
   */
  async writeTrace(
    runId: string,
    candidateId: string,
    taskId: string,
    events: TraceEvent[],
  ): Promise<void> {
    const dir = this.tracesDir(runId, candidateId);
    await this.ensureDir(dir);

    const jsonl = events.map(e => JSON.stringify(e)).join('\n') + '\n';
    await writeFile(join(dir, `${taskId}.jsonl`), jsonl, 'utf-8');
  }

  /**
   * Load trace events for a task.
   */
  async loadTrace(
    runId: string,
    candidateId: string,
    taskId: string,
  ): Promise<TraceEvent[]> {
    try {
      const content = await readFile(
        join(this.tracesDir(runId, candidateId), `${taskId}.jsonl`),
        'utf-8',
      );
      return content
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as TraceEvent);
    } catch (err: unknown) {
      if (isNotFoundError(err)) return [];
      throw err;
    }
  }

  // ─── Scores ───────────────────────────────────────────

  /**
   * Write aggregate scores for a candidate.
   */
  async writeScores(
    runId: string,
    candidateId: string,
    scores: Record<string, unknown>,
  ): Promise<void> {
    const dir = this.candidateDir(runId, candidateId);
    await this.ensureDir(dir);
    await writeFile(
      join(dir, 'scores.json'),
      JSON.stringify(scores, null, 2),
      'utf-8',
    );
  }

  /**
   * Load aggregate scores for a candidate.
   */
  async loadScores(
    runId: string,
    candidateId: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      const content = await readFile(
        join(this.candidateDir(runId, candidateId), 'scores.json'),
        'utf-8',
      );
      return JSON.parse(content);
    } catch (err: unknown) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  // ─── Datasets ─────────────────────────────────────────

  /**
   * Ensure the datasets directory exists and return its path.
   */
  async ensureDatasetDir(): Promise<string> {
    const dir = this.datasetsDir();
    await this.ensureDir(dir);
    return dir;
  }

  /**
   * Check if a dataset exists.
   */
  async datasetExists(name: string): Promise<boolean> {
    try {
      await stat(join(this.datasetsDir(), name));
      return true;
    } catch {
      return false;
    }
  }
}

// ─── Helpers ──────────────────────────────────────────

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
