/**
 * Layer 7 — Commands: Automation slash commands
 *
 * Factory functions that create commands with closures over automation instances.
 * /bg — background session management
 * /proactive — proactive loop (autonomous goal pursuit)
 */

import type { Command, CommandContext, CommandResult } from './registry.js';
import type { BackgroundManager } from '../automation/background.js';
import type { LoopConfig } from '../engine/loop.js';

// ─── /bg — Background Sessions ─────────────────────────

export function createBgCommand(
  bgManager: BackgroundManager,
  loopConfigFactory: () => LoopConfig,
): Command {
  return {
    name: 'bg',
    aliases: ['background'],
    description: 'Manage background sessions',
    usage: '/bg <prompt> | /bg list | /bg attach <id> | /bg kill <id>',
    async execute(args: string, ctx: CommandContext): Promise<CommandResult> {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0]?.toLowerCase() ?? '';

      if (sub === 'list' || sub === 'ls' || !args.trim()) {
        const sessions = bgManager.list();
        if (sessions.length === 0) {
          ctx.info('No background sessions. Usage: /bg <prompt>');
          return { type: 'handled' };
        }
        ctx.info(`Background sessions (${sessions.length}):`);
        for (const s of sessions) {
          const age = s.endedAt
            ? `done in ${Math.round((new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()) / 1000)}s`
            : 'running';
          ctx.info(`  ${s.status === 'running' ? '⚡' : '✓'} ${s.id}: ${s.name} (${s.turns}t, ${age})`);
        }
        return { type: 'handled' };
      }

      if (sub === 'attach') {
        const id = parts[1];
        if (!id) {
          return { type: 'error', message: 'Usage: /bg attach <session-id>' };
        }
        const session = bgManager.getSession(id);
        if (!session) {
          return { type: 'error', message: `Session "${id}" not found` };
        }
        ctx.info(`Attaching to ${id}...`);
        const unsub = bgManager.attach(id, (line) => ctx.info(`  [${id}] ${line}`));
        if (!unsub) {
          return { type: 'error', message: `Cannot attach to "${id}"` };
        }
        // Detach after showing current log (non-blocking)
        ctx.info(`Showing log for ${id} (${session.log.length} lines). Session status: ${session.status}`);
        return { type: 'handled' };
      }

      if (sub === 'kill' || sub === 'stop') {
        const id = parts[1];
        if (!id) {
          return { type: 'error', message: 'Usage: /bg kill <session-id>' };
        }
        if (bgManager.abort(id)) {
          ctx.info(`Aborted session ${id}`);
        } else {
          ctx.error(`Session "${id}" not found or not running`);
        }
        return { type: 'handled' };
      }

      if (sub === 'remove' || sub === 'rm') {
        const id = parts[1];
        if (!id) {
          return { type: 'error', message: 'Usage: /bg remove <session-id>' };
        }
        if (bgManager.remove(id)) {
          ctx.info(`Removed session ${id}`);
        } else {
          ctx.error(`Session "${id}" not found or still running`);
        }
        return { type: 'handled' };
      }

      // Default: start a new background session with the entire args as prompt
      const prompt = args.trim();
      const name = prompt.slice(0, 40);
      const config = loopConfigFactory();

      ctx.info(`Starting background session: ${name}`);
      const session = await bgManager.start(name, prompt, config);
      ctx.info(`  ID: ${session.id} — use /bg list to check status`);

      return { type: 'handled' };
    },
  };
}

// ─── /proactive — Proactive Loop ───────────────────────

export function createProactiveCommand(
  runAgentLoop: (prompt: string) => Promise<string>,
): Command {
  return {
    name: 'proactive',
    aliases: ['auto'],
    description: 'Start/stop proactive autonomous mode',
    usage: '/proactive <goal> | /proactive stop',
    async execute(args: string, ctx: CommandContext): Promise<CommandResult> {
      const trimmed = args.trim();

      if (trimmed === 'stop') {
        ctx.info('Use Ctrl+C to stop the current proactive loop.');
        return { type: 'handled' };
      }

      if (!trimmed) {
        ctx.info('Usage: /proactive <goal>\nExample: /proactive "Fix all TODO comments in src/"');
        return { type: 'handled' };
      }

      // Start proactive mode — inject the goal as a prompt
      ctx.info(`\n⚡ Proactive mode — goal: ${trimmed}`);
      ctx.info('The agent will work autonomously. Use /proactive stop to interrupt.\n');

      return {
        type: 'prompt',
        prompt: `[PROACTIVE MODE] Goal: ${trimmed}\n\nBegin working toward this goal autonomously. Do not ask for confirmation — proceed with your best judgment. When the goal is fully achieved, say "[GOAL_ACHIEVED]" as the first line of your response.`,
      };
    },
  };
}
