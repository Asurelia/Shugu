/**
 * scripts/analyze-traces.ts
 *
 * Empirical analysis of Shugu's JSONL trace files to answer the
 * measurement questions raised in rapport_gpt/rodin_review_20260416.md:
 *
 *   - A1.3: how effective is the 3-identical-call loop detector?
 *   - A1.4: is the 10-element recentToolMeta window big enough?
 *   - A2.3: is the best → balanced → fast fallback chain actually used?
 *   - A2.4: how much retry budget is wasted after breaker-worthy failures?
 *
 * The goal is NOT to produce pretty graphs. It's to surface numbers
 * that let you judge whether a magic number deserves to stay magic.
 *
 * Usage:
 *   npx tsx scripts/analyze-traces.ts
 *   npx tsx scripts/analyze-traces.ts --days=7
 *   npx tsx scripts/analyze-traces.ts --out=rapport_gpt/metrics-2026-04-16.md
 *
 * Input:  ~/.pcc/traces/YYYY-MM-DD.jsonl (one file per day)
 * Output: markdown report to stdout, or --out=path.md
 */

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

// ─── Types ──────────────────────────────────────────────

interface TraceEvent {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  type: string;
  timestamp: string;
  durationMs?: number;
  data: Record<string, unknown>;
  stage?: string;
  agentId?: string;
}

interface Args {
  daysBack: number;
  outPath: string | null;
  tracesDir: string;
}

// ─── CLI parsing ────────────────────────────────────────

function parseArgs(argv: string[]): Args {
  const args: Args = {
    daysBack: 30,
    outPath: null,
    tracesDir: join(homedir(), '.pcc', 'traces'),
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--days=')) {
      args.daysBack = Math.max(1, parseInt(arg.slice(7), 10));
    } else if (arg.startsWith('--out=')) {
      args.outPath = arg.slice(6);
    } else if (arg.startsWith('--dir=')) {
      args.tracesDir = arg.slice(6);
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${arg}`);
      printHelp();
      process.exit(1);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`
Usage: tsx scripts/analyze-traces.ts [options]

Options:
  --days=N       Analyze last N days of traces (default: 30)
  --dir=PATH     Traces directory (default: ~/.pcc/traces)
  --out=PATH     Write markdown report to PATH instead of stdout
  --help, -h     Show this help
`);
}

// ─── Trace loading ──────────────────────────────────────

async function loadTraces(tracesDir: string, daysBack: number): Promise<TraceEvent[]> {
  let entries: string[];
  try {
    entries = await readdir(tracesDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);
  const cutoffIso = cutoff.toISOString().split('T')[0]!;

  const files = entries
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .filter((f) => f.slice(0, 10) >= cutoffIso)
    .sort();

  const events: TraceEvent[] = [];
  for (const f of files) {
    const raw = await readFile(join(tracesDir, f), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as TraceEvent);
      } catch {
        // Skip malformed lines
      }
    }
  }
  return events;
}

// ─── Analyses ───────────────────────────────────────────

interface SessionStats {
  traceId: string;
  toolCalls: number;
  distinctFilePaths: number;
  loopInjectionsObserved: number;
  modelFallbacks: Array<{ from: string; to: string; reason: string }>;
  errorToolResults: number;
  successToolResults: number;
}

function groupBySession(events: TraceEvent[]): Map<string, TraceEvent[]> {
  const m = new Map<string, TraceEvent[]>();
  for (const e of events) {
    const arr = m.get(e.traceId) ?? [];
    arr.push(e);
    m.set(e.traceId, arr);
  }
  return m;
}

function analyzeSession(events: TraceEvent[]): SessionStats {
  const toolCalls = events.filter((e) => e.type === 'tool_call');
  const toolResults = events.filter((e) => e.type === 'tool_result');

  const filePaths = new Set<string>();
  for (const e of toolCalls) {
    const input = e.data['input'];
    if (typeof input === 'string') {
      const m = input.match(/"file_path"\s*:\s*"([^"]+)"/);
      if (m) filePaths.add(m[1]!);
    }
  }

  // Loop injection: the code pushes a user message containing
  // "[LOOP DETECTED]" — these don't go through the tracer directly but
  // "tool_call" followed immediately by a user message is rare. We use
  // signature-match heuristic instead: count triplets of identical tool
  // signatures as the detector sees them.
  const signatures = toolCalls.map((e) => {
    const tool = (e.data['tool'] as string) ?? '';
    const input = typeof e.data['input'] === 'string' ? (e.data['input'] as string).slice(0, 100) : '';
    return `${tool}:${input}`;
  });
  let loopInjectionsObserved = 0;
  for (let i = 2; i < signatures.length; i++) {
    if (signatures[i] === signatures[i - 1] && signatures[i] === signatures[i - 2]) {
      loopInjectionsObserved++;
    }
  }

  const modelFallbacks: SessionStats['modelFallbacks'] = [];
  for (const e of events) {
    if (e.type === 'decision' && e.data['action'] === 'model_fallback') {
      modelFallbacks.push({
        from: (e.data['from'] as string) ?? '?',
        to: (e.data['to'] as string) ?? '?',
        reason: (e.data['reason'] as string) ?? '',
      });
    }
  }

  const errorToolResults = toolResults.filter((e) => e.data['is_error'] === true).length;
  const successToolResults = toolResults.length - errorToolResults;

  return {
    traceId: events[0]?.traceId ?? 'unknown',
    toolCalls: toolCalls.length,
    distinctFilePaths: filePaths.size,
    loopInjectionsObserved,
    modelFallbacks,
    errorToolResults,
    successToolResults,
  };
}

// ─── Report generation ──────────────────────────────────

interface Report {
  meta: { daysBack: number; totalEvents: number; sessions: number; tracesDir: string };
  windowUtility: { p50: number; p95: number; max: number; overWindow: number; totalSessions: number };
  loopDetector: { totalSessions: number; sessionsWithSignature3x: number; percent: number };
  fallback: { totalFallbacks: number; byTransition: Record<string, number> };
  errors: { totalToolResults: number; errorRate: number };
}

function buildReport(args: Args, events: TraceEvent[]): Report {
  const sessions = groupBySession(events);
  const sessionStats = [...sessions.values()].map(analyzeSession);

  // A1.4 window utility: distribution of distinctFilePaths per session
  const filePathCounts = sessionStats.map((s) => s.distinctFilePaths).sort((a, b) => a - b);
  const WINDOW = 10;
  const p = (q: number): number =>
    filePathCounts.length === 0
      ? 0
      : filePathCounts[Math.min(filePathCounts.length - 1, Math.floor(filePathCounts.length * q))]!;

  // A1.3 loop detector: sessions with any signature-3x
  const withLoop = sessionStats.filter((s) => s.loopInjectionsObserved > 0).length;

  // A2.3 fallback frequency
  const byTransition: Record<string, number> = {};
  let totalFallbacks = 0;
  for (const s of sessionStats) {
    for (const f of s.modelFallbacks) {
      const key = `${f.from} → ${f.to}`;
      byTransition[key] = (byTransition[key] ?? 0) + 1;
      totalFallbacks++;
    }
  }

  // Error rate overall
  const totalResults = sessionStats.reduce((n, s) => n + s.errorToolResults + s.successToolResults, 0);
  const totalErrors = sessionStats.reduce((n, s) => n + s.errorToolResults, 0);

  return {
    meta: {
      daysBack: args.daysBack,
      totalEvents: events.length,
      sessions: sessions.size,
      tracesDir: args.tracesDir,
    },
    windowUtility: {
      p50: p(0.5),
      p95: p(0.95),
      max: filePathCounts.length > 0 ? filePathCounts[filePathCounts.length - 1]! : 0,
      overWindow: filePathCounts.filter((n) => n > WINDOW).length,
      totalSessions: filePathCounts.length,
    },
    loopDetector: {
      totalSessions: sessionStats.length,
      sessionsWithSignature3x: withLoop,
      percent: sessionStats.length === 0 ? 0 : Math.round((withLoop / sessionStats.length) * 100),
    },
    fallback: { totalFallbacks, byTransition },
    errors: {
      totalToolResults: totalResults,
      errorRate: totalResults === 0 ? 0 : +(totalErrors / totalResults).toFixed(3),
    },
  };
}

function renderMarkdown(r: Report): string {
  const lines: string[] = [];
  lines.push(`# Shugu trace metrics — last ${r.meta.daysBack} days`);
  lines.push('');
  lines.push(`- Traces directory: \`${r.meta.tracesDir}\``);
  lines.push(`- Total events analyzed: **${r.meta.totalEvents}**`);
  lines.push(`- Sessions (distinct traceId): **${r.meta.sessions}**`);
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push('');

  lines.push(`## A1.4 — recentToolMeta window (current size = 10)`);
  lines.push('');
  lines.push(`Distribution of distinct file paths touched per session.`);
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| p50 | ${r.windowUtility.p50} |`);
  lines.push(`| p95 | ${r.windowUtility.p95} |`);
  lines.push(`| max | ${r.windowUtility.max} |`);
  lines.push(`| sessions over window (>10) | ${r.windowUtility.overWindow} / ${r.windowUtility.totalSessions} |`);
  lines.push('');
  lines.push(
    `**Reading**: if p95 > 10, the routing window drops late-session paths. ` +
      `If p50 is < 5, the window is oversized.`,
  );
  lines.push('');

  lines.push(`## A1.3 — Loop detector (3 identical tool signatures)`);
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Sessions | ${r.loopDetector.totalSessions} |`);
  lines.push(`| Sessions triggering signature-3x | ${r.loopDetector.sessionsWithSignature3x} |`);
  lines.push(`| Percent | ${r.loopDetector.percent}% |`);
  lines.push('');
  lines.push(
    `**Reading**: low percent doesn't prove the detector is useless — sessions ` +
      `without a trigger may not have had loops at all. Cross-reference with ` +
      `user-reported "stuck agent" complaints.`,
  );
  lines.push('');

  lines.push(`## A2.3 — Model fallback chain usage`);
  lines.push('');
  if (r.fallback.totalFallbacks === 0) {
    lines.push(`No model fallbacks observed in this window.`);
  } else {
    lines.push(`| Transition | Count |`);
    lines.push(`|---|---|`);
    const transitions = Object.entries(r.fallback.byTransition).sort((a, b) => b[1] - a[1]);
    for (const [k, v] of transitions) {
      lines.push(`| ${k} | ${v} |`);
    }
    lines.push(`| **Total** | **${r.fallback.totalFallbacks}** |`);
  }
  lines.push('');

  lines.push(`## A2.4 — Tool error rate (proxy for breaker-worthy failures)`);
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Tool results | ${r.errors.totalToolResults} |`);
  lines.push(`| Error rate | ${(r.errors.errorRate * 100).toFixed(1)}% |`);
  lines.push('');
  lines.push(
    `**Reading**: this is a lower bound for "retry budget wasted" — it ` +
      `includes legitimate tool failures (bad args, timeouts), not just ` +
      `endpoint outages. A sustained spike correlates with "break the breaker".`,
  );
  lines.push('');

  return lines.join('\n') + '\n';
}

// ─── Main ───────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const events = await loadTraces(args.tracesDir, args.daysBack);

  if (events.length === 0) {
    console.error(
      `No trace events found under ${args.tracesDir} (last ${args.daysBack} days). ` +
        `Run Shugu first, or pass --dir=<path>.`,
    );
    process.exit(2);
  }

  const report = buildReport(args, events);
  const md = renderMarkdown(report);

  if (args.outPath) {
    await mkdir(dirname(args.outPath), { recursive: true });
    await writeFile(args.outPath, md, 'utf8');
    console.error(`Report written to ${args.outPath}`);
  } else {
    process.stdout.write(md);
  }
}

main().catch((err) => {
  console.error(`analyze-traces failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
