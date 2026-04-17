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

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { redactSensitive } from '../context/memory/agent.js';

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
  | 'session_end'
  | 'stage_change'
  | 'decision';

export type TrackerStage = 'idle' | 'input' | 'strategy' | 'model' | 'tool_exec' | 'tool_result' | 'reflection' | 'intelligence' | 'done';

export interface TraceEvent {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  type: TraceEventType;
  timestamp: string;
  durationMs?: number;
  data: Record<string, unknown>;
  /** Pipeline stage for real-time tracker visualization */
  stage?: TrackerStage;
  /** Agent identity for multi-agent tracking */
  agentId?: string;
}

// ─── Tracer ───────────────────────────────────────────

const TRACES_DIR = join(homedir(), '.pcc', 'traces');
const CALLS_DIR = join(TRACES_DIR, 'calls');
// Real-time event emitter for UI subscribers (TrackerPanel)
const _emitter = new EventEmitter();
_emitter.setMaxListeners(20);

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

function redactEventData(event: TraceEvent): TraceEvent {
  const redacted: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(event.data)) {
    if (typeof v === 'string') {
      redacted[k] = redactSensitive(v);
    } else if (v !== null && typeof v === 'object') {
      redacted[k] = JSON.parse(redactSensitive(JSON.stringify(v)));
    } else {
      redacted[k] = v;
    }
  }
  return { ...event, data: redacted };
}

async function writeEvent(event: TraceEvent): Promise<void> {
  // Redact before storing — safe wrapper to never throw
  let safe: TraceEvent;
  try {
    safe = redactEventData(event);
  } catch {
    safe = event; // If redaction fails (circular ref), store raw
  }

  // Push redacted event to memory buffer
  _sessionEvents.push(safe);
  if (_sessionEvents.length > 200) _sessionEvents.shift();

  // Emit for real-time subscribers
  _emitter.emit('event', safe);

  try {
    await mkdir(TRACES_DIR, { recursive: true });
    // Storage: one file per day (daily rollover, no size-based rotation).
    const line = JSON.stringify(safe) + '\n';
    await appendFile(getTraceFile(), line, 'utf-8');
  } catch {
    // Tracer must never throw
  }
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

  /**
   * Begin a new span and make it the "current" span for subsequent log()
   * calls. The returned spanId can be passed as the parentSpanId argument
   * to log()/logTimed() to attach nested events.
   *
   * NOTE: the previous implementation accepted a parentSpanId argument but
   * ignored it — events formed a linear chain (each new span overwrote
   * _currentSpanId). This signature now matches the actual behavior.
   * True tree-shaped tracing (per-agent span stacks) is tracked as a
   * separate improvement and is not required by current consumers.
   */
  startSpan(): string {
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

  /** Log a trace event, optionally with pipeline stage. */
  async log(type: TraceEventType, data: Record<string, unknown>, parentSpanId?: string, stage?: TrackerStage): Promise<void> {
    const event: TraceEvent = {
      traceId: _currentTraceId ?? 'none',
      spanId: genId(),
      parentSpanId: parentSpanId ?? _currentSpanId ?? undefined,
      type,
      timestamp: new Date().toISOString(),
      data,
      stage,
    };
    await writeEvent(event);
  },

  /** Log with duration (for timed operations). */
  async logTimed(type: TraceEventType, data: Record<string, unknown>, startMs: number, parentSpanId?: string, stage?: TrackerStage): Promise<void> {
    const event: TraceEvent = {
      traceId: _currentTraceId ?? 'none',
      spanId: genId(),
      parentSpanId: parentSpanId ?? _currentSpanId ?? undefined,
      type,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      data,
      stage,
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

  /** Subscribe to real-time trace events. Returns unsubscribe function. */
  onEvent(callback: (event: TraceEvent) => void): () => void {
    _emitter.on('event', callback);
    return () => { _emitter.off('event', callback); };
  },

  /** Get current pipeline stage from most recent event. */
  getCurrentStage(): TrackerStage {
    for (let i = _sessionEvents.length - 1; i >= 0; i--) {
      if (_sessionEvents[i]!.stage) return _sessionEvents[i]!.stage!;
    }
    return 'idle';
  },

  /** Get active (not yet completed) agents from session buffer. */
  getActiveAgents(): Array<{ id: string; type: string; startedAt: string }> {
    const spawns = _sessionEvents.filter(e => e.type === 'agent_spawn');
    const doneIds = new Set(
      _sessionEvents.filter(e => e.type === 'agent_done').map(e => (e.data['agentId'] as string) ?? e.spanId),
    );
    return spawns
      .filter(e => !doneIds.has((e.data['agentId'] as string) ?? e.spanId))
      .map(e => ({
        id: (e.data['agentId'] as string) ?? e.spanId,
        type: (e.data['agentType'] as string) ?? 'unknown',
        startedAt: e.timestamp,
      }));
  },

  /** Log a full model call to a dedicated per-call file for deep inspection. */
  async logModelCall(data: {
    traceId: string;
    spanId: string;
    prompt: string;
    response: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    toolsUsed?: string[];
  }): Promise<void> {
    try {
      await mkdir(CALLS_DIR, { recursive: true });
      const filename = `${data.traceId}-${data.spanId}.json`;
      await writeFile(join(CALLS_DIR, filename), JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      // Tracer must never throw
    }
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
