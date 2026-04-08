# Architecture of Shugu (Project CC) — v0.2.0

> **Shugu** is a 14-layer, mono-provider CLI agent built as a clean-room
> reimplementation of Claude Code targeting **MiniMax M2.7**.  The architecture
> follows a strict layered dependency graph where each layer only imports from
> lower layers, with Layer 0 (Protocol) having zero dependencies.

**Key insight:** *A sub-agent is not a process — it is a nested `runLoop()` call.*
This single decision eliminates React routing, IPC, process management, and most
of the complexity found in the reference codebase (~487 K lines, 89 feature
flags, 344 user-type gates).

---

## Quick Stats

| Metric | Value |
|---|---|
| Source files (`.ts` + `.tsx`) | 159 |
| Lines of code (src/) | ~25,500 |
| Lines of code (tests/) | ~5,500 |
| Test files | 37 |
| Architectural layers | 14 (0 through 14) |
| Tools (model-callable) | 14 |
| Slash commands | 19+ (built-in) + dynamic |
| Bundled skills | 7 |
| Agent types | 5 (general, explore, code, review, test) |
| Permission modes | 5 (plan, default, acceptEdits, fullAuto, bypass) |
| Feature flags | 0 |
| Target model | MiniMax M2.7-highspeed (204.8 K context) |
| Fallback models | MiniMax M2.7, MiniMax M2.5-highspeed |
| Runtime | Node.js >= 20.0.0, ESM |
| UI framework | React 19 + Ink 6 (terminal only) |

---

## Project Topology

### Root Directory

```
Project_cc/
├── bin/                    # Executable entry — pcc.mjs shim
│   └── pcc.mjs            # .env loader + dynamic import of dist/entrypoints/cli.js
├── dist/                   # Build output (esbuild via scripts/build.ts)
├── docs/                   # Architecture docs, API references
├── plans/                  # Design plans and specs (pre-implementation)
├── scripts/                # Build tooling, benchmarks
│   ├── build.ts            # esbuild bundler configuration
│   ├── benchmark-context.ts# Context-window benchmark harness
│   └── quick-bench-c.ts    # Quick benchmark runner
├── src/                    # Source code — 159 files, 14 layers
├── tests/                  # Vitest test suite — 37 test files, ~5,500 LOC
│   ├── helpers/            # Shared test utilities
│   └── *.test.ts           # Per-module integration + unit tests
├── .pcc/                   # Local PCC configuration directory
├── .remember/              # Session memory persistence
├── package.json            # shugu@0.2.0, MIT license
├── tsconfig.json           # TypeScript strict, ESM, target ES2022
└── vitest.config.ts        # Vitest configuration
```

### Source Tree (`src/`)

```
src/                                  159 files total
├── brand.ts                          # Brand constants
│
├── protocol/         (7 files)       # Layer 0  — Pure types, zero deps
│   ├── index.ts                      #   Barrel export
│   ├── messages.ts                   #   Message, ContentBlock, Usage types
│   ├── tools.ts                      #   Tool, ToolCall, ToolResult, ToolContext
│   ├── events.ts                     #   StreamEvent, ContentDelta types
│   ├── thinking.ts                   #   ThinkingConfig, MiniMaxReasoningDetail
│   ├── session.ts                    #   Session, Turn, Transcript types
│   └── actions.ts                    #   ActionTriggerBy enum, ActionRecord
│
├── transport/        (5 files)       # Layer 1  — MiniMax HTTP client
│   ├── index.ts                      #   Barrel export
│   ├── client.ts                     #   MiniMaxClient class (stream, complete)
│   ├── auth.ts                       #   Auth resolution (env vars, vault)
│   ├── stream.ts                     #   SSE parser, stream accumulator
│   └── errors.ts                     #   Transport errors, retry logic, fallback
│
├── engine/           (8 files)       # Layer 2  — Agentic loop core
│   ├── index.ts                      #   Barrel export
│   ├── loop.ts                       #   runLoop() AsyncGenerator — THE core
│   ├── turns.ts                      #   Turn analysis, tool-result pairing
│   ├── strategy.ts                   #   Task classification + strategic hints
│   ├── budget.ts                     #   BudgetTracker, cost calculation
│   ├── interrupts.ts                 #   InterruptController (abort/pause)
│   ├── reflection.ts                 #   Mid-turn reflection injection
│   └── intelligence.ts               #   Post-turn: suggestion, speculation, memory
│
├── tools/            (17 files)      # Layer 3  — Tool implementations
│   ├── index.ts                      #   Barrel + createDefaultRegistry()
│   ├── registry.ts                   #   ToolRegistryImpl — Map<string, Tool>
│   ├── executor.ts                   #   Batch execution, parallel/serial
│   ├── outputLimits.ts               #   Truncation + spill-to-disk
│   ├── bash/BashTool.ts              #   Shell command execution
│   ├── files/FileReadTool.ts         #   File reading
│   ├── files/FileWriteTool.ts        #   File creation
│   ├── files/FileEditTool.ts         #   Surgical file editing
│   ├── search/GlobTool.ts            #   File pattern matching
│   ├── search/GrepTool.ts            #   Content search (ripgrep)
│   ├── web/WebFetchTool.ts           #   HTTP fetch (credentialed)
│   ├── web/WebSearchTool.ts          #   Web search
│   ├── repl/REPLTool.ts              #   Interactive REPL execution
│   ├── tasks/TaskTools.ts            #   TaskCreate, TaskUpdate, TaskList
│   ├── utility/SleepTool.ts          #   Async delay
│   ├── obsidian/ObsidianTool.ts      #   Obsidian vault interaction
│   └── agents/AgentTool.ts           #   Sub-agent spawning via orchestrator
│
├── policy/           (6 files)       # Layer 4  — Permission system
│   ├── index.ts                      #   Barrel export
│   ├── permissions.ts                #   PermissionResolver — central decision point
│   ├── modes.ts                      #   5 permission modes + matrix
│   ├── rules.ts                      #   Rule engine (built-in + user rules)
│   ├── classifier.ts                 #   Bash risk classifier (pattern-based)
│   └── workspace.ts                  #   Workspace-level policy overrides
│
├── context/          (11 files)      # Layer 5  — Memory, sessions, workspace
│   ├── index.ts                      #   Barrel export
│   ├── tokenBudget.ts                #   Token budget tracking + auto-compact trigger
│   ├── compactor.ts                  #   Conversation compaction via LLM summary
│   ├── promptCache.ts                #   Prompt caching utilities
│   ├── memory/agent.ts               #   MemoryAgent — unified memory interface
│   ├── memory/store.ts               #   MemoryStore — persistent memory
│   ├── memory/extract.ts             #   Memory hint detection + formatting
│   ├── memory/obsidian.ts            #   ObsidianVault — Obsidian integration
│   ├── session/persistence.ts        #   SessionManager — save/load/list sessions
│   ├── workspace/git.ts              #   Git context discovery
│   └── workspace/project.ts          #   Project context detection
│
├── integrations/     (3 files)       # Layer 6  — CLI-first tool discovery
│   ├── index.ts                      #   Barrel export
│   ├── discovery.ts                  #   CLI tool discovery (git, docker, etc.)
│   └── adapter.ts                    #   CLI adapter + hint generation
│
├── commands/         (12 files)      # Layer 7  — Slash commands
│   ├── index.ts                      #   Barrel + createDefaultCommands()
│   ├── registry.ts                   #   CommandRegistry — dispatch engine
│   ├── builtins.ts                   #   /help, /quit, /clear, /compact, /commit...
│   ├── config.ts                     #   /model, /fast, /diff, /export, /rewind
│   ├── init.ts                       #   /init — project initialization
│   ├── doctor.ts                     #   /doctor — system health check
│   ├── trace.ts                      #   /trace, /health — diagnostics
│   ├── automation.ts                 #   /bg, /proactive
│   ├── team.ts                       #   /team — agent team management
│   ├── review.ts                     #   /review — code review orchestration
│   ├── batch.ts                      #   /batch — parallel batch execution
│   └── vault.ts                      #   /vault — credential management
│
├── agents/           (5 files)       # Layer 8  — Multi-agent orchestration
│   ├── index.ts                      #   Barrel export
│   ├── orchestrator.ts               #   AgentOrchestrator — spawn/manage sub-agents
│   ├── delegation.ts                 #   Parallel + chain delegation patterns
│   ├── worktree.ts                   #   Git worktree isolation for agents
│   └── teams.ts                      #   AgentTeam — named team configurations
│
├── automation/       (8 files)       # Layer 9  — Background + scheduling
│   ├── index.ts                      #   Barrel export
│   ├── scheduler.ts                  #   Cron-based job scheduler
│   ├── daemon.ts                     #   DaemonController + DaemonWorker
│   ├── background.ts                 #   BackgroundManager — async sessions
│   ├── triggers.ts                   #   TriggerServer — webhook triggers
│   ├── proactive.ts                  #   ProactiveLoop — autonomous suggestions
│   ├── obsidian-agent.ts             #   Obsidian vault maintenance automation
│   └── kairos.ts                     #   Kairos — session timing + break hints
│
├── remote/           (3 files)       # Layer 10 — Remote execution
│   ├── index.ts                      #   Barrel export
│   ├── ssh.ts                        #   SSH exec, SCP upload/download, SOCKS proxy
│   └── gateway.ts                    #   SessionGateway — remote session sharing
│
├── ui/               (12 files)      # Layer 11 — Terminal UI (React + Ink)
│   ├── FullApp.tsx                   #   Full Ink application (Static + live area)
│   ├── App.tsx                       #   Simpler app variant
│   ├── PromptArea.tsx                #   Input area with mode switching
│   ├── renderer.ts                   #   TerminalRenderer — ANSI output
│   ├── banner.ts                     #   Startup banner generation
│   ├── statusbar.ts                  #   Status bar (model, context%, cost)
│   ├── highlight.ts                  #   Syntax highlighting (multi-language)
│   ├── markdown.tsx                  #   Rich markdown rendering component
│   ├── parsers.ts                    #   Markdown + content parsers
│   ├── paste.ts                      #   Multi-line paste handling
│   ├── buddy.ts                      #   Legacy companion rendering
│   ├── companion/                    #   Companion sprite system (5 files)
│   │   ├── index.ts                  #     Barrel export
│   │   ├── companion.ts             #     Companion generation + persistence
│   │   ├── CompanionSprite.tsx       #     React sprite component
│   │   ├── sprites.ts               #     ASCII sprite frames
│   │   ├── prompt.ts                #     Reaction generation
│   │   └── types.ts                 #     Companion types (Species, Eye, Hat...)
│   └── components/                   #   Shared UI components (4 files)
│       ├── Messages.tsx              #     Message rendering
│       ├── ScrollBox.tsx             #     Scrollable container
│       ├── Spinner.tsx               #     Activity spinner
│       ├── ThinkingBlock.tsx         #     Thinking/reasoning display
│       └── ToolCallBlock.tsx         #     Tool call visualization
│
├── voice/            (2 files)       # Layer 12 — Voice input
│   ├── index.ts                      #   Barrel export
│   └── capture.ts                    #   Audio capture + transcription
│
├── credentials/      (6 files)       # Cross-cutting — Encrypted vault
│   ├── index.ts                      #   Barrel export
│   ├── vault.ts                      #   CredentialVault (AES-256-GCM)
│   ├── provider.ts                   #   CredentialProvider — runtime accessor
│   ├── types.ts                      #   Credential, ServiceType, templates
│   ├── errors.ts                     #   Vault error hierarchy
│   └── prompt.ts                     #   Interactive password prompting
│
├── skills/           (9 files)       # Layer 13 — Skill system
│   ├── index.ts                      #   Barrel + createDefaultSkillRegistry()
│   ├── loader.ts                     #   SkillRegistry, load + match
│   ├── generator.ts                  #   Skill code generation
│   └── bundled/                      #   7 bundled skills
│       ├── vibe.ts                   #     /vibe — guided code generation
│       ├── dream.ts                  #     /dream — creative exploration
│       ├── hunter.ts                 #     /hunt — bug hunting
│       ├── loop.ts                   #     /loop — recurring tasks
│       ├── schedule.ts               #     /schedule — cron scheduling
│       └── secondbrain.ts            #     /brain — Obsidian second brain
│
├── plugins/          (7 files)       # Layer 14 — Plugin + hook system
│   ├── index.ts                      #   Barrel export
│   ├── hooks.ts                      #   HookRegistry — event interception
│   ├── loader.ts                     #   Plugin loading + manifest parsing
│   ├── registry.ts                   #   PluginRegistry — global plugin manager
│   └── builtin/                      #   Built-in hooks (3 files)
│       ├── behavior-hooks.ts         #     Behavioral guardrails
│       ├── knowledge-hook.ts         #     Knowledge injection
│       └── verification-hook.ts      #     Post-action verification
│
├── meta/             (12 files)      # Layer 14+ — Meta-Harness optimizer
│   ├── types.ts                      #   All Meta-Harness type definitions
│   ├── cli.ts                        #   /meta command (10 subcommands)
│   ├── config.ts                     #   HarnessConfig loader + validator
│   ├── dataset.ts                    #   Dataset loading + search/holdout split
│   ├── evaluator.ts                  #   MetaEvaluator — task execution + scoring
│   ├── proposer.ts                   #   MetaProposer — LLM-driven config mutations
│   ├── selector.ts                   #   Pareto frontier + candidate selection
│   ├── runtime.ts                    #   Non-interactive Shugu runtime for eval
│   ├── archive.ts                    #   MetaArchive — persistent result storage
│   ├── collect.ts                    #   Tool statistics collector
│   ├── redact.ts                     #   PII/secrets redaction for proposer
│   └── report.ts                     #   Human-readable run reports
│
├── entrypoints/      (8 files)       # Top-level — CLI wiring
│   ├── cli.ts                        #   main() — parse args, bootstrap, dispatch
│   ├── bootstrap.ts                  #   Service assembly + vault unlock
│   ├── services.ts                   #   RuntimeServices interface
│   ├── repl.ts                       #   runREPL() — interactive loop
│   ├── single-shot.ts               #   runSingleQuery() — one-shot mode
│   ├── prompt-builder.ts            #   System prompt assembly
│   ├── repl-commands.ts             #   Inline REPL command handlers
│   └── cli-handlers.ts             #   Event-to-UI bridge, formatters
│
└── utils/            (7 files)       # Shared utilities
    ├── logger.ts                     #   Structured logger
    ├── tracer.ts                     #   Execution tracer
    ├── ansi.ts                       #   ANSI escape helpers
    ├── fs.ts                         #   Filesystem utilities
    ├── git.ts                        #   Git helper functions
    ├── strings.ts                    #   String manipulation
    └── random.ts                     #   Random generation utilities
```

---

## The 14 Architectural Layers

Each layer is annotated in its `index.ts` barrel export with `Layer N` in the
JSDoc header.  The fundamental rule: **a layer may only import from layers with
a lower number.**  Layer 0 has zero runtime imports.

```
┌──────────────────────────────────────────────────────┐
│ Layer 14+  meta/         Meta-Harness optimizer       │
├──────────────────────────────────────────────────────┤
│ Layer 14   plugins/      Plugin + hook system          │
├──────────────────────────────────────────────────────┤
│ Layer 13   skills/       Skill system                  │
├──────────────────────────────────────────────────────┤
│ Layer 12   voice/        Audio capture                 │
├──────────────────────────────────────────────────────┤
│ Layer 11   ui/           Terminal rendering (Ink)       │
├──────────────────────────────────────────────────────┤
│ Layer 10   remote/       SSH, session gateway           │
├──────────────────────────────────────────────────────┤
│ Layer 9    automation/   Scheduling, daemons, triggers  │
├──────────────────────────────────────────────────────┤
│ Layer 8    agents/       Multi-agent orchestration       │
├──────────────────────────────────────────────────────┤
│ Layer 7    commands/     Slash commands                  │
├──────────────────────────────────────────────────────┤
│ Layer 6    integrations/ CLI tool discovery              │
├──────────────────────────────────────────────────────┤
│ Layer 5    context/      Memory, sessions, workspace     │
├──────────────────────────────────────────────────────┤
│ Layer 4    policy/       Permission resolution           │
├──────────────────────────────────────────────────────┤
│ Layer 3    tools/        Tool implementations            │
├──────────────────────────────────────────────────────┤
│ Layer 2    engine/       Agentic loop core               │
├──────────────────────────────────────────────────────┤
│ Layer 1    transport/    MiniMax HTTP client              │
├──────────────────────────────────────────────────────┤
│ Layer 0    protocol/     Pure types, ZERO dependencies   │
└──────────────────────────────────────────────────────┘
         ▲ imports flow UPWARD only ▲
    Cross-cutting: credentials/, utils/, entrypoints/
```

---

### Layer 0 — Protocol (`src/protocol/`)

**Purpose:** Define the vocabulary of the entire system.  Pure TypeScript
interfaces and enums with zero runtime imports.  Every other layer depends on
Protocol; Protocol depends on nothing.

| File | Responsibility |
|---|---|
| `messages.ts` | `Message`, `AssistantMessage`, `UserMessage`, `ContentBlock`, `TextBlock`, `ToolUseBlock`, `ToolResultBlock`, `ThinkingBlock`, `Usage` |
| `tools.ts` | `Tool`, `ToolDefinition`, `ToolCall`, `ToolResult`, `ToolContext`, `PermissionMode`, `ToolRegistry` |
| `events.ts` | `StreamEvent`, `ContentDelta`, `MessageStartEvent`, `ContentBlockStartEvent`, `ContentBlockDeltaEvent`, `MessageDeltaEvent`, `MessageStopEvent` |
| `thinking.ts` | `ThinkingConfig`, `MiniMaxReasoningDetail`, `ReasoningAccumulator` |
| `session.ts` | `Session`, `Turn`, `TurnToolCall`, `Transcript`, `SessionState` |
| `actions.ts` | `ActionTriggerBy` enum (User/Agent/System), `ActionRecord`, `ActionType` |

**Architectural pattern:** Value Object / Shared Kernel.  These types are the
Rosetta Stone of the system.  Because they are pure interfaces with no runtime
code, they can be safely imported by every layer without introducing coupling.

**Allowed imports:** None (zero dependencies).

**Key exports:**
- `Message`, `AssistantMessage`, `UserMessage` — conversation units
- `Tool`, `ToolCall`, `ToolResult` — tool contract
- `StreamEvent` — SSE event vocabulary
- `PermissionMode` — `'default' | 'plan' | 'acceptEdits' | 'fullAuto' | 'bypass'`
- `ActionTriggerBy` — audit trail for who triggered each action

---

### Layer 1 — Transport (`src/transport/`)

**Purpose:** Single point of network contact with MiniMax.  The rest of the
system **never** talks to MiniMax directly.  All HTTP details, auth, SSE
parsing, retries, error classification, and model fallback are encapsulated here.

| File | Responsibility |
|---|---|
| `client.ts` | `MiniMaxClient` — streaming + complete, model fallback chain |
| `auth.ts` | `resolveAuth()` — env var priority: `MINIMAX_API_KEY` > `ANTHROPIC_AUTH_TOKEN` > `ANTHROPIC_API_KEY` |
| `stream.ts` | `parseSSEStream()` — SSE event parser; `accumulateStream()` — full response builder |
| `errors.ts` | Error hierarchy (`TransportError`, `RateLimitError`, `ContextTooLongError`, `AuthenticationError`, `StreamTimeoutError`, `ModelFallbackError`); `withRetry()` — exponential backoff |

**Architectural pattern:** Adapter (wraps MiniMax's Anthropic-compatible API
into internal Protocol types).

**Allowed imports:** `protocol/`

**Key exports:**
- `MiniMaxClient` — the only class that speaks HTTP
- `MINIMAX_MODELS` — `{ best: 'MiniMax-M2.7-highspeed', balanced: 'MiniMax-M2.7', fast: 'MiniMax-M2.5-highspeed' }`
- `accumulateStream()` — converts SSE stream into `AccumulatedResponse`

**MiniMax quirks handled here:**
- `reasoning_split: true` always (reasoning is mandatory on M2.7)
- `temperature` forced > 0 (range (0.01, 1.0], default 1.0)
- Full assistant responses preserved in multi-turn (including reasoning blocks)
- Model fallback chain: best -> balanced -> fast on 404 or 3x consecutive 529

```
┌─────────────────────────────────────────────┐
│               MiniMaxClient                  │
│                                              │
│  stream()  ─── POST /messages ───> MiniMax   │
│     │                                        │
│     ▼                                        │
│  parseSSEStream()                            │
│     │  yields StreamEvent                    │
│     ▼                                        │
│  accumulateStream()                          │
│     │  returns AccumulatedResponse           │
│     │  { message, stopReason, usage }        │
│     ▼                                        │
│  complete()  ── convenience wrapper ──       │
│                                              │
│  Fallback:  best → balanced → fast           │
│  Retry:     429/529 with exponential backoff │
└─────────────────────────────────────────────┘
```

---

### Layer 2 — Engine (`src/engine/`)

**Purpose:** The agentic loop core.  This is the heart of Shugu: a `while(true)`
loop that streams model responses, analyzes stop reasons, executes tools, and
yields typed events to all observers.

| File | Responsibility |
|---|---|
| `loop.ts` | `runLoop()` — THE AsyncGenerator that powers every agent |
| `turns.ts` | `analyzeTurn()`, `buildToolResultMessage()`, `ensureToolResultPairing()`, `shouldContinue()`, `ContinuationTracker` |
| `strategy.ts` | `analyzeTask()` — heuristic-first, LLM-fallback task classification (trivial/simple/complex/epic) |
| `budget.ts` | `BudgetTracker` — cost tracking, budget enforcement, MiniMax pricing table |
| `interrupts.ts` | `InterruptController` — abort, pause, resume with checkpoint mechanism |
| `reflection.ts` | `buildReflectionPrompt()`, `shouldReflect()` — mid-turn self-evaluation injection |
| `intelligence.ts` | Post-turn background forks: prompt suggestion, speculation, memory extraction |

**Architectural pattern:** AsyncGenerator Event Stream (Observer).

**Allowed imports:** `protocol/`, `transport/`

**Key exports:**
- `runLoop()` — `AsyncGenerator<LoopEvent>` — the single most important function
- `LoopEvent` — discriminated union of 12 event types
- `LoopConfig` — configuration for a loop instance (client, tools, system prompt, limits, hooks)
- `analyzeTask()` — strategic task analysis
- `BudgetTracker` — cost accumulation and enforcement

**LoopEvent types:**
```typescript
type LoopEvent =
  | { type: 'turn_start';         turnIndex: number }
  | { type: 'stream_delta';       delta: ContentDelta; blockIndex: number }
  | { type: 'stream_text';        text: string }
  | { type: 'stream_thinking';    thinking: string }
  | { type: 'stream_tool_start';  toolName: string; toolId: string }
  | { type: 'assistant_message';  message: AssistantMessage }
  | { type: 'tool_executing';     call: ToolCall; triggeredBy: ActionTriggerBy }
  | { type: 'tool_result';        result: ToolResult; durationMs?: number }
  | { type: 'tool_result_message'; message: UserMessage }
  | { type: 'turn_end';           turnIndex: number; usage: Usage }
  | { type: 'history_sync';       messages: Message[] }
  | { type: 'loop_end';           reason: string; totalUsage: Usage; totalCost: number }
  | { type: 'error';              error: Error }
```

**Loop algorithm:**
```
while (true) {
  1. checkpoint(interrupt)           // Await if paused, throw if aborted
  2. yield turn_start
  3. stream model response           // POST to MiniMax via transport
  4. yield assistant_message
  5. analyzeTurn(response)           // Extract tool calls, stop reason
  6. budget.addTurnUsage(usage)
  7. yield turn_end
  8. inject reflection?              // If reflectionInterval matched
  9. shouldContinue()?               // Budget check, turn limit, stop reason
     ├── end_turn + no tools → STOP
     ├── max_tokens + budget ok → auto-continue
     ├── max_turns → STOP
     └── tool_use → CONTINUE
  10. for each toolCall:
      ├── loop detection (3x same call → inject warning)
      ├── yield tool_executing
      ├── validateInput()
      ├── PreToolUse hook (can block or modify)
      ├── askPermission() (via PermissionResolver)
      ├── tool.execute() with timeout + abort race
      ├── PostToolUse hook (can modify result)
      └── yield tool_result
  11. enforceMessageLimit(results)   // Spill large results to disk
  12. append tool_result_message
  13. yield history_sync             // Canonical message snapshot
  14. turnIndex++ → LOOP BACK TO 1
}
```

**Auto-continuation:** When the model hits `max_tokens` without completing, the
loop checks budget headroom (`< 90%` context used, `< 5` continuations, no
diminishing returns) and automatically injects a continuation nudge to resume
output.

---

### Layer 3 — Tools (`src/tools/`)

**Purpose:** Every tool the model can call.  Tools implement the `Tool` interface
from `protocol/tools.ts`, register with `ToolRegistryImpl`, and are dispatched
by the engine loop without knowing implementation details.

| File | Responsibility |
|---|---|
| `registry.ts` | `ToolRegistryImpl` — `Map<string, Tool>` with `register()`, `get()`, `getDefinitions()` |
| `executor.ts` | `executeToolCalls()` — batch execution with read-parallel/write-serial partitioning |
| `outputLimits.ts` | `truncateToolResult()`, `enforceMessageLimit()` — prevent context overflow |
| `bash/BashTool.ts` | Shell command execution via `child_process.spawn` |
| `files/FileReadTool.ts` | Read file contents with line numbers |
| `files/FileWriteTool.ts` | Create or overwrite files |
| `files/FileEditTool.ts` | Surgical string replacement in files |
| `search/GlobTool.ts` | File pattern matching (fast path via `fs.glob`) |
| `search/GrepTool.ts` | Content search (delegates to `ripgrep`) |
| `web/WebFetchTool.ts` | HTTP fetch with credential injection |
| `web/WebSearchTool.ts` | Web search |
| `repl/REPLTool.ts` | Interactive REPL execution (Node, Python, etc.) |
| `tasks/TaskTools.ts` | Task management (TaskCreate, TaskUpdate, TaskList — 3 tools) |
| `utility/SleepTool.ts` | Async delay for rate limiting |
| `obsidian/ObsidianTool.ts` | Obsidian vault read/write/search |
| `agents/AgentTool.ts` | Sub-agent spawning via `AgentOrchestrator` |

**Architectural pattern:** Strategy Pattern + Factory.  The registry is a
factory that produces Tool instances by name.  The engine calls
`tool.execute(call, context)` without knowing the concrete type.

**Allowed imports:** `protocol/`, `engine/` (NOT `transport/`!)

**Critical rule:** Tools never import from Transport.  They speak Protocol
types, and the Engine mediates.  This means swapping MiniMax for another
provider only changes `transport/client.ts`.

**Tool list (14 tools as the model sees them):**

| # | Tool Name | Category | Concurrent? | Description |
|---|-----------|----------|-------------|-------------|
| 1 | `Bash` | execute | No | Run shell commands |
| 2 | `Read` | read | Yes | Read file contents |
| 3 | `Write` | write | No | Create/overwrite files |
| 4 | `Edit` | write | No | Surgical file edits |
| 5 | `Glob` | read | Yes | Find files by pattern |
| 6 | `Grep` | read | Yes | Search file contents |
| 7 | `WebFetch` | network | Yes | HTTP requests |
| 8 | `WebSearch` | network | Yes | Web search |
| 9 | `REPL` | execute | No | Interactive code execution |
| 10 | `TaskCreate` | system | No | Create tracked task |
| 11 | `TaskUpdate` | system | No | Update task status |
| 12 | `TaskList` | system | Yes | List tasks |
| 13 | `Sleep` | system | Yes | Async delay |
| 14 | `Agent` | agent | No | Spawn sub-agent |

(Obsidian tool is the 15th registered tool but only active when vault discovered.)

**Executor batching (from OpenClaude pattern):**
```
┌─────────────────────────────────────────────┐
│              Tool Call Batch                  │
│                                              │
│  [Read, Grep, Glob]  → parallel (max 10)     │
│  [Edit]              → serial (alone)         │
│  [Read, Read]        → parallel               │
│  [Bash]              → serial (alone)         │
│                                              │
│  concurrencySafe=true  → grouped in batch     │
│  concurrencySafe=false → isolated execution   │
└─────────────────────────────────────────────┘
```

---

### Layer 4 — Policy (`src/policy/`)

**Purpose:** Central permission decision engine.  Given a tool call, the current
mode, and active rules, determines: allow, deny, or ask.

| File | Responsibility |
|---|---|
| `permissions.ts` | `PermissionResolver` — main entry point |
| `modes.ts` | 5 permission modes + default decision matrix |
| `rules.ts` | Built-in deny rules + user rule evaluation |
| `classifier.ts` | Pattern-based bash risk classifier (low/medium/high) |
| `workspace.ts` | Workspace-level policy overrides |

**Architectural pattern:** Chain of Responsibility.  Resolution order:

```
Request ──► 1. Built-in Deny Rules ──► 2. User Rules ──► 3. Session Allows
                     │                       │                    │
                 [deny]                 [match]              [found]
                     ▼                       ▼                    ▼
                 BLOCKED                  RESULT               ALLOW
                                                                 │
       4. Risk Classifier (fullAuto+execute only)                │
                     │                                           │
                [low=allow, med/high=ask]                        │
                     ▼                                           │
       5. Mode Default Matrix                                    │
                     │                                           │
                     ▼                                           │
                  RESULT ◄───────────────────────────────────────┘
```

**Permission matrix:**

| | read | write | execute | network | agent | system |
|---|---|---|---|---|---|---|
| **plan** | ask | ask | ask | ask | ask | ask |
| **default** | allow | ask | ask | allow | ask | ask |
| **acceptEdits** | allow | allow | ask | allow | ask | ask |
| **fullAuto** | allow | allow | *classifier* | allow | allow | allow |
| **bypass** | allow | allow | allow | allow | allow | allow |

*In fullAuto mode, `execute` category is deferred to the risk classifier:
low-risk commands auto-allowed, medium/high require confirmation.*

**Allowed imports:** `protocol/`, `tools/` (for ToolCall type only)

**Key exports:**
- `PermissionResolver` — `resolve(call: ToolCall): PermissionResult`
- `classifyBashRisk(command: string): RiskClassification`
- `MODE_DESCRIPTIONS` — human-readable mode descriptions

---

### Layer 5 — Context (`src/context/`)

**Purpose:** Everything about the conversation's surroundings: token budgets,
conversation compaction, persistent memory, session management, workspace
detection (git, project type), and Obsidian vault integration.

| File | Responsibility |
|---|---|
| `tokenBudget.ts` | `TokenBudgetTracker` — tracks token usage against 204.8K context window, triggers auto-compaction |
| `compactor.ts` | `compactConversation()` — LLM-powered conversation summary to reclaim context space |
| `promptCache.ts` | Prompt caching utilities |
| `memory/agent.ts` | `MemoryAgent` — unified memory interface over store + Obsidian |
| `memory/store.ts` | `MemoryStore` — persistent JSON memory with types (fact, preference, correction) |
| `memory/extract.ts` | `detectMemoryHints()` — FR + EN keyword-based memory detection |
| `memory/obsidian.ts` | `ObsidianVault` — vault discovery, note CRUD, search |
| `session/persistence.ts` | `SessionManager` — save/load/list sessions as JSON files |
| `workspace/git.ts` | `getGitContext()` — branch, status, recent commits |
| `workspace/project.ts` | `getProjectContext()` — package.json, tech stack detection |

**Architectural pattern:** Repository Pattern (MemoryStore, SessionManager) +
Facade (MemoryAgent combines multiple sources).

**Allowed imports:** `protocol/`, `engine/`

**Key exports:**
- `TokenBudgetTracker` — `shouldAutoCompact()`, `getStatus()`, `updateFromUsage()`
- `compactConversation()` — replaces old turns with LLM-generated summary
- `MemoryAgent` — `getRelevantContext(input, limit)`, `save(item)`, `saveLLMExtracted()`
- `SessionManager` — `createSession()`, `save()`, `load()`, `loadLatest()`, `listRecent()`

---

### Layer 6 — Integrations (`src/integrations/`)

**Purpose:** CLI-first tool discovery.  Instead of MCP servers (1,300
tokens/server/turn), Shugu discovers installed CLI tools (git, docker, npm,
etc.) and generates lightweight prompt hints (~150 tokens total, once).

| File | Responsibility |
|---|---|
| `discovery.ts` | `discoverTools(cwd)` — scans PATH for known CLI tools |
| `adapter.ts` | `generateHints()` — produces prompt injection for discovered tools; `CliAdapter` type |

**Architectural pattern:** Adapter Pattern (wraps CLI tool discovery into
prompt context).

**Allowed imports:** `protocol/`, `tools/`

**Key exports:**
- `discoverTools()` — returns `CliAdapter[]` with `{ name, installed, version }`
- `generateHints()` — generates system prompt fragment for discovered tools

```
MCP approach (rejected):                CLI-first approach (adopted):
┌──────────┐  JSON-RPC  ┌──────────┐   ┌──────────┐  hint    ┌──────────┐
│  Model   │──────────►│MCP Server│   │  Model   │────────►│ BashTool │
│(+1300 tok│  per turn  │  (proc)  │   │(+150 tok)│  once    │  (exec)  │
│ per srv) │           └──────────┘   │          │         └──────────┘
└──────────┘                          └──────────┘
```

---

### Layer 7 — Commands (`src/commands/`)

**Purpose:** Slash command system.  Commands are typed functions registered in a
`CommandRegistry` and dispatched from REPL input starting with `/`.

| File | Responsibility |
|---|---|
| `registry.ts` | `CommandRegistry` — `register()`, `dispatch()`, `getAll()` |
| `builtins.ts` | Core commands: `/help`, `/quit`, `/clear`, `/compact`, `/commit`, `/status`, `/review`, `/memory` |
| `config.ts` | Configuration: `/model`, `/fast`, `/diff`, `/export`, `/rewind` |
| `init.ts` | `/init` — project setup wizard |
| `doctor.ts` | `/doctor` — system health diagnostics |
| `trace.ts` | `/trace`, `/health` — execution diagnostics |
| `automation.ts` | `/bg`, `/proactive` — background agent management |
| `team.ts` | `/team` — agent team commands |
| `review.ts` | `/review` — multi-agent code review |
| `batch.ts` | `/batch` — parallel batch execution |
| `vault.ts` | `/vault` — credential vault management |

**Architectural pattern:** Command Pattern with registry-based dispatch.

**Allowed imports:** `protocol/`, `engine/`, `tools/`, `context/`, `integrations/`

**Key exports:**
- `CommandRegistry` — `dispatch(input, ctx): Promise<CommandResult | null>`
- `createDefaultCommands()` — factory for built-in command set (17 commands)
- `CommandResult` — discriminated union: `'handled' | 'prompt' | 'clear' | 'exit' | 'error'`

**Built-in commands (registered at startup):**

| Command | Description |
|---|---|
| `/help` | Show available commands |
| `/quit` (`/exit`, `/q`) | Exit with session save |
| `/clear` | Clear conversation |
| `/compact` | Manual context compaction |
| `/commit` | Generate and execute git commit |
| `/status` | Show session status |
| `/review` | Multi-agent code review |
| `/memory` | View/manage memory |
| `/init` | Project initialization |
| `/doctor` | System health check |
| `/model` | Switch active model |
| `/fast` | Switch to fast model |
| `/diff` | Show recent diffs |
| `/export` | Export conversation |
| `/rewind` | Rewind conversation to earlier turn |
| `/trace` | Execution trace diagnostics |
| `/health` | System health metrics |
| `/bg` | Background agent management |
| `/proactive` | Proactive suggestion control |
| `/team` | Agent team management |
| `/batch` | Parallel batch execution |
| `/vault` | Credential vault operations |
| `/meta` (`/mh`) | Meta-Harness optimization (10 subcommands) |

---

### Layer 8 — Agents (`src/agents/`)

**Purpose:** Multi-agent orchestration.  A sub-agent is a nested `runLoop()`
call with its own conversation, budget, and restricted tool set.  No separate
process, no IPC, no React — just recursive function composition.

| File | Responsibility |
|---|---|
| `orchestrator.ts` | `AgentOrchestrator` — spawn, manage, abort sub-agents |
| `delegation.ts` | `delegateParallel()`, `delegateChain()` — fan-out patterns |
| `worktree.ts` | `createWorktree()`, `removeWorktree()`, `mergeWorktree()` — git worktree isolation |
| `teams.ts` | `AgentTeam` — named team configurations with templates |

**Architectural pattern:** Recursive Composition + Factory.

**Allowed imports:** `engine/`, `tools/`, `policy/`, `context/`

**Key exports:**
- `AgentOrchestrator` — `spawn(task, type, options): Promise<AgentResult>`
- `BUILTIN_AGENTS` — 5 pre-defined agent types
- `delegateParallel()` — fan-out to N agents, collect results
- `createWorktree()` — git worktree for file-system isolation

**Built-in agent types:**

| Type | Role | Tools | Max Turns |
|---|---|---|---|
| `general` | Full-capability sub-agent | All | 15 |
| `explore` | Read-only code exploration | Read, Glob, Grep, Bash | 10 |
| `code` | Code writing and editing | All | 20 |
| `review` | Code quality analysis | Read, Glob, Grep, Bash | 10 |
| `test` | Test writing and execution | All | 15 |

**Safety limits:**
- `MAX_AGENT_DEPTH = 3` — maximum nesting depth
- `MAX_ACTIVE_AGENTS = 15` — maximum concurrent agents across all depths
- At max depth, the `Agent` tool is removed from the tool set entirely
- Below max depth, each child gets a clone of the `Agent` tool with incremented depth

```
┌─────────────────────────────────────────────────┐
│              Parent runLoop()                     │
│                                                  │
│  AgentTool.execute("explore: find all TODO")     │
│  │                                               │
│  ├──► orchestrator.spawn("find all TODO",        │
│  │                        "explore")             │
│  │    ┌──────────────────────────────────┐       │
│  │    │  Child runLoop() [depth=1]       │       │
│  │    │  - own conversation              │       │
│  │    │  - own budget                    │       │
│  │    │  - restricted tools [R,G,Gr,B]   │       │
│  │    │  - own InterruptController       │       │
│  │    │  - optionally in git worktree    │       │
│  │    └──────────────────────────────────┘       │
│  │                                               │
│  ◄── AgentResult { response, events, costUsd }   │
│                                                  │
└─────────────────────────────────────────────────┘
```

---

### Layer 9 — Automation (`src/automation/`)

**Purpose:** Background processing, scheduling, daemons, triggers, proactive
suggestions, and session timing.

| File | Responsibility |
|---|---|
| `scheduler.ts` | `Scheduler` — cron-based job scheduler with `parseCron()` |
| `daemon.ts` | `DaemonController`, `DaemonWorker` — long-running background processes |
| `background.ts` | `BackgroundManager` — async session management |
| `triggers.ts` | `TriggerServer` — webhook-based execution triggers |
| `proactive.ts` | `ProactiveLoop` — autonomous suggestion pipeline |
| `obsidian-agent.ts` | Obsidian vault maintenance automation |
| `kairos.ts` | `Kairos` — session timing, break suggestions, away detection |

**Architectural pattern:** Scheduler + Observer.

**Allowed imports:** `engine/`, `context/`

**Key exports:**
- `Scheduler` — `schedule(cron, executor)`, `start()`, `stop()`
- `BackgroundManager` — manage background agentic sessions
- `Kairos` — `onUserInput()`, `getTimeContext()`, `getSessionSummary()`

---

### Layer 10 — Remote (`src/remote/`)

**Purpose:** SSH execution and session sharing for VPS/remote development.

| File | Responsibility |
|---|---|
| `ssh.ts` | `sshExec()`, `sshTest()`, `scpUpload()`, `scpDownload()`, `openSOCKSProxy()` |
| `gateway.ts` | `SessionGateway` — remote session sharing and management |

**Architectural pattern:** Proxy (executes commands on remote machines).

**Allowed imports:** `engine/`, `context/`

---

### Layer 11 — UI (`src/ui/`)

**Purpose:** Terminal rendering using React 19 + Ink 6.  Uses Ink's `<Static>`
for message history (printed to terminal scrollback, never re-rendered) and a
live area for the current input, spinner, and status bar.

| File | Responsibility |
|---|---|
| `FullApp.tsx` | Full Ink application — Static history + live input area |
| `App.tsx` | Simpler app variant |
| `PromptArea.tsx` | Input area with mode switcher |
| `renderer.ts` | `TerminalRenderer` — ANSI escape code rendering |
| `banner.ts` | Startup banner generation |
| `statusbar.ts` | Status bar: model, context%, cost, mode |
| `highlight.ts` | Multi-language syntax highlighting tokenizer |
| `markdown.tsx` | Rich markdown rendering React component |
| `parsers.ts` | Content and markdown parsers |
| `paste.ts` | Multi-line paste detection and handling |
| `components/` | `Messages`, `ScrollBox`, `Spinner`, `ThinkingBlock`, `ToolCallBlock` |
| `companion/` | Pet companion sprite system (species, eyes, hats, reactions) |

**Architectural pattern:** Component Composition (React).  Static printed
history + minimal live area to avoid re-render overhead.

**Allowed imports:** `protocol/`, `engine/`

**Layout:**
```
┌─────────────────────────────────────────┐
│  <Static>                                │ ← Printed to scrollback
│    Banner                                │    Native scroll
│    [user] What files are in src/?        │    No re-render
│    [assistant] Here are the files...     │    overhead
│    [tool] Glob: src/**/*.ts              │
│    [brew] 2.3s, 1,247 tokens             │
│  </Static>                               │
│                                          │
│  ── separator ──────────────────────     │ ← Live area
│  ▸ spinner / streaming indicator         │    Re-renders
│  ── separator ──────────────────────     │
│  > [TextInput cursor]                    │
│  ── separator ──────────────────────     │
│  ⏵⏵ default  │  M2.7-hs  │  42%  │ $0.03 │
│  companion: (=^.^=) "reviewing..."       │
└─────────────────────────────────────────┘
```

---

### Layer 12 — Voice (`src/voice/`)

**Purpose:** Audio capture and transcription for voice input.

| File | Responsibility |
|---|---|
| `capture.ts` | `recordAudio()`, `transcribe()` — audio recording + speech-to-text |

**Allowed imports:** `engine/`

---

### Layer 13 — Skills (`src/skills/`)

**Purpose:** Domain-specific workflows that extend the agent with triggered
behaviors.  Skills are matched against user input via command triggers, keywords,
or patterns.

| File | Responsibility |
|---|---|
| `loader.ts` | `SkillRegistry` — load, register, match skills |
| `generator.ts` | Skill code generation + `/skill-creator` skill |
| `bundled/vibe.ts` | `/vibe` — guided collaborative code generation |
| `bundled/dream.ts` | `/dream` — creative exploration mode |
| `bundled/hunter.ts` | `/hunt` — bug hunting workflow |
| `bundled/loop.ts` | `/loop` — recurring task execution |
| `bundled/schedule.ts` | `/schedule` — cron job scheduling |
| `bundled/secondbrain.ts` | `/brain` — Obsidian second brain interface |

**Architectural pattern:** Strategy Pattern + Plugin.

**Allowed imports:** `protocol/`, `tools/`, `engine/`

**7 bundled skills:**

| Skill | Trigger | Category |
|---|---|---|
| `vibe` | `/vibe` | workflow |
| `dream` | `/dream` | analysis |
| `hunter` | `/hunt` | analysis |
| `loop` | `/loop` | utility |
| `schedule` | `/schedule` | automation |
| `secondbrain` | `/brain` | knowledge |
| `skill-creator` | `/skill-create` | utility |

**Skill execution flow:**
```
User input "/vibe a REST API"
    │
    ▼
SkillRegistry.match(input)
    │ → SkillMatch { skill, args: "a REST API" }
    ▼
skill.execute(SkillContext)
    │ → SkillContext has: input, cwd, messages,
    │   tools, toolContext, query(), runAgent()
    ▼
SkillResult
    ├── { type: 'handled' }      → done
    ├── { type: 'prompt', ... }  → inject into conversation
    └── { type: 'error', ... }   → show error
```

---

### Layer 14 — Plugins (`src/plugins/`)

**Purpose:** Extensibility backbone.  Plugins can intercept tool execution,
command dispatch, and lifecycle events via a prioritized hook system.

| File | Responsibility |
|---|---|
| `hooks.ts` | `HookRegistry` — register, execute, and chain hooks |
| `loader.ts` | `loadPlugin()`, `loadAllPlugins()`, `discoverPluginDirs()` |
| `registry.ts` | `PluginRegistry` — global plugin manager with trust prompting |
| `builtin/behavior-hooks.ts` | Behavioral guardrails (e.g., prevent infinite loops) |
| `builtin/knowledge-hook.ts` | Knowledge injection from external sources |
| `builtin/verification-hook.ts` | Post-action verification checks |

**Architectural pattern:** Event-driven Plugin Architecture.

**Allowed imports:** `protocol/`, `tools/`, `commands/`, `skills/`

**Hook types and execution model:**

| Hook Type | When | Can Block? | Can Modify? |
|---|---|---|---|
| `PreToolUse` | Before tool executes | Yes (blockReason) | Yes (modifiedCall) |
| `PostToolUse` | After tool executes | No | Yes (modifiedResult) |
| `PreCommand` | Before slash command | No | No |
| `PostCommand` | After slash command | No | No |
| `OnMessage` | New message added | No | No |
| `OnStart` | PCC starts | No | No |
| `OnExit` | PCC about to exit | No | No |

**Hook execution:**
```
PreToolUse:
  Hook A (priority=10) ──► Hook B (priority=50) ──► Hook C (priority=90)
       │                         │                         │
   [proceed?]               [proceed?]                [proceed?]
   [modify?]                [modify?]                 [modify?]
       │                         │                         │
  If any returns proceed=false, execution STOPS immediately
  Modified calls chain: A's output becomes B's input

PostToolUse:
  Hook A ──► Hook B ──► Hook C
       │          │          │
  [modify?]  [modify?]  [modify?]
  Modified results chain through all hooks
```

---

### Layer 14+ — Meta-Harness (`src/meta/`)

**Purpose:** Outer-loop optimizer that automatically searches for better harness
configurations.  Implements the methodology from "Meta-Harness: End-to-End
Optimization of Model Harnesses" (Lee et al., arXiv 2603.28052).

| File | Responsibility |
|---|---|
| `types.ts` | All Meta-Harness interfaces (HarnessConfig, EvalTask, EvalResult, CandidateManifest, RunManifest...) |
| `cli.ts` | `/meta` command with 10 subcommands (init, run, resume, status, top, inspect, diff, validate, promote, abort) |
| `config.ts` | HarnessConfig loading and validation |
| `dataset.ts` | Task dataset management with search/holdout split |
| `evaluator.ts` | `MetaEvaluator` — run tasks against candidate configs, collect scores |
| `proposer.ts` | `MetaProposer` — LLM-driven config mutation proposals |
| `selector.ts` | Pareto frontier computation + multi-objective candidate selection |
| `runtime.ts` | Non-interactive Shugu runtime for headless evaluation |
| `archive.ts` | `MetaArchive` — persistent storage for runs, candidates, results |
| `collect.ts` | Tool statistics collector (calls, errors, duration per tool) |
| `redact.ts` | PII/secrets redaction before feeding results to proposer |
| `report.ts` | Human-readable run reports and diffs |

**Architectural pattern:** Evolutionary Search + Pareto Optimization.

**Mutable knobs (what the proposer can change):**
- `systemPromptAppend` — text appended after base system prompt
- `promptFragments` — named fragments injected at predefined positions
- `strategy.*` — complexity overrides, strategy prompts, reflection intervals
- `reflection.*` — prompt template, forced interval
- `agents.*` — agent role prompts, allowed tools, turn limits
- `limits.*` — maxTurns, maxBudgetUsd, toolTimeoutMs
- `model.*` — temperature, maxTokens
- `hooks.*` — enable/disable built-in hooks

**Immutable zones (the proposer cannot touch):**
- BASE_SYSTEM_PROMPT
- model.name (fixed per run)
- transport/protocol/policy/credentials layers

**Optimization loop:**
```
┌─────────────────────────────────────────────────────┐
│                  /meta run                           │
│                                                     │
│  1. Load dataset → split into search + holdout      │
│  2. Load base HarnessConfig                         │
│                                                     │
│  For each generation (0..maxGenerations):            │
│    3. MetaProposer generates N candidate configs     │
│       (mutations of current best)                   │
│    4. MetaEvaluator runs each candidate on           │
│       search set tasks (in git worktrees)           │
│    5. Score each candidate (accuracy, cost, tokens)  │
│    6. computeParetoFrontier() → select parents       │
│    7. Archive results, update run manifest           │
│                                                     │
│  /meta validate <id> → evaluate on holdout set       │
│  /meta promote <id>  → set as active harness         │
└─────────────────────────────────────────────────────┘
```

**Scorer types:**
- `criteria` — built-in multi-criteria (file_exists, file_contains, command_succeeds, output_contains, cost_under, turns_under)
- `command` — external scorer via shell command (exit_code or stdout_float)
- `llm_judge` — LLM-as-judge for subjective quality tasks

---

### Cross-Cutting: Credentials (`src/credentials/`)

**Purpose:** AES-256-GCM encrypted credential vault.  Credentials never enter
LLM context.

| File | Responsibility |
|---|---|
| `vault.ts` | `CredentialVault` — init, unlock, lock, store, retrieve (AES-256-GCM, PBKDF2 100K iterations) |
| `provider.ts` | `CredentialProvider` — runtime credential accessor with VPS config support |
| `types.ts` | `Credential`, `ServiceType`, `ServiceTemplate` — typed credential schemas |
| `errors.ts` | Error hierarchy: `WrongPasswordError`, `CorruptedVaultError`, `VaultNotFoundError`, etc. |
| `prompt.ts` | Interactive password prompting with confirmation |

---

### Cross-Cutting: Entrypoints (`src/entrypoints/`)

**Purpose:** Top-level wiring that assembles all layers into a running
application.  This is the only place where all layers converge.

| File | Responsibility |
|---|---|
| `cli.ts` | `main()` — parse args, bootstrap, dispatch to REPL or single-shot |
| `bootstrap.ts` | `bootstrap()` — construct `RuntimeServices` container from CLI args |
| `services.ts` | `RuntimeServices` — the single DI container (16 readonly service fields) |
| `repl.ts` | `runREPL()` — interactive REPL loop with Ink app |
| `single-shot.ts` | `runSingleQuery()` — execute one prompt and exit |
| `prompt-builder.ts` | `buildSystemPrompt()` — assemble static + dynamic prompt sections |
| `repl-commands.ts` | Inline REPL command handlers (not slash commands) |
| `cli-handlers.ts` | Event-to-UI bridge, formatting utilities |

---

### Cross-Cutting: Utils (`src/utils/`)

**Purpose:** Shared utilities with zero domain knowledge.

| File | Responsibility |
|---|---|
| `logger.ts` | Structured logger with levels |
| `tracer.ts` | Execution tracer for performance analysis |
| `ansi.ts` | ANSI escape code helpers |
| `fs.ts` | Filesystem utilities (mkdirp, exists, etc.) |
| `git.ts` | Git helper functions (resolveGitRoot, etc.) |
| `strings.ts` | String manipulation utilities |
| `random.ts` | Random ID/name generation |

---

## Architectural Patterns

### 1. AsyncGenerator Event Stream (Observer Pattern)

The agentic loop (`engine/loop.ts`) is an `AsyncGenerator<LoopEvent>` that
yields typed events at each step.  Consumers (UI, session persistence, budget
tracking, companion reactions) observe without coupling.

```
                    ┌──────────────────┐
                    │   runLoop()      │
                    │ AsyncGenerator   │
                    │ <LoopEvent>      │
                    └────────┬─────────┘
                             │ yields events
                ┌────────────┼────────────┬────────────┐
                ▼            ▼            ▼            ▼
          ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
          │ Ink App  │ │  Budget  │ │ Session  │ │Companion │
          │ renderer │ │ tracker  │ │  saver   │ │ reactor  │
          └──────────┘ └──────────┘ └──────────┘ └──────────┘

Benefits:
  - Zero framework dependency (no React state management)
  - Consumers can be added/removed at runtime
  - Events are typed — exhaustive switch possible
  - Same loop drives REPL, single-shot, sub-agents, and Meta-Harness eval
```

The same `runLoop()` function is called:
- By `runREPL()` for interactive sessions
- By `runSingleQuery()` for single-shot mode
- By `AgentOrchestrator.spawn()` for sub-agents (nested call)
- By `MetaEvaluator` for headless harness evaluation
- By `BackgroundManager` for background sessions
- By `/proactive` for autonomous operations

### 2. Strategy Pattern (Tool System)

Every tool implements the `Tool` interface.  The engine dispatches via name
lookup without knowing concrete implementations.

```
                ┌────────────────────┐
                │  LoopConfig.tools  │
                │  Map<string, Tool> │
                └─────────┬──────────┘
                          │ get(call.name)
                          ▼
              ┌───────────────────────┐
              │   tool.execute(call,  │
              │     context)          │
              └───────────┬───────────┘
                          │ returns ToolResult
        ┌─────────┬──────┴──────┬─────────┐
        ▼         ▼             ▼         ▼
   ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
   │BashTool│ │ReadTool│ │EditTool│ │  ...   │
   └────────┘ └────────┘ └────────┘ └────────┘

The Tool interface contract:
  definition: ToolDefinition     → JSON schema for the model
  execute(call, ctx): ToolResult → the actual work
  validateInput?(input): string? → optional pre-check
```

### 3. Chain of Responsibility (Permission System)

Permission resolution follows a priority chain.  First match wins, and the
chain short-circuits on deny or explicit match.

```
ToolCall ──► Built-in Deny ──► User Rules ──► Session Allows
                 │                  │               │
             [match]           [match]          [found]
                 │                  │               │
                 ▼                  ▼               ▼
             BLOCKED            RESULT           ALLOW
                                                    │
                                                    ▼
         Risk Classifier ◄──── (fullAuto+execute only)
                 │
                 ▼
         Mode Default Matrix
                 │
                 ▼
              RESULT
```

### 4. Recursive Composition (Multi-Agent)

A sub-agent is a nested `runLoop()` call.  This is the most elegant pattern in
the system: no process spawning, no IPC, no message serialization.  The child
loop gets its own conversation array, its own budget tracker, its own interrupt
controller, and an optionally restricted tool set.

```
Parent runLoop() [depth=0]
│
├── User: "Refactor the auth module and add tests"
│
├── Model: tool_use(Agent, {type:"code", prompt:"refactor auth"})
│   │
│   └── orchestrator.spawn("refactor auth", "code", {depth:1})
│       │
│       └── Child runLoop() [depth=1]
│           ├── Model: tool_use(Read, "src/auth/...")
│           ├── Model: tool_use(Edit, "src/auth/...")
│           ├── Model: tool_use(Agent, {type:"test", ...})
│           │   │
│           │   └── Grandchild runLoop() [depth=2]
│           │       └── (can spawn 1 more level, depth=3 is max)
│           │
│           └── returns AgentResult
│
├── Model: tool_use(Agent, {type:"test", prompt:"add auth tests"})
│   └── (another child loop)
│
└── Model: "Refactoring complete, tests added..."
```

### 5. Adapter Pattern (CLI-first Integrations)

Instead of running MCP servers, Shugu discovers installed CLI tools and generates
lightweight prompt hints.  The model then calls them through `BashTool`.

```
Discovery phase (once at startup):
  PATH scan → [git ✓, docker ✓, npm ✓, kubectl ✗]
       │
       ▼
  generateHints() → "You have git, docker, npm available via Bash."
       │              (~150 tokens, injected into system prompt)
       ▼
  Model sees hints → calls BashTool("git log --oneline -5")
```

### 6. Dependency Injection (Services Container)

The `RuntimeServices` interface is a single container holding all 16 services.
It is constructed once in `bootstrap()` and threaded through the application.

```typescript
interface RuntimeServices {
  readonly client: MiniMaxClient;           // Layer 1
  readonly registry: ToolRegistryImpl;      // Layer 3
  readonly toolContext: ToolContext;         // Layer 0
  readonly permResolver: PermissionResolver;// Layer 4
  readonly hookRegistry: HookRegistry;      // Layer 14
  readonly skillRegistry: SkillRegistry;    // Layer 13
  readonly commands: CommandRegistry;       // Layer 7
  readonly sessionMgr: SessionManager;      // Layer 5
  readonly bgManager: BackgroundManager;    // Layer 9
  readonly scheduler: Scheduler;            // Layer 9
  readonly memoryAgent: MemoryAgent;        // Layer 5
  readonly obsidianVault: ObsidianVault | null; // Layer 5
  readonly credentialProvider: CredentialProvider; // Cross-cutting
  readonly kairos: Kairos;                  // Layer 9
  readonly renderer: TerminalRenderer;      // Layer 11
  dispose(): Promise<void>;
}
```

This replaces the 15+ positional parameters that would otherwise thread through
`main()` -> `runREPL()`.  Services are constructed in dependency order in
`bootstrap()`, and `dispose()` handles graceful shutdown.

### 7. Factory Pattern (Registries)

Three registries use the factory pattern:

```
createDefaultRegistry()    → ToolRegistryImpl (14 tools)
createDefaultCommands()    → CommandRegistry (17+ commands)
createDefaultSkillRegistry() → SkillRegistry (7 skills)

Each returns a pre-populated registry.
Additional entries are registered dynamically:
  - bootstrap() adds /team, /review, /batch, /meta, /vault, /bg, /proactive
  - Plugins can add tools, commands, and skills at load time
```

---

## Entry Points and Bootstrap

### CLI Entry (`bin/pcc.mjs` -> `cli.ts`)

```
bin/pcc.mjs
│ 1. Load .env from: cwd/.env > ~/.pcc/.env > package-root/.env
│ 2. import('../dist/entrypoints/cli.js')
│
▼
src/entrypoints/cli.ts :: main()
│ 1. parseArgs() → CliArgs { mode, prompt, continue, resume, verbose, model }
│ 2. bootstrap(cliArgs) → { services, systemPrompt, needsHatchCeremony, resumedMessages }
│ 3. Dispatch:
│    ├── cliArgs.prompt? → runSingleQuery(services, prompt, systemPrompt)
│    └── else           → runREPL(services, systemPrompt, ...)
│
▼
Process exits
```

### Bootstrap Sequence (`bootstrap.ts`)

```
bootstrap(cliArgs):
│
├── 1. Create TerminalRenderer + MiniMaxClient
├── 2. Configure tracer (verbose mode)
│
├── 3. Vault initialization:
│   ├── vault.exists()? → unlockExistingVault (env var or interactive, 3 attempts)
│   └── !exists?        → initializeNewVault (create + set password)
│   └── → CredentialProvider
│
├── 4. Create core registries:
│   ├── createDefaultRegistry(credentialProvider) → ToolRegistryImpl + handles
│   ├── PermissionResolver(mode)
│   ├── createDefaultSkillRegistry() → SkillRegistry (7 skills)
│   └── createDefaultCommands() → CommandRegistry (17 commands)
│
├── 5. Load plugins:
│   ├── pluginRegistry.loadAll(cwd, ...) → discovers + loads project plugins
│   ├── trust prompt for local plugins (bypass mode auto-trusts)
│   └── registerBehaviorHooks(), registerVerificationHook()
│
├── 6. Discover Obsidian vault (optional):
│   └── discoverVault(cwd) → ObsidianVault or null
│
├── 7. Initialize MemoryAgent:
│   └── loadIndex() + maintenance() (fire-and-forget)
│
├── 8. Create automation services:
│   └── BackgroundManager, Scheduler, Kairos, SessionManager
│
├── 9. Wire AgentOrchestrator:
│   ├── orchestrator = new AgentOrchestrator(client, tools, context)
│   ├── agentTool.setOrchestrator(orchestrator)
│   └── Register dynamic commands: /team, /review, /batch, /meta, /vault, /bg, /proactive
│
├── 10. Build system prompt:
│   ├── discoverTools(cwd) → CLI adapters
│   └── buildSystemPrompt(cwd, skills, adapters, memory)
│
├── 11. Handle session resume (--continue / --resume):
│   └── sessionMgr.loadLatest() or sessionMgr.load(id)
│
└── 12. Construct RuntimeServices container → return
```

### REPL Mode (`repl.ts`)

The REPL is a `while(true)` loop that:
1. Waits for user input via `app.waitForInput()` (Ink TextInput)
2. Routes input through: correction detection -> Kairos timing -> inline commands -> skills -> command registry -> model
3. Runs strategic task analysis (`analyzeTask()`)
4. Builds volatile prompt parts (mode, vault context, strategy hints, memory)
5. Checks auto-compaction threshold
6. Constructs `LoopConfig` and runs `runLoop()` with an `InterruptController`
7. Bridges loop events to the Ink app via `handleEventForApp()`
8. Runs post-turn intelligence (suggestion, speculation, memory extraction)
9. Saves session periodically

### Single-Shot Mode (`single-shot.ts`)

Simpler path: constructs a single `LoopConfig`, runs `runLoop()` once, bridges
events to the `TerminalRenderer`, and exits.

### Daemon Mode (`automation/daemon.ts`)

The `DaemonController` spawns a `DaemonWorker` in a background process.  The
worker runs a headless `runLoop()` without UI, communicating results via
structured messages.

### Meta-Harness Bootstrap (`meta/runtime.ts`)

Creates a non-interactive Shugu runtime: constructs a minimal `RuntimeServices`
with `fullAuto` permissions, no UI renderer, and the HarnessConfig applied.
Runs tasks in isolated git worktrees.

---

## Primary Data Flow

Complete trace: user types a prompt -> response displayed.

```
User types: "List all TODO comments in src/"
    │
    ▼
┌─ [FullApp.tsx] Ink TextInput captures input
│   app.waitForInput() resolves
    │
    ▼
┌─ [repl.ts] REPL loop receives input
│   1. Trace start
│   2. Correction detection (FR + EN patterns)
│   3. Kairos timing check
│   4. Not a /command or skill → push to conversationMessages
│   5. analyzeTask(input) → { complexity: 'simple', strategyPrompt: '...', reflectionInterval: 5 }
│   6. buildVolatilePromptParts() → dynamic prompt sections
│   7. Check tokenTracker.shouldAutoCompact() → false (under threshold)
    │
    ▼
┌─ [repl.ts] Construct LoopConfig
│   {
│     client: MiniMaxClient,
│     systemPrompt: [
│       { text: BASE_SYSTEM_PROMPT + workspace + CLI hints + memories, cache_control: 'ephemeral' },
│       { text: volatile parts (mode hints, strategy, memory context) },
│     ],
│     tools: Map<14 tools>,
│     toolDefinitions: ToolDefinition[14],
│     toolContext: { cwd, abortSignal, permissionMode, askPermission },
│     hookRegistry,
│     maxTurns: 25,
│     reflectionInterval: 5,
│   }
    │
    ▼
┌─ [loop.ts] runLoop(messages, config, interrupt)
│   │
│   ├── yield { type: 'turn_start', turnIndex: 0 }
│   │
│   ├── [client.ts] POST api.minimax.io/v1/messages
│   │   {
│   │     model: 'MiniMax-M2.7-highspeed',
│   │     messages: [{role:'user', content:'List all TODO...'}],
│   │     tools: [14 definitions],
│   │     reasoning_split: true,
│   │     temperature: 1.0,
│   │     max_tokens: 16384,
│   │     stream: true,
│   │   }
│   │
│   ├── [stream.ts] SSE parsing:
│   │   message_start → content_block_start(thinking) → thinking_delta...
│   │   → content_block_stop → content_block_start(tool_use, "Grep")
│   │   → input_json_delta... → content_block_stop → message_delta(stop_reason:"tool_use")
│   │
│   ├── yield { type: 'assistant_message', message: {..., tool_use(Grep)} }
│   │
│   ├── [turns.ts] analyzeTurn() → { toolCalls: [{Grep, {pattern:"TODO"}}], needsToolExecution: true }
│   │
│   ├── yield { type: 'turn_end', turnIndex: 0, usage: {input: 3200, output: 150} }
│   │
│   ├── shouldContinue() → { continue: true } (tool_use)
│   │
│   ├── Tool execution:
│   │   ├── yield { type: 'tool_executing', call: {Grep, ...} }
│   │   ├── [hooks.ts] PreToolUse hooks → { proceed: true }
│   │   ├── [permissions.ts] Grep → category:"read" → mode:"default" → ALLOW
│   │   ├── [GrepTool.ts] spawns `rg TODO src/` → results
│   │   ├── [hooks.ts] PostToolUse hooks → no modifications
│   │   └── yield { type: 'tool_result', result: {content: "src/foo.ts:42: // TODO ..."} }
│   │
│   ├── buildToolResultMessage(results) → UserMessage with tool_result blocks
│   ├── yield { type: 'tool_result_message', message }
│   │
│   ├── turnIndex = 1
│   │
│   ├── yield { type: 'turn_start', turnIndex: 1 }
│   │
│   ├── [client.ts] POST (second request with tool results in conversation)
│   │
│   ├── [stream.ts] SSE: thinking... → text_delta... → stop_reason:"end_turn"
│   │
│   ├── yield { type: 'assistant_message', message: "Here are the TODO comments..." }
│   │
│   ├── [turns.ts] analyzeTurn() → { toolCalls: [], needsToolExecution: false }
│   │
│   ├── yield { type: 'turn_end', turnIndex: 1, usage: {input: 3800, output: 800} }
│   │
│   ├── shouldContinue() → { continue: false, reason: 'end_turn' }
│   │
│   ├── yield { type: 'history_sync', messages: [...full conversation...] }
│   │
│   └── yield { type: 'loop_end', reason: 'end_turn', totalUsage, totalCost }
    │
    ▼
┌─ [repl.ts] Event processing complete
│   1. handleEventForApp() bridged all events to Ink components
│   2. app.pushMessage({ type: 'brew', durationMs, tokens })
│   3. renderer.statusBar.update({ contextPercent, costUsd })
│   4. runPostTurnIntelligence() (fire-and-forget):
│      ├── generatePromptSuggestion() → "run the tests?"
│      ├── speculate() → pre-analyze next likely prompt
│      └── extractMemories() → save interesting facts
│   5. sessionMgr.save(session)
    │
    ▼
┌─ [FullApp.tsx] renders response
│   <Static> adds assistant message blocks
│   Live area returns to input state
│   Status bar: M2.7-hs │ Project_cc │ 2% │ $0.01
│   Companion reacts: (=^.^=) ✓
    │
    ▼
User sees formatted response, prompt ready for next input
```

---

## Design Decisions

| Decision | Why | Alternative Rejected |
|---|---|---|
| **Anthropic-compat transport** | MiniMax speaks Anthropic natively. The OpenAI shim was 800 lines of lossy conversion that stripped thinking blocks. | OpenAI-format transport layer |
| **No React/Ink for core logic** | 800 lines ANSI + Ink for UI only. No virtual DOM for the agentic loop. React is only used for the terminal UI components. | Full React-based architecture (40K+ lines in reference) |
| **Nested loops for agents** | `runLoop()` already has everything a sub-agent needs — conversation, budget, tools, interrupts. Processes would add IPC for no benefit. | Process-based sub-agents with IPC |
| **CLI-first over MCP** | MCP = 1,300 tokens/server/turn in overhead. CLI hints = 150 tokens once. Same success rate in practice. | MCP server integration |
| **AES-256-GCM vault** | Same encryption as 1Password. PBKDF2 100K iterations. Credentials never serialized into LLM context. | Plaintext .env files |
| **Pattern-based risk classifier** | 0ms latency vs ~500ms for LLM-based classification. Deterministic. Built-in deny rules as safety net. | LLM-based command classification |
| **Strict layered architecture** | Prevents circular dependencies. Protocol can be used anywhere without pulling HTTP clients or UI. Provider swap only touches transport/. | Flat module structure |
| **AsyncGenerator over callbacks** | Type-safe event stream. Single consumption point. Natural backpressure. Works with `for await...of`. | Event emitter, callback chains, RxJS |
| **Single RuntimeServices container** | Replaces 15+ positional parameters. Clear lifetime management via `dispose()`. | Global singletons, parameter threading |
| **Heuristic-first strategy** | 0 tokens for trivial/simple tasks (~80% of inputs). LLM fallback (~150 tokens M2.5) only for ambiguous tasks. | Always-LLM classification |
| **FR + EN keyword detection** | User writes in French. NLP heuristics include FR keywords (corriger, analyser, développer) alongside EN. | English-only heuristics |
| **204.8K context with auto-compaction** | MiniMax M2.7's full context window. Auto-compact at 75% usage with circuit breaker (3 failures -> manual). | Fixed truncation windows |
| **Model fallback chain** | best -> balanced -> fast. Automatic downgrade on 404 (model unavailable) or 3x consecutive 529 (overloaded). | Fail-fast on model errors |
| **Git worktree isolation** | Sub-agents can modify files in an isolated worktree. Parent decides to merge or discard. No inter-agent file conflicts. | Shared filesystem between agents |

---

## Strengths and Trade-offs

### Strengths

1. **Testability** — Each layer testable in isolation.  Protocol has zero deps.
   37 test files with ~5,500 lines of tests cover the critical paths.

2. **Provider swappability** — Changing LLM provider only touches 5 files in
   `transport/`.  The rest of the system speaks Protocol types.

3. **Zero feature flags** — Everything is always on.  Zero gating complexity,
   zero dead codepaths, zero A/B test overhead.

4. **Radical simplicity** — ~25,500 LOC replaces ~487K LOC by eliminating
   multi-provider support, React routing, analytics, telemetry, OAuth,
   GrowthBook, and feature gating.

5. **Security** — Credentials encrypted at rest (AES-256-GCM), never enter LLM
   context.  Permission system with 5 modes and pattern-based risk classification.

6. **Self-optimizing** — The Meta-Harness can automatically search for better
   harness configurations using evolutionary optimization with Pareto selection.

7. **Progressive complexity** — Simple tasks use 0 extra tokens (heuristic
   classification).  Complex tasks get strategic hints.  Epic tasks get full
   agent delegation.

### Trade-offs

1. **Mono-provider** — Locked to MiniMax's Anthropic-compatible API.  Adding a
   new provider requires implementing a new Transport layer (but only there).

2. **Single-threaded tools** — Tool execution is sequential within a mutation
   batch.  Mitigated by parallel read-only batching and VPS/SSH delegation.

3. **Pattern-based classifier** — May miss novel dangerous commands.  Mitigated
   by built-in deny rules as a safety net and the ability to add user rules.

4. **Context overhead** — Auto-compaction uses an LLM call, costing tokens.
   Circuit breaker prevents runaway compaction failures.

5. **Ink dependency** — UI uses React+Ink which adds ~2MB to dependencies for
   what is fundamentally a CLI application.  The alternative (pure ANSI) lacks
   the input handling quality.

---

## Mentally Executable Summary

### The 30-Second Description

Shugu is a 14-layer TypeScript CLI agent that talks to MiniMax M2.7 via an
Anthropic-compatible HTTP API.  Its core is a single `runLoop()` AsyncGenerator
that streams model responses, executes 14 tools, and yields typed events.
Sub-agents are nested `runLoop()` calls — no processes, no IPC.  Permissions
follow a chain-of-responsibility through 5 modes.  A Meta-Harness outer loop
can automatically optimize the system's configuration using evolutionary search.

### The 10 Most Strategic Files to Read First

| Priority | File | Why |
|---|---|---|
| 1 | `src/engine/loop.ts` | THE core — every execution path runs through this |
| 2 | `src/protocol/tools.ts` | The Tool contract that all 14 tools implement |
| 3 | `src/entrypoints/bootstrap.ts` | How everything gets wired together |
| 4 | `src/agents/orchestrator.ts` | Multi-agent = nested runLoop() |
| 5 | `src/policy/permissions.ts` | Every tool call goes through this gate |
| 6 | `src/transport/client.ts` | The only file that knows MiniMax exists |
| 7 | `src/entrypoints/repl.ts` | The interactive experience end-to-end |
| 8 | `src/engine/strategy.ts` | How tasks get classified and routed |
| 9 | `src/plugins/hooks.ts` | Extensibility backbone |
| 10 | `src/meta/types.ts` | Meta-Harness vocabulary |

### The 5 Most Important Execution Paths

1. **User prompt -> tool execution -> response** — The happy path through
   `repl.ts` -> `runLoop()` -> tool execute -> render.

2. **Sub-agent spawning** — `AgentTool.execute()` ->
   `orchestrator.spawn()` -> nested `runLoop()` -> aggregate result.

3. **Permission resolution** — Tool call -> `PermissionResolver.resolve()` ->
   built-in rules -> user rules -> classifier -> mode matrix.

4. **Auto-compaction** — `tokenTracker.shouldAutoCompact()` ->
   `compactConversation()` -> replace old turns with summary.

5. **Meta-Harness evaluation** — `/meta run` -> proposer generates config ->
   evaluator runs tasks in worktrees -> scorer computes metrics ->
   Pareto selection -> next generation.

### The 5 Most Dangerous Couplings

1. **`bootstrap.ts` imports everything** — By design, this is the composition
   root.  But it means bootstrap changes can break any layer.  Mitigated by
   the `RuntimeServices` interface providing a stable contract.

2. **`repl.ts` <-> `FullApp.tsx`** — The REPL drives the Ink app via
   imperative methods (`pushMessage`, `startStreaming`, `setMode`).  Changing
   the app API requires updating repl.ts.

3. **`AgentTool` <-> `AgentOrchestrator`** — The tool holds a reference to the
   orchestrator via `setOrchestrator()`.  Late binding avoids circular imports
   but creates a runtime dependency.

4. **`loop.ts` <-> `hooks.ts`** — The loop calls `PreToolUse` and `PostToolUse`
   hooks inline.  A misbehaving hook can block or corrupt tool execution.
   Mitigated by try/catch per hook.

5. **`MiniMaxClient` <-> MiniMax API** — Transport is a hard dependency on
   MiniMax's Anthropic-compatible endpoint.  Mitigated by the API being
   standard Anthropic format, but any MiniMax-specific quirks live here.

### Progressive Exploration Guide

**Level 1 — Understand the loop** (30 minutes)
- Read `src/protocol/tools.ts` — the Tool contract
- Read `src/engine/loop.ts` — the agentic loop
- Read `src/engine/turns.ts` — turn lifecycle

**Level 2 — Understand the wiring** (1 hour)
- Read `src/entrypoints/cli.ts` — entry point
- Read `src/entrypoints/bootstrap.ts` — service assembly
- Read `src/entrypoints/services.ts` — the DI container
- Read `src/transport/client.ts` — MiniMax communication

**Level 3 — Understand tools and permissions** (1 hour)
- Read `src/tools/index.ts` — tool registration
- Read `src/tools/bash/BashTool.ts` — a concrete tool
- Read `src/policy/permissions.ts` — permission resolution
- Read `src/policy/classifier.ts` — risk classification

**Level 4 — Understand agents and intelligence** (1 hour)
- Read `src/agents/orchestrator.ts` — multi-agent
- Read `src/engine/strategy.ts` — task analysis
- Read `src/engine/intelligence.ts` — post-turn intelligence
- Read `src/engine/reflection.ts` — mid-turn reflection

**Level 5 — Understand the Meta-Harness** (1 hour)
- Read `src/meta/types.ts` — vocabulary
- Read `src/meta/cli.ts` — operator UX
- Read `src/meta/evaluator.ts` — task evaluation
- Read `src/meta/proposer.ts` — config mutation
- Read `src/meta/selector.ts` — Pareto selection

**Level 6 — Understand the UI and skills** (1 hour)
- Read `src/ui/FullApp.tsx` — Ink application
- Read `src/entrypoints/repl.ts` — REPL loop
- Read `src/skills/loader.ts` — skill system
- Read `src/plugins/hooks.ts` — plugin hooks

---

## Appendix: Layer Dependency Graph

```
Layer 14+  meta/         ──► engine/, transport/, agents/, protocol/
Layer 14   plugins/      ──► protocol/, tools/, commands/, skills/
Layer 13   skills/       ──► protocol/, tools/, engine/
Layer 12   voice/        ──► engine/
Layer 11   ui/           ──► protocol/, engine/
Layer 10   remote/       ──► engine/, context/
Layer 9    automation/   ──► engine/, context/
Layer 8    agents/       ──► engine/, tools/, policy/, context/, transport/
Layer 7    commands/     ──► protocol/, engine/, tools/, context/, integrations/, transport/
Layer 6    integrations/ ──► protocol/, tools/
Layer 5    context/      ──► protocol/, engine/, transport/
Layer 4    policy/       ──► protocol/
Layer 3    tools/        ──► protocol/, engine/  (NEVER transport!)
Layer 2    engine/       ──► protocol/, transport/
Layer 1    transport/    ──► protocol/
Layer 0    protocol/     ──► (nothing)

Cross-cutting:
  credentials/           ──► (standalone, used by transport/ and tools/)
  utils/                 ──► (standalone, used everywhere)
  entrypoints/           ──► ALL layers (composition root)
```

---

*Document generated for Shugu v0.2.0.  159 source files, ~25,500 LOC,
37 test files, ~5,500 test LOC.  Last verified: 2026-04-08.*
