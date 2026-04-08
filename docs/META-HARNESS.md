# Meta-Harness -- Outer-Loop Optimization System

The Meta-Harness is Shugu's self-improvement engine. It treats the agent's
configuration as a search space and uses evolutionary optimization to find
better configurations through automated evaluation. The agent literally
optimizes itself: Shugu proposes new harness configs, evaluates them against
a task suite, selects the best via Pareto frontier analysis, and repeats.

**Inspired by:** "Meta-Harness: End-to-End Optimization of Model Harnesses"
(Lee et al., arXiv 2603.28052)

---

## Architecture Overview

```
                    +--------------------------------------------+
                    |              Meta-Harness                   |
                    |                                            |
                    |  +-----------+  +-----------+  +--------+  |
                    |  | Proposer  |->| Evaluator |->| Select |  |
                    |  +-----------+  +-----------+  +--------+  |
                    |       ^                            |        |
                    |       +----------------------------+        |
                    |             (generation loop)               |
                    |                                            |
                    |  +----------+  +---------+  +-----------+  |
                    |  | Dataset  |  | Archive |  |  Report   |  |
                    |  +----------+  +---------+  +-----------+  |
                    |                                            |
                    |  +----------+  +---------+  +-----------+  |
                    |  | Runtime  |  | Collect |  |  Redact   |  |
                    |  +----------+  +---------+  +-----------+  |
                    +--------------------------------------------+
                                       |
                                       v
                    +--------------------------------------------+
                    |           CLI  (/meta command)              |
                    +--------------------------------------------+
```

The outer loop runs as follows:

1. **Dataset** loads a task suite and splits it into search/holdout sets.
2. **Evaluator** runs the baseline config against the search set.
3. **Proposer** (itself a Shugu agent) analyzes prior results and proposes
   new harness configurations.
4. **Evaluator** runs each proposed config against the search set.
5. **Selector** computes the Pareto frontier across all candidates.
6. **Archive** persists everything to `~/.pcc/meta/`.
7. Steps 3-6 repeat for N generations.
8. **Promote** validates the best candidate on the holdout set and copies
   its config into production.

---

## File Inventory

The entire subsystem lives in `src/meta/` and comprises 12 files totaling
3,207 lines.

### 1. `src/meta/types.ts` (364 lines)

**Key exports:** `HarnessConfig`, `HarnessRuntime`, `EvalTask`, `TaskScorer`,
`SuccessCriterion`, `CriterionResult`, `EvalResult`, `ToolStat`,
`CandidateManifest`, `RunManifest`, `StructuredResult`, `ScoredCandidate`,
`EvaluatorOptions`, `MetaRuntimeConfig`, `DatasetSplit`

**Dependencies:** `../protocol/messages.js` (Message, Usage),
`../engine/loop.js` (LoopEvent), `../engine/strategy.js` (Complexity),
`../agents/orchestrator.js` (AgentDefinition)

Central vocabulary file. Every other meta module imports from here. Defines
the full data model: what a harness configuration looks like, how tasks are
structured, what evaluation results contain, how candidates and runs are
manifested, and the multi-objective score vector used for selection.

### 2. `src/meta/config.ts` (183 lines)

**Key exports:** `loadHarnessConfig()`, `validateHarnessConfig()`,
`ValidationResult`

**Dependencies:** `node:fs/promises`, `node:path`, `yaml`, `./types.js`

Loads `HarnessConfig` from a YAML directory structure and validates it
against V1 security restrictions. Resolves file references for prompt
fragments (`system-prompt-append.md`, `strategy-prompts/*.md`,
`reflection-template.md`). Enforces immutable zones: rejects any config
that references `transport/`, `protocol/`, `policy/`, or `credentials/`
paths.

### 3. `src/meta/runtime.ts` (164 lines)

**Key exports:** `bootstrapMeta()`, `MetaRuntime`

**Dependencies:** `../transport/client.js`, `../tools/index.js`,
`../policy/permissions.js`, `../credentials/vault.js`,
`../credentials/provider.js`, `../plugins/registry.js`,
`../plugins/builtin/behavior-hooks.js`,
`../plugins/builtin/verification-hook.js`,
`../agents/orchestrator.js`, `../entrypoints/prompt-builder.js`,
`../engine/loop.js`, `./types.js`, `../utils/tracer.js`

Non-interactive runtime factory. Replicates the full bootstrap pipeline
(`src/entrypoints/bootstrap.ts`) without TTY, terminal renderer, REPL, or
interactive permission prompts. Creates a complete `LoopConfig` with
MiniMaxClient, tool registry, permission resolver (fullAuto), plugin/hook
registry, agent orchestrator, and system prompt. Vault credentials unlock
via `PCC_VAULT_PASSWORD` environment variable only. Returns a `MetaRuntime`
with `loopConfig`, `orchestrator`, `systemPrompt`, and a `dispose()` method.

### 4. `src/meta/evaluator.ts` (413 lines)

**Key exports:** `MetaEvaluator` (class)

**Dependencies:** `node:crypto`, `node:child_process`, `node:fs/promises`,
`node:path`, `../agents/worktree.js`, `../utils/git.js`,
`../utils/tracer.js`, `./runtime.js`, `./collect.js`, `./redact.js`,
`./archive.js`, `./types.js`

The evaluation engine. Runs candidate harness configs against task suites.
Each task executes in a fresh git worktree for isolation. Supports three
scorer types: criteria-based, command-based, and LLM-as-judge. Aggregates
scores across repeated runs using configurable strategies (mean, median,
best, worst). Enforces per-candidate budget guards. Redacts traces before
archival. Produces a `CandidateManifest` with aggregate metrics.

### 5. `src/meta/proposer.ts` (237 lines)

**Key exports:** `MetaProposer` (class)

**Dependencies:** `yaml`, `node:fs/promises`, `node:path`,
`../agents/orchestrator.js`, `../transport/client.js`, `./archive.js`,
`./types.js`, `./selector.js`, `./config.js`, `../utils/tracer.js`

Agentic proposer -- uses Shugu itself (via `AgentOrchestrator.spawn()`)
to analyze prior candidates' configs, scores, and execution traces, then
propose improved configurations. The proposer agent runs in a worktree
with access to Read, Write, Glob, Grep, and Bash tools and is budgeted at
$0.50 / 25 turns. Builds a detailed prompt with parent summaries, per-task
results, Pareto frontier context, and mutation space documentation. Extracts
new configs from proposer-written YAML files or from YAML code blocks in
the response text. All proposals are validated before acceptance.

### 6. `src/meta/selector.ts` (178 lines)

**Key exports:** `computeParetoFrontier()`, `rankByWeightedScore()`,
`selectParents()`

**Dependencies:** `./types.js`

Multi-objective selection over candidate harnesses. Implements standard
Pareto dominance: candidate A dominates B if A is no worse on all 5
objectives and strictly better on at least one. Also provides weighted
scalar ranking with configurable weights (default: accuracy=1.0,
errorRate=0.4, cost=0.3, turns=0.2, tokens=0.1) and min-max normalization.
`selectParents()` picks from the Pareto frontier with diversity, filling
with top-ranked non-frontier candidates when needed.

### 7. `src/meta/dataset.ts` (232 lines)

**Key exports:** `loadDataset()`, `splitDataset()`, `createDefaultDataset()`

**Dependencies:** `node:fs/promises`, `node:crypto`, `yaml`, `./types.js`

Loads YAML-formatted task suites and splits them into search/holdout sets
using deterministic SHA-256 hashing of task IDs (reproducible across runs).
Validates all tasks for required fields, unique IDs, and valid scorer types.
Includes a built-in default dataset of 8 canonical coding tasks covering
file creation, bug fixing, codebase search, refactoring, multi-file editing,
efficiency testing, test writing, and error handling.

### 8. `src/meta/collect.ts` (139 lines)

**Key exports:** `runStructuredQuery()`

**Dependencies:** `../engine/loop.js`, `../engine/interrupts.js`,
`../protocol/messages.js`, `../utils/tracer.js`, `./runtime.js`,
`./types.js`

Bridge between the MetaEvaluator and the Shugu engine. Wraps `runLoop()`
to collect all events and return a `StructuredResult`. Runs headlessly with
no terminal renderer. Tracks per-tool statistics (calls, errors, duration),
cumulative token usage, turn counts, and wall-clock timing. Supports
configurable timeouts via `InterruptController.abort()`.

### 9. `src/meta/archive.ts` (379 lines)

**Key exports:** `MetaArchive` (class)

**Dependencies:** `node:fs/promises`, `node:path`, `yaml`, `./types.js`,
`../utils/tracer.js`

Filesystem archive at `~/.pcc/meta/`. All operations are explicit about
errors (no silent catches -- only ENOENT is handled gracefully). Manages
runs (create, update, load, list, getLatest), candidates (write manifest +
config, load, list), results (write per-task, load all), traces (write
redacted JSONL, load), scores (write/load aggregate JSON), and datasets.
Ensures directory structure is created recursively on write.

### 10. `src/meta/report.ts` (175 lines)

**Key exports:** `generateRunReport()`, `generateCandidateReport()`,
`generateDiffReport()`

**Dependencies:** `./types.js`

Produces human-readable Markdown reports. The run report includes a
summary table of all candidates with scores, success rates, costs, turns,
and Pareto frontier membership. The candidate report shows per-task
results, tool usage summaries, and failure details with per-criterion
breakdowns. The diff report compares two `HarnessConfig` objects
field-by-field, showing additions, removals, and changes.

### 11. `src/meta/redact.ts` (103 lines)

**Key exports:** `redactMessages()`, `redactTraceEvents()`

**Dependencies:** `../plugins/builtin/behavior-hooks.js` (SECRET_PATTERNS),
`../protocol/messages.js`, `../utils/tracer.js`

Sanitizes execution traces and messages before archival. Reuses
`SECRET_PATTERNS` from the builtin secret-scanner hook to catch API keys,
tokens, and credentials. Adds additional patterns for sensitive filesystem
paths (`~/.pcc/credentials/`, `.ssh/id_*`, `.env*`, private keys). Always
returns new arrays -- never mutates originals. Redacts text in both
string-content messages and structured content blocks (text, thinking,
content fields).

### 12. `src/meta/cli.ts` (640 lines)

**Key exports:** `createMetaCommand()`

**Dependencies:** `node:crypto`, `node:fs/promises`, `node:path`,
`node:os`, `yaml`, `../commands/registry.js`,
`../agents/orchestrator.js`, `../transport/client.js`, `./archive.js`,
`./evaluator.js`, `./proposer.js`, `./config.js`, `./dataset.js`,
`./selector.js`, `./report.js`, `./types.js`

The `/meta` CLI command -- the operator's interface to the entire system.
Factory function pattern (same as `createBatchCommand()`). Implements 10
subcommands: `init`, `run`, `resume`, `status`, `top`, `inspect`, `diff`,
`validate`, `promote`, `abort`. Orchestrates the full optimization loop
in `handleRun()`, wiring together the evaluator, proposer, and selector.

---

## Core Types

### HarnessConfig

The central configuration type. Captures all mutable knobs around the Shugu
engine. The proposer edits these; the evaluator applies them.

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Human-readable name for this configuration (required) |
| `version` | `string` | Semantic version string (required) |
| `parent` | `string?` | `candidateId` of the parent config, for lineage tracking |
| `systemPromptAppend` | `string?` | Text appended AFTER the immutable base system prompt |
| `promptFragments` | `Record<string, string>?` | Named text blocks injected at predefined positions in the prompt |
| `strategy.classifyPrompt` | `string?` | Override the LLM classification prompt |
| `strategy.complexityOverride` | `Complexity?` | Force a specific complexity level (skip classification) |
| `strategy.strategyPrompts` | `Partial<Record<Complexity, string \| null>>?` | Override strategy prompts per complexity level |
| `strategy.reflectionIntervals` | `Partial<Record<Complexity, number>>?` | Override reflection frequency per complexity level |
| `reflection.promptTemplate` | `string?` | Override the reflection prompt template; supports `{{turnIndex}}` and `{{maxTurns}}` placeholders |
| `reflection.forceInterval` | `number?` | Force a specific reflection interval for all complexities |
| `agents` | `Record<string, Partial<AgentDefinition>>?` | Override or add agent definitions (merged with BUILTIN_AGENTS) |
| `limits.maxTurns` | `number?` | Max turns per task (1-500) |
| `limits.maxBudgetUsd` | `number?` | Max budget per task in USD (0.01-50) |
| `limits.toolTimeoutMs` | `number?` | Tool execution timeout in milliseconds (5000-600000) |
| `model.temperature` | `number?` | Temperature for the evaluated model (0.01-2.0) |
| `model.maxTokens` | `number?` | Max tokens per response (256-32768) |
| `hooks.enable` | `string[]?` | Names of builtin hooks to enable |
| `hooks.disable` | `string[]?` | Names of builtin hooks to disable |

### HarnessRuntime

Runtime overrides threaded into the engine loop. These are the values that
`loop.ts` reads at specific points during execution.

| Field | Type | Description |
|-------|------|-------------|
| `toolTimeoutMs` | `number?` | Override TOOL_TIMEOUT_MS (default 300,000) |
| `reflectionInterval` | `number?` | Override reflection interval (per-complexity or forced) |
| `reflectionTemplate` | `string?` | Override reflection prompt template |
| `maxContinuations` | `number?` | Override MAX_CONTINUATIONS |

### EvalTask

A single task the evaluator runs against a candidate harness.

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique identifier |
| `prompt` | `string` | The prompt sent to Shugu |
| `cwd` | `string?` | Working directory relative to repo root (resolved to worktree at eval time) |
| `setupCommand` | `string?` | Bash command to run before the task (e.g., git checkout, file setup) |
| `timeoutMs` | `number?` | Max time for the entire task execution |
| `tags` | `string[]?` | Tags for filtering and grouping |
| `scorer` | `TaskScorer` | How to score this task |

### TaskScorer

A discriminated union supporting three scoring modes:

**`criteria`** -- Built-in multi-criteria scoring. Each criterion has a type,
expected value, and optional weight. The aggregate score is the
weight-normalized sum of passed criteria.

```typescript
{ type: 'criteria'; criteria: SuccessCriterion[] }
```

**`command`** -- External scorer via shell command. Score is parsed from
either the exit code (0 = pass = 1.0, nonzero = fail = 0.0) or stdout as
a float.

```typescript
{ type: 'command'; command: string; parseScore: 'exit_code' | 'stdout_float' }
```

**`llm_judge`** -- LLM-as-judge for subjective tasks. Provides a prompt and
rubric to an LLM that evaluates the output.

```typescript
{ type: 'llm_judge'; prompt: string; rubric: string }
```

### SuccessCriterion

A single criterion for the built-in criteria scorer.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `'file_exists' \| 'file_contains' \| 'command_succeeds' \| 'output_contains' \| 'cost_under' \| 'turns_under'` | The kind of check to perform |
| `value` | `string \| number` | Expected value: path for `file_exists`, pattern for `file_contains`, command for `command_succeeds`, text for `output_contains`, threshold for `cost_under`/`turns_under` |
| `weight` | `number?` | Weight in the aggregate score (default: 1) |

### CriterionResult

Result of evaluating a single criterion.

| Field | Type | Description |
|-------|------|-------------|
| `criterion` | `SuccessCriterion` | The criterion that was evaluated |
| `passed` | `boolean` | Whether the criterion passed |
| `actual` | `string \| number?` | The actual value observed |

### EvalResult

Result of evaluating a single task with a single candidate.

| Field | Type | Description |
|-------|------|-------------|
| `taskId` | `string` | The task that was evaluated |
| `candidateId` | `string` | The candidate being evaluated |
| `runId` | `string` | The optimization run this belongs to |
| `repeatIndex` | `number` | Which repetition this is (0-indexed) |
| `success` | `boolean` | Whether the task succeeded per the scorer |
| `score` | `number` | Score from 0.0 to 1.0 |
| `criteriaResults` | `CriterionResult[]` | Per-criterion results (for criteria scorer) |
| `costUsd` | `number` | Total cost in USD |
| `turns` | `number` | Number of turns used |
| `totalTokens` | `{ input: number; output: number }` | Token usage |
| `endReason` | `string` | How the loop ended |
| `durationMs` | `number` | Wall-clock duration in milliseconds |
| `traceId` | `string` | Trace ID for correlation |
| `toolStats` | `Record<string, ToolStat>` | Per-tool statistics |
| `error` | `string?` | Error message if the task errored |

### ToolStat

Per-tool execution statistics.

| Field | Type | Description |
|-------|------|-------------|
| `calls` | `number` | Number of times this tool was called |
| `errors` | `number` | Number of error results |
| `totalMs` | `number` | Total wall-clock milliseconds spent in this tool |

### CandidateManifest

Aggregate manifest for a candidate harness after evaluation.

| Field | Type | Description |
|-------|------|-------------|
| `candidateId` | `string` | Unique candidate identifier |
| `runId` | `string` | Parent run identifier |
| `generation` | `number` | Generation in the search process |
| `parentId` | `string?` | Parent candidate ID (for lineage tracking) |
| `config` | `HarnessConfig` | The harness config snapshot |
| `aggregateScore` | `number` | Aggregate score across all tasks |
| `costUsd` | `number` | Total cost of evaluation |
| `avgTurns` | `number` | Average turns per task |
| `avgTokens` | `number` | Average tokens per task |
| `taskCount` | `number` | Number of tasks evaluated |
| `successRate` | `number` | Fraction of tasks that succeeded (0.0 to 1.0) |
| `paretoRank` | `number?` | Pareto rank (1 = frontier, higher = dominated) |
| `createdAt` | `string` | ISO 8601 timestamp |

### RunManifest

Manifest for an optimization run.

| Field | Type | Description |
|-------|------|-------------|
| `runId` | `string` | Unique run identifier (12-char UUID prefix) |
| `status` | `'running' \| 'paused' \| 'completed' \| 'aborted'` | Current run status |
| `generation` | `number` | Current generation (0-indexed) |
| `maxGenerations` | `number` | Max generations before stopping |
| `candidatesPerGeneration` | `number` | Candidates proposed per generation |
| `dataset` | `string` | Absolute path to the dataset YAML file |
| `searchSetIds` | `string[]` | Task IDs in the search set (proposer sees these results) |
| `holdoutSetIds` | `string[]` | Task IDs in the holdout set (proposer NEVER sees these) |
| `startedAt` | `string` | ISO 8601 timestamp |
| `updatedAt` | `string` | ISO 8601 timestamp |
| `candidates` | `string[]` | All candidate IDs in this run |
| `currentBest` | `string?` | Current best candidate on search set |
| `totalCostUsd` | `number` | Total cost of the entire run |
| `holdoutResults` | `Record<string, CandidateManifest>?` | Holdout evaluation results for promoted candidates |

### StructuredResult

The structured output of running a single task through the engine. This is
what `runStructuredQuery()` returns.

| Field | Type | Description |
|-------|------|-------------|
| `messages` | `Message[]` | Canonical conversation messages |
| `events` | `LoopEvent[]` | All loop events (for trace archival) |
| `costUsd` | `number` | Total cost in USD |
| `turns` | `number` | Number of turns |
| `endReason` | `string` | How the loop ended |
| `toolStats` | `Record<string, ToolStat>` | Per-tool statistics |
| `traceId` | `string` | Trace ID for correlation |
| `totalUsage` | `Usage` | Cumulative token usage (`input_tokens`, `output_tokens`) |
| `durationMs` | `number` | Wall-clock duration in milliseconds |

### ScoredCandidate

A candidate with its multi-objective scores for Pareto selection.

| Field | Type | Description |
|-------|------|-------------|
| `candidateId` | `string` | Candidate identifier |
| `objectives.accuracy` | `number` | Higher is better (0-1) |
| `objectives.cost` | `number` | Lower is better (USD per task) |
| `objectives.tokens` | `number` | Lower is better (average tokens) |
| `objectives.turns` | `number` | Lower is better (average turns) |
| `objectives.errorRate` | `number` | Lower is better (0-1, = 1 - successRate) |

### EvaluatorOptions

Configuration for the evaluation engine.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `repeatCount` | `number` | 1 | How many times to repeat each task |
| `aggregation` | `'median' \| 'mean' \| 'best' \| 'worst'` | `'median'` | How to aggregate scores across repetitions |
| `temperature` | `number?` | 0.01 | Temperature override for evaluation runs |
| `maxCandidateBudgetUsd` | `number?` | 2.0 | Max budget per candidate evaluation in USD |

### MetaRuntimeConfig

Config for bootstrapping a non-interactive Shugu runtime.

| Field | Type | Description |
|-------|------|-------------|
| `harnessConfig` | `HarnessConfig` | The harness configuration to apply |
| `cwd` | `string` | Working directory (typically a worktree path) |
| `permissionMode` | `'fullAuto' \| 'bypass'?` | Permission mode (default: `'fullAuto'`) |
| `archivePath` | `string` | Absolute path to the meta archive (`~/.pcc/meta/`) |

### DatasetSplit

A dataset split into search and holdout sets.

| Field | Type | Description |
|-------|------|-------------|
| `searchSet` | `EvalTask[]` | Tasks used during optimization (proposer sees results) |
| `holdoutSet` | `EvalTask[]` | Tasks reserved for final validation (proposer never sees) |

---

## The Optimization Loop

### Step 1: Initialization (`/meta init`)

1. Creates `harnesses/default/config.yaml` in the project root with a
   minimal baseline config (name + version, no overrides).
2. Creates the default dataset at `~/.pcc/meta/datasets/default.yaml`
   containing 8 canonical coding tasks.
3. Sets up the archive directory at `~/.pcc/meta/`.

### Step 2: Dataset Split

When `/meta run` starts, `loadDataset()` reads the YAML task suite and
splits it using `splitDataset()`.

**How the split works:**

Each task ID is hashed with SHA-256. The first 4 bytes are read as a
big-endian uint32 and normalized to [0, 1). If the value is less than
`splitRatio` (default: 0.7), the task goes to the search set; otherwise
it goes to the holdout set.

**Why this matters:**

- The **search set** (70%) is what the proposer sees. Candidates are
  evaluated against it, and the proposer reads these results to make
  informed proposals.
- The **holdout set** (30%) is invisible to the proposer. It exists solely
  for final validation. This prevents overfitting to the search set --
  a candidate that scores well on the search set but poorly on holdout
  has memorized the evaluation rather than genuinely improving.
- The split is **deterministic** -- the same task IDs always hash to the
  same set, ensuring reproducibility across runs.
- Safety: both sets are guaranteed non-empty. If one is empty after hashing,
  a task is moved from the other.

### Step 3: Candidate Proposal

The `MetaProposer` uses Shugu itself to propose new configs:

1. **Parent selection:** `selectParents()` picks up to 3 parents from the
   Pareto frontier, prioritizing diversity. If the frontier is smaller than
   the requested count, top-ranked non-frontier candidates fill the gap.

2. **Prompt construction:** `buildProposerPrompt()` assembles a detailed
   task prompt containing:
   - Parent candidate summaries (score, success rate, cost, turns, tokens)
   - Per-task result breakdowns for the top 3 parents
   - The current Pareto frontier
   - The top-5 leaderboard (by weighted score)
   - The full mutation space (what CAN be changed)
   - Explicit constraints (what CANNOT be changed)
   - Archive directory structure for the proposer to explore

3. **Agent execution:** The proposer runs as a Shugu agent spawned via
   `AgentOrchestrator.spawn()` with:
   - Agent profile: `general`
   - Max turns: 25
   - Max budget: $0.50
   - Isolation: worktree
   - Tools: Read, Write, Glob, Grep, Bash

4. **Config extraction:** After the proposer finishes, configs are extracted
   by:
   - First: reading `proposed-1.yaml`, `proposed-2.yaml`, etc. from the
     proposer's worktree
   - Fallback: parsing YAML code blocks from the response text
   - All extracted configs are validated via `validateHarnessConfig()`
     before acceptance

### Step 4: Evaluation

The `MetaEvaluator.evaluate()` method runs a candidate config against the
task suite:

1. **Iteration:** For each task, for each repeat (configurable, default 1):

2. **Worktree isolation:** A fresh git worktree is created via
   `createWorktree()` for each task evaluation. The worktree is cleaned up
   in a `finally` block regardless of outcome.

3. **Setup:** If the task has a `setupCommand`, it runs in the worktree
   with a 30-second timeout. Failure here produces an error result.

4. **Runtime bootstrap:** `bootstrapMeta()` creates a complete
   non-interactive Shugu runtime with:
   - MiniMaxClient configured with the candidate's temperature/maxTokens
   - Full tool registry + permissions in fullAuto mode
   - Plugin/hook registry (with behavior hooks and verification hook)
   - Agent orchestrator with merged agent profiles
   - System prompt built by `buildSystemPrompt()` with the harness config
   - HarnessRuntime overrides for toolTimeout, reflection interval/template

5. **Execution:** `runStructuredQuery()` feeds the task prompt into
   `runLoop()` and collects all events, tracking:
   - Turn count
   - Per-tool statistics (calls, errors, duration)
   - Token usage (input + output)
   - Cost
   - End reason
   - Wall-clock duration
   - Timeout enforcement via `InterruptController`

6. **Scoring:** The task's scorer determines the result:
   - **criteria:** Each criterion is evaluated independently. Score =
     weighted sum of passed criteria / total weight. Success = score >= 0.5.
     Criterion types:
     - `file_exists`: Checks if a file exists at the given path in the worktree
     - `file_contains`: Searches recently modified files for a text pattern
     - `command_succeeds`: Runs a shell command, passes on exit code 0
     - `output_contains`: Checks if assistant messages contain text
     - `cost_under`: Passes if total cost < threshold
     - `turns_under`: Passes if turn count < threshold
   - **command:** Runs an external command. Parses score from exit code or
     stdout float.
   - **llm_judge:** LLM-as-judge (placeholder in V1, returns 0.5).

7. **Redaction:** Messages and trace events are redacted via
   `redactMessages()` and `redactTraceEvents()` before archival.

8. **Archival:** The `EvalResult` and redacted traces are written to the
   archive.

9. **Budget guard:** If the cumulative cost exceeds
   `maxCandidateBudgetUsd`, remaining tasks are skipped.

10. **Aggregation:** Scores across repeated runs are aggregated per-task
    using the configured strategy (median/mean/best/worst), then averaged
    across tasks to produce the `CandidateManifest`.

### Step 5: Selection

After each generation, selection happens in three layers:

1. **Pareto frontier computation** (`computeParetoFrontier()`):
   A candidate is on the frontier if no other candidate dominates it.
   Candidate A dominates B when A is no worse on ALL 5 objectives and
   strictly better on at least one.

2. **Weighted score ranking** (`rankByWeightedScore()`):
   For ordering within the frontier and for leaderboard display. Each
   objective is min-max normalized to [0, 1] across the population, then
   multiplied by its weight and summed.

   Default weights:
   | Objective | Weight | Direction |
   |-----------|--------|-----------|
   | accuracy | 1.0 | Higher is better |
   | errorRate | 0.4 | Lower is better |
   | cost | 0.3 | Lower is better |
   | turns | 0.2 | Lower is better |
   | tokens | 0.1 | Lower is better |

3. **Parent selection** (`selectParents()`):
   For the next generation's proposer. Picks from the Pareto frontier
   with diversity (evenly spaced candidates from the ranked frontier).
   If the frontier has fewer than the requested count, supplements with
   top-ranked non-frontier candidates.

### Step 6: Archive

All data is persisted to `~/.pcc/meta/` via the `MetaArchive` class.
See "Archive Structure" below for the directory layout.

Key operations:
- `createRun()` / `updateRun()` / `loadRun()` / `listRuns()` / `getLatestRun()` -- run lifecycle
- `writeCandidate()` / `loadCandidate()` / `loadCandidateConfig()` / `listCandidates()` -- candidate CRUD
- `writeResult()` / `loadResults()` -- per-task evaluation results
- `writeTrace()` / `loadTrace()` -- redacted JSONL trace events
- `writeScores()` / `loadScores()` -- aggregate score JSON

All writes create directories recursively. Only `ENOENT` errors are
handled gracefully (return null/empty); all other errors propagate.

### Step 7: Promotion

Promotion is a gated, two-stage process:

1. **Holdout validation** (`/meta validate <id>`):
   The candidate is evaluated on the holdout set (tasks it was never
   optimized against). Results are stored in
   `RunManifest.holdoutResults`.

2. **Promotion** (`/meta promote <id>`):
   - Requires prior holdout validation (error if not validated)
   - Requires holdout success rate >= 50% (rejects if too low)
   - Copies the candidate's `config.yaml` to `harnesses/active/config.yaml`
   - Displays both search and holdout scores for comparison

---

## Configuration Reference

### What CAN Be Mutated (Mutation Space)

These are the fields the proposer can modify in `HarnessConfig`:

**Prompt mutations:**
- `systemPromptAppend` -- text appended after the base system prompt.
  This is the primary mechanism for improving behavior. Can include
  instructions, heuristics, examples, constraints.
- `promptFragments` -- named text blocks injected at predefined positions.
  Allows targeted injection without modifying the main prompt flow.

**Strategy mutations:**
- `strategy.classifyPrompt` -- override the LLM prompt used to classify
  task complexity.
- `strategy.complexityOverride` -- bypass classification entirely and
  force a complexity level (trivial, simple, complex, epic).
- `strategy.strategyPrompts` -- per-complexity strategy hints that guide
  the agent's approach.
- `strategy.reflectionIntervals` -- per-complexity reflection frequency
  (how often the agent pauses to reflect on progress).

**Reflection mutations:**
- `reflection.promptTemplate` -- custom reflection prompt. Supports
  `{{turnIndex}}` and `{{maxTurns}}` template variables.
- `reflection.forceInterval` -- override reflection interval for all
  complexities.

**Agent profile mutations:**
- `agents` -- override or add agent definitions. Each entry is merged
  with the builtin agent of the same name (or `general` as base).
  Can modify `rolePrompt`, `maxTurns`, `allowedTools`.

**Limits:**
- `limits.maxTurns` -- max conversation turns (1-500)
- `limits.maxBudgetUsd` -- max cost per task ($0.01-$50)
- `limits.toolTimeoutMs` -- tool execution timeout (5s-600s)

**Model settings:**
- `model.temperature` -- inference temperature (0.01-2.0)
- `model.maxTokens` -- max tokens per response (256-32768)

**Hook activation:**
- `hooks.enable` -- list of builtin hook names to activate
- `hooks.disable` -- list of builtin hook names to deactivate

### What CANNOT Be Mutated (Immutable Zones)

These are enforced by `validateHarnessConfig()` and will cause validation
errors if referenced:

- **BASE_SYSTEM_PROMPT** -- the core system prompt is immutable. V1 forbids
  `systemPromptOverride`. Only `systemPromptAppend` is allowed.
- **model.name** -- the model is fixed for the entire run. Not mutable by
  the proposer.
- **transport/** -- the transport layer (MiniMaxClient, HTTP config) is
  immutable.
- **protocol/** -- the message protocol is immutable.
- **policy/** -- permission policies are immutable.
- **credentials/** -- credential management is immutable.
- **Security rules** -- the builtin deny rules and permission resolver
  cannot be modified.
- **Shell metacharacters** -- the config validator has a
  `SHELL_METACHAR_PATTERN` (`[;&|`$(){}[]<>!]`) defined but not yet
  enforced on command fields in V1.

---

## CLI Usage

### /meta command

```
/meta <subcommand> [args]
```

Aliases: `/mh`

### Subcommands

#### `/meta init`

Initialize the harness and dataset structure.

Creates:
- `harnesses/default/config.yaml` -- minimal baseline config
- `~/.pcc/meta/datasets/default.yaml` -- default dataset (8 tasks)
- `~/.pcc/meta/` directory structure

#### `/meta run [options]`

Start a new optimization run.

**Options:**
| Flag | Default | Description |
|------|---------|-------------|
| `--generations=N` | 5 | Number of generations |
| `--candidates=N` | 2 | Candidates proposed per generation |
| `--repeat=N` | 1 | Times to repeat each task evaluation |
| `--dataset=PATH` | `~/.pcc/meta/datasets/default.yaml` | Path to dataset YAML |

**Process:**
1. Loads and validates `harnesses/default/config.yaml`
2. Loads and splits the dataset (70/30 search/holdout)
3. Evaluates the baseline config on the search set
4. Runs N generations of propose-evaluate-select
5. Outputs a final run report with Pareto frontier

**Evaluator defaults:**
- `repeatCount`: value from `--repeat` (default 1)
- `aggregation`: `median`
- `temperature`: 0.01
- `maxCandidateBudgetUsd`: $2.00

#### `/meta resume [runId]`

Resume a paused or interrupted run. If no `runId` is given, resumes the
most recent run.

#### `/meta status`

Show current run status: run ID, status, generation progress, candidate
count, total cost, and current best.

#### `/meta top [N]`

Show the top N candidates (default: 5) from the latest run, ranked by
weighted score. Displays accuracy, cost, and turns for each.

#### `/meta inspect <candidateId>`

Generate a detailed candidate report. Supports prefix matching on
candidate IDs. Shows:
- Aggregate metrics (score, success rate, cost, turns, tokens)
- Per-task results table
- Tool usage summary
- Failure details with per-criterion breakdowns

#### `/meta diff <candidateA> <candidateB>`

Compare two candidate configurations side by side. Shows field-by-field
differences with the actual YAML values for added, removed, and changed
fields.

#### `/meta validate <candidateId>`

Evaluate a candidate on the holdout set. This is required before
promotion. Runs the candidate against the holdout tasks (which the
proposer never saw) and stores results in `RunManifest.holdoutResults`.

#### `/meta promote <candidateId>`

Promote a validated candidate to the active harness configuration.

**Requirements:**
- Candidate must have been validated via `/meta validate`
- Holdout success rate must be >= 50%

**Result:**
- Copies config to `harnesses/active/config.yaml`
- Displays both search and holdout scores

#### `/meta abort`

Abort the currently running optimization. Sets the run status to `aborted`.

---

## Scoring System

### Score Vector

Each candidate is evaluated across 5 objectives, forming a score vector:

| Objective | Direction | Source | Description |
|-----------|-----------|--------|-------------|
| `accuracy` | Higher is better | `successRate` | Fraction of tasks that succeeded |
| `cost` | Lower is better | `costUsd / taskCount` | Average cost per task in USD |
| `tokens` | Lower is better | `avgTokens` | Average total tokens per task |
| `turns` | Lower is better | `avgTurns` | Average conversation turns per task |
| `errorRate` | Lower is better | `1 - successRate` | Fraction of tasks that failed |

### Pareto Frontier

The Meta-Harness uses multi-objective optimization because there is no
single "best" metric. A config that achieves 100% success but costs $5
per task is not strictly better than one with 90% success at $0.10 per
task. The Pareto frontier captures this tradeoff.

**Dominance:** Candidate A dominates candidate B if:
- A is no worse than B on ALL 5 objectives, AND
- A is strictly better than B on AT LEAST ONE objective

**Frontier:** A candidate is on the Pareto frontier if no other candidate
dominates it. The frontier represents the set of optimal tradeoffs.

**Weighted scalar ranking** is used for ordering within the frontier and
for display purposes. Each objective is min-max normalized across the
population, then weighted:

```
score = 1.0 * norm(accuracy) + 0.4 * norm(1 - errorRate) + 0.3 * norm(1 - cost)
      + 0.2 * norm(1 - turns) + 0.1 * norm(1 - tokens)
```

("Lower is better" objectives are inverted before weighting so that all
normalized values follow the "higher is better" convention.)

---

## Data Redaction

Before any execution data is written to the archive, it passes through the
redaction pipeline. This is critical because the proposer agent has
filesystem access to the archive and could otherwise read secrets.

### What is redacted

1. **Secret patterns** -- reuses `SECRET_PATTERNS` from the builtin
   secret-scanner hook. Catches API keys, bearer tokens, access tokens,
   and other credential patterns. Replaced with `[REDACTED]`.

2. **Sensitive filesystem paths:**
   - `~/.pcc/credentials/` -- replaced with `[REDACTED:path]`
   - `/.pcc/credentials/` -- replaced with `[REDACTED:path]`
   - PEM private keys (RSA and generic) -- replaced with `[REDACTED:path]`
   - `/.ssh/id_*` -- replaced with `[REDACTED:path]`
   - `/.env`, `/.env.local`, `/.env.production`, `/.env.staging` -- replaced with `[REDACTED:path]`

### Where redaction is applied

- **Messages** (`redactMessages()`): Processes both string-content messages
  and structured content blocks. Handles `text`, `thinking`, and `content`
  fields within blocks. Returns a new array -- never mutates originals.

- **Trace events** (`redactTraceEvents()`): Processes all string values in
  each event's data payload. Returns a new array -- never mutates originals.

### When redaction happens

Redaction occurs in `MetaEvaluator.evaluateTask()`, after `runStructuredQuery()`
completes and before `archive.writeTrace()` is called.

---

## Archive Structure

The archive lives at `~/.pcc/meta/` (absolute path, independent of any
git worktree).

```
~/.pcc/meta/
|
+-- runs/
|   |
|   +-- <runId>/                        (12-char UUID prefix)
|   |   |
|   |   +-- manifest.json              RunManifest (status, generations,
|   |   |                                search/holdout IDs, candidates,
|   |   |                                cost, holdout results)
|   |   |
|   |   +-- candidates/
|   |       |
|   |       +-- <candidateId>/
|   |       |   |
|   |       |   +-- manifest.json      CandidateManifest (scores, config
|   |       |   |                        snapshot, generation, lineage)
|   |       |   |
|   |       |   +-- config.yaml        HarnessConfig (the actual config
|   |       |   |                        that was evaluated)
|   |       |   |
|   |       |   +-- scores.json        Aggregate scores (aggregateScore,
|   |       |   |                        successRate, avgTurns, avgTokens)
|   |       |   |
|   |       |   +-- results/
|   |       |   |   +-- <taskId>.json           EvalResult for repeat 0
|   |       |   |   +-- <taskId>-run1.json      EvalResult for repeat 1
|   |       |   |   +-- <taskId>-run2.json      EvalResult for repeat 2
|   |       |   |   +-- ...
|   |       |   |
|   |       |   +-- traces/
|   |       |       +-- <taskId>.jsonl  Redacted trace events (one JSON
|   |       |       +-- ...              object per line)
|   |       |
|   |       +-- baseline-<hash>/        The baseline candidate (gen 0)
|   |       +-- gen1-<hash>/            Generation 1 candidates
|   |       +-- gen2-<hash>/            Generation 2 candidates
|   |       +-- ...
|   |
|   +-- <runId>/                        (another run)
|       +-- ...
|
+-- datasets/
    |
    +-- default.yaml                    Default dataset (8 tasks)
    +-- custom.yaml                     User-defined datasets
    +-- ...
```

### Naming conventions

- **Run IDs:** `randomUUID().slice(0, 12)` -- 12-character UUID prefix
- **Baseline candidate ID:** `baseline-<6-char UUID>`
- **Generation candidate IDs:** `gen<N>-<6-char UUID>` (e.g., `gen1-a3f2b1`)
- **Holdout candidate IDs:** `<originalId>-holdout`
- **Result filenames:** `<taskId>.json` for repeat 0, `<taskId>-run<N>.json` for repeats > 0
- **Trace filenames:** `<taskId>.jsonl`

---

## Diagrams

### Full Optimization Loop

```
  /meta init                     /meta run
      |                              |
      v                              v
  Create baseline             Load harness config
  config + dataset            Validate config
      |                       Load + split dataset
      |                              |
      |                     +--------v--------+
      |                     | Evaluate        |
      |                     | baseline on     |
      |                     | search set      |
      |                     +--------+--------+
      |                              |
      |                     +--------v--------+
      |                     | GENERATION LOOP |<-----------+
      |                     |  (gen 1..N)     |            |
      |                     +--------+--------+            |
      |                              |                     |
      |                     +--------v--------+            |
      |                     | Select parents  |            |
      |                     | (Pareto front)  |            |
      |                     +--------+--------+            |
      |                              |                     |
      |                     +--------v--------+            |
      |                     | Proposer agent  |            |
      |                     | (Shugu spawn)   |            |
      |                     +--------+--------+            |
      |                              |                     |
      |                     +--------v--------+            |
      |                     | Evaluate each   |            |
      |                     | proposal on     |            |
      |                     | search set      |            |
      |                     +--------+--------+            |
      |                              |                     |
      |                     +--------v--------+            |
      |                     | Update archive  |            |
      |                     | + run manifest  |            |
      |                     +--------+--------+            |
      |                              |                     |
      |                              +------> gen < N? ----+
      |                              |           no
      |                     +--------v--------+
      |                     | Final report    |
      |                     | Pareto frontier |
      |                     +-----------------+
      |
      |    /meta validate <id>       /meta promote <id>
      |          |                          |
      |          v                          v
      |    Evaluate on holdout       Check holdout validated?
      |    (unseen tasks)            Check holdout >= 50%?
      |    Store results             Copy config to
      |                              harnesses/active/
```

### Data Flow Diagram

```
  Dataset YAML            Harness Config YAML
       |                         |
       v                         v
  loadDataset()           loadHarnessConfig()
       |                         |
       v                         v
  splitDataset()          validateHarnessConfig()
       |                         |
       v                         v
  DatasetSplit            HarnessConfig
  {searchSet,                    |
   holdoutSet}                   |
       |                         |
       +----------+--------------+
                  |
                  v
          MetaEvaluator.evaluate()
                  |
       +----------+----------+
       |                     |
       v                     v
  bootstrapMeta()     (per task, per repeat)
       |                     |
       v                     v
  MetaRuntime         createWorktree()
       |                     |
       v                     v
  runStructuredQuery()  Setup command
       |                     |
       v                     |
  StructuredResult           |
       |                     |
       +----------+----------+
                  |
       +----------+----------+-----------+
       |          |          |           |
       v          v          v           v
  scoreTask()  redact()  archive     aggregate
       |          |     .writeResult()   |
       v          v          |           v
  {score,     redacted       |    CandidateManifest
   criteria,  messages       |           |
   success}   + traces       |           |
              -> writeTrace()|           v
                             |    archive.writeCandidate()
                             |           |
                             +-----+-----+
                                   |
                                   v
                          MetaProposer.propose()
                                   |
                                   v
                          AgentOrchestrator.spawn()
                                   |
                                   v
                          Extract + validate configs
                                   |
                                   v
                          HarnessConfig[] (proposals)
```

### File Relationship Diagram

```
                          +------------+
                          | types.ts   |  (all type definitions)
                          +-----+------+
                                |
          +----------+----------+----------+----------+
          |          |          |          |          |
          v          v          v          v          v
     config.ts  dataset.ts  archive.ts selector.ts report.ts
          |          |          |          |          |
          +-----+----+    +----+----+     |          |
                |          |         |    |          |
                v          v         v    v          |
            runtime.ts  evaluator.ts proposer.ts     |
                |          |          |               |
                v          v          v               |
             collect.ts    +----+-----+               |
                                |                     |
                           redact.ts                  |
                                                      |
                          +---------------------------+
                          |
                          v
                       cli.ts
                    (orchestrates all)
```

The dependency flow is strictly top-down:
- `types.ts` has no internal dependencies
- `config.ts`, `dataset.ts`, `archive.ts`, `selector.ts`, `report.ts`
  depend only on `types.ts`
- `runtime.ts` depends on `types.ts` + engine/transport/policy modules
- `collect.ts` depends on `runtime.ts` + engine modules
- `evaluator.ts` depends on `runtime.ts`, `collect.ts`, `redact.ts`,
  `archive.ts`, `types.ts`
- `proposer.ts` depends on `archive.ts`, `selector.ts`, `config.ts`,
  `types.ts`
- `redact.ts` depends on `../plugins/builtin/behavior-hooks.js` + `types.ts`
- `cli.ts` depends on everything -- it is the top-level orchestrator

---

## Default Dataset

The built-in default dataset (`createDefaultDataset()`) contains 8 canonical
coding tasks that test different Shugu capabilities:

| ID | Tags | Description | Scorer Type |
|----|------|-------------|-------------|
| `create-file` | basic, create | Create a TypeScript file with a specific export | criteria (file_exists, file_contains x2) |
| `fix-bug` | basic, fix | Fix a subtraction-instead-of-addition bug | criteria (file_contains, command_succeeds) |
| `search-codebase` | basic, search | Find TypeScript files that export classes | criteria (turns_under, cost_under) |
| `refactor-rename` | refactor | Rename a function and update references | criteria (file_contains, command_succeeds x2) |
| `multi-file-edit` | complex, create | Create a todo module across 3 files | criteria (file_exists x3, file_contains x2, command_succeeds) |
| `efficiency-simple` | trivial, efficiency | Answer a simple question about code | criteria (turns_under, cost_under) |
| `test-writing` | test, create | Write test cases for a math module | criteria (file_exists, file_contains x2) |
| `error-handling` | fix, error-handling | Add error handling with default config | criteria (file_contains x3) |

---

## Harness Config Directory Structure

When loading a harness config, `loadHarnessConfig()` expects the following
directory structure:

```
harnesses/<name>/
  config.yaml              Main config (required)
  system-prompt-append.md  Optional: loaded into systemPromptAppend
  strategy-prompts/        Optional: loaded into strategy.strategyPrompts
    simple.md
    complex.md
    epic.md
  reflection-template.md   Optional: loaded into reflection.promptTemplate
```

File-based overrides are only loaded if the corresponding field is not
already set in `config.yaml`. This means `config.yaml` values take
precedence over file-based values.

---

## Security Considerations

1. **Immutable base prompt:** The BASE_SYSTEM_PROMPT cannot be overridden,
   only appended to. This prevents the proposer from weakening safety
   instructions.

2. **Immutable zones:** Any config that references transport, protocol,
   policy, or credentials paths is rejected by validation.

3. **Trace redaction:** All execution traces are sanitized before archival.
   The proposer agent reads the archive via standard filesystem tools, so
   any leaked secrets would be visible to it.

4. **Worktree isolation:** Each task evaluation runs in a fresh git worktree,
   preventing cross-contamination between tasks.

5. **Budget guards:** Per-candidate budget limits prevent runaway costs. The
   proposer itself is budgeted at $0.50 / 25 turns.

6. **Holdout validation:** Promotion requires passing validation on unseen
   tasks, preventing overfitting to the search set.

7. **fullAuto permission mode:** The evaluator runs in fullAuto mode (all
   tool permissions auto-granted). This is appropriate because tasks run in
   isolated worktrees with controlled inputs.

8. **Credential isolation:** In meta mode, the vault unlocks only via the
   `PCC_VAULT_PASSWORD` environment variable. No TTY prompts. If no vault
   or no password is available, evaluation proceeds without vault access
   (most tasks do not need credentials).
