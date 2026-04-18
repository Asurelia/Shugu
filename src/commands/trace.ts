/**
 * /trace and /health commands — Observability
 *
 * /trace               — show recent events from memory buffer
 * /trace <traceId>     — show events for a specific trace
 * /trace sessions      — list past sessions on disk
 * /trace session       — show current session summary (dir + counts)
 * /trace where         — print paths where monitoring data is stored
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command, CommandContext, CommandResult } from './registry.js';
import { tracer } from '../utils/tracer.js';

// ─── /trace ───────────────────────────────────────────

export const traceCommand: Command = {
  name: 'trace',
  aliases: ['traces'],
  description: 'Inspect trace events, sessions, and monitoring paths',
  async execute(args: string, ctx: CommandContext): Promise<CommandResult> {
    const arg = args.trim();

    if (arg === 'where') return printPaths(ctx);
    if (arg === 'session' || arg === 'current') return printCurrentSession(ctx);
    if (arg === 'sessions' || arg === 'list') return listSessions(ctx);

    if (arg) {
      // Show specific trace from in-memory buffer
      const events = tracer.getTraceEvents(arg);
      if (events.length === 0) {
        ctx.info(`  No events found for trace: ${arg}`);
        return { type: 'handled' };
      }
      ctx.info(`\n  Trace ${arg} (${events.length} events):\n`);
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
      ctx.info('  No trace events yet. Try /trace where to see storage paths.');
      return { type: 'handled' };
    }

    ctx.info('\n  Recent trace events:\n');
    for (const e of events) {
      const dur = e.durationMs ? ` (${e.durationMs}ms)` : '';
      const time = e.timestamp.split('T')[1]?.slice(0, 8) ?? '';
      const color = EVENT_COLORS[e.type] ?? '';
      ctx.info(`  ${time} [${e.traceId}] ${color}${e.type}\x1b[0m${dur} ${formatData(e.data)}`);
    }
    ctx.info('\n  \x1b[2mTip: /trace session for current session info, /trace sessions to list past sessions.\x1b[0m');
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
    if (tracer.sessionId) ctx.info(`  Session:        ${tracer.sessionId}`);
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

    if (tracer.sessionDir) {
      ctx.info(`\n  \x1b[2mFull I/O: ${tracer.sessionDir}\x1b[0m`);
    }

    return { type: 'handled' };
  },
};

// ─── Helpers ──────────────────────────────────────────

async function printPaths(ctx: CommandContext): Promise<CommandResult> {
  ctx.info('\n  \x1b[1mMonitoring storage paths\x1b[0m\n');
  ctx.info(`  Base dir:        ${tracer.baseDir}`);
  ctx.info(`  Current session: ${tracer.sessionDir ?? '(none — legacy mode)'}`);
  if (tracer.sessionDir) {
    ctx.info(`    events.jsonl       — all trace events (append-only)`);
    ctx.info(`    model-calls/       — full system prompt + messages + response per call`);
    ctx.info(`    tool-calls/        — full tool input/output per call`);
    ctx.info(`    agents/            — full transcripts for spawned sub-agents`);
    ctx.info(`    system-prompts/    — deduplicated system prompt snapshots`);
    ctx.info(`    manifest.json      — session metadata`);
  }
  ctx.info(`\n  \x1b[2mOverride base dir: export SHUGU_TRACE_DIR=/custom/path\x1b[0m`);
  return { type: 'handled' };
}

async function printCurrentSession(ctx: CommandContext): Promise<CommandResult> {
  if (!tracer.sessionId || !tracer.sessionDir) {
    ctx.info('  No active session (legacy mode — events in ~/.pcc/traces/).');
    return { type: 'handled' };
  }
  ctx.info(`\n  \x1b[1mCurrent session\x1b[0m\n`);
  ctx.info(`  ID:     ${tracer.sessionId}`);
  ctx.info(`  Dir:    ${tracer.sessionDir}`);
  await printCounts(ctx, tracer.sessionDir);
  return { type: 'handled' };
}

async function listSessions(ctx: CommandContext): Promise<CommandResult> {
  const sessions = await tracer.listSessions(20);
  if (sessions.length === 0) {
    ctx.info(`  No past sessions found under ${tracer.baseDir}/sessions/.`);
    return { type: 'handled' };
  }
  ctx.info(`\n  \x1b[1mRecent sessions\x1b[0m\n`);
  for (const s of sessions) {
    const end = s.endedAt ? `ended ${s.endedAt.split('T')[1]?.slice(0, 8)}` : '\x1b[32mlive\x1b[0m';
    ctx.info(`  ${s.sessionId}  pid=${s.pid}  model=${s.model ?? '?'}  ${end}`);
    ctx.info(`    cwd: ${s.cwd}`);
  }
  return { type: 'handled' };
}

async function printCounts(ctx: CommandContext, dir: string): Promise<void> {
  const entries: Array<{ name: string; count: number; kind: string }> = [];
  for (const sub of ['model-calls', 'tool-calls', 'agents', 'system-prompts']) {
    try {
      const p = join(dir, sub);
      const st = await stat(p);
      if (!st.isDirectory()) continue;
      const list = await readdir(p);
      entries.push({ name: sub, count: list.length, kind: sub === 'agents' ? 'agents' : 'files' });
    } catch {
      // missing — skip
    }
  }
  if (entries.length === 0) return;
  ctx.info('  Contents:');
  for (const e of entries) ctx.info(`    ${e.name.padEnd(18)} ${e.count} ${e.kind}`);
}

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
  session_start: '\x1b[35m',
  session_end: '\x1b[35m',
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
