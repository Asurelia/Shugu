/**
 * Tests for Layer 9 — Automation: Scheduler
 */

import { describe, it, expect } from 'vitest';
import { parseCron, cronMatches, Scheduler, type ScheduledJob } from '../src/automation/scheduler.js';

describe('Cron parser', () => {
  it('parses wildcard expression', () => {
    const schedule = parseCron('* * * * *');
    expect(schedule.minute).toBeNull();
    expect(schedule.hour).toBeNull();
    expect(schedule.dayOfMonth).toBeNull();
    expect(schedule.month).toBeNull();
    expect(schedule.dayOfWeek).toBeNull();
  });

  it('parses specific values', () => {
    const schedule = parseCron('30 9 * * *');
    expect(schedule.minute).toEqual([30]);
    expect(schedule.hour).toEqual([9]);
    expect(schedule.dayOfMonth).toBeNull();
  });

  it('parses comma-separated values', () => {
    const schedule = parseCron('0,15,30,45 * * * *');
    expect(schedule.minute).toEqual([0, 15, 30, 45]);
  });

  it('parses step values', () => {
    const schedule = parseCron('*/15 * * * *');
    expect(schedule.minute).toEqual([0, 15, 30, 45]);
  });

  it('parses step with base', () => {
    const schedule = parseCron('5/10 * * * *');
    expect(schedule.minute).toEqual([5, 15, 25, 35, 45, 55]);
  });

  it('throws on invalid expression (wrong field count)', () => {
    expect(() => parseCron('* * *')).toThrow('expected 5 fields');
  });

  it('throws on out-of-range values', () => {
    expect(() => parseCron('60 * * * *')).toThrow();
    expect(() => parseCron('* 25 * * *')).toThrow();
    expect(() => parseCron('* * 0 * *')).toThrow(); // day-of-month starts at 1
  });

  it('throws on invalid step', () => {
    expect(() => parseCron('*/0 * * * *')).toThrow('Invalid step');
  });
});

describe('Cron matching', () => {
  it('wildcard matches any time', () => {
    const schedule = parseCron('* * * * *');
    expect(cronMatches(schedule, new Date('2026-04-06T14:30:00'))).toBe(true);
    expect(cronMatches(schedule, new Date('2026-01-01T00:00:00'))).toBe(true);
  });

  it('matches specific minute and hour', () => {
    const schedule = parseCron('30 9 * * *');
    expect(cronMatches(schedule, new Date('2026-04-06T09:30:00'))).toBe(true);
    expect(cronMatches(schedule, new Date('2026-04-06T09:31:00'))).toBe(false);
    expect(cronMatches(schedule, new Date('2026-04-06T10:30:00'))).toBe(false);
  });

  it('matches day of week (0=Sunday)', () => {
    const schedule = parseCron('0 9 * * 1'); // Monday at 9:00
    // 2026-04-06 is a Monday
    expect(cronMatches(schedule, new Date('2026-04-06T09:00:00'))).toBe(true);
    expect(cronMatches(schedule, new Date('2026-04-07T09:00:00'))).toBe(false); // Tuesday
  });

  it('matches stepped minutes', () => {
    const schedule = parseCron('*/15 * * * *');
    expect(cronMatches(schedule, new Date('2026-04-06T10:00:00'))).toBe(true);
    expect(cronMatches(schedule, new Date('2026-04-06T10:15:00'))).toBe(true);
    expect(cronMatches(schedule, new Date('2026-04-06T10:07:00'))).toBe(false);
  });
});

describe('Scheduler', () => {
  it('adds and lists jobs', () => {
    const scheduler = new Scheduler();
    const job = scheduler.addJob({
      name: 'test-job',
      prompt: 'check CI',
      schedule: { type: 'interval', ms: 60000 },
      enabled: true,
    });

    expect(job.id).toMatch(/^job-/);
    expect(job.name).toBe('test-job');
    expect(job.runCount).toBe(0);

    const jobs = scheduler.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.id).toBe(job.id);
  });

  it('removes jobs', () => {
    const scheduler = new Scheduler();
    const job = scheduler.addJob({
      name: 'removable',
      prompt: 'test',
      schedule: { type: 'interval', ms: 1000 },
      enabled: true,
    });

    expect(scheduler.listJobs()).toHaveLength(1);
    expect(scheduler.removeJob(job.id)).toBe(true);
    expect(scheduler.listJobs()).toHaveLength(0);
  });

  it('enables and disables jobs', () => {
    const scheduler = new Scheduler();
    const job = scheduler.addJob({
      name: 'toggleable',
      prompt: 'test',
      schedule: { type: 'interval', ms: 1000 },
      enabled: true,
    });

    expect(job.enabled).toBe(true);
    scheduler.setJobEnabled(job.id, false);
    expect(scheduler.getJob(job.id)!.enabled).toBe(false);
    scheduler.setJobEnabled(job.id, true);
    expect(scheduler.getJob(job.id)!.enabled).toBe(true);
  });

  it('validates cron expression on job creation', () => {
    const scheduler = new Scheduler();
    expect(() =>
      scheduler.addJob({
        name: 'bad-cron',
        prompt: 'test',
        schedule: { type: 'cron', expression: 'invalid' },
        enabled: true,
      }),
    ).toThrow();
  });

  it('throws when running without executor', async () => {
    const scheduler = new Scheduler();
    const job = scheduler.addJob({
      name: 'no-exec',
      prompt: 'test',
      schedule: { type: 'interval', ms: 1000 },
      enabled: true,
    });

    await expect(scheduler.runNow(job.id)).rejects.toThrow('No executor set');
  });

  it('executes a job with executor', async () => {
    const scheduler = new Scheduler();
    scheduler.setExecutor(async (job) => `Result for: ${job.prompt}`);

    const job = scheduler.addJob({
      name: 'exec-test',
      prompt: 'hello',
      schedule: { type: 'interval', ms: 60000 },
      enabled: true,
    });

    const result = await scheduler.runNow(job.id);
    expect(result).toBe('Result for: hello');
    expect(scheduler.getJob(job.id)!.runCount).toBe(1);
    expect(scheduler.getJob(job.id)!.lastRunAt).toBeTruthy();
  });
});
