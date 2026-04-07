/**
 * Bundled Skill: Schedule
 *
 * Create, list, and manage scheduled agent tasks using the automation scheduler.
 *
 * Usage:
 * - /schedule add "0 9 * * *" "Review PRs and summarize"
 * - /schedule list
 * - /schedule remove <id>
 * - /schedule run <id>       — force-run immediately
 * - /schedule enable <id>
 * - /schedule disable <id>
 */

import type { Skill, SkillContext, SkillResult } from '../loader.js';
import { Scheduler, type ScheduledJob } from '../../automation/scheduler.js';

// Shared scheduler instance — initialized once, reused
let sharedScheduler: Scheduler | null = null;

export function getSharedScheduler(): Scheduler {
  if (!sharedScheduler) {
    sharedScheduler = new Scheduler();
  }
  return sharedScheduler;
}

export const scheduleSkill: Skill = {
  name: 'schedule',
  description: 'Create and manage scheduled agent tasks (cron-based or interval)',
  category: 'automation',
  triggers: [
    { type: 'command', command: 'schedule' },
    { type: 'command', command: 'cron' },
  ],

  async execute(ctx: SkillContext): Promise<SkillResult> {
    const scheduler = getSharedScheduler();
    scheduler.setExecutor((job) => ctx.runAgent(job.prompt));
    const args = ctx.args.trim();
    const parts = args.split(/\s+/);
    const subcommand = parts[0]?.toLowerCase() ?? '';

    switch (subcommand) {
      case 'add': {
        // /schedule add "cron-expr" "prompt"
        // Parse quoted strings
        const quotedMatch = args.slice(4).match(/"([^"]+)"\s+"([^"]+)"/);
        if (!quotedMatch) {
          return {
            type: 'error',
            message: 'Usage: /schedule add "<cron-expression>" "<prompt>"\nExample: /schedule add "0 9 * * 1-5" "Check CI status and report"',
          };
        }

        const cronExpr = quotedMatch[1]!;
        const prompt = quotedMatch[2]!;

        try {
          const job = scheduler.addJob({
            name: prompt.slice(0, 40),
            prompt,
            schedule: { type: 'cron', expression: cronExpr },
            enabled: true,
          });

          ctx.info(`✓ Scheduled job ${job.id}: "${job.name}"`);
          ctx.info(`  Cron: ${cronExpr}`);
          ctx.info(`  Note: start the scheduler with /schedule start`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { type: 'error', message: `Invalid schedule: ${msg}` };
        }

        return { type: 'handled' };
      }

      case 'interval': {
        // /schedule interval <ms> "prompt"
        const ms = parseInt(parts[1] ?? '', 10);
        const promptMatch = args.match(/"([^"]+)"/);

        if (isNaN(ms) || !promptMatch) {
          return {
            type: 'error',
            message: 'Usage: /schedule interval <ms> "<prompt>"\nExample: /schedule interval 300000 "Check for new issues"',
          };
        }

        const job = scheduler.addJob({
          name: promptMatch[1]!.slice(0, 40),
          prompt: promptMatch[1]!,
          schedule: { type: 'interval', ms },
          enabled: true,
        });

        ctx.info(`✓ Interval job ${job.id}: every ${ms}ms`);
        return { type: 'handled' };
      }

      case 'list': {
        const jobs = scheduler.listJobs();
        if (jobs.length === 0) {
          ctx.info('No scheduled jobs. Use /schedule add to create one.');
          return { type: 'handled' };
        }

        ctx.info(`Scheduled jobs (${jobs.length}):`);
        for (const job of jobs) {
          const status = job.enabled ? '✓' : '✗';
          const schedule = job.schedule.type === 'cron'
            ? `cron: ${job.schedule.expression}`
            : `every ${job.schedule.ms}ms`;
          const lastRun = job.lastRunAt ? ` | last: ${job.lastRunAt}` : '';
          ctx.info(`  ${status} ${job.id}: ${job.name} [${schedule}] (runs: ${job.runCount}${lastRun})`);
        }
        return { type: 'handled' };
      }

      case 'remove':
      case 'delete': {
        const id = parts[1];
        if (!id) {
          return { type: 'error', message: 'Usage: /schedule remove <job-id>' };
        }
        if (scheduler.removeJob(id)) {
          ctx.info(`Removed job ${id}`);
        } else {
          ctx.error(`Job "${id}" not found`);
        }
        return { type: 'handled' };
      }

      case 'run': {
        const id = parts[1];
        if (!id) {
          return { type: 'error', message: 'Usage: /schedule run <job-id>' };
        }
        ctx.info(`Running job ${id}...`);
        try {
          const result = await scheduler.runNow(id);
          ctx.info(`Job ${id} completed: ${result.slice(0, 200)}`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          ctx.error(`Job ${id} failed: ${msg}`);
        }
        return { type: 'handled' };
      }

      case 'enable': {
        const id = parts[1];
        if (!id) return { type: 'error', message: 'Usage: /schedule enable <job-id>' };
        scheduler.setJobEnabled(id, true);
        ctx.info(`Enabled job ${id}`);
        return { type: 'handled' };
      }

      case 'disable': {
        const id = parts[1];
        if (!id) return { type: 'error', message: 'Usage: /schedule disable <job-id>' };
        scheduler.setJobEnabled(id, false);
        ctx.info(`Disabled job ${id}`);
        return { type: 'handled' };
      }

      case 'start': {
        scheduler.start();
        ctx.info('Scheduler started — cron jobs will fire on schedule.');
        return { type: 'handled' };
      }

      case 'stop': {
        scheduler.stop();
        ctx.info('Scheduler stopped.');
        return { type: 'handled' };
      }

      default: {
        ctx.info('Usage: /schedule <add|interval|list|remove|run|enable|disable|start|stop>');
        ctx.info('  add "<cron>" "<prompt>"    — add a cron-scheduled job');
        ctx.info('  interval <ms> "<prompt>"   — add an interval job');
        ctx.info('  list                       — list all jobs');
        ctx.info('  remove <id>                — remove a job');
        ctx.info('  run <id>                   — force-run a job now');
        ctx.info('  start / stop               — start/stop the scheduler');
        return { type: 'handled' };
      }
    }
  },
};
