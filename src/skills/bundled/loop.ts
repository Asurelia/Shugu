/**
 * Bundled Skill: Loop
 *
 * Run a prompt or command on a recurring interval.
 * Useful for monitoring, polling, and recurring maintenance tasks.
 *
 * Usage:
 * - /loop 5m check CI status        → check CI every 5 minutes
 * - /loop 1h run tests              → run tests every hour
 * - /loop 30s git status            → git status every 30 seconds
 * - /loop stop                      → stop all running loops
 */

import type { Skill, SkillContext, SkillResult } from '../loader.js';

// Active loops tracked globally
const activeLoops = new Map<string, { timer: ReturnType<typeof setInterval>; description: string }>();
let loopCounter = 0;

function parseInterval(input: string): number | null {
  const match = input.match(/^(\d+)(s|m|h)$/);
  if (!match) return null;

  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;

  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60_000;
    case 'h': return value * 3_600_000;
    default: return null;
  }
}

export const loopSkill: Skill = {
  name: 'loop',
  description: 'Run a prompt or command on a recurring interval (e.g., /loop 5m check CI)',
  category: 'utility',
  triggers: [
    { type: 'command', command: 'loop' },
  ],

  async execute(ctx: SkillContext): Promise<SkillResult> {
    const args = ctx.args.trim();

    // /loop stop — stop all loops
    if (args === 'stop' || args === 'stop all') {
      const count = activeLoops.size;
      for (const [id, loop] of activeLoops) {
        clearInterval(loop.timer);
      }
      activeLoops.clear();
      ctx.info(`Stopped ${count} active loop(s).`);
      return { type: 'handled' };
    }

    // /loop list — show active loops
    if (args === 'list' || args === '') {
      if (activeLoops.size === 0) {
        ctx.info('No active loops. Usage: /loop <interval> <prompt>');
        ctx.info('Examples: /loop 5m check CI, /loop 30s git status, /loop stop');
        return { type: 'handled' };
      }
      ctx.info('Active loops:');
      for (const [id, loop] of activeLoops) {
        ctx.info(`  ${id}: ${loop.description}`);
      }
      return { type: 'handled' };
    }

    // /loop stop <id> — stop specific loop
    if (args.startsWith('stop ')) {
      const id = args.slice(5).trim();
      const loop = activeLoops.get(id);
      if (loop) {
        clearInterval(loop.timer);
        activeLoops.delete(id);
        ctx.info(`Stopped loop ${id}: ${loop.description}`);
      } else {
        ctx.error(`Loop "${id}" not found. Use /loop list to see active loops.`);
      }
      return { type: 'handled' };
    }

    // Parse: /loop <interval> <prompt>
    const parts = args.split(/\s+/);
    const intervalStr = parts[0];
    const prompt = parts.slice(1).join(' ');

    if (!intervalStr || !prompt) {
      return {
        type: 'error',
        message: 'Usage: /loop <interval> <prompt>\nInterval: 30s, 5m, 1h\nExample: /loop 5m check CI status',
      };
    }

    const intervalMs = parseInterval(intervalStr);
    if (!intervalMs) {
      return {
        type: 'error',
        message: `Invalid interval: "${intervalStr}". Use format: 30s, 5m, 1h`,
      };
    }

    const loopId = `loop-${++loopCounter}`;
    const description = `every ${intervalStr}: ${prompt}`;

    ctx.info(`Starting loop ${loopId}: ${description}`);
    ctx.info(`(Use /loop stop ${loopId} to stop, or /loop stop to stop all)`);

    // Run immediately once
    const runOnce = async () => {
      ctx.info(`\n[${loopId}] Running: ${prompt}`);
      try {
        const result = await ctx.runAgent(prompt);
        ctx.info(`[${loopId}] Done.`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        ctx.error(`[${loopId}] Error: ${msg}`);
      }
    };

    // Start recurring
    const timer = setInterval(runOnce, intervalMs);
    activeLoops.set(loopId, { timer, description });

    // Run first iteration immediately
    runOnce().catch((err) => {
      ctx.error(`[${loopId}] First iteration failed: ${err instanceof Error ? err.message : String(err)}`);
    });

    return { type: 'handled' };
  },
};
