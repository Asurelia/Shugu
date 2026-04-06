/**
 * Layer 9 — Automation: Scheduler
 *
 * Cron-like scheduling for recurring agent tasks.
 * Jobs run on intervals or cron expressions, each spawning
 * an agentic loop with a given prompt and tool set.
 *
 * Uses a simple tick-based approach — no external cron dependencies.
 * The scheduler runs in-process alongside the REPL.
 */

import { EventEmitter } from 'node:events';

// ─── Cron Expression Parser (minimal) ──────────────────

/**
 * Minimal cron parser supporting: minute hour day-of-month month day-of-week
 * Supports: numbers, *, /step, and comma-separated values.
 * Does NOT support: ranges (1-5), L, W, #, etc.
 */
export function parseCron(expr: string): CronSchedule {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: "${expr}" — expected 5 fields (min hour dom month dow)`);
  }

  return {
    minute: parseCronField(parts[0]!, 0, 59),
    hour: parseCronField(parts[1]!, 0, 23),
    dayOfMonth: parseCronField(parts[2]!, 1, 31),
    month: parseCronField(parts[3]!, 1, 12),
    dayOfWeek: parseCronField(parts[4]!, 0, 6),
  };
}

interface CronSchedule {
  minute: number[] | null;     // null = wildcard (every)
  hour: number[] | null;
  dayOfMonth: number[] | null;
  month: number[] | null;
  dayOfWeek: number[] | null;
}

function parseCronField(field: string, min: number, max: number): number[] | null {
  if (field === '*') return null;

  const values = new Set<number>();

  for (const part of field.split(',')) {
    if (part.includes('/')) {
      const [base, stepStr] = part.split('/');
      const step = parseInt(stepStr!, 10);
      if (isNaN(step) || step <= 0) throw new Error(`Invalid step: ${part}`);
      const start = base === '*' ? min : parseInt(base!, 10);
      for (let i = start; i <= max; i += step) {
        values.add(i);
      }
    } else {
      const val = parseInt(part, 10);
      if (isNaN(val) || val < min || val > max) {
        throw new Error(`Invalid cron value: ${part} (expected ${min}-${max})`);
      }
      values.add(val);
    }
  }

  return Array.from(values).sort((a, b) => a - b);
}

/**
 * Check if a Date matches a cron schedule.
 */
export function cronMatches(schedule: CronSchedule, date: Date): boolean {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const month = date.getMonth() + 1;
  const dow = date.getDay();

  if (schedule.minute && !schedule.minute.includes(minute)) return false;
  if (schedule.hour && !schedule.hour.includes(hour)) return false;
  if (schedule.dayOfMonth && !schedule.dayOfMonth.includes(dom)) return false;
  if (schedule.month && !schedule.month.includes(month)) return false;
  if (schedule.dayOfWeek && !schedule.dayOfWeek.includes(dow)) return false;

  return true;
}

// ─── Job Definition ────────────────────────────────────

export interface ScheduledJob {
  /** Unique job ID */
  id: string;
  /** Human-readable name */
  name: string;
  /** The prompt to execute when the job fires */
  prompt: string;
  /** Cron expression (5-field) OR interval in milliseconds */
  schedule: { type: 'cron'; expression: string } | { type: 'interval'; ms: number };
  /** Maximum execution time per run (ms) */
  timeoutMs?: number;
  /** Whether the job is currently enabled */
  enabled: boolean;
  /** When the job was created */
  createdAt: string;
  /** Last execution time (ISO) */
  lastRunAt?: string;
  /** Last execution result summary */
  lastResult?: string;
  /** Number of times this job has run */
  runCount: number;
  /** Working directory for the job */
  cwd?: string;
  /** Agent type to use (from orchestrator) */
  agentType?: string;
}

// ─── Scheduler Events ──────────────────────────────────

export interface SchedulerEvents {
  'job:start': (job: ScheduledJob) => void;
  'job:complete': (job: ScheduledJob, result: string) => void;
  'job:error': (job: ScheduledJob, error: Error) => void;
  'tick': (timestamp: Date) => void;
}

// ─── Job Executor Callback ─────────────────────────────

/**
 * Function that actually runs a job's prompt through the agentic loop.
 * Injected by the CLI/REPL that owns the engine.
 */
export type JobExecutor = (job: ScheduledJob) => Promise<string>;

// ─── Scheduler ─────────────────────────────────────────

export class Scheduler extends EventEmitter {
  private jobs = new Map<string, ScheduledJob>();
  private intervalTimers = new Map<string, ReturnType<typeof setInterval>>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private executor: JobExecutor | null = null;
  private running = new Set<string>();
  private jobCounter = 0;

  /**
   * Set the executor function that runs job prompts.
   * Must be called before starting the scheduler.
   */
  setExecutor(executor: JobExecutor): void {
    this.executor = executor;
  }

  /**
   * Start the scheduler tick (checks cron jobs every 60s).
   */
  start(): void {
    if (this.tickTimer) return;

    // Tick every 60 seconds for cron jobs
    this.tickTimer = setInterval(() => {
      this.tick();
    }, 60_000);

    // Also start all interval-based jobs
    for (const job of this.jobs.values()) {
      if (job.enabled && job.schedule.type === 'interval') {
        this.startIntervalJob(job);
      }
    }
  }

  /**
   * Stop the scheduler and all running jobs.
   */
  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    for (const [id, timer] of this.intervalTimers) {
      clearInterval(timer);
    }
    this.intervalTimers.clear();
  }

  /**
   * Add a new scheduled job.
   */
  addJob(config: Omit<ScheduledJob, 'id' | 'createdAt' | 'runCount'>): ScheduledJob {
    const job: ScheduledJob = {
      ...config,
      id: `job-${++this.jobCounter}`,
      createdAt: new Date().toISOString(),
      runCount: 0,
    };

    // Validate cron expression early
    if (job.schedule.type === 'cron') {
      parseCron(job.schedule.expression);
    }

    this.jobs.set(job.id, job);

    // If scheduler is running and this is an interval job, start it immediately
    if (this.tickTimer && job.enabled && job.schedule.type === 'interval') {
      this.startIntervalJob(job);
    }

    return job;
  }

  /**
   * Remove a job.
   */
  removeJob(id: string): boolean {
    const timer = this.intervalTimers.get(id);
    if (timer) {
      clearInterval(timer);
      this.intervalTimers.delete(id);
    }
    return this.jobs.delete(id);
  }

  /**
   * Enable/disable a job.
   */
  setJobEnabled(id: string, enabled: boolean): void {
    const job = this.jobs.get(id);
    if (!job) return;

    job.enabled = enabled;

    if (!enabled) {
      const timer = this.intervalTimers.get(id);
      if (timer) {
        clearInterval(timer);
        this.intervalTimers.delete(id);
      }
    } else if (job.schedule.type === 'interval' && this.tickTimer) {
      this.startIntervalJob(job);
    }
  }

  /**
   * Get all jobs.
   */
  listJobs(): ScheduledJob[] {
    return Array.from(this.jobs.values());
  }

  /**
   * Get a specific job.
   */
  getJob(id: string): ScheduledJob | undefined {
    return this.jobs.get(id);
  }

  /**
   * Whether a job is currently running.
   */
  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  /**
   * Force-run a job immediately (regardless of schedule).
   */
  async runNow(id: string): Promise<string> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    return this.executeJob(job);
  }

  // ─── Private ────────────────────────────────────────

  private tick(): void {
    const now = new Date();
    this.emit('tick', now);

    for (const job of this.jobs.values()) {
      if (!job.enabled) continue;
      if (job.schedule.type !== 'cron') continue;
      if (this.running.has(job.id)) continue;

      const schedule = parseCron(job.schedule.expression);
      if (cronMatches(schedule, now)) {
        this.executeJob(job).catch(() => {});
      }
    }
  }

  private startIntervalJob(job: ScheduledJob): void {
    if (job.schedule.type !== 'interval') return;
    if (this.intervalTimers.has(job.id)) return;

    const timer = setInterval(() => {
      if (!this.running.has(job.id) && job.enabled) {
        this.executeJob(job).catch(() => {});
      }
    }, job.schedule.ms);

    this.intervalTimers.set(job.id, timer);
  }

  private async executeJob(job: ScheduledJob): Promise<string> {
    if (!this.executor) {
      throw new Error('No executor set — call scheduler.setExecutor() first');
    }

    if (this.running.has(job.id)) {
      return '[Job already running]';
    }

    this.running.add(job.id);
    this.emit('job:start', job);

    try {
      // Apply timeout if configured
      let result: string;
      if (job.timeoutMs) {
        result = await Promise.race([
          this.executor(job),
          new Promise<string>((_, reject) =>
            setTimeout(() => reject(new Error('Job timed out')), job.timeoutMs),
          ),
        ]);
      } else {
        result = await this.executor(job);
      }

      job.lastRunAt = new Date().toISOString();
      job.lastResult = result.slice(0, 500);
      job.runCount++;
      this.emit('job:complete', job, result);
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      job.lastRunAt = new Date().toISOString();
      job.lastResult = `Error: ${err.message}`;
      job.runCount++;
      this.emit('job:error', job, err);
      throw err;
    } finally {
      this.running.delete(job.id);
    }
  }
}
