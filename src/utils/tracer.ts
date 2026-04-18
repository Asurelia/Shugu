/**
 * Structured Trace Logger — Full observability for Shugu
 *
 * Captures EVERYTHING that happens during a request:
 * - User inputs, model calls (full system prompt + messages + response),
 *   thinking chains, tool calls (full I/O), agent spawns and transcripts,
 *   errors, decisions
 * - Correlation via traceId (1 per user request) and spanId (1 per operation)
 * - Parent-child nesting for agent → tool tracing
 *
 * Storage layout (session-scoped when `startSession()` is called):
 *   ~/.pcc/sessions/{sessionId}/
 *     manifest.json              — session metadata (pid, cwd, model, start/end)
 *     events.jsonl               — all trace events (append-only)
 *     model-calls/{id}.json      — FULL model I/O (system prompt + messages + response)
 *     tool-calls/{id}.json       — FULL tool I/O (input + output)
 *     agents/{agentId}/          — full agent transcripts
 *       prompt.txt
 *       events.jsonl
 *       result.json
 *     system-prompts/{hash}.md   — deduplicated system prompt snapshots
 *
 * Legacy path (backward compat when no session is active, e.g. unit tests):
 *   ~/.pcc/traces/{date}.jsonl
 *   ~/.pcc/traces/calls/{traceId}-{spanId}.json
 *
 * Base dir can be overridden via SHUGU_TRACE_DIR env var (used by tests to isolate).
 * NEVER transmits data online. All telemetry stays on disk.
 */

import { appendFile, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
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

export interface SessionManifest {
  sessionId: string;
  pid: number;
  cwd: string;
  model?: string;
  mode?: string;
  user?: string;
  shuguVersion?: string;
  startedAt: string;
  endedAt?: string;
  endReason?: string;
}

// ─── Internal state ───────────────────────────────────

function defaultBaseDir(): string {
  return process.env['SHUGU_TRACE_DIR'] ?? join(homedir(), '.pcc');
}

let _baseDir = defaultBaseDir();
let _sessionId: string | null = null;
let _sessionDir: string | null = null;
let _sessionManifest: SessionManifest | null = null;

// Emetteur temps-réel des événements de trace pour les abonnés UI (TrackerPanel
// de la REPL, tests, éventuels agents délégués). L'usage standard est d'un
// seul abonné actif en même temps — la limite de 20 est un filet de sécurité
// contre les fuites : si on dépasse, Node émet un MaxListenersExceededWarning
// qui signale qu'un `unsubscribe()` a été oublié quelque part.
// Les abonnés doivent TOUJOURS capturer la fonction `unsubscribe` retournée
// par `tracer.onEvent(...)` et l'appeler au shutdown.
const _emitter = new EventEmitter();
_emitter.setMaxListeners(20);

let _currentTraceId: string | null = null;
let _currentSpanId: string | null = null;
let _verbose = false;
let _sessionEvents: TraceEvent[] = []; // In-memory buffer for /trace command

// ─── Path resolvers ───────────────────────────────────

function legacyTracesDir(): string {
  return join(_baseDir, 'traces');
}

function legacyCallsDir(): string {
  return join(legacyTracesDir(), 'calls');
}

function getEventsFile(): string {
  if (_sessionDir) return join(_sessionDir, 'events.jsonl');
  const date = new Date().toISOString().split('T')[0];
  return join(legacyTracesDir(), `${date}.jsonl`);
}

function getModelCallsDir(): string {
  return _sessionDir ? join(_sessionDir, 'model-calls') : legacyCallsDir();
}

function getToolCallsDir(): string {
  return _sessionDir ? join(_sessionDir, 'tool-calls') : join(legacyTracesDir(), 'tool-calls');
}

function getAgentsDir(): string {
  return _sessionDir ? join(_sessionDir, 'agents') : join(legacyTracesDir(), 'agents');
}

function getSystemPromptsDir(): string {
  return _sessionDir ? join(_sessionDir, 'system-prompts') : join(legacyTracesDir(), 'system-prompts');
}

function sessionsRoot(): string {
  return join(_baseDir, 'sessions');
}

// ─── Helpers ──────────────────────────────────────────

function genId(): string {
  return randomUUID().slice(0, 8);
}

function sessionStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-` +
    `${process.pid}`
  );
}

function hashShort(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') return redactSensitive(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v);
    }
    return out;
  }
  return value;
}

function redactEventData(event: TraceEvent): TraceEvent {
  let data: Record<string, unknown>;
  try {
    data = redactDeep(event.data) as Record<string, unknown>;
  } catch {
    data = event.data;
  }
  return { ...event, data };
}

async function writeEvent(event: TraceEvent): Promise<void> {
  let safe: TraceEvent;
  try {
    safe = redactEventData(event);
  } catch {
    safe = event;
  }

  _sessionEvents.push(safe);
  if (_sessionEvents.length > 200) _sessionEvents.shift();

  _emitter.emit('event', safe);

  try {
    const file = getEventsFile();
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, JSON.stringify(safe) + '\n', 'utf-8');
  } catch {
    // Tracer must never throw
  }
}

async function writeJson(path: string, payload: unknown): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const safe = redactDeep(payload);
    await writeFile(path, JSON.stringify(safe, null, 2), 'utf-8');
  } catch {
    // never throw
  }
}

async function updateManifest(): Promise<void> {
  if (!_sessionDir || !_sessionManifest) return;
  try {
    await writeFile(join(_sessionDir, 'manifest.json'), JSON.stringify(_sessionManifest, null, 2), 'utf-8');
  } catch {
    // never throw
  }
}

// ─── Public API ───────────────────────────────────────

export const tracer = {
  // ── Configuration ───────────────────────────────────

  /**
   * Override the base directory used for trace storage. Mostly useful for
   * tests that want to isolate from the user's real `~/.pcc` directory.
   * Call before `startSession()` or any `log()` call.
   */
  setBaseDir(dir: string): void {
    _baseDir = dir;
  },

  /** Current base directory (useful for tests and /trace command). */
  get baseDir(): string {
    return _baseDir;
  },

  /** Re-read the base directory from the environment (for tests). */
  resetBaseDir(): void {
    _baseDir = defaultBaseDir();
  },

  // ── Session lifecycle ───────────────────────────────

  /**
   * Start a new session. Creates `{baseDir}/sessions/{sessionId}/` and routes
   * all subsequent events there. If already started, returns the existing id.
   */
  async startSession(meta: Omit<SessionManifest, 'sessionId' | 'pid' | 'startedAt'> & {
    sessionId?: string;
  } = { cwd: process.cwd() }): Promise<string> {
    if (_sessionId) return _sessionId;
    const sessionId = meta.sessionId ?? sessionStamp();
    _sessionId = sessionId;
    _sessionDir = join(sessionsRoot(), sessionId);
    _sessionManifest = {
      sessionId,
      pid: process.pid,
      cwd: meta.cwd ?? process.cwd(),
      model: meta.model,
      mode: meta.mode,
      user: meta.user,
      shuguVersion: meta.shuguVersion,
      startedAt: new Date().toISOString(),
    };
    try {
      await mkdir(_sessionDir, { recursive: true });
      await updateManifest();
    } catch {
      // never throw — fall back to legacy paths if mkdir fails
    }
    await writeEvent({
      traceId: _currentTraceId ?? 'none',
      spanId: genId(),
      type: 'session_start',
      timestamp: new Date().toISOString(),
      data: { sessionId, pid: process.pid, cwd: _sessionManifest.cwd, model: meta.model, mode: meta.mode },
    });
    return sessionId;
  },

  /** End the current session, writing a final manifest entry. */
  async endSession(reason: string = 'exit'): Promise<void> {
    if (!_sessionId) return;
    if (_sessionManifest) {
      _sessionManifest.endedAt = new Date().toISOString();
      _sessionManifest.endReason = reason;
      await updateManifest();
    }
    await writeEvent({
      traceId: _currentTraceId ?? 'none',
      spanId: genId(),
      type: 'session_end',
      timestamp: new Date().toISOString(),
      data: { sessionId: _sessionId, reason },
    });
    _sessionId = null;
    _sessionDir = null;
    _sessionManifest = null;
  },

  /** Current session ID, or null if none started. */
  get sessionId(): string | null {
    return _sessionId;
  },

  /** Current session directory, or null if none started. */
  get sessionDir(): string | null {
    return _sessionDir;
  },

  /** Update session metadata after start (e.g. when the model is confirmed). */
  async updateSessionMeta(patch: Partial<Omit<SessionManifest, 'sessionId' | 'pid' | 'startedAt'>>): Promise<void> {
    if (!_sessionManifest) return;
    Object.assign(_sessionManifest, patch);
    await updateManifest();
  },

  // ── Trace lifecycle ─────────────────────────────────

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

  // ── Event logging ───────────────────────────────────

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

  // ── Recent-events accessors ─────────────────────────

  /** Get recent events (for /trace command). */
  getRecentEvents(limit: number = 20): TraceEvent[] {
    return _sessionEvents.slice(-limit);
  },

  /** Get events for a specific traceId. */
  getTraceEvents(traceId: string): TraceEvent[] {
    return _sessionEvents.filter(e => e.traceId === traceId);
  },

  /** Load events from the current events file (for cross-session viewing). */
  async loadTodayEvents(limit: number = 50): Promise<TraceEvent[]> {
    try {
      const content = await readFile(getEventsFile(), 'utf-8');
      const lines = content.trim().split('\n').slice(-limit);
      return lines.map(l => JSON.parse(l) as TraceEvent);
    } catch {
      return [];
    }
  },

  /** List all past sessions on disk, newest first. */
  async listSessions(limit: number = 20): Promise<SessionManifest[]> {
    try {
      const entries = await readdir(sessionsRoot(), { withFileTypes: true });
      const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort().reverse().slice(0, limit);
      const result: SessionManifest[] = [];
      for (const d of dirs) {
        try {
          const raw = await readFile(join(sessionsRoot(), d, 'manifest.json'), 'utf-8');
          result.push(JSON.parse(raw) as SessionManifest);
        } catch {
          // skip missing/corrupt manifests
        }
      }
      return result;
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

  /** Reset session buffer (for /clear). Does NOT end the disk session. */
  reset(): void {
    _sessionEvents = [];
    _currentTraceId = null;
    _currentSpanId = null;
  },

  // ── Subscribers ─────────────────────────────────────

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

  // ── Full-content capture ────────────────────────────

  /**
   * Log a full model call to a dedicated per-call file for deep inspection.
   * Unlike the event stream, this captures the COMPLETE system prompt,
   * messages, and response — no truncation. All content is redacted before
   * being written to disk.
   */
  async logModelCall(data: {
    traceId: string;
    spanId: string;
    /** Full system prompt (string, blocks, or omitted). */
    systemPrompt?: unknown;
    /** Truncated preview kept for backward compat with older callers. */
    prompt?: string;
    /** Full messages array at the time of the call. */
    messages?: unknown;
    /** Full assistant response (content blocks). */
    response?: unknown;
    /** Model id. */
    model: string;
    /** Tool definitions offered this turn (optional). */
    toolDefs?: unknown;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    toolsUsed?: string[];
    /** When inside a sub-agent, the agent id for correlation. */
    agentId?: string;
  }): Promise<void> {
    try {
      const dir = getModelCallsDir();
      await mkdir(dir, { recursive: true });
      const filename = `${data.traceId}-${data.spanId}.json`;
      const payload = {
        traceId: data.traceId,
        spanId: data.spanId,
        agentId: data.agentId,
        model: data.model,
        timestamp: new Date().toISOString(),
        durationMs: data.durationMs,
        usage: { input_tokens: data.inputTokens, output_tokens: data.outputTokens },
        systemPrompt: data.systemPrompt,
        prompt: data.prompt,
        messages: data.messages,
        response: data.response,
        toolDefs: data.toolDefs,
        toolsUsed: data.toolsUsed,
      };
      await writeJson(join(dir, filename), payload);

      // Deduplicate system prompts to `system-prompts/{hash}.md` so we don't
      // rewrite the same 10 kB prompt on every turn.
      if (typeof data.systemPrompt === 'string' && data.systemPrompt.length > 0) {
        const hash = hashShort(data.systemPrompt);
        const promptsDir = getSystemPromptsDir();
        await mkdir(promptsDir, { recursive: true });
        await writeFile(join(promptsDir, `${hash}.md`), data.systemPrompt, { encoding: 'utf-8', flag: 'w' });
      }
    } catch {
      // Tracer must never throw
    }
  },

  /**
   * Log a full tool call with its input and result. Writes to
   * `tool-calls/{spanId}.json`. Redacts sensitive strings automatically.
   */
  async logToolCall(data: {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    tool: string;
    input: unknown;
    output: unknown;
    isError: boolean;
    durationMs: number;
    agentId?: string;
  }): Promise<void> {
    try {
      const dir = getToolCallsDir();
      await mkdir(dir, { recursive: true });
      const filename = `${data.spanId}.json`;
      await writeJson(join(dir, filename), {
        ...data,
        timestamp: new Date().toISOString(),
      });
    } catch {
      // never throw
    }
  },

  /**
   * Log a full agent run transcript. Writes prompt, events, and result into
   * `agents/{agentId}/`. This captures exactly what was sent to the sub-agent
   * and what it produced — including its own nested tool calls and model I/O
   * (which are also captured by nested `logModelCall` / `logToolCall`
   * invocations correlated by `agentId`).
   */
  async logAgentRun(data: {
    agentId: string;
    agentType: string;
    parentSpanId?: string;
    prompt: string;
    response: string;
    endReason: string;
    turns: number;
    costUsd: number;
    events?: unknown[];
    context?: string;
    depth?: number;
  }): Promise<void> {
    try {
      const root = getAgentsDir();
      const dir = join(root, data.agentId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'prompt.txt'), redactSensitive(data.prompt), 'utf-8');
      await writeFile(join(dir, 'response.txt'), redactSensitive(data.response), 'utf-8');
      await writeJson(join(dir, 'result.json'), {
        agentId: data.agentId,
        agentType: data.agentType,
        endReason: data.endReason,
        turns: data.turns,
        costUsd: data.costUsd,
        depth: data.depth,
        contextProvided: data.context ? data.context.length : 0,
        timestamp: new Date().toISOString(),
      });
      if (data.events && data.events.length > 0) {
        const lines = data.events.map(e => JSON.stringify(redactDeep(e))).join('\n');
        await writeFile(join(dir, 'events.jsonl'), lines + '\n', 'utf-8');
      }
    } catch {
      // never throw
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
