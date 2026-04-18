/**
 * Pure helpers for the socratic/finish-feature commands:
 * slug, report filename, JSON-block extraction, hedge detection,
 * frontmatter builder, TTY summary formatter.
 *
 * No filesystem access here — all I/O lives in socratic.ts.
 */

export interface FauxItem {
  id: string;
  file: string;
  line: number;
  evidence: string;
  suggestion: string;
}

export interface LabelCounts {
  faux: number;
  contestable: number;
  simplification: number;
  angle_mort: number;
  correct: number;
}

export interface SocraticMetrics {
  ts: string;
  scope: 'diff' | 'feature' | 'full';
  topic: string;
  turns: number;
  max_turns: number;
  cost: number;
  faux_count: number;
  total_items: number;
  verdict_contains_hedge: boolean;
  files_read: number;
  commits_reviewed: string[];
}

export function slugify(input: string): string {
  const cleaned = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!cleaned) return 'audit';
  return cleaned.slice(0, 60).replace(/-+$/g, '');
}

export function buildReportFilename(
  ts: Date,
  scope: 'diff' | 'feature' | 'full',
  topicSlug: string,
): string {
  const pad = (n: number): string => n.toString().padStart(2, '0');
  const y = ts.getUTCFullYear();
  const m = pad(ts.getUTCMonth() + 1);
  const d = pad(ts.getUTCDate());
  const hh = pad(ts.getUTCHours());
  const mm = pad(ts.getUTCMinutes());
  const ss = pad(ts.getUTCSeconds());
  return `${y}-${m}-${d}-${hh}${mm}${ss}-${scope}-${topicSlug}.md`;
}

const ANNEX_HEADING = /^##\s+Annexe\s+machine-readable/im;
const JSON_BLOCK = /```json\s*\n([\s\S]*?)\n```/;

export function extractFauxBlock(report: string): { faux: FauxItem[] } {
  const annexIdx = report.search(ANNEX_HEADING);
  if (annexIdx < 0) return { faux: [] };
  const tail = report.slice(annexIdx);
  const matched = tail.match(JSON_BLOCK);
  if (!matched || !matched[1]) return { faux: [] };
  try {
    const parsed = JSON.parse(matched[1]) as unknown;
    if (
      typeof parsed === 'object' && parsed !== null &&
      'faux' in parsed && Array.isArray((parsed as { faux: unknown }).faux)
    ) {
      const items = ((parsed as { faux: unknown[] }).faux)
        .filter((x): x is FauxItem =>
          typeof x === 'object' && x !== null &&
          'id' in x && 'file' in x && 'line' in x &&
          typeof (x as FauxItem).file === 'string' &&
          typeof (x as FauxItem).line === 'number',
        );
      return { faux: items };
    }
  } catch {
    // fall through
  }
  return { faux: [] };
}

const HEDGE_PATTERNS: RegExp[] = [
  /\bglobalement\b/i,
  /\bdans l'ensemble\b/i,
  /\bquelques points\b/i,
  /\bquelques améliorations\b/i,
  /\b\d+\s*\/\s*10\b/,
  /\boverall (healthy|sound|fine)\b/i,
];

export function detectHedge(verdictSection: string): boolean {
  return HEDGE_PATTERNS.some((re) => re.test(verdictSection));
}

export function buildFrontmatter(m: SocraticMetrics): string {
  const commits = m.commits_reviewed.length > 0
    ? `[${m.commits_reviewed.join(', ')}]`
    : '[]';
  return [
    '---',
    `scope: ${m.scope}`,
    `topic: "${m.topic.replace(/"/g, '\\"')}"`,
    `timestamp: ${m.ts}`,
    `turns_used: ${m.turns}`,
    `max_turns: ${m.max_turns}`,
    `cost_usd: ${m.cost.toFixed(4)}`,
    `commits_reviewed: ${commits}`,
    `files_read: ${m.files_read}`,
    `verdict_contains_hedge: ${m.verdict_contains_hedge}`,
    '---',
    '',
  ].join('\n');
}

export function countLabels(report: string): LabelCounts {
  const count = (re: RegExp): number => (report.match(re) || []).length;
  return {
    faux: count(/###\s+[^\n]*✗/g),
    contestable: count(/###\s+[^\n]*~\s/g),
    simplification: count(/###\s+[^\n]*⚡/g),
    angle_mort: count(/###\s+[^\n]*◐/g),
    correct: count(/###\s+[^\n]*✓/g),
  };
}

export function totalItems(counts: LabelCounts): number {
  return counts.faux + counts.contestable + counts.simplification
       + counts.angle_mort + counts.correct;
}

export function extractVerdictSection(report: string): string {
  const matched = report.match(/^##\s+Verdict\s*\n([\s\S]*?)(?=\n##\s|\n---\s*\n|$)/mi);
  return matched ? (matched[1] ?? '') : '';
}

export interface TtySummaryInput {
  path: string;
  metrics: SocraticMetrics;
  fauxItems: FauxItem[];
  labelCounts: LabelCounts;
}

export function formatTtySummary(input: TtySummaryInput): string {
  const { path, metrics: m, fauxItems, labelCounts: l } = input;
  const lines: string[] = [];
  lines.push(`✓ Socratic audit complete — ${path}`);
  lines.push(
    `  Scope: ${m.scope} · Turns: ${m.turns}/${m.max_turns} · ` +
    `Cost: $${m.cost.toFixed(2)} · Files: ${m.files_read}`,
  );
  lines.push(
    `  Items: ${m.total_items} total ` +
    `(${l.faux} ✗, ${l.contestable} ~, ${l.simplification} ⚡, ${l.angle_mort} ◐, ${l.correct} ✓)`,
  );
  if (m.faux_count > 0) {
    lines.push(`  ⚠ ${m.faux_count} ✗ Faux identified:`);
    for (const item of fauxItems) {
      const snippet = item.suggestion.slice(0, 80);
      lines.push(`    • ${item.file}:${item.line} — ${snippet}`);
    }
    lines.push(`  Open the report for the full socratic analysis.`);
  }
  if (m.verdict_contains_hedge) {
    lines.push(
      `  ⚠ Verdict hedges ("globalement", "dans l'ensemble"...) — ` +
      `consider rerunning with --scope feature to go deeper.`,
    );
  }
  return lines.join('\n');
}
