# Shugu Cognitive OS Integration Plan

## Goal

Add five new capabilities to Shugu without fighting the current architecture:

1. `codebase-graph/`
2. `memory-episodes/`
3. `memory-semantic/`
4. `learning/`
5. `retrieval-planner/`

The target system is:

- one visible orchestrator
- multiple invisible specialized sub-agents
- one shared structured memory
- targeted retrieval before each response
- continuous learning after each turn/session

This document is based on the current codebase, not a greenfield design.

---

## Verified Baseline

Shugu already has the right skeleton for this direction.

### What already exists

- A real sub-agent orchestrator via nested `runLoop()` calls in `src/agents/orchestrator.ts`.
- A visible top-level orchestration layer in `src/entrypoints/repl.ts`, `src/entrypoints/prompt-builder.ts`, and `src/engine/strategy.ts`.
- A shared runtime container assembled in `src/entrypoints/bootstrap.ts`.
- A workspace index with file records, chunks, and regex-based symbol extraction in `src/context/workspace/`.
- A memory system with local cache plus Obsidian integration in `src/context/memory/agent.ts` and `src/context/memory/obsidian.ts`.
- Session persistence and rehydration in `src/context/session/persistence.ts` and `src/context/session/work-context.ts`.
- Hooks for file tracking and verification in `src/plugins/builtin/`.
- A per-turn context refresh hook in `src/engine/loop.ts`.
- Background automation infrastructure in `src/automation/`.

### What is missing

- No persistent AST index.
- No import graph.
- No call graph.
- No route map.
- No ownership map.
- No episodic memory schema for full tasks.
- No clear split between stable semantic memory and transient/episodic memory.
- No learning pipeline that consolidates episodes into recall rules.
- No retrieval planner that chooses targeted repo slices before model execution.
- No shared blackboard where sub-agents write structured artifacts.

---

## Architectural Constraint

Shugu is not a multi-process system by default.

Today, a sub-agent is "another loop with a restricted prompt and toolset", not a separate worker process. That is good news:

- low integration cost
- no IPC rewrite required
- invisible sub-agents are already possible
- shared memory can be introduced inside the same runtime first

That means the best near-term architecture is not "spin up a distributed system".
It is "add a cognition layer inside the current process, then expose only useful outputs".

---

## Mapping A-E To The Current Repo

### A. `codebase-graph/`

Best anchor points:

- `src/context/workspace/indexer.ts`
- `src/context/workspace/store.ts`
- `src/context/workspace/query.ts`
- `src/context/workspace/symbols.ts`
- `src/tools/search/SemSearchTool.ts`
- `src/commands/workspace.ts`

Current state:

- file hash index: yes
- chunk index: yes
- symbol index: yes
- AST graph: no

Conclusion:

Do not replace the current workspace index.
Extend it into a layered graph service.

### B. `memory-episodes/`

Best anchor points:

- `src/context/session/persistence.ts`
- `src/context/session/work-context.ts`
- `src/plugins/builtin/file-tracking-hook.ts`
- `src/engine/loop.ts`
- `src/entrypoints/repl.ts`

Current state:

- session history: yes
- snapshots: yes
- active files: yes
- tool history: yes
- pending work: yes
- episode schema: no
- hypothesis/result/lesson capture: no

Conclusion:

Episodes should be built from session + tool + file + result events, not from freeform notes.

### C. `memory-semantic/`

Best anchor points:

- `src/context/memory/agent.ts`
- `src/context/memory/obsidian.ts`
- `src/engine/intelligence.ts`

Current state:

- memory cache: yes
- relevance search: yes
- Obsidian source of truth: yes
- stable module summaries / invariants / anti-patterns: no

Conclusion:

Do not keep adding more heterogeneous items into the current flat memory index.
Split semantic memory into its own store and retrieval path.

### D. `learning/`

Best anchor points:

- `src/engine/intelligence.ts`
- `src/entrypoints/repl.ts`
- `src/automation/obsidian-agent.ts`
- `src/automation/background.ts`

Current state:

- memory extraction after turn: yes
- archive/digest maintenance: yes
- consolidation into rules: no
- forgetting policy: no
- graph updates driven by learning: no

Conclusion:

Learning should become a first-class asynchronous pipeline, not another note-maintenance helper.

### E. `retrieval-planner/`

Best anchor points:

- `src/engine/strategy.ts`
- `src/entrypoints/repl.ts`
- `src/engine/loop.ts`
- `src/entrypoints/prompt-builder.ts`

Current state:

- task complexity analysis: yes
- memory retrieval: yes
- vault refresh: yes
- tool routing: yes
- graph-aware context planning: no

Conclusion:

The planner belongs before `runLoop()` and inside `refreshContext()`, not inside the static prompt builder.

---

## Scenario 1: Minimal Evolution

### Summary

Keep the current architecture intact.
Extend existing `context/workspace` and `context/memory` modules.

### Shape

- add graph files under `src/context/workspace/graph/`
- add episodic memory files under `src/context/memory/episodes.ts`
- add semantic memory files under `src/context/memory/semantic.ts`
- call retrieval planning directly from `repl.ts`

### Storage

- `.pcc/codebase-graph/`
- `.pcc/memory/episodes/`
- `.pcc/memory/semantic/`
- `.pcc/learning/recall-rules.json`

### Pros

- lowest risk
- minimal refactor
- fastest time to first value
- reuses `bootstrap.ts`, `repl.ts`, `loop.ts`, `WorkspaceIndexer`, `MemoryAgent`

### Cons

- cognition logic spreads across existing modules
- harder to reason about ownership
- memory and graph concerns stay mixed with prompt/context concerns
- future sub-agent coordination becomes ad hoc

### Best use

- v1 for one repo
- medium codebase
- single-process CLI remains the main product

---

## Scenario 2: In-Process Cognitive Runtime

### Summary

Add a dedicated runtime namespace:

`src/cognition/`

This is the recommended target.

### Shape

```text
src/cognition/
  index.ts
  blackboard.ts
  schemas.ts
  service.ts
  codebase-graph/
    ast-indexer.ts
    graph-store.ts
    import-graph.ts
    call-graph.ts
    routes.ts
    ownership.ts
    relevance.ts
  memory-episodes/
    episode-store.ts
    recorder.ts
    summarizer.ts
    schemas.ts
  memory-semantic/
    semantic-store.ts
    module-summary.ts
    conventions.ts
    invariants.ts
    anti-patterns.ts
    hidden-deps.ts
  learning/
    consolidator.ts
    recall-rules.ts
    forgetting.ts
    scheduler.ts
  retrieval-planner/
    planner.ts
    query-builder.ts
    budgeter.ts
    result-assembler.ts
  agents/
    roles.ts
    contracts.ts
    board-access.ts
```

### Core idea

Introduce a shared blackboard service:

- orchestrator reads from it
- sub-agents write structured outputs to it
- retrieval-planner queries it
- learning consolidates it

### Blackboard record types

- graph facts
- validated repo facts
- hypotheses
- test results
- attempted fixes
- final episode summaries
- semantic rules
- recall rules

### Pros

- clean separation of concerns
- visible orchestrator remains simple
- invisible sub-agents can be disciplined
- future persistent teams become possible
- storage and retrieval contracts become explicit

### Cons

- more upfront design
- new runtime service to bootstrap and test
- requires new schemas and migration logic

### Best use

- recommended target for Shugu
- keeps current process model
- supports serious multi-agent behavior without becoming distributed too early

---

## Scenario 3: Sidecar / Daemon

### Summary

Move graph indexing and learning into a background daemon or sidecar process.

### Shape

- main CLI queries a local daemon
- daemon maintains graph/memory continuously
- scheduler/background manager trigger updates

### Pros

- heavy indexing does not block interactive turns
- better for large repos and long-lived sessions
- continuous graph freshness

### Cons

- more failure modes
- more lifecycle complexity
- harder Windows ergonomics
- cache invalidation and schema versioning become mandatory
- overkill before the in-process contracts stabilize

### Best use

- later stage
- large monorepos
- many recurring background jobs
- long-lived workspace intelligence

### Recommendation

Do not start here.

---

## Recommended Target

Choose a hybrid:

1. Build Scenario 2 as the target architecture.
2. Deliver it through Scenario 1 style increments.
3. Keep Scenario 3 as a later scale path only.

In short:

- target architecture: `src/cognition/`
- first implementation style: incremental, in-process, compatible with existing modules

---

## Exact Integration Points

### 1. Bootstrap

Extend `src/entrypoints/bootstrap.ts` to create a `CognitionService`.

Responsibilities:

- load graph store
- load episode store
- load semantic store
- load recall rules
- expose them through `RuntimeServices`

Do not put planner logic directly in bootstrap.
Bootstrap should assemble services, not decide turn-level context.

### 2. Before each user turn

In `src/entrypoints/repl.ts`, between:

- user input expansion
- `analyzeTask(...)`
- `buildVolatilePromptParts(...)`

insert:

- `retrievalPlanner.plan(effectiveInput, session, workContext, recentFiles, gitContext)`

Planner output should include:

- relevant files
- relevant symbols
- relevant episodes
- relevant semantic rules
- relevant graph slices
- suggested agent roles
- prompt fragments under a token budget

### 3. During loop execution

Use `src/engine/loop.ts` event stream as the canonical event source.

Feed the cognition layer from:

- `tool_executing`
- `tool_result`
- `tool_result_message`
- `assistant_message`
- `history_sync`
- `loop_end`

This is how episodes become event-backed instead of note-backed.

### 4. After each turn

In `src/entrypoints/repl.ts`, after `runPostTurnIntelligence(...)`:

- finalize or update active episode
- extract candidate lessons
- update semantic summaries only if confidence is high
- enqueue graph refresh for changed files

### 5. After each session

At session save / dispose time:

- compress finished episodes
- dedupe semantic memory
- regenerate recall rules
- forget low-value noise

### 6. Workspace graph update

Keep `WorkspaceIndexer` as the fast lexical index.
Add `CodebaseGraphIndexer` beside it, not inside it.

Suggested relation:

- `WorkspaceIndexer` = fast broad search
- `CodebaseGraphIndexer` = structural truth

### 7. Sub-agent coordination

Keep `AgentOrchestrator` and `AgentTool`.
Do not rewrite them first.

Instead:

- extend `AgentDefinition`
- add role contracts
- add blackboard read/write access
- make outputs structured

---

## Proposed Storage Layout

```text
.pcc/
  index/
    files.jsonl
    symbols.jsonl
    meta.json
  codebase-graph/
    meta.json
    ast/
      files.jsonl
    imports.jsonl
    calls.jsonl
    routes.jsonl
    ownership.jsonl
    symbols.jsonl
  memory/
    index.json
    episodes/
      active/
        <episode-id>.json
      closed/
        <episode-id>.json
    semantic/
      modules/
        <module-key>.json
      conventions.json
      invariants.json
      anti-patterns.json
      hidden-dependencies.json
    recall-rules.json
  learning/
    queue.json
    digest.json
    forgotten.json
```

---

## Data Contracts

### Episode

```json
{
  "id": "ep_2026_04_09_001",
  "goal": "Fix plugin sandbox loading failure",
  "status": "closed",
  "startedAt": "2026-04-09T20:10:00Z",
  "endedAt": "2026-04-09T20:24:00Z",
  "filesTouched": ["src/plugins/loader.ts", "src/plugins/registry.ts"],
  "hypotheses": [
    {"text": "Registry never receives brokered tool categories", "confidence": 0.62}
  ],
  "commands": [
    {"tool": "Read", "target": "src/plugins/loader.ts", "outcome": "success"},
    {"tool": "Bash", "target": "npm test -- tests/plugin-broker.test.ts", "outcome": "success"}
  ],
  "result": {
    "status": "fixed",
    "summary": "Brokered tools now register categories before validation"
  },
  "lesson": {
    "summary": "Plugin-loaded tools must be categorized before ToolRouter validation",
    "promoteToSemantic": true
  }
}
```

### Semantic memory item

```json
{
  "key": "tool-router-categories",
  "kind": "invariant",
  "scope": "repo",
  "summary": "Every registered tool must declare at least one category before router validation runs.",
  "evidence": [
    "src/tools/router.ts",
    "src/entrypoints/bootstrap.ts"
  ],
  "confidence": 0.95,
  "updatedAt": "2026-04-09T20:24:00Z"
}
```

### Recall rule

```json
{
  "id": "rr_tool_categories_before_validation",
  "trigger": {
    "queryTerms": ["tool", "plugin", "register", "category", "router"]
  },
  "action": {
    "injectSemanticKeys": ["tool-router-categories"],
    "prioritizeFiles": ["src/tools/router.ts", "src/entrypoints/bootstrap.ts"]
  },
  "confidence": 0.88
}
```

---

## How To Build `codebase-graph/`

### Recommended V1 scope

Shugu is TypeScript-first.
Use the TypeScript compiler API first because `typescript` is already a dependency.

V1:

- parse `.ts`, `.tsx`, `.js`, `.jsx`
- build AST-backed symbol map
- build import graph
- build call graph for local named functions where resolvable
- detect routes for common Node/Express/Fastify/Next patterns
- infer ownership from nearest package/app/module boundaries and git history heuristics

Fallback for unsupported languages:

- keep current regex symbol extraction
- mark graph coverage as partial

### Why not start with a universal parser

- adds dependency cost immediately
- increases maintenance surface
- Shugu already lives in a TS codebase
- TS-first gets useful graph coverage fast

---

## How To Build `memory-episodes/`

### Principle

Episodes should be event-sourced from runtime facts, then summarized.

### Raw sources

- session messages
- `workContext`
- file tracking hook
- tool call stream
- test/build outcomes
- final assistant synthesis

### Capture policy

Create one active episode per user task, not per turn.

Open episode:

- first user request
- `/retry` continues same episode if same goal
- explicit user pivot starts a new episode

Close episode:

- task completed
- user abandons
- session exits
- agent blocked and summarized

### Important

Do not let the model be the only source of truth for commands and touched files.
Those should come from tool events.

---

## How To Build `memory-semantic/`

### Principle

Semantic memory must contain stable truths, not conversation residue.

### Good candidates

- module summaries
- project conventions
- invariants
- anti-patterns
- hidden dependencies
- recurring failure modes

### Bad candidates

- "opened file X"
- "the user asked Y"
- temporary debugging notes
- low-confidence guesses

### Promotion rule

Only promote episode lessons into semantic memory when:

- the episode succeeded, or
- the failure produced a verified invariant

and:

- there is evidence in code/tool output, not just model prose

---

## How To Build `learning/`

### Learning stages

1. collect
2. compress
3. validate
4. promote
5. forget

### After each turn

- append event facts to active episode
- append changed-file graph refresh tasks
- collect candidate lessons

### After each session

- summarize completed episodes
- merge duplicates
- regenerate recall rules
- decay weak/noisy memories

### Forgetting policy

Forget:

- duplicate lessons
- low-evidence facts
- one-off failed hypotheses
- stale debug debris

Never silently drop:

- promoted invariants
- validated hidden dependencies
- high-confidence recall rules

---

## How To Build `retrieval-planner/`

### Planner input

- raw user goal
- task complexity
- current work context
- changed files
- recent tool history
- graph coverage metadata
- episodic memory hits
- semantic memory hits
- recall rule hits

### Planner output

- targeted file list
- targeted symbol list
- targeted graph facts
- relevant episodes
- relevant semantic memory
- suggested agent roles
- prompt blocks sized to budget

### Planner stages

1. detect repo area
2. retrieve graph slice
3. retrieve semantic memory
4. retrieve similar episodes
5. apply recall rules
6. budget and assemble

### Placement

- main call before `runLoop()`
- incremental call inside `refreshContext()`

Do not put this only in `buildSystemPrompt()`.
That file is startup-oriented, not turn-oriented.

---

## Sub-Agent Discipline Model

The orchestration design should be:

- visible orchestrator
- invisible specialists
- strict role contracts
- structured outputs

### Add these constraints to `AgentDefinition`

- `allowedTools`
- `maxTurns`
- `maxBudgetUsd`
- `writesToBlackboard: string[]`
- `readsFromBlackboard: string[]`
- `outputSchema`
- `visibility: visible | silent`

### Example roles

- `repo-mapper`
- `memory-agent`
- `impact-agent`
- `patch-agent`
- `test-agent`
- `critic-agent`
- `doc-agent`

### Example role rules

- `repo-mapper` cannot edit
- `test-agent` cannot propose architecture
- `critic-agent` cannot write final patch
- `memory-agent` returns only recalled facts plus confidence

---

## Recommended Delivery Phases

### Phase 0: Hardening

- make learning/memory failures observable
- add service-level health/status for graph and memory stores
- stop silent best-effort writes for critical cognition paths

### Phase 1: Graph V1

- add TS-first AST index
- add import graph
- upgrade symbol map
- expose graph status in `/workspace status`

### Phase 2: Episodes

- add episode schema
- record tool events, files, results, lessons
- save active/closed episodes under `.pcc/memory/episodes/`

### Phase 3: Retrieval planner

- add planner service
- call it before loop and in refresh
- inject targeted context blocks

### Phase 4: Semantic memory

- promote validated lessons from episodes
- add recall rules
- split semantic retrieval from episodic retrieval

### Phase 5: Specialized teams

- add structured blackboard access
- add specialized silent agents
- let orchestrator decide which roles to spawn

### Phase 6: Optional daemon

- only if graph cost becomes a UX problem

---

## Risks

### Risk 1: Silent forgetting

Current memory-related paths already contain best-effort behavior.
If repeated in the new cognition layer, Shugu will appear smart but lose facts silently.

Mitigation:

- explicit health counters
- persisted failure queue
- visible degraded-mode status

### Risk 2: LLM-only graph extraction

If graph facts are inferred from prose instead of code parsing, retrieval quality will drift.

Mitigation:

- AST-backed facts first
- LLM only for summaries, not structural truth

### Risk 3: Flat memory growth

If episodes and semantic memory share one undifferentiated store, retrieval noise will explode.

Mitigation:

- separate stores
- separate ranking
- promotion rules

### Risk 4: Sidecar too early

A daemon before schemas stabilize will create more failure modes than value.

Mitigation:

- in-process first
- stable contracts first
- sidecar later

---

## Net Recommendation

Shugu should evolve into an in-process cognitive runtime, not a larger prompt.

The right path is:

- keep the current visible orchestrator
- keep real hidden sub-agents
- add a shared blackboard
- split memory into episodic and semantic layers
- build a real codebase graph
- insert retrieval planning before every turn
- consolidate learning after each turn/session

Do not treat this as "one more memory feature".
Treat it as a new runtime layer that sits between:

- raw repo facts
- raw session facts
- agent orchestration
- prompt assembly

That is the point where Shugu stops being "a CLI with tools" and starts behaving like a cognitive operating system around the model.
