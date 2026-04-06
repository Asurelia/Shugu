/**
 * Structured Trace Logger — Full observability for Shugu
 *
 * Captures EVERYTHING that happens during a request:
 * - User inputs, model calls, thinking chains, tool calls, agent spawns, errors
 * - Correlation via traceId (1 per user request) and spanId (1 per operation)
 * - Parent-child nesting for agent → tool tracing
 *
 * Storage: ~/.pcc/traces/{date}.jsonl — 1 file per day, local only.
 * NEVER transmits data online. All telemetry stays on disk.
 */

import { appendFile, mkdir, stat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

// ─── Types ────────────────────────────────────────────

export type TraceEventType =
  | 'user_input'
  | 'model_call'
  | 'model_response'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'agent_spawn'
  | 'agent_done'
  | 'strategy'
  | 'memory_save'
  | 'error'
  | 'session_start'
  | 'session_end';

export interface TraceEvent {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  type: TraceEventType;
  timestamp: string;
  durationMs?: number;
  data: Record<string, unknown>;
}

// ─── Tracer ───────────────────────────────────────────

const TRACES_DIR = join(homedir(), '.pcc', 'traces');
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

let _currentTraceId: string | null = null;
let _currentSpanId: string | null = null;
let _verbose = false;
let _sessionEvents: TraceEvent[] = []; // In-memory buffer for /trace command

function getTraceFile(): string {
  const date = new Date().toISOString().split('T')[0];
  return join(TRACES_DIR, `${date}.jsonl`);
}

function genId(): string {
  return randomUUID().slice(0, 8);
}

async function writeEvent(event: TraceEvent): Promise<void> {
  try {
    await mkdir(TRACES_DIR, { recursive: true });

    // Rotation: if file > 50MB, it's fine — new day = new file
    const line = JSON.stringify(event) + '\n';
    await appendFile(getTraceFile(), line, 'utf-8');
  } catch {
    // Tracer must never throw
  }

  // Keep in memory for /trace command (last 200 events)
  _sessionEvents.push(event);
  if (_sessionEvents.length > 200) _sessionEvents.shift();
}

// ─── Public API ───────────────────────────────────────

export const tracer = {
  /** Start a new trace (1 per user request). Returns traceId. */
  startTrace(): string {
    _currentTraceId = genId();
    _currentSpanId = genId();
    return _currentTraceId;
  },

  /** Get current trace ID. */
  get traceId(): string | null {
    return _currentTraceId;
  },

  /** Create a child span (for nesting agent → tool). Returns spanId. */
  startSpan(parentSpanId?: string): string {
    const spanId = genId();
    _currentSpanId = spanId;
    return spanId;
  },

  /** Set verbose mode (show thinking + traces in UI). */
  setVerbose(v: boolean): void {
    _verbose = v;
  },

  get isVerbose(): boolean {
    return _verbose;
  },

  /** Log a trace event. */
  async log(type: TraceEventType, data: Record<string, unknown>, parentSpanId?: string): Promise<void> {
    const event: TraceEvent = {
      traceId: _currentTraceId ?? 'none',
      spanId: genId(),
      parentSpanId: parentSpanId ?? _currentSpanId ?? undefined,
      type,
      timestamp: new Date().toISOString(),
      data,
    };
    await writeEvent(event);
  },

  /** Log with duration (for timed operations). */
  async logTimed(type: TraceEventType, data: Record<string, unknown>, startMs: number, parentSpanId?: string): Promise<void> {
    const event: TraceEvent = {
      traceId: _currentTraceId ?? 'none',
      spanId: genId(),
      parentSpanId: parentSpanId ?? _currentSpanId ?? undefined,
      type,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      data,
    };
    await writeEvent(event);
  },

  /** Get recent events (for /trace command). */
  getRecentEvents(limit: number = 20): TraceEvent[] {
    return _sessionEvents.slice(-limit);
  },

  /** Get events for a specific traceId. */
  getTraceEvents(traceId: string): TraceEvent[] {
    return _sessionEvents.filter(e => e.traceId === traceId);
  },

  /** Load events from today's trace file (for cross-session viewing). */
  async loadTodayEvents(limit: number = 50): Promise<TraceEvent[]> {
    try {
      const content = await readFile(getTraceFile(), 'utf-8');
      const lines = content.trim().split('\n').slice(-limit);
      return lines.map(l => JSON.parse(l) as TraceEvent);
    } catch {
      return [];
    }
  },

  /** Get session statistics. */
  getStats(): TraceStats {
    const events = _sessionEvents;
    const modelCalls = events.filter(e => e.type === 'model_call' || e.type === 'model_response');
    const toolCalls = events.filter(e => e.type === 'tool_call');
    const agentSpawns = events.filter(e => e.type === 'agent_spawn');
    const errors = events.filter(e => e.type === 'error');

    const totalTokensIn = modelCalls.reduce((sum, e) => sum + ((e.data['input_tokens'] as number) ?? 0), 0);
    const totalTokensOut = modelCalls.reduce((sum, e) => sum + ((e.data['output_tokens'] as number) ?? 0), 0);

    const durations = events.filter(e => e.durationMs).map(e => e.durationMs!);
    const avgDuration = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;

    // Tool frequency
    const toolFreq = new Map<string, number>();
    for (const e of toolCalls) {
      const name = (e.data['tool'] as string) ?? 'unknown';
      toolFreq.set(name, (toolFreq.get(name) ?? 0) + 1);
    }

    return {
      totalEvents: events.length,
      modelCalls: modelCalls.length,
      toolCalls: toolCalls.length,
      agentSpawns: agentSpawns.length,
      errors: errors.length,
      totalTokensIn,
      totalTokensOut,
      avgDurationMs: avgDuration,
      toolFrequency: Object.fromEntries(toolFreq),
    };
  },

  /** Reset session buffer (for /clear). */
  reset(): void {
    _sessionEvents = [];
    _currentTraceId = null;
    _currentSpanId = null;
  },
};

export interface TraceStats {
  totalEvents: number;
  modelCalls: number;
  toolCalls: number;
  agentSpawns: number;
  errors: number;
  totalTokensIn: number;
  totalTokensOut: number;
  avgDurationMs: number;
  toolFrequency: Record<string, number>;
}
