---
title: "Socratic Agent (Rodin-style) — Design"
date: 2026-04-17
status: approved-brainstorm
authors: [shugu-team]
---

# Socratic Agent — Design

## 1. Intent

Add a 6th builtin agent to Shugu, named `socratic`, that performs adversarial Rodin-style reviews. It is distinct from the existing `review` agent: Rodin asks questions, tags items with five labels (✓ / ~ / ⚡ / ◐ / ✗), and refuses both complaisance ("it's fine") and soft centrism ("globally healthy, some improvements possible").

The agent is invoked two ways:
- **Manually** via a `/socratic [--scope diff|feature|full]` slash command.
- **Ritually at feature completion** via `/finish-feature`, which performs the merge and then runs `socratic --scope diff`.

There is no auto-trigger on hooks, no background scheduler, no periodic scan. Rodin's value comes from deliberate invocation, not ambient noise.

## 2. Non-goals

- No automatic task creation from findings (preserves the "humain décide" posture).
- No multi-pass self-refine or dual-persona debate in V1. These may be added after instrumentation data justifies the cost.
- No Meta-Harness integration in V1. The harness (`src/meta/`) is earmarked for V1.1 when a real ground-truth dataset can be built from accumulated reports.
- No injection of prior Rodin reports into subsequent audits (prevents self-citation and prompt injection via persisted content).

## 3. Architecture

### 3.1 File layout

```
src/agents/orchestrator.ts            → BUILTIN_AGENTS['socratic'] : prompt + maxTurns 25
src/commands/socratic.ts              → /socratic [--scope diff|feature|full] [--topic <name>]
src/commands/finish-feature.ts        → /finish-feature : merge + spawn socratic --scope diff
src/commands/socratic-report.ts       → helpers: frontmatter writer, JSON-block parser, TTY printer
.pcc/rodin/                           → audit reports, gitignored
.pcc/rodin/metrics.jsonl              → append-only run metrics
```

`finish-feature.ts` depends on a small `GitStatusProvider` helper (`src/commands/git-status.ts`) that surfaces commits-since-branch-point and changed files; the helper is inline-simple and does not warrant its own module unless reused.

### 3.2 Agent definition (excerpt)

```ts
'socratic': {
  name: 'socratic',
  rolePrompt: /* Rodin prompt — see §4 */,
  allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
  bashDenylist: [
    /^git\s+(reset|push|checkout\s+--|commit|rebase|merge|tag)/,
    /^(rm|mv|cp)\s/,
    /^(npm|pnpm|yarn)\s+(install|add|remove|run|exec)/,
    /^(tsx|node|npx)\s+[^ ]+\.(ts|js|mjs)/,
    /\s>\s/, // stdout redirection
  ],
  maxTurns: 25, // default; overridden per scope at spawn time (§3.3)
},
```

The `maxTurns` default of 25 is only used when the agent is spawned without a scope (e.g., `AgentOrchestrator.spawn('socratic', ...)` from another agent). The `/socratic` command always overrides this value from the scope table in §3.3.

The Bash denylist is authoritative — the agent has read-only Bash access for `git log`, `git diff`, `git show`, `git blame`, `ls`, `cat`, `wc`. It cannot mutate the repo, execute build tools, or redirect output.

### 3.3 Scope-driven context loading

Implemented in `socratic.ts` before spawning the agent:

| Scope | Budget | Temp | Initial context loaded |
|---|---|---|---|
| `diff` | 12 turns | 0.3 | `git diff HEAD~N..HEAD` + touched files + **one level of direct consumers** (files that import the touched files, found via `grep -rl "from '.*/<touched-file>'"`) + README/ARCHITECTURE if touched |
| `feature` | 18 turns | 0.3 | Files matching `--topic` glob + their tests + their direct consumers (same grep rule) |
| `full` | 30 turns | 0.7 | `docs/ARCHITECTURE.md` + `src/**/*.ts` list + `src/**/index.ts` contents. Warn user of estimated cost before spawning. |

"Direct consumers" means files that *import from* the touched/topic files — not files imported *by* them. This is the guard against blind-spot review on small diffs: without seeing who depends on the changed code, scope=diff risks duplicating the existing `review` agent with only a different tone.

## 4. Prompt (Rodin-style)

Full prompt lives in `src/agents/orchestrator.ts`. Key elements:

- Five labels with strict semantics:
  - `✓ Correct` — stands, add arguments the author did not write
  - `~ Contestable` — defensible, but a credible opposite exists
  - `⚡ Simplification` — a case treated as simple is richer than stated
  - `◐ Angle mort` — something the code does not see, and nothing in the repo addresses
  - `✗ Faux` — demonstrable bug, contradiction, or decision incoherent with its own premises
- Every item cites `file:line` or is rejected.
- Verdict MUST name a single point of pressure; phrases like "globalement sain", "dans l'ensemble", "7/10", "quelques points perfectibles" are explicitly banned.
- Anti-rationalization block: "Tu vas vouloir conclure qu'il n'y a rien de grave. Nomme l'item qui, s'il reste, cassera en production."
- French-first idioms are preferred (matches repo convention) but English items are accepted if file contents are in English.

## 5. Report format

### 5.1 Path and filename

```
.pcc/rodin/YYYY-MM-DD-HHMMSS-<scope>-<slug>.md
```

`<slug>` is a kebab-case derivation of the topic (branch name for `diff`, user-supplied `--topic` for `feature`, literal `full` for `full`).

### 5.2 Structure

```markdown
---
scope: diff | feature | full
topic: "<topic or branch name>"
timestamp: <ISO 8601>
turns_used: <int>
max_turns: <int>
cost_usd: <float>
commits_reviewed: [<sha>, ...]
files_read: <int>
verdict_contains_hedge: <bool>
---

# Revue Socratique — <topic>

## Préambule
<posture, perimeter, rules of the game — 1-2 paragraphs>

## Axe N — <name>
### <code>.<n> — <label> : <title>
<free analysis, socratic questions, file:line citations>

## Verdict
<short synthesis, single point of pressure, no /10>

---

## Annexe machine-readable

```json
{
  "faux": [
    { "id": "A3.2", "file": "src/meta/evaluator.ts", "line": 120,
      "evidence": "<exact quote or description>",
      "suggestion": "<specific fix>" }
  ]
}
```
```

Only `✗ Faux` items are mirrored into the JSON block. Labels `~`, `⚡`, `◐`, `✓` remain in prose only — they require human judgment, not machine consumption.

### 5.3 TTY pretty-print

After the audit completes, `socratic.ts` prints a compact summary to the REPL:

```
✓ Socratic audit complete — .pcc/rodin/2026-04-17-143200-diff-finish-feature.md
  Scope: diff · Turns: 11/12 · Cost: $0.34 · Files: 14
  Items: 9 total (2 ✗, 3 ~, 2 ⚡, 1 ◐, 1 ✓)
  ⚠ 2 ✗ Faux identified:
    • src/meta/evaluator.ts:120 — execAsync(setupCommand) sans validation SHELL_METACHAR_PATTERN
    • src/automation/proactive.ts:108 — permissionMode non dégradé en fullAuto
  Open the report for the full socratic analysis.
```

If `faux_count === 0`: print only the one-line success + path. If `verdict_contains_hedge === true`: print a soft warning ("verdict hedges — consider re-running with --scope feature to go deeper"), but never block.

## 6. Metrics (instrumentation)

`.pcc/rodin/metrics.jsonl` append-only, one line per run:

```jsonl
{"ts":"2026-04-17T14:32:00Z","scope":"diff","turns":11,"max_turns":12,"cost":0.34,"faux_count":2,"total_items":9,"verdict_contains_hedge":false,"files_read":14,"topic_slug":"finish-feature"}
```

Purpose: enable empirical answers to tuning questions ("should maxTurns be 18 or 25 for scope=feature?") once ~30-50 runs accumulate. No metrics-driven automation in V1; the file is human-readable and `grep`-friendly, matching the `.pcc/traces/` convention already in the repo.

A post-check in `socratic.ts` detects hedge phrases in the Verdict section via a small regex set (`/\b(globalement|dans l'ensemble|7\/10|quelques points)\b/i`) and sets `verdict_contains_hedge` accordingly. Rising hedge-rate over time indicates prompt drift and is a V1.1 signal for prompt refresh.

## 7. Commands

### 7.1 `/socratic`

Arguments:
- `--scope diff|feature|full` (default: `feature`)
- `--topic <name>` (required for `feature`, ignored otherwise)
- `--no-summary` (skip TTY pretty-print; useful for batch / testing)

Behavior:
- Loads scope-specific context (§3.3)
- Spawns the `socratic` agent via `AgentOrchestrator.spawn`
- On completion: writes report, appends metrics, prints summary
- Returns the report path as the command result

### 7.2 `/finish-feature`

No arguments. Behavior:
1. Verifies current branch is not `main` or `master`; aborts otherwise.
2. Verifies working tree is clean (no uncommitted changes); aborts otherwise with a clear message.
3. Runs `git log main..HEAD --oneline` to confirm commits exist; aborts if empty.
4. Runs `/socratic --scope diff --topic <branch-name>` and waits for completion.
5. On `faux_count === 0`: offers to proceed with merge (prompts user). On `faux_count > 0`: aborts merge, displays summary, asks user to address items first.
6. If user confirms merge: `git checkout main && git merge --no-ff <branch>`. No push.

`/finish-feature` never pushes, resets, or rebases. It can only fast-forward/no-ff-merge into `main`. All destructive verbs remain in the user's hands.

## 8. Security considerations

- Agent tools: read-only suite + Bash with denylist (§3.2). No `Edit`, no `Write`, no `Agent` nesting.
- Shell denylist is pattern-based and covers the attack surface observed in `project_post_rodin_findings.md` (shell metachar, git mutation, install commands, stdout redirection). Patterns are reviewed alongside the prompt.
- Rodin reports in `.pcc/rodin/` are **never** injected into downstream system prompts. Any future feature that wants to "learn from past reviews" must go through an explicit allowlist + sanitization path.
- `.pcc/rodin/` is gitignored to prevent accidental commit of internal critique into the public history.
- The `metrics.jsonl` file contains no sensitive content (no file contents, no secrets) and can be included in support bundles if needed.

## 9. Implementation order

1. Add `socratic` to `BUILTIN_AGENTS` in `orchestrator.ts` with prompt + denylist + maxTurns.
2. Add `/socratic` command in `src/commands/socratic.ts` with scope handling and report writer.
3. Add `/finish-feature` in `src/commands/finish-feature.ts` with merge orchestration.
4. Add TTY pretty-print and `metrics.jsonl` append in a shared helper `src/commands/socratic-report.ts`.
5. Register both commands in the command registry (wherever `/review`, `/test` etc. are registered).
6. Tests: unit tests for report parsing (JSON block extraction), scope context loading (mock fs), and denylist enforcement. Integration test: invoke `/socratic --scope diff` on a known small diff fixture and assert report structure.
7. Update `docs/commands.md` and `README.md` with the two new commands.

## 10. Out of scope / future work

- **V1.1:** Meta-Harness dataset for Rodin (`src/meta/rodin-eval.ts`) with 10-15 ground-truth situations drawn from `rapport_gpt/` and real accumulated reports. Enables tuning maxTurns / temp empirically.
- **V1.2:** Dual-persona debate variant (one "charitable" Rodin, one "hostile") with a synthesizer, gated behind a `--debate` flag. Only pursued if V1.1 measurements show single-pass Rodin misses known findings ≥ 30% of the time.
- **V2:** Optional hedge-rate dashboard and prompt-drift detector.

## 11. Open questions

None — all design decisions have been made. Implementation plan will be drafted next via the `writing-plans` skill.
