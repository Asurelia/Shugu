# Shugu (Project CC) — Quality Status

**Last updated:** 2026-04-17
**Version:** 0.2.0
**Branch:** main (post-Rodin + post-ultrareview corrections)

---

## Snapshot

| Metric | Value |
|---|---|
| Source files (`.ts` + `.tsx`) | 185 |
| Lines of code (src/) | ~37,400 |
| Lines of code (tests/) | ~11,800 |
| Test files | 67 |
| Tests passing | **942 / 942** |
| TypeScript strict | 0 errors |
| Build size (`dist/pcc.mjs`) | ~820 KB |

## Audit history

Three independent audits have been produced for this codebase. Each is
preserved for traceability — this file is the current summary.

| Date | Report | Focus |
|---|---|---|
| 2026-04-12 | [`rapport_gpt/00_synthese.md`](rapport_gpt/00_synthese.md) + `01-05*.md` | Bugs, robustness, UI/UX, skills/plugins, logging, tests, smoke API |
| 2026-04-16 | [`rapport_gpt/rodin_review_20260416.md`](rapport_gpt/rodin_review_20260416.md) | Socratic architectural review. 11 RÉSOLU / 9 REPORTÉ / 1 INVALIDÉ |
| 2026-04-16 | [`rapport_gpt/metrics-20260416.md`](rapport_gpt/metrics-20260416.md) | Empirical metrics from 131 sessions, 15 days of traces |
| 2026-04-17 | Ultra-review differential (this merge) | Verified Rodin fixes + uncovered zones + quality scan |

## What has been fixed

### Rodin corrections (merged 2026-04-16, verified 2026-04-17)

All 11 ✗/⚡/◐ items flagged RÉSOLU tested empirically:

- Circuit breaker (Hystrix-like, 3 states) wired in `transport/breaker.ts`.
- `GUARD_BYPASS_MODES = ['fullAuto', 'bypass']` in `FileWriteTool` / `FileEditTool`.
- `ReadTracker` exposes `clear() / invalidate(path) / size()` with auto-invalidation after Write/Edit.
- `compileRules()` fail-closed on invalid regex via `validateRegexSafety`.
- `StreamAbortError` replaces DOMException throws in transport.
- `startSpan()` signature rendered honest (no ignored `parentSpanId`).
- `trusted` → `unrestricted` plugin isolation rename with backward-compat.
- Trust store TOFU (`~/.pcc/trusted-repos.json`, SHA-256 per file, `PCC_TRUST_ALL=1`).
- `.env*` blocking validated incl. Windows backslashes.
- GrepTool `spawn('rg')` wrapped in try/catch for EPERM fallback.
- Commentaire FR → EN in `ui/FullApp.tsx`.

### Ultra-review additions (2026-04-17)

**P0 — Shell injection defence** in Meta-Harness datasets (`src/meta/config.ts`, `dataset.ts`, `evaluator.ts`):
a `containsShellInjection()` helper rejects `;`, backticks, `$(…)`, `${…}`, `||`
outside quoted strings both at dataset load time and at exec time
(defense-in-depth). Legitimate `&&`/`>`/`|`/`!` are preserved.

**P1 — EventEmitter leaks** closed in `PluginHost` and `DaemonController`:
listeners on `child.stdout` / `stderr` / `exit` / `message` and the readline
interface are detached via `detachChildListeners()` called from the child's
`exit` handler. `DaemonWorker` also releases its `process.on('message')` binding
on stop.

**P1 — Meta proposer no longer has Bash**: `allowedTools` in `src/meta/proposer.ts`
reduced to `['Read', 'Write', 'Glob', 'Grep']`.

**P1 — `/bg` permission-mode degradation**: `degradeForUnattended()` in
`src/policy/modes.ts` downgrades `fullAuto`/`bypass` to `acceptEdits` for
unattended background sessions. Opt-out with `/bg <prompt> --fullauto`.

**P2 — `pcc-tools.yaml` prompt-injection defence**: all project-sourced
strings pass through `sanitizeUntrustedContent` before splicing into the
system prompt.

**P2 — `doctor.ts` catches** now attach `logger.debug` diagnostics so
unexpected error codes (EPERM, etc.) are surfaced instead of swallowed.

**P2 — `console.*` → `logger.*`** in `plugins/loader.ts`, `skills/loader.ts`.

**P2 — `DOMException` cleanup** in `engine/interrupts.ts:isAbortError`:
duck-typed on `.name === 'AbortError'` instead of a `DOMException` instanceof.

## What remains REPORTÉ (by design)

These items were identified in the Rodin review and consciously deferred:

- `classifyByLLM` budget tuning for MiniMax (A1.2 — requires product decision FR/EN first vs universal).
- `recentToolMeta=10` window size (A1.4 — measured 97.7 % coverage from metrics; defensible magic number).
- `--permission` off in dev mode (A3.4 — design decision).
- Shadow-by-name vs shadow-by-semantic plugin protection (A3.5 — threat-model decision).
- Tracer 200-event buffer not indexed by traceId (A4.2 — readability debt).
- `TrackerPanel` stage async race (A6.3 — revisit if observed in practice).
- `Buddy` observations as `role: 'user'` (A6.4 — design decision).
- Docker-first packaging (A5.4 — packaging decision).
- Tracer globals (`_currentTraceId` etc.) migration to `AsyncLocalStorage` — structural refactor.
- `protocol/messages.ts` runtime validation via Zod — separate design discussion.

## Not audited (honesty)

- Long-running behaviour (24 h+ sessions).
- Performance under concurrent multi-agent load.
- Real-world network resilience over unstable connections.
- Memory growth in prolonged voice+automation use.

These areas cannot be assessed by static review; they require runtime
observation and load testing.

## How to run verification

```bash
# From project root
node_modules/.bin/tsc --noEmit              # typecheck (expect: 0 errors)
node_modules/.bin/vitest run                # test suite (expect: 942 passing)
npx tsx scripts/build.ts                    # production build (expect: dist/pcc.mjs ~820 KB)
```

## Reviewer workflow guidance

See [`AGENTS.md`](AGENTS.md) for the reviewing rules applied across all three
audits. Silent failures in security, sandbox, auth, config, process execution,
and telemetry are treated as **high severity** unless proven non-critical.
