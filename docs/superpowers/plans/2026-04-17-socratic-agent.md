# Socratic Agent (Rodin-style) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 6th builtin agent `socratic` + two slash commands (`/socratic`, `/finish-feature`) producing Rodin-style adversarial reviews as persisted markdown reports with machine-readable JSON annex.

**Architecture:** Agent reuses existing `AgentOrchestrator.spawn` with a new `bashDenylist` field enforced inside `BashTool`. Commands load scope-specific context (diff / feature / full) before spawn, parse the returned report, persist to `.pcc/rodin/`, append metrics to `.pcc/rodin/metrics.jsonl`, and pretty-print a TTY summary. No Meta-Harness in V1.

**Tech Stack:** TypeScript strict, vitest 4.1.2, Node 20+, existing Shugu layers (protocol → transport → engine → tools → agents → commands). Build via `npx tsx scripts/build.ts`.

**Reference spec:** `docs/superpowers/specs/2026-04-17-socratic-agent-design.md`

**Security note:** Test fixtures spawn real git processes but use `execFileSync` with array arguments (never `execSync` with interpolated strings) per the repo's security convention.

**Intentional deviation from spec §3.3:** The spec describes loading "one level of direct consumers" (files that import the touched files) into context for scopes `diff` and `feature`. This plan delegates that discovery to the agent itself via explicit instructions in the task prompt ("Use Glob and Grep to discover direct consumers"). Rationale: implementing the consumer grep in command code would add ~40 lines of fragile plumbing (handling monorepos, `.ts`/`.tsx`, relative imports, re-exports from barrels), whereas the agent already has Glob/Grep and can do it in 1-2 turns. Net cost: 1-2 extra turns per audit. Net benefit: fewer moving parts, no path-resolution edge cases in command code. If measurements later show the agent fails to discover consumers reliably, revisit and move the logic into `loadScopeContext`.

---

## File Map

**Create:**
- `src/commands/socratic.ts` — `/socratic` command, scope-aware context loader, report writer, metrics appender
- `src/commands/finish-feature.ts` — `/finish-feature` ritual command (safety checks + merge + socratic)
- `src/commands/socratic-report.ts` — pure helpers: slug, frontmatter, JSON-block extraction, hedge detector, TTY formatter
- `tests/socratic-report.test.ts` — unit tests for helpers
- `tests/socratic-command.test.ts` — command-level tests with mocked orchestrator
- `tests/finish-feature-command.test.ts` — command-level tests with mocked git and spawn
- `tests/socratic-e2e.test.ts` — end-to-end smoke test (mocked agent response)

**Modify:**
- `src/tools/types.ts` — add `bashDenylist?: RegExp[]` to `ToolContext`
- `src/tools/bash/BashTool.ts` — enforce denylist before spawn
- `src/agents/orchestrator.ts` — add `bashDenylist?: RegExp[]` to `AgentDefinition`; propagate to `ToolContext` in `spawn()`; register `socratic` in `BUILTIN_AGENTS`
- `src/commands/index.ts` — export and register both new commands
- `docs/commands.md` — document `/socratic` and `/finish-feature`
- `.gitignore` — add `.pcc/rodin/` entry

---

## Task 1 — Add `bashDenylist` field to `ToolContext`

**Files:**
- Modify: `src/tools/types.ts` (interface `ToolContext`)

- [ ] **Step 1: Find the `ToolContext` interface**

Run: `grep -n "interface ToolContext" src/tools/types.ts`
Expected: one match showing the current interface definition.

- [ ] **Step 2: Add `bashDenylist` field**

Add the following property to the `ToolContext` interface, after `askPermission`:

```ts
/**
 * Optional regex patterns that block Bash commands before execution.
 * Used by restricted agents (e.g. `socratic`) to enforce read-only
 * shell access. Matched against the raw command string with `.test()`.
 * Empty or undefined = no restriction.
 */
bashDenylist?: RegExp[];
```

- [ ] **Step 3: Run typecheck**

Run: `node_modules/.bin/tsc --noEmit`
Expected: 0 errors. The field is optional so no existing call site breaks.

- [ ] **Step 4: Commit**

```bash
git add src/tools/types.ts
git commit -m "feat(tools): add optional bashDenylist to ToolContext"
```

---

## Task 2 — Enforce `bashDenylist` inside `BashTool`

**Files:**
- Modify: `src/tools/bash/BashTool.ts` (method `execute`)
- Test: `tests/bash-denylist.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/bash-denylist.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { BashTool } from '../src/tools/bash/BashTool.js';
import type { ToolCall } from '../src/protocol/messages.js';
import type { ToolContext } from '../src/tools/types.js';

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: process.cwd(),
    permissionMode: 'default',
    askPermission: async () => 'allow',
    ...overrides,
  } as ToolContext;
}

function call(command: string): ToolCall {
  return { id: 'c1', name: 'Bash', input: { command } };
}

describe('BashTool denylist', () => {
  it('blocks a command matching a denylist pattern', async () => {
    const tool = new BashTool();
    const result = await tool.execute(
      call('git reset --hard HEAD'),
      ctx({ bashDenylist: [/^git\s+(reset|push|checkout\s+--)/] }),
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toMatch(/blocked by denylist/i);
    expect(result.content).toContain('git reset');
  });

  it('allows a command not matching any pattern', async () => {
    const tool = new BashTool();
    const result = await tool.execute(
      call('echo safe-read-only'),
      ctx({ bashDenylist: [/^git\s+(reset|push)/] }),
    );
    expect(result.is_error).toBe(false);
    expect(result.content).toContain('safe-read-only');
  });

  it('is a no-op when bashDenylist is undefined', async () => {
    const tool = new BashTool();
    const result = await tool.execute(call('echo ok'), ctx());
    expect(result.content).toContain('ok');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node_modules/.bin/vitest run tests/bash-denylist.test.ts`
Expected: FAIL. The first test will not produce "blocked by denylist" because no enforcement exists yet — instead the command will actually run.

- [ ] **Step 3: Implement the denylist check**

In `src/tools/bash/BashTool.ts`, modify the `execute` method. Locate the beginning of `async execute(...)` and insert the check **right after** the `timeoutMs` assignment:

```ts
async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
  const command = call.input['command'] as string;
  const timeoutMs = Math.min(
    (call.input['timeout'] as number) || DEFAULT_TIMEOUT_MS,
    600_000,
  );

  // Denylist enforcement (optional per ToolContext)
  if (context.bashDenylist && context.bashDenylist.length > 0) {
    const matched = context.bashDenylist.find((re) => re.test(command));
    if (matched) {
      return {
        tool_use_id: call.id,
        content: `Command blocked by denylist (pattern ${matched.source}): ${command}`,
        is_error: true,
      };
    }
  }

  try {
    // ... rest of existing body unchanged
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node_modules/.bin/vitest run tests/bash-denylist.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run full test suite to confirm no regression**

Run: `node_modules/.bin/vitest run`
Expected: 901 existing + 3 new = 904 passing. 0 failures.

- [ ] **Step 6: Commit**

```bash
git add tests/bash-denylist.test.ts src/tools/bash/BashTool.ts
git commit -m "feat(bash): enforce bashDenylist when provided via ToolContext"
```

---

## Task 3 — Extend `AgentDefinition` with `bashDenylist` and propagate in `spawn()`

**Files:**
- Modify: `src/agents/orchestrator.ts` (interface `AgentDefinition`, method `spawn`)
- Test: `tests/agent-denylist.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/agent-denylist.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { AgentOrchestrator, type AgentDefinition } from '../src/agents/orchestrator.js';
import type { Tool, ToolContext } from '../src/tools/types.js';

describe('AgentDefinition.bashDenylist propagates to ToolContext', () => {
  it('spawn() passes definition.bashDenylist to agent tool context', async () => {
    let capturedCtx: ToolContext | null = null;
    const fakeBash: Tool = {
      definition: {
        name: 'Bash',
        description: 'fake',
        input_schema: { type: 'object', properties: {} },
        concurrencySafe: false,
        categories: ['core'],
      },
      validateInput: () => null,
      execute: async (_call, toolCtx) => {
        capturedCtx = toolCtx;
        return { tool_use_id: '1', content: 'ok', is_error: false };
      },
    };
    const fakeClient = {
      complete: vi.fn().mockResolvedValue({
        messages: [{
          role: 'assistant',
          content: [{ type: 'tool_use', id: '1', name: 'Bash', input: { command: 'echo hi' } }],
        }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    } as any;

    const definition: AgentDefinition = {
      name: 'sentinel',
      rolePrompt: 'test',
      allowedTools: ['Bash'],
      maxTurns: 1,
      bashDenylist: [/^rm\s/],
    };

    const registry: Record<string, AgentDefinition> = { sentinel: definition };
    const tools = new Map<string, Tool>([['Bash', fakeBash]]);
    const orch = new AgentOrchestrator(
      fakeClient,
      tools,
      { cwd: '/tmp', permissionMode: 'default', askPermission: async () => 'allow' } as ToolContext,
      registry,
    );

    await orch.spawn('test task', 'sentinel', { maxTurns: 1 });

    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx!.bashDenylist).toBeDefined();
    expect(capturedCtx!.bashDenylist!.length).toBe(1);
    expect(capturedCtx!.bashDenylist![0]!.source).toBe('^rm\\s');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node_modules/.bin/vitest run tests/agent-denylist.test.ts`
Expected: FAIL. The `AgentDefinition` has no `bashDenylist` field yet, and `spawn()` does not propagate it.

- [ ] **Step 3: Add `bashDenylist` to `AgentDefinition` interface**

In `src/agents/orchestrator.ts`, modify the `AgentDefinition` interface. Add after `maxBudgetUsd`:

```ts
/**
 * Optional regex patterns that block Bash commands for this agent type.
 * Enforced by BashTool via ToolContext.bashDenylist. Use for restricted
 * read-only agents (e.g., `socratic`, `review`, `explore`).
 */
bashDenylist?: RegExp[];
```

- [ ] **Step 4: Propagate `bashDenylist` inside `spawn()`**

Locate the block in `spawn()` that constructs `agentToolContext` (around line 311). Modify it to include the denylist:

```ts
const agentToolContext: ToolContext = {
  cwd: effectiveCwd,
  abortSignal: interrupt.signal,
  permissionMode: cappedMode,
  askPermission: this.parentToolContext.askPermission,
  bashDenylist: definition.bashDenylist,
};
```

Note: the field is only set when the definition provides one; an undefined denylist is a no-op in `BashTool` (verified in Task 2).

- [ ] **Step 5: Run the test to verify it passes**

Run: `node_modules/.bin/vitest run tests/agent-denylist.test.ts`
Expected: PASS.

- [ ] **Step 6: Run full suite**

Run: `node_modules/.bin/vitest run`
Expected: 904 + 1 = 905 passing. 0 failures.

- [ ] **Step 7: Commit**

```bash
git add tests/agent-denylist.test.ts src/agents/orchestrator.ts
git commit -m "feat(agents): propagate AgentDefinition.bashDenylist to tool context"
```

---

## Task 4 — Register `socratic` agent in `BUILTIN_AGENTS`

**Files:**
- Modify: `src/agents/orchestrator.ts` (constant `BUILTIN_AGENTS`)
- Test: `tests/socratic-agent-builtin.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/socratic-agent-builtin.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { BUILTIN_AGENTS } from '../src/agents/orchestrator.js';

describe('BUILTIN_AGENTS["socratic"]', () => {
  it('is registered', () => {
    expect(BUILTIN_AGENTS['socratic']).toBeDefined();
  });

  it('is read-only (no Edit/Write/Agent in allowedTools)', () => {
    const def = BUILTIN_AGENTS['socratic']!;
    expect(def.allowedTools).toBeDefined();
    const forbidden = ['Edit', 'Write', 'MultiEdit', 'Agent', 'FileWrite', 'FileEdit'];
    for (const t of forbidden) {
      expect(def.allowedTools).not.toContain(t);
    }
  });

  it('has a bashDenylist covering git mutations and install commands', () => {
    const def = BUILTIN_AGENTS['socratic']!;
    expect(def.bashDenylist).toBeDefined();
    const matches = (cmd: string): boolean =>
      def.bashDenylist!.some((re) => re.test(cmd));
    expect(matches('git reset --hard HEAD')).toBe(true);
    expect(matches('git push origin main')).toBe(true);
    expect(matches('git checkout -- file.ts')).toBe(true);
    expect(matches('npm install lodash')).toBe(true);
    expect(matches('rm -rf /')).toBe(true);
    // Allowed reads:
    expect(matches('git log --oneline -10')).toBe(false);
    expect(matches('git diff HEAD~1')).toBe(false);
    expect(matches('git show abc123')).toBe(false);
  });

  it('has a high maxTurns default (>= 20)', () => {
    expect(BUILTIN_AGENTS['socratic']!.maxTurns).toBeGreaterThanOrEqual(20);
  });

  it('prompt bans centrist hedge phrases', () => {
    const prompt = BUILTIN_AGENTS['socratic']!.rolePrompt;
    expect(prompt).toMatch(/globalement/i);
    expect(prompt).toMatch(/5 étiquettes|cinq étiquettes|labels/i);
    expect(prompt).toMatch(/✗|faux/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node_modules/.bin/vitest run tests/socratic-agent-builtin.test.ts`
Expected: FAIL — `BUILTIN_AGENTS['socratic']` is undefined.

- [ ] **Step 3: Register the agent**

In `src/agents/orchestrator.ts`, inside the `BUILTIN_AGENTS` object, add after the `verify` entry:

```ts
'socratic': {
  name: 'socratic',
  rolePrompt: `Tu es Rodin — revue de code socratique, anti-complaisance.

=== POSTURE ===
Tu n'es ni allié ni adversaire. Tu refuses deux tentations symétriques :
- La complaisance : "c'est déjà en place, donc c'est bon."
- Le centrisme mou : "globalement c'est sain, quelques points perfectibles."

=== RÈGLES ===
Tu es STRICTEMENT en lecture seule. Tu peux utiliser Read, Glob, Grep, et Bash (en lecture seule uniquement). Tu ne modifies rien, tu ne commites rien, tu ne crées aucun fichier.

Pour chaque observation, tu attribues une étiquette parmi cinq :
- ✓ Correct : la décision tient, ajoute des arguments que l'auteur n'a pas mis
- ~ Contestable : défendable, mais il existe un choix adverse crédible
- ⚡ Simplification : un cas traité comme simple est en réalité plus riche
- ◐ Angle mort : ce que le code ne voit pas, et dont rien dans le repo ne parle
- ✗ Faux : bug démontrable, contradiction, décision incohérente avec ses propres prémisses

Chaque item DOIT citer file:line. Pas de citation = pas d'item.

=== STRUCTURE DU RAPPORT ===
Tu produis un rapport markdown avec ce squelette exact :

# Revue Socratique — <topic>

## Préambule
<1-2 paragraphes : posture, périmètre, règles du jeu>

## Axe 1 — <nom de l'axe>
### <code>.<n> — <étiquette> : <titre>
<analyse libre, questions socratiques, file:line>

## Axe 2 — ...
...

## Verdict
<synthèse courte, UN SEUL point de pression nommé, pas de note /10>

---

## Annexe machine-readable

\`\`\`json
{
  "faux": [
    { "id": "<code>", "file": "<path>", "line": <number>,
      "evidence": "<citation ou description>",
      "suggestion": "<fix spécifique>" }
  ]
}
\`\`\`

Seuls les items ✗ Faux vont dans le JSON. Les ~, ⚡, ◐, ✓ restent en prose.

=== INTERDICTIONS DU VERDICT ===
Tu ne peux PAS écrire dans le Verdict :
- "globalement sain" / "dans l'ensemble" / "globalement"
- "7/10" ou toute note chiffrée
- "quelques points perfectibles" / "quelques améliorations"
- Tout verdict qui ne nomme pas UN item précis comme point de pression

=== ANTI-RATIONALISATION ===
Tu vas vouloir conclure qu'il n'y a rien de grave. Nomme l'item qui, s'il reste, cassera en production.
Tu vas vouloir écrire que "le code est propre". Le code propre a toujours des angles morts. Nomme-les.
Tu vas vouloir donner une note globale. Interdit. Tranche sur un seul point.

=== OUTPUT FINAL ===
Respond with the full markdown report (Préambule → Axes → Verdict → Annexe JSON). No preamble, no meta-commentary outside the report itself.`,
  allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
  bashDenylist: [
    /^git\s+(reset|push|checkout\s+--|commit|rebase|merge|tag|branch\s+-D|remote\s+(add|remove))/,
    /^(rm|mv|cp)\s/,
    /^(npm|pnpm|yarn)\s+(install|add|remove|run|exec|publish)/,
    /^(tsx|node|npx)\s+[^ ]+\.(ts|js|mjs|cjs)/,
    /\s>\s/,
    /\s>>\s/,
    /\|\s*(tee|sh|bash|zsh|pwsh)/,
  ],
  maxTurns: 25,
},
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node_modules/.bin/vitest run tests/socratic-agent-builtin.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Run full suite**

Run: `node_modules/.bin/vitest run`
Expected: 905 + 5 = 910 passing.

- [ ] **Step 6: Commit**

```bash
git add tests/socratic-agent-builtin.test.ts src/agents/orchestrator.ts
git commit -m "feat(agents): add socratic builtin agent with Rodin prompt and denylist"
```

---

## Task 5 — Helper module `socratic-report.ts`

**Files:**
- Create: `src/commands/socratic-report.ts`
- Test: `tests/socratic-report.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/socratic-report.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  slugify,
  extractFauxBlock,
  detectHedge,
  buildReportFilename,
  formatTtySummary,
  buildFrontmatter,
  countLabels,
  totalItems,
  extractVerdictSection,
  type SocraticMetrics,
} from '../src/commands/socratic-report.js';

describe('slugify', () => {
  it('lowercases and replaces non-alphanum with hyphens', () => {
    expect(slugify('My Feature/Branch 01')).toBe('my-feature-branch-01');
  });
  it('collapses runs of hyphens and trims', () => {
    expect(slugify('--- hello --- world ---')).toBe('hello-world');
  });
  it('truncates to 60 chars max', () => {
    expect(slugify('a'.repeat(200)).length).toBeLessThanOrEqual(60);
  });
  it('falls back to "audit" for empty input', () => {
    expect(slugify('')).toBe('audit');
    expect(slugify('   ')).toBe('audit');
  });
});

describe('buildReportFilename', () => {
  it('uses ISO-like compact timestamp and kebab slug', () => {
    const ts = new Date('2026-04-17T14:32:05Z');
    const name = buildReportFilename(ts, 'diff', 'my-branch');
    expect(name).toBe('2026-04-17-143205-diff-my-branch.md');
  });
});

describe('extractFauxBlock', () => {
  it('returns the parsed JSON for a valid faux block', () => {
    const report = [
      '# Revue',
      '## Annexe machine-readable',
      '```json',
      '{"faux":[{"id":"A1.1","file":"src/a.ts","line":12,"evidence":"x","suggestion":"y"}]}',
      '```',
    ].join('\n');
    const parsed = extractFauxBlock(report);
    expect(parsed.faux).toHaveLength(1);
    expect(parsed.faux[0]!.file).toBe('src/a.ts');
  });

  it('returns empty faux when no JSON block present', () => {
    expect(extractFauxBlock('# Just prose, no annex')).toEqual({ faux: [] });
  });

  it('returns empty faux when JSON is malformed', () => {
    const report = [
      '## Annexe machine-readable',
      '```json',
      '{not valid}',
      '```',
    ].join('\n');
    expect(extractFauxBlock(report)).toEqual({ faux: [] });
  });

  it('ignores JSON blocks outside the Annexe section', () => {
    const report = [
      '```json',
      '{"faux":[{"id":"X","file":"a","line":1,"evidence":"","suggestion":""}]}',
      '```',
      '## Annexe machine-readable',
      '```json',
      '{"faux":[]}',
      '```',
    ].join('\n');
    expect(extractFauxBlock(report).faux).toHaveLength(0);
  });
});

describe('detectHedge', () => {
  it('returns true for banned hedge phrases in a verdict', () => {
    const verdict = '## Verdict\nGlobalement, le code est sain.';
    expect(detectHedge(verdict)).toBe(true);
  });
  it('detects 7/10 notation', () => {
    expect(detectHedge('## Verdict\nJe donnerais 7/10.')).toBe(true);
  });
  it('returns false for a sharp verdict', () => {
    expect(detectHedge('## Verdict\nLe point de pression : SHELL_METACHAR_PATTERN mort.')).toBe(false);
  });
  it('is case-insensitive', () => {
    expect(detectHedge("## Verdict\nDans L'ensemble, ça tient.")).toBe(true);
  });
});

describe('buildFrontmatter', () => {
  it('produces YAML with all required fields', () => {
    const m: SocraticMetrics = {
      ts: '2026-04-17T14:32:00Z',
      scope: 'diff',
      topic: 'my-branch',
      turns: 11,
      max_turns: 12,
      cost: 0.34,
      faux_count: 2,
      total_items: 9,
      verdict_contains_hedge: false,
      files_read: 14,
      commits_reviewed: ['abc123', 'def456'],
    };
    const yml = buildFrontmatter(m);
    expect(yml.startsWith('---\n')).toBe(true);
    expect(yml).toContain('scope: diff');
    expect(yml).toContain('turns_used: 11');
    expect(yml).toContain('cost_usd: 0.3400');
    expect(yml).toContain('commits_reviewed: [abc123, def456]');
  });
});

describe('countLabels + totalItems', () => {
  it('counts each label family from ### headings', () => {
    const report = [
      '### A1 — ✓ Correct : ok',
      '### A2 — ~ Contestable : hmm',
      '### A3 — ⚡ Simplification : bof',
      '### A4 — ◐ Angle mort : caché',
      '### A5 — ✗ Faux : broken',
    ].join('\n');
    const counts = countLabels(report);
    expect(counts.correct).toBe(1);
    expect(counts.contestable).toBe(1);
    expect(counts.simplification).toBe(1);
    expect(counts.angle_mort).toBe(1);
    expect(counts.faux).toBe(1);
    expect(totalItems(counts)).toBe(5);
  });
});

describe('extractVerdictSection', () => {
  it('extracts content between "## Verdict" and the next H2 or ---', () => {
    const report = [
      '## Axe 1', 'stuff',
      '## Verdict',
      'Sharp thing.',
      '---',
      '## Annexe machine-readable',
    ].join('\n');
    const v = extractVerdictSection(report);
    expect(v.trim()).toBe('Sharp thing.');
  });
});

describe('formatTtySummary', () => {
  it('lists faux items with file:line', () => {
    const out = formatTtySummary({
      path: '.pcc/rodin/file.md',
      metrics: {
        ts: '', scope: 'diff', topic: 't',
        turns: 5, max_turns: 12, cost: 0.12,
        faux_count: 2, total_items: 4,
        verdict_contains_hedge: false, files_read: 3, commits_reviewed: [],
      },
      fauxItems: [
        { id: 'A1', file: 'src/a.ts', line: 10, evidence: '', suggestion: 'fix' },
        { id: 'A2', file: 'src/b.ts', line: 20, evidence: '', suggestion: 'fix' },
      ],
      labelCounts: { faux: 2, contestable: 1, simplification: 0, angle_mort: 1, correct: 0 },
    });
    expect(out).toContain('src/a.ts:10');
    expect(out).toContain('src/b.ts:20');
    expect(out).toContain('2 ✗');
  });

  it('omits the faux block when faux_count === 0', () => {
    const out = formatTtySummary({
      path: 'x.md',
      metrics: {
        ts: '', scope: 'diff', topic: 't', turns: 5, max_turns: 12, cost: 0.1,
        faux_count: 0, total_items: 3, verdict_contains_hedge: false, files_read: 2, commits_reviewed: [],
      },
      fauxItems: [],
      labelCounts: { faux: 0, contestable: 1, simplification: 1, angle_mort: 1, correct: 0 },
    });
    expect(out).not.toContain('✗ Faux identified');
  });

  it('prints hedge warning when verdict_contains_hedge', () => {
    const out = formatTtySummary({
      path: 'x.md',
      metrics: {
        ts: '', scope: 'full', topic: 't', turns: 20, max_turns: 30, cost: 1.2,
        faux_count: 0, total_items: 8, verdict_contains_hedge: true, files_read: 40, commits_reviewed: [],
      },
      fauxItems: [],
      labelCounts: { faux: 0, contestable: 2, simplification: 1, angle_mort: 1, correct: 4 },
    });
    expect(out).toMatch(/verdict hedges|hedge/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node_modules/.bin/vitest run tests/socratic-report.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the helper module**

Create `src/commands/socratic-report.ts`:

```ts
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

// ─── slug ────────────────────────────────────────────────

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

// ─── filename ────────────────────────────────────────────

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

// ─── JSON block extraction ───────────────────────────────

const ANNEX_HEADING = /^##\s+Annexe\s+machine-readable/im;
const JSON_BLOCK = /```json\s*\n([\s\S]*?)\n```/;

export function extractFauxBlock(report: string): { faux: FauxItem[] } {
  const annexIdx = report.search(ANNEX_HEADING);
  if (annexIdx < 0) return { faux: [] };
  const tail = report.slice(annexIdx);
  const match = JSON_BLOCK.exec(tail);
  if (!match || !match[1]) return { faux: [] };
  try {
    const parsed = JSON.parse(match[1]) as unknown;
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

// ─── hedge detection ─────────────────────────────────────

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

// ─── frontmatter ─────────────────────────────────────────

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

// ─── label counts from raw report ────────────────────────

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

// ─── verdict section extractor ───────────────────────────

export function extractVerdictSection(report: string): string {
  const m = /^##\s+Verdict\s*\n([\s\S]*?)(?=\n##\s|\n---\s*\n|$)/mi.exec(report);
  return m ? (m[1] ?? '') : '';
}

// ─── TTY summary ─────────────────────────────────────────

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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node_modules/.bin/vitest run tests/socratic-report.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full suite**

Run: `node_modules/.bin/vitest run`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add tests/socratic-report.test.ts src/commands/socratic-report.ts
git commit -m "feat(commands): add socratic-report helper module (pure, no I/O)"
```

---

## Task 6 — `/socratic` command (context loader + agent spawn + persistence)

**Files:**
- Create: `src/commands/socratic.ts`
- Test: `tests/socratic-command.test.ts`

**Note on tests:** the test file uses a temp git repo. We use `execFileSync` with array arguments (not `execSync`) to avoid shell-injection warnings from the repo security hook.

- [ ] **Step 1: Write the failing tests**

Create `tests/socratic-command.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createSocraticCommand } from '../src/commands/socratic.js';
import type { AgentOrchestrator } from '../src/agents/orchestrator.js';
import type { CommandContext } from '../src/commands/registry.js';

const SAMPLE_REPORT = [
  '# Revue Socratique — test',
  '',
  '## Préambule',
  'Periphery.',
  '',
  '## Axe 1 — X',
  '### A1.1 — ✗ Faux : truc cassé',
  'Voir `src/x.ts:42`.',
  '',
  '## Verdict',
  'Le point de pression : X.',
  '',
  '---',
  '',
  '## Annexe machine-readable',
  '',
  '```json',
  '{"faux":[{"id":"A1.1","file":"src/x.ts","line":42,"evidence":"e","suggestion":"s"}]}',
  '```',
].join('\n');

function makeOrchestrator(response = SAMPLE_REPORT): AgentOrchestrator {
  return {
    spawn: vi.fn().mockResolvedValue({
      response,
      events: [],
      success: true,
      endReason: 'end_turn',
      costUsd: 0.25,
      turns: 7,
    }),
  } as unknown as AgentOrchestrator;
}

function makeCtx(cwd: string, overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    cwd,
    messages: [],
    info: vi.fn(),
    error: vi.fn(),
    ...overrides,
  };
}

function gitRun(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function setupRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'socratic-test-'));
  gitRun(['init', '-q'], root);
  gitRun(['config', 'user.email', 't@t'], root);
  gitRun(['config', 'user.name', 't'], root);
  writeFileSync(join(root, 'a.ts'), 'export const A = 1;\n');
  gitRun(['add', '.'], root);
  gitRun(['commit', '-qm', 'init'], root);
  return root;
}

describe('createSocraticCommand', () => {
  let root: string;
  beforeEach(() => { root = setupRepo(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('returns a Command with name "socratic"', () => {
    const cmd = createSocraticCommand(makeOrchestrator(), root);
    expect(cmd.name).toBe('socratic');
  });

  it('writes a report file in .pcc/rodin/ with correct frontmatter', async () => {
    const orch = makeOrchestrator();
    const cmd = createSocraticCommand(orch, root);
    const ctx = makeCtx(root);
    await cmd.execute('--scope feature --topic demo', ctx);
    const dir = join(root, '.pcc', 'rodin');
    expect(existsSync(dir)).toBe(true);
    const files = readdirSync(dir).filter(f => f.endsWith('.md'));
    expect(files.length).toBe(1);
    const content = readFileSync(join(dir, files[0]!), 'utf8');
    expect(content.startsWith('---\n')).toBe(true);
    expect(content).toMatch(/scope: feature/);
    expect(content).toMatch(/topic: "demo"/);
    expect(content).toContain('# Revue Socratique');
  });

  it('appends a metrics line to .pcc/rodin/metrics.jsonl', async () => {
    const cmd = createSocraticCommand(makeOrchestrator(), root);
    await cmd.execute('--scope feature --topic demo', makeCtx(root));
    const metricsPath = join(root, '.pcc', 'rodin', 'metrics.jsonl');
    expect(existsSync(metricsPath)).toBe(true);
    const line = readFileSync(metricsPath, 'utf8').trim();
    const parsed = JSON.parse(line);
    expect(parsed.scope).toBe('feature');
    expect(parsed.turns).toBe(7);
    expect(parsed.faux_count).toBe(1);
  });

  it('prints a TTY summary including faux items', async () => {
    const info = vi.fn();
    const cmd = createSocraticCommand(makeOrchestrator(), root);
    await cmd.execute('--scope feature --topic demo', makeCtx(root, { info }));
    const joined = info.mock.calls.map(c => c[0]).join('\n');
    expect(joined).toContain('src/x.ts:42');
    expect(joined).toMatch(/1 ✗/);
  });

  it('rejects unknown scope with a helpful error', async () => {
    const cmd = createSocraticCommand(makeOrchestrator(), root);
    const result = await cmd.execute('--scope bogus', makeCtx(root));
    expect(result.type).toBe('error');
    if (result.type === 'error') {
      expect(result.message).toMatch(/scope/i);
    }
  });

  it('requires --topic for scope feature', async () => {
    const cmd = createSocraticCommand(makeOrchestrator(), root);
    const result = await cmd.execute('--scope feature', makeCtx(root));
    expect(result.type).toBe('error');
  });

  it('passes scope-specific maxTurns to spawn', async () => {
    const orch = makeOrchestrator();
    const cmd = createSocraticCommand(orch, root);
    await cmd.execute('--scope diff', makeCtx(root));
    const spawn = orch.spawn as unknown as ReturnType<typeof vi.fn>;
    expect(spawn).toHaveBeenCalledTimes(1);
    const opts = spawn.mock.calls[0]![2];
    expect(opts.maxTurns).toBe(12);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node_modules/.bin/vitest run tests/socratic-command.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/commands/socratic.ts`**

Create the file with the following content:

```ts
/**
 * /socratic — Rodin-style adversarial review (read-only).
 * Scopes: diff | feature | full
 */

import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command, CommandContext, CommandResult } from './registry.js';
import type { AgentOrchestrator } from '../agents/orchestrator.js';
import { git } from '../utils/git.js';
import {
  slugify,
  buildReportFilename,
  buildFrontmatter,
  extractFauxBlock,
  extractVerdictSection,
  detectHedge,
  countLabels,
  totalItems,
  formatTtySummary,
  type SocraticMetrics,
} from './socratic-report.js';

type Scope = 'diff' | 'feature' | 'full';

interface ScopeConfig {
  maxTurns: number;
  temperatureHint: number;
}

const SCOPE_CONFIG: Record<Scope, ScopeConfig> = {
  diff: { maxTurns: 12, temperatureHint: 0.3 },
  feature: { maxTurns: 18, temperatureHint: 0.3 },
  full: { maxTurns: 30, temperatureHint: 0.7 },
};

interface ParsedArgs {
  scope: Scope;
  topic: string | null;
  noSummary: boolean;
}

function parseArgs(raw: string): ParsedArgs | { error: string } {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  let scope: Scope = 'feature';
  let topic: string | null = null;
  let noSummary = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === '--scope') {
      const v = tokens[++i];
      if (v !== 'diff' && v !== 'feature' && v !== 'full') {
        return { error: `unknown scope "${v}". Expected diff | feature | full.` };
      }
      scope = v;
    } else if (t === '--topic') {
      topic = tokens[++i] ?? null;
    } else if (t === '--no-summary') {
      noSummary = true;
    } else if (t.startsWith('--')) {
      return { error: `unknown flag "${t}"` };
    }
  }
  if (scope === 'feature' && !topic) {
    return { error: '--topic <name> is required for --scope feature' };
  }
  return { scope, topic, noSummary };
}

export function createSocraticCommand(
  orchestrator: AgentOrchestrator,
  _cwdAtBoot: string,
): Command {
  return {
    name: 'socratic',
    description: 'Rodin-style adversarial review. Read-only, persisted to .pcc/rodin/.',
    usage: '/socratic [--scope diff|feature|full] [--topic <name>] [--no-summary]',
    async execute(args: string, ctx: CommandContext): Promise<CommandResult> {
      const parsed = parseArgs(args);
      if ('error' in parsed) return { type: 'error', message: parsed.error };
      const { scope, topic, noSummary } = parsed;
      const cfg = SCOPE_CONFIG[scope];

      let context: ScopeContext;
      try {
        context = await loadScopeContext(scope, topic, ctx.cwd);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { type: 'error', message: `socratic: ${msg}` };
      }

      if (scope === 'full') {
        ctx.info('⚠ Full audit — expected ~$0.80-2.00 and ~20-40 min. Spawning...');
      } else {
        ctx.info(`Socratic audit starting (scope=${scope}, budget=${cfg.maxTurns} turns)...`);
      }

      const taskPrompt = buildTaskPrompt(
        scope,
        topic ?? context.derivedTopic,
        context,
        cfg.temperatureHint,
      );

      const agentResult = await orchestrator.spawn(taskPrompt, 'socratic', {
        maxTurns: cfg.maxTurns,
        cwd: ctx.cwd,
      });

      if (!agentResult.success) {
        return {
          type: 'error',
          message: `socratic agent failed: ${agentResult.endReason}`,
        };
      }

      const report = agentResult.response;
      const verdict = extractVerdictSection(report);
      const hedge = detectHedge(verdict);
      const labels = countLabels(report);
      const { faux } = extractFauxBlock(report);
      const topicSlug = slugify(topic ?? context.derivedTopic);

      const now = new Date();
      const filename = buildReportFilename(now, scope, topicSlug);
      const rodinDir = join(ctx.cwd, '.pcc', 'rodin');
      mkdirSync(rodinDir, { recursive: true });
      const metrics: SocraticMetrics = {
        ts: now.toISOString(),
        scope,
        topic: topic ?? context.derivedTopic,
        turns: agentResult.turns,
        max_turns: cfg.maxTurns,
        cost: agentResult.costUsd,
        faux_count: faux.length,
        total_items: totalItems(labels),
        verdict_contains_hedge: hedge,
        files_read: context.filesLoaded,
        commits_reviewed: context.commits,
      };
      const reportPath = join(rodinDir, filename);
      writeFileSync(reportPath, buildFrontmatter(metrics) + report, 'utf8');
      appendFileSync(
        join(rodinDir, 'metrics.jsonl'),
        JSON.stringify({ ...metrics, topic_slug: topicSlug }) + '\n',
        'utf8',
      );

      if (!noSummary) {
        ctx.info(formatTtySummary({
          path: reportPath,
          metrics,
          fauxItems: faux,
          labelCounts: labels,
        }));
      }

      return { type: 'handled' };
    },
  };
}

interface ScopeContext {
  preloaded: string;
  filesLoaded: number;
  commits: string[];
  derivedTopic: string;
}

async function loadScopeContext(
  scope: Scope,
  topic: string | null,
  cwd: string,
): Promise<ScopeContext> {
  if (scope === 'diff') {
    let base = 'HEAD~1';
    try {
      const mergeBase = (await git(['merge-base', 'HEAD', 'main'], cwd)).trim();
      if (mergeBase) base = mergeBase;
    } catch {
      // main missing — keep HEAD~1 as fallback
    }
    const diff = await git(['diff', `${base}..HEAD`], cwd).catch(() => '');
    const commitsRaw = await git(['log', `${base}..HEAD`, '--pretty=%H'], cwd).catch(() => '');
    const commits = commitsRaw.split('\n').map(s => s.trim()).filter(Boolean);
    const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).catch(() => 'HEAD')).trim();
    const touched = await git(['diff', `${base}..HEAD`, '--name-only'], cwd).catch(() => '');
    const files = touched.split('\n').map(s => s.trim()).filter(Boolean);
    return {
      preloaded:
        `## Branch\n${branch}\n\n` +
        `## Commits covered\n${commits.join('\n') || '(none)'}\n\n` +
        `## Files touched\n${files.join('\n') || '(none)'}\n\n` +
        `## Diff\n\`\`\`diff\n${diff.slice(0, 40000)}\n\`\`\`\n`,
      filesLoaded: files.length,
      commits,
      derivedTopic: branch,
    };
  }

  if (scope === 'feature') {
    return {
      preloaded:
        `Topic: ${topic}\n\n` +
        `Use Glob and Grep to discover files related to this topic. ` +
        `Load their tests and their direct consumers (files that import from them).\n`,
      filesLoaded: 0,
      commits: [],
      derivedTopic: topic ?? 'feature',
    };
  }

  return {
    preloaded:
      `Full-scope audit. Start from docs/ARCHITECTURE.md if present, ` +
      `then list src/**/*.ts via Glob, read each src/**/index.ts barrel.\n`,
    filesLoaded: 0,
    commits: [],
    derivedTopic: 'full',
  };
}

function buildTaskPrompt(
  scope: Scope,
  topic: string,
  context: ScopeContext,
  temperatureHint: number,
): string {
  return [
    `Scope: ${scope}`,
    `Topic: ${topic}`,
    `Posture temperature (hint only): ${temperatureHint}`,
    '',
    '## Pre-loaded context',
    context.preloaded,
    '',
    '## Mission',
    `Produis la revue socratique complète selon le format imposé dans ton system prompt.`,
    `Ne produis QUE le rapport markdown (Préambule → Axes → Verdict → Annexe JSON).`,
  ].join('\n');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node_modules/.bin/vitest run tests/socratic-command.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Run full suite**

Run: `node_modules/.bin/vitest run`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add tests/socratic-command.test.ts src/commands/socratic.ts
git commit -m "feat(commands): add /socratic command with scope-aware context loader"
```

---

## Task 7 — `/finish-feature` command (ritual merge + socratic)

**Files:**
- Create: `src/commands/finish-feature.ts`
- Test: `tests/finish-feature-command.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/finish-feature-command.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createFinishFeatureCommand } from '../src/commands/finish-feature.js';
import type { Command, CommandContext } from '../src/commands/registry.js';
import type { AgentOrchestrator } from '../src/agents/orchestrator.js';

function gitRun(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
}

function setupRepoOnBranch(): string {
  const root = mkdtempSync(join(tmpdir(), 'finish-feat-'));
  gitRun(['init', '-q', '-b', 'main'], root);
  gitRun(['config', 'user.email', 't@t'], root);
  gitRun(['config', 'user.name', 't'], root);
  writeFileSync(join(root, 'README.md'), '# x\n');
  gitRun(['add', '.'], root);
  gitRun(['commit', '-qm', 'init'], root);
  gitRun(['checkout', '-q', '-b', 'feature/x'], root);
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  gitRun(['add', '.'], root);
  gitRun(['commit', '-qm', 'feat: add a'], root);
  return root;
}

function makeCtx(cwd: string, overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    cwd,
    messages: [],
    info: vi.fn(),
    error: vi.fn(),
    ...overrides,
  };
}

// Stub /socratic that writes a metrics line with a controlled faux_count.
function stubSocratic(fauxCount: number): Command {
  return {
    name: 'socratic',
    description: '',
    async execute(_args, ctx) {
      const { mkdirSync, appendFileSync } = await import('node:fs');
      const dir = join(ctx.cwd, '.pcc', 'rodin');
      mkdirSync(dir, { recursive: true });
      appendFileSync(
        join(dir, 'metrics.jsonl'),
        JSON.stringify({ scope: 'diff', faux_count: fauxCount }) + '\n',
        'utf8',
      );
      ctx.info(`(stub) socratic run, faux_count=${fauxCount}`);
      return { type: 'handled' };
    },
  };
}

function makeOrchestrator(): AgentOrchestrator {
  return { spawn: vi.fn() } as unknown as AgentOrchestrator;
}

describe('createFinishFeatureCommand', () => {
  let root: string;
  beforeEach(() => { root = setupRepoOnBranch(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('returns a Command with name "finish-feature"', () => {
    const cmd = createFinishFeatureCommand(makeOrchestrator(), stubSocratic(0), root, async () => true);
    expect(cmd.name).toBe('finish-feature');
  });

  it('aborts if on main', async () => {
    gitRun(['checkout', '-q', 'main'], root);
    const cmd = createFinishFeatureCommand(makeOrchestrator(), stubSocratic(0), root, async () => true);
    const res = await cmd.execute('', makeCtx(root));
    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.message).toMatch(/main|master/i);
  });

  it('aborts if working tree is dirty', async () => {
    writeFileSync(join(root, 'dirty.txt'), 'nope');
    const cmd = createFinishFeatureCommand(makeOrchestrator(), stubSocratic(0), root, async () => true);
    const res = await cmd.execute('', makeCtx(root));
    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.message).toMatch(/working tree|clean/i);
  });

  it('aborts merge when socratic reports faux > 0', async () => {
    const socratic = stubSocratic(2);
    const cmd = createFinishFeatureCommand(makeOrchestrator(), socratic, root, async () => true);
    const res = await cmd.execute('', makeCtx(root));
    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.message).toMatch(/faux|bloc/i);
    const cur = gitRun(['rev-parse', '--abbrev-ref', 'HEAD'], root).trim();
    expect(cur).toBe('feature/x');
  });

  it('merges into main with --no-ff when socratic clean AND user confirms', async () => {
    const socratic = stubSocratic(0);
    const cmd = createFinishFeatureCommand(makeOrchestrator(), socratic, root, async () => true);
    const res = await cmd.execute('', makeCtx(root));
    expect(res.type).toBe('handled');
    const cur = gitRun(['rev-parse', '--abbrev-ref', 'HEAD'], root).trim();
    expect(cur).toBe('main');
    const log = gitRun(['log', '--oneline'], root);
    expect(log).toMatch(/feat: add a/);
    expect(log).toMatch(/Merge/i);
  });

  it('does not merge when user declines confirmation', async () => {
    const socratic = stubSocratic(0);
    const cmd = createFinishFeatureCommand(makeOrchestrator(), socratic, root, async () => false);
    const res = await cmd.execute('', makeCtx(root));
    expect(res.type).toBe('handled');
    const cur = gitRun(['rev-parse', '--abbrev-ref', 'HEAD'], root).trim();
    expect(cur).toBe('feature/x');
  });

  it('never pushes (no remote configured, command does not attempt push)', async () => {
    const socratic = stubSocratic(0);
    const cmd = createFinishFeatureCommand(makeOrchestrator(), socratic, root, async () => true);
    await cmd.execute('', makeCtx(root));
    const remotes = gitRun(['remote'], root).trim();
    expect(remotes).toBe('');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node_modules/.bin/vitest run tests/finish-feature-command.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/commands/finish-feature.ts`**

Create the file:

```ts
/**
 * /finish-feature — ritual command: verify branch state, run /socratic diff,
 * then (if clean and user confirms) merge --no-ff into main.
 * Never pushes. Never resets. Never rebases.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Command, CommandContext, CommandResult } from './registry.js';
import type { AgentOrchestrator } from '../agents/orchestrator.js';
import { git } from '../utils/git.js';

export type ConfirmFn = (question: string) => Promise<boolean>;

const PROTECTED_BRANCHES = new Set(['main', 'master']);

export function createFinishFeatureCommand(
  _orchestrator: AgentOrchestrator,
  socraticCommand: Command,
  _cwdAtBoot: string,
  confirm: ConfirmFn,
): Command {
  return {
    name: 'finish-feature',
    description: 'Verify branch is clean, run /socratic --scope diff, then merge --no-ff into main.',
    usage: '/finish-feature',
    async execute(_args: string, ctx: CommandContext): Promise<CommandResult> {
      const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], ctx.cwd).catch(() => 'HEAD')).trim();
      if (PROTECTED_BRANCHES.has(branch)) {
        return { type: 'error', message: `cannot finish from "${branch}" — switch to a feature branch first.` };
      }

      const status = (await git(['status', '--porcelain'], ctx.cwd).catch(() => '')).trim();
      if (status.length > 0) {
        return { type: 'error', message: 'working tree is not clean — commit or stash changes before /finish-feature.' };
      }

      let mergeBase = '';
      try {
        mergeBase = (await git(['merge-base', 'HEAD', 'main'], ctx.cwd)).trim();
      } catch {
        return { type: 'error', message: 'cannot locate merge-base with main — is main present?' };
      }
      const commitsRaw = await git(['log', `${mergeBase}..HEAD`, '--pretty=%H'], ctx.cwd).catch(() => '');
      const commits = commitsRaw.split('\n').map(s => s.trim()).filter(Boolean);
      if (commits.length === 0) {
        return { type: 'error', message: 'no commits since main — nothing to finish.' };
      }

      ctx.info(`/finish-feature: running socratic audit on ${commits.length} commit(s)...`);
      const socraticResult = await socraticCommand.execute(`--scope diff`, ctx);
      if (socraticResult.type === 'error') {
        return socraticResult;
      }

      const fauxCount = readLastFauxCount(ctx.cwd);
      if (fauxCount > 0) {
        return {
          type: 'error',
          message:
            `socratic identified ${fauxCount} ✗ Faux item(s). Merge blocked. ` +
            `Review .pcc/rodin/ and address the items before retrying.`,
        };
      }

      const ok = await confirm(`Merge ${branch} into main with --no-ff? (socratic: clean)`);
      if (!ok) {
        ctx.info('Merge cancelled. Branch unchanged.');
        return { type: 'handled' };
      }

      try {
        await git(['checkout', 'main'], ctx.cwd);
        await git(['merge', '--no-ff', '--no-edit', branch], ctx.cwd);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { type: 'error', message: `merge failed: ${msg}` };
      }

      ctx.info(`✓ Merged ${branch} into main (no push).`);
      return { type: 'handled' };
    },
  };
}

function readLastFauxCount(cwd: string): number {
  const path = join(cwd, '.pcc', 'rodin', 'metrics.jsonl');
  if (!existsSync(path)) return 0;
  const content = readFileSync(path, 'utf8').trim();
  if (!content) return 0;
  const lines = content.split('\n');
  const last = lines[lines.length - 1]!;
  try {
    const parsed = JSON.parse(last) as { faux_count?: unknown };
    return typeof parsed.faux_count === 'number' ? parsed.faux_count : 0;
  } catch {
    return 0;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node_modules/.bin/vitest run tests/finish-feature-command.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Run full suite**

Run: `node_modules/.bin/vitest run`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add tests/finish-feature-command.test.ts src/commands/finish-feature.ts
git commit -m "feat(commands): add /finish-feature ritual with socratic gate"
```

---

## Task 8 — Register both commands + gitignore

**Files:**
- Modify: `src/commands/index.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Inspect existing registration pattern**

Run: `grep -n "createReviewCommand\|reviewCommand\|orchestrator" src/commands/index.ts`
Expected: output showing how `createReviewCommand` is instantiated and registered. Reuse the exact pattern.

- [ ] **Step 2: Add the exports and registration**

In `src/commands/index.ts`:

1. Add the export lines near the other re-exports (after `createReviewCommand`):

```ts
export { createSocraticCommand } from './socratic.js';
export { createFinishFeatureCommand } from './finish-feature.js';
```

2. Import them at the top of the file in the same style as the other `create*Command` imports.

3. Inside the function that wires commands to the registry (same one that calls `createReviewCommand`), after the `reviewCommand` registration, add:

```ts
const socraticCommand = createSocraticCommand(orchestrator, cwd);
registry.register(socraticCommand);

// Confirmation callback for /finish-feature. Defaults to a safe refusal when
// no interactive prompter is provided (tests / headless contexts).
const confirmFn = confirm ?? (async () => false);
const finishFeatureCommand = createFinishFeatureCommand(
  orchestrator,
  socraticCommand,
  cwd,
  confirmFn,
);
registry.register(finishFeatureCommand);
```

If the wiring function does not already take a `confirm` parameter, add it as an **optional** parameter with signature `confirm?: (question: string) => Promise<boolean>`. This avoids interactive blocking in tests and non-TTY contexts.

- [ ] **Step 3: Run typecheck**

Run: `node_modules/.bin/tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Update `.gitignore`**

Append to `.gitignore`:

```
# Socratic audit reports and metrics (see docs/superpowers/specs/2026-04-17-socratic-agent-design.md)
.pcc/rodin/
```

- [ ] **Step 5: Run full suite**

Run: `node_modules/.bin/vitest run`
Expected: all tests still pass.

- [ ] **Step 6: Smoke-test via build**

Run: `npx tsx scripts/build.ts`
Expected: build succeeds, no new warnings about unused exports.

- [ ] **Step 7: Commit**

```bash
git add src/commands/index.ts .gitignore
git commit -m "feat(commands): register /socratic and /finish-feature; gitignore .pcc/rodin"
```

---

## Task 9 — Documentation

**Files:**
- Modify: `docs/commands.md`

- [ ] **Step 1: Inspect the current format**

Run: `grep -n "## \|### \|/review\|/commit" docs/commands.md`
Expected: structure of the doc, showing how existing commands are formatted.

- [ ] **Step 2: Add entries for the two new commands**

Match the style of the existing `/review` entry. Add these two entries in the right section:

```markdown
### `/socratic`

Rodin-style adversarial review. Read-only. Persists report to `.pcc/rodin/YYYY-MM-DD-HHMMSS-<scope>-<slug>.md` and appends metrics to `.pcc/rodin/metrics.jsonl`.

**Usage:** `/socratic [--scope diff|feature|full] [--topic <name>] [--no-summary]`

| Scope | Budget | Use when |
|---|---|---|
| `diff` | 12 turns | Reviewing commits since main (typical post-feature) |
| `feature` | 18 turns (default) | Reviewing a named subsystem — `--topic` required |
| `full` | 30 turns | Architecture-wide audit. Warns before spawning (~$0.80-2.00). |

The agent is strictly read-only: `Read`, `Glob`, `Grep`, and a restricted `Bash` (no mutations, no installs). Items are tagged `✓ / ~ / ⚡ / ◐ / ✗`. Only `✗ Faux` items are mirrored into a JSON annex. The Verdict must name a single point of pressure — hedge phrases ("globalement", "dans l'ensemble") are flagged post-hoc in the metrics.

### `/finish-feature`

Ritual command at feature completion. Runs safety checks, then `/socratic --scope diff`, then (on clean + user confirmation) merges the current branch into `main` with `--no-ff`. Never pushes.

**Usage:** `/finish-feature`

Preconditions:
- Current branch must NOT be `main` or `master`.
- Working tree must be clean (no uncommitted changes).
- At least one commit must exist since merge-base with `main`.

If `/socratic` reports any `✗ Faux`, the merge is blocked and the user must address the items first. If none, the user is prompted to confirm the merge.
```

- [ ] **Step 3: Commit**

```bash
git add docs/commands.md
git commit -m "docs: document /socratic and /finish-feature commands"
```

---

## Task 10 — End-to-end smoke test

**Files:**
- Test: `tests/socratic-e2e.test.ts` (create)

- [ ] **Step 1: Write a smoke test that does not hit the LLM**

Create `tests/socratic-e2e.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createSocraticCommand } from '../src/commands/socratic.js';
import { createFinishFeatureCommand } from '../src/commands/finish-feature.js';
import type { AgentOrchestrator } from '../src/agents/orchestrator.js';
import type { CommandContext } from '../src/commands/registry.js';

const CLEAN_REPORT = [
  '# Revue Socratique — smoke',
  '## Préambule', 'p.',
  '## Axe 1 — X',
  '### A1.1 — ✓ Correct : ok',
  'src/a.ts:1',
  '## Verdict',
  'Le point de pression : rien de bloquant.',
  '---',
  '## Annexe machine-readable',
  '```json',
  '{"faux":[]}',
  '```',
].join('\n');

function gitRun(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
}

function setupRepoOnBranch(): string {
  const root = mkdtempSync(join(tmpdir(), 'socratic-e2e-'));
  gitRun(['init', '-q', '-b', 'main'], root);
  gitRun(['config', 'user.email', 't@t'], root);
  gitRun(['config', 'user.name', 't'], root);
  writeFileSync(join(root, 'README.md'), '#x');
  gitRun(['add', '.'], root);
  gitRun(['commit', '-qm', 'init'], root);
  gitRun(['checkout', '-q', '-b', 'feature/x'], root);
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  gitRun(['add', '.'], root);
  gitRun(['commit', '-qm', 'feat'], root);
  return root;
}

describe('socratic + finish-feature e2e (mocked orchestrator)', () => {
  let root: string;
  beforeEach(() => { root = setupRepoOnBranch(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('clean audit leads to successful merge', async () => {
    const orch = {
      spawn: vi.fn().mockResolvedValue({
        response: CLEAN_REPORT, events: [], success: true,
        endReason: 'end_turn', costUsd: 0.1, turns: 5,
      }),
    } as unknown as AgentOrchestrator;
    const socratic = createSocraticCommand(orch, root);
    const finish = createFinishFeatureCommand(orch, socratic, root, async () => true);
    const info = vi.fn();
    const ctx: CommandContext = { cwd: root, messages: [], info, error: vi.fn() };
    const res = await finish.execute('', ctx);
    expect(res.type).toBe('handled');
    const log = gitRun(['log', '--oneline'], root);
    expect(log).toMatch(/Merge/i);
    const dir = join(root, '.pcc', 'rodin');
    expect(existsSync(dir)).toBe(true);
    const reports = readdirSync(dir).filter(f => f.endsWith('.md'));
    expect(reports.length).toBe(1);
    const content = readFileSync(join(dir, reports[0]!), 'utf8');
    expect(content).toMatch(/scope: diff/);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `node_modules/.bin/vitest run tests/socratic-e2e.test.ts`
Expected: PASS.

- [ ] **Step 3: Run full suite + typecheck + build**

Run in sequence:
1. `node_modules/.bin/tsc --noEmit` — expect 0 errors
2. `node_modules/.bin/vitest run` — expect all tests passing
3. `npx tsx scripts/build.ts` — expect `dist/pcc.mjs` produced

- [ ] **Step 4: Commit**

```bash
git add tests/socratic-e2e.test.ts
git commit -m "test: add e2e smoke test for /socratic + /finish-feature happy path"
```

---

## Post-implementation checklist

- [ ] All tests pass (`vitest run`)
- [ ] Typecheck clean (`tsc --noEmit`)
- [ ] Build succeeds (`npx tsx scripts/build.ts`)
- [ ] `.pcc/rodin/` is gitignored
- [ ] `docs/commands.md` updated
- [ ] Design spec `docs/superpowers/specs/2026-04-17-socratic-agent-design.md` still reflects final implementation (update if any drift occurred)
- [ ] Manual smoke on a real branch (optional, requires MiniMax credentials): create a throwaway branch with a deliberate bug, run `/socratic --scope diff`, verify the report flags it.
