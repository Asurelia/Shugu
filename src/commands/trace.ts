/**
 * /trace and /health commands — Observability
 */

import type { Command, CommandContext, CommandResult } from './registry.js';
import { tracer } from '../utils/tracer.js';

// ─── /trace ───────────────────────────────────────────

export const traceCommand: Command = {
  name: 'trace',
  aliases: ['traces'],
  description: 'Show recent trace events or detail for a specific trace',
  async execute(args: string, ctx: CommandContext): Promise<CommandResult> {
    const traceId = args.trim();

    if (traceId) {
      // Show specific trace
      const events = tracer.getTraceEvents(traceId);
      if (events.length === 0) {
        ctx.info(`  No events found for trace: ${traceId}`);
        return { type: 'handled' };
      }
      ctx.info(`\n  Trace ${traceId} (${events.length} events):\n`);
      for (const e of events) {
        const dur = e.durationMs ? ` (${e.durationMs}ms)` : '';
        const time = e.timestamp.split('T')[1]?.slice(0, 8) ?? '';
        ctx.info(`  ${time} \x1b[33m${e.type}\x1b[0m${dur} ${formatData(e.data)}`);
      }
      return { type: 'handled' };
    }

    // Show recent events
    const events = tracer.getRecentEvents(20);
    if (events.length === 0) {
      ctx.info('  No trace events yet.');
      return { type: 'handled' };
    }

    ctx.info('\n  Recent trace events:\n');
    for (const e of events) {
      const dur = e.durationMs ? ` (${e.durationMs}ms)` : '';
      const time = e.timestamp.split('T')[1]?.slice(0, 8) ?? '';
      const color = EVENT_COLORS[e.type] ?? '';
      ctx.info(`  ${time} [${e.traceId}] ${color}${e.type}\x1b[0m${dur} ${formatData(e.data)}`);
    }
    return { type: 'handled' };
  },
};

// ─── /health ──────────────────────────────────────────

export const healthCommand: Command = {
  name: 'health',
  aliases: ['stats', 'dashboard'],
  description: 'Show session health dashboard',
  async execute(_args: string, ctx: CommandContext): Promise<CommandResult> {
    const stats = tracer.getStats();

    ctx.info('\n  \x1b[1mSession Health Dashboard\x1b[0m\n');
    ctx.info(`  Model calls:    ${stats.modelCalls}`);
    ctx.info(`  Tool calls:     ${stats.toolCalls}`);
    ctx.info(`  Agent spawns:   ${stats.agentSpawns}`);
    ctx.info(`  Errors:         ${stats.errors > 0 ? `\x1b[31m${stats.errors}\x1b[0m` : '0'}`);
    ctx.info(`  Tokens in:      ${stats.totalTokensIn.toLocaleString()}`);
    ctx.info(`  Tokens out:     ${stats.totalTokensOut.toLocaleString()}`);
    ctx.info(`  Avg duration:   ${stats.avgDurationMs}ms`);

    if (Object.keys(stats.toolFrequency).length > 0) {
      ctx.info('\n  Tool usage:');
      const sorted = Object.entries(stats.toolFrequency).sort((a, b) => b[1] - a[1]);
      for (const [tool, count] of sorted) {
        const bar = '\x1b[36m' + '█'.repeat(Math.min(count, 30)) + '\x1b[0m';
        ctx.info(`    ${tool.padEnd(12)} ${bar} ${count}`);
      }
    }

    return { type: 'handled' };
  },
};

// ─── Helpers ──────────────────────────────────────────

const EVENT_COLORS: Record<string, string> = {
  user_input: '\x1b[32m',
  model_call: '\x1b[34m',
  model_response: '\x1b[34m',
  thinking: '\x1b[90m',
  tool_call: '\x1b[33m',
  tool_result: '\x1b[33m',
  agent_spawn: '\x1b[36m',
  agent_done: '\x1b[36m',
  error: '\x1b[31m',
  strategy: '\x1b[35m',
  memory_save: '\x1b[32m',
};

function formatData(data: Record<string, unknown>): string {
  const parts: string[] = [];
  if (data['tool']) parts.push(String(data['tool']));
  if (data['model']) parts.push(String(data['model']));
  if (data['query']) parts.push(`"${String(data['query']).slice(0, 40)}"`);
  if (data['input']) parts.push(String(data['input']).slice(0, 50));
  if (data['message']) parts.push(String(data['message']).slice(0, 50));
  if (data['error']) parts.push(`\x1b[31m${String(data['error']).slice(0, 60)}\x1b[0m`);
  if (data['input_tokens']) parts.push(`↓${data['input_tokens']}`);
  if (data['output_tokens']) parts.push(`↑${data['output_tokens']}`);
  return parts.length > 0 ? `\x1b[2m${parts.join(' | ')}\x1b[0m` : '';
}
