# Shugu Dependencies -- Internal & External Dependency Map

> Generated from source analysis. Reflects actual `import` statements, not guesses.

---

## External Dependencies (npm)

### Runtime Dependencies

| Package | Version | Used By | Purpose |
|---------|---------|---------|---------|
| ink | ^6.8.0 | ui/App.tsx, ui/FullApp.tsx, ui/PromptArea.tsx, ui/highlight.ts, ui/markdown.tsx, ui/companion/CompanionSprite.tsx, ui/components/*.tsx | Terminal UI framework (React for CLI) |
| ink-text-input | ^6.0.0 | ui/App.tsx, ui/FullApp.tsx, ui/PromptArea.tsx | Text input component for Ink |
| react | ^19.2.4 | ui/App.tsx, ui/FullApp.tsx, ui/PromptArea.tsx, ui/highlight.ts, ui/markdown.tsx, ui/companion/CompanionSprite.tsx, ui/components/*.tsx | JSX runtime for Ink components |
| yaml | ^2.8.0 | integrations/discovery.ts, meta/config.ts, meta/dataset.ts, meta/proposer.ts, meta/cli.ts, meta/archive.ts | Parse/stringify YAML (pcc-tools.yaml, harness configs, datasets) |

### Dev Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| @types/node | ^22.0.0 | TypeScript definitions for Node.js APIs |
| @types/react | ^19.2.14 | TypeScript definitions for React 19 |
| esbuild | ^0.27.7 | Bundler for production builds (scripts/build.ts) |
| tsx | ^4.19.0 | TypeScript execution for dev mode and build scripts |
| typescript | ^5.7.0 | Type checking (tsc --noEmit, build:tsc) |
| vitest | ^4.1.2 | Test runner (448 tests / 37 files) |

### Node.js Built-in Modules Used

| Module | Used By | Purpose |
|--------|---------|---------|
| node:crypto | credentials/vault.ts, context/session/persistence.ts, voice/capture.ts, meta/dataset.ts, utils/tracer.ts | AES-256-GCM encryption (vault), randomUUID (sessions, traces), createHash (dataset splits) |
| node:fs/promises | credentials/vault.ts, context/memory/*.ts, context/session/*.ts, context/workspace/*.ts, tools/outputLimits.ts, utils/logger.ts, utils/tracer.ts, meta/*.ts, commands/init.ts | Async filesystem I/O across all persistent state |
| node:fs | plugins/loader.ts, skills/loader.ts, skills/generator.ts, automation/daemon.ts, ui/companion/companion.ts | Sync filesystem I/O for plugin/skill loading, daemon state, companion persistence |
| node:path | Pervasive | Path joining, resolution, basename extraction |
| node:os | context/memory/*.ts, context/session/*.ts, tools/outputLimits.ts, utils/logger.ts, utils/tracer.ts, credentials/vault.ts, voice/capture.ts | homedir() for ~/.pcc/, tmpdir() for spill files |
| node:child_process | transport/... (none -- uses fetch), context/workspace/git.ts, tools/bash/BashTool.ts, tools/repl/REPLTool.ts, agents/worktree.ts, automation/daemon.ts, remote/ssh.ts, voice/capture.ts, utils/git.ts, plugins/builtin/verification-hook.ts, commands/doctor.ts | spawn/fork/execFile for shell commands, git, SSH, audio capture, daemon IPC |
| node:readline | credentials/prompt.ts, ui/renderer.ts | Masked password input, terminal line control |
| node:events | automation/scheduler.ts, automation/daemon.ts, automation/background.ts, automation/triggers.ts, plugins/hooks.ts, plugins/registry.ts, skills/loader.ts | EventEmitter for async coordination |
| node:http | automation/triggers.ts, remote/gateway.ts | HTTP server for trigger webhooks and session gateway |
| node:net | automation/daemon.ts | Unix socket / named pipe for daemon IPC |
| node:util | plugins/builtin/verification-hook.ts, commands/doctor.ts, commands/config.ts | promisify(execFile) |
| node:url | integrations/discovery.ts | fileURLToPath for __dirname equivalent in ESM |

---

## Internal Module Dependency Matrix

### Layer Rules

Layer N may only import from layers < N. Layer 0 has zero internal dependencies.

| Module | Layer | Comment |
|--------|-------|---------|
| protocol | 0 | Message/tool/event types -- zero dependencies |
| transport | 1 | HTTP client, SSE parser, auth -- depends only on protocol |
| engine | 2 | Agentic loop, turns, budget, intelligence, strategy, reflection |
| tools | 3 | Tool registry, executor, all tool implementations |
| policy | 4 | Permission modes, rules, risk classifier, workspace validator |
| context | 5 | Token budget, compaction, memory, sessions, workspace detection |
| integrations | 6 | CLI discovery, adapter hints |
| commands | 7 | Slash command registry and all /commands |
| agents | 8 | Orchestrator, delegation, worktrees, teams |
| automation | 9 | Scheduler, daemon, background, triggers, proactive, Kairos |
| remote | 10 | SSH execution, session gateway |
| ui | 11 | Renderer, banner, buddy, status bar, highlight, Ink components, companion |
| voice | 12 | Audio capture and transcription |
| skills | 13 | Skill registry, loader, bundled skills, generator |
| plugins | 14 | Hook system, plugin loader, plugin registry, built-in hooks |
| meta | -- | Meta-Harness optimizer (cross-cutting, imports from many layers) |
| utils | -- | Zero-dependency utilities (logger, tracer, fs, git, strings, ansi, random) |
| entrypoints | -- | CLI, bootstrap, REPL, prompt-builder (imports ALL layers) |

### Dependency Matrix (reads as: ROW imports FROM COLUMN)

Legend: `YES` = direct import, `type` = type-only import, `--` = self, empty = no dependency

|  | protocol | transport | engine | tools | policy | context | credentials | commands | agents | automation | remote | ui | plugins | skills | integrations | meta | utils |
|--|----------|-----------|--------|-------|--------|---------|-------------|----------|--------|------------|--------|----|---------|---------|----- |------|-------|
| **protocol** | -- | | | | | | | | | | | | | | | | |
| **transport** | YES | -- | | | | | | | | | | | | | | | |
| **engine** | YES | YES | -- | | | | | | | | | | type | | | type | YES |
| **tools** | YES | | | -- | YES | YES | type | | type | | | | | | | | YES |
| **policy** | YES | | | | -- | | | | | | | | | | | | |
| **context** | YES | YES | YES | | | -- | | | | | | | | | | | YES |
| **credentials** | | | | | | | -- | | | | | | | | | | |
| **commands** | YES | YES | YES | | | YES | YES | -- | YES | YES | | | | | | | YES |
| **agents** | YES | YES | YES | | | | | | -- | | | | | | | | YES |
| **automation** | YES | | YES | | | YES | | | | -- | | | | | | | YES |
| **remote** | | | YES | | | | type | | | | -- | | | | | | |
| **ui** | | | | | | | | | | | | -- | | | | | YES |
| **plugins** | YES | | | | | YES | | YES | | | | | -- | YES | | | YES |
| **skills** | YES | | | | | | | | | | | | | -- | | | |
| **integrations** | | | | | | | | | | | | | | | -- | | |
| **voice** | | | | | | | | | | | | | | | | | |
| **meta** | YES | YES | YES | YES | YES | | YES | | YES | | | | YES | | | -- | YES |
| **entrypoints** | YES | YES | YES | YES | YES | YES | YES | YES | YES | YES | | YES | YES | YES | YES | YES | YES |

### Notable Layer Violations

1. **tools -> credentials** (Layer 3 -> unlayered): `tools/index.ts` and `tools/web/WebFetchTool.ts` import `CredentialProvider` for auto-injecting API keys. This is a `type`-only import at the registry level; the actual injection happens at bootstrap time.

2. **tools -> context** (Layer 3 -> Layer 5): `tools/obsidian/ObsidianTool.ts` imports `ObsidianVault` from `context/memory/obsidian.ts`. The tool needs vault access to read/write notes.

3. **tools -> agents** (Layer 3 -> Layer 8): `tools/agents/AgentTool.ts` imports `AgentOrchestrator` type. This is resolved at runtime via `setOrchestrator()` injection -- not a hard compile-time coupling.

4. **tools -> policy** (Layer 3 -> Layer 4): `GlobTool`, `GrepTool`, `FileReadTool`, `FileWriteTool`, `FileEditTool` all import `validateWorkspacePath` from `policy/workspace.ts` for path sandboxing.

5. **engine -> plugins** (Layer 2 -> Layer 14): `engine/loop.ts` imports `HookRegistry` type for Pre/PostToolUse hooks. Type-only -- the registry is injected via `LoopConfig`.

6. **context -> engine** (Layer 5 -> Layer 2): `context/tokenBudget.ts` imports `getContextWindow` from `engine/budget.ts`. A small upward reach for context window constants.

---

## Module-Level Dependency Graph (ASCII)

```
                          +-----------+
                          | protocol  |  Layer 0 — Zero dependencies
                          +-----+-----+
                                |
                          +-----v-----+
                          | transport |  Layer 1 — protocol
                          +-----+-----+
                                |
                   +------------v-----------+
                   |         engine         |  Layer 2 — protocol, transport, utils
                   | (loop, turns, budget,  |           (+ type-only: plugins, meta)
                   |  intelligence,         |
                   |  strategy, reflection) |
                   +--+--------+--------+--+
                      |        |        |
              +-------v--+ +--v-----+ +v--------+
              |  tools   | | policy | | context  |  Layers 3-5
              | (all 14  | | (modes | | (memory, |  tools: protocol, policy, context,
              |  tools + | |  rules | |  session |         credentials, agents (type)
              |  registry| |  class)| |  git,    |  policy: protocol
              |  exec)   | |        | |  project)|  context: protocol, transport,
              +----+-----+ +---+----+ +----+-----+          engine, utils
                   |           |           |
              +----v-----------v-----------v----+
              |          commands               |  Layer 7 — protocol, transport,
              | (registry, builtins, config,    |    engine, context, credentials,
              |  automation, team, review,       |    agents, automation, utils
              |  batch, vault, init, doctor,     |
              |  trace)                          |
              +-----------+---------------------+
                          |
              +-----------v-----------+     +----------+
              |       agents          |     |integr.   |  Layer 6/8
              | (orchestrator,        |     |(discovery |  agents: protocol, transport,
              |  delegation,          |     | adapter)  |           engine, utils
              |  worktree, teams)     |     +----------+  integrations: (standalone +yaml)
              +-----------+-----------+
                          |
              +-----------v-----------+     +----------+
              |     automation        |     |  remote  |  Layer 9/10
              | (scheduler, daemon,   |     |(ssh,     |  automation: protocol, engine,
              |  background, triggers,|     | gateway) |              context, utils
              |  proactive, kairos,   |     +----------+  remote: engine, credentials
              |  obsidian-agent)      |
              +-----------+-----------+
                          |
              +-----------v-----------+     +----------+     +----------+
              |       plugins         |     |  skills  |     |  voice   |  Layer 12-14
              | (hooks, loader,       |     | (loader, |     |(capture) |  plugins: protocol,
              |  registry,            |     |  bundled,|     +----------+     context, commands,
              |  behavior-hooks,      |     |  gen.)   |                      skills, utils
              |  verification-hook,   |     +----------+  skills: protocol
              |  knowledge-hook)      |
              +-----------+-----------+
                          |
                +---------v----------+
                |       meta         |  Meta-Harness (cross-cutting)
                | (cli, runtime,     |  imports: protocol, transport, engine,
                |  evaluator,        |    tools, policy, credentials, agents,
                |  proposer, config, |    plugins, utils, yaml
                |  dataset, selector,|
                |  archive, redact,  |
                |  report)           |
                +---------+----------+
                          |
              +-----------v-----------+
              |     entrypoints       |  Top of the stack
              | (cli, bootstrap,      |  imports: ALL modules
              |  repl, services,      |
              |  prompt-builder,      |
              |  single-shot,         |
              |  cli-handlers,        |
              |  repl-commands)       |
              +-----------------------+

  +-------+
  | utils |  Leaf dependency (zero internal imports)
  +-------+  logger, tracer, fs, git, strings, ansi, random
             Used by: engine, tools, context, commands, agents,
                      automation, plugins, meta, entrypoints, ui
```

---

## Critical Coupling Points

### 1. engine/loop.ts -- The Central Nervous System

- **Files involved:** `engine/loop.ts`, `transport/client.ts`, `transport/stream.ts`, `tools/outputLimits.ts`, `plugins/hooks.ts`, `engine/turns.ts`, `engine/budget.ts`, `engine/interrupts.ts`, `engine/reflection.ts`
- **Risk:** Every agentic operation flows through `runLoop()`. A bug here halts the entire system.
- **Why it matters:** `runLoop()` is the single async generator driving all model calls, tool execution, hook dispatch, budget tracking, auto-continuation, loop detection, and reflection injection. It directly orchestrates 8 modules.
- **Mitigation:** The function is well-isolated as a pure generator -- it yields events, doesn't own state. Testing the generator independently is possible without a live model.

### 2. entrypoints/bootstrap.ts -- The God Constructor

- **Files involved:** `entrypoints/bootstrap.ts`, `entrypoints/services.ts`, and imports from 16 different modules.
- **Risk:** A single file that instantiates and wires ALL services. Any module initialization failure here crashes the entire app.
- **Why it matters:** `bootstrap()` is the only place where the dependency graph is physically assembled. It imports from protocol, transport, tools, policy, context, credentials, commands, skills, plugins, automation, agents, integrations, engine, meta, ui, and utils. A breaking change in any module's constructor signature breaks bootstrap.
- **Mitigation:** The `RuntimeServices` interface provides a clean contract. Each service is independently testable. The vault unlock has retry logic and typed errors.

### 3. protocol/messages.ts + protocol/tools.ts -- The Type Foundation

- **Files involved:** `protocol/messages.ts`, `protocol/tools.ts`, `protocol/events.ts`
- **Risk:** These types are imported by nearly every module in the system. A breaking type change cascades everywhere.
- **Why it matters:** `Message`, `ContentBlock`, `ToolCall`, `ToolResult`, `ToolDefinition`, `ToolContext` are the lingua franca of the entire codebase. 15+ modules depend on them directly.
- **Mitigation:** Layer 0 has zero dependencies itself, so it cannot break due to upstream changes. The types closely mirror the Anthropic API format, providing stability.

### 4. tools/index.ts createDefaultRegistry() -- Tool Wiring Hub

- **Files involved:** `tools/index.ts`, all 14 tool files, `credentials/provider.ts`
- **Risk:** A registration error silently drops a tool from the agent's capabilities. The function imports from credentials (cross-layer) and passes providers via setter injection.
- **Why it matters:** This is where the agent's actual capabilities are determined. Missing a `registry.register()` call means the model calls a tool that doesn't exist, producing cryptic errors.
- **Mitigation:** The tool count (14 tools) is small enough to audit manually. The AgentTool/WebFetchTool/ObsidianTool use explicit setter injection rather than constructor coupling.

### 5. context/memory/agent.ts -- Memory Convergence Point

- **Files involved:** `context/memory/agent.ts`, `context/memory/obsidian.ts`, `context/memory/extract.ts`, `context/memory/store.ts`, `plugins/builtin/knowledge-hook.ts`, `automation/obsidian-agent.ts`
- **Risk:** Memory operations span 3 subsystems (MemoryAgent, ObsidianVault, knowledge-hook) with overlapping responsibilities. A dedup failure causes repeated memories; a flush failure loses data.
- **Why it matters:** The `MemoryAgent` is the unified coordinator for all persistence -- it manages the index.json cache, Obsidian vault writes, and background maintenance. Corruption here affects future sessions.
- **Mitigation:** The agent uses an explicit `loadIndex()`/`flushIndex()` lifecycle. The `maintenance()` call is fire-and-forget with error logging.

---

## Single Points of Failure

### 1. MiniMaxClient (transport/client.ts)
Every model interaction goes through this single client instance. If the HTTP call fails in a way not caught by `withRetry()` or the model fallback chain, the entire loop stalls. The fallback chain (best -> balanced -> fast) mitigates overload, but a total API outage is unrecoverable.

### 2. CredentialVault (credentials/vault.ts)
The vault must unlock successfully for the app to start at all (`process.exit(1)` on failure). If the vault file is corrupted (`CorruptedVaultError`), the user cannot proceed without manual deletion and re-creation.

### 3. HookRegistry (plugins/hooks.ts)
All Pre/PostToolUse hooks flow through a single `HookRegistry` instance. A synchronous exception in a hook handler could block tool execution in the main loop. Hooks do use try-catch, but a hanging async hook would stall the pipeline.

### 4. utils/logger.ts and utils/tracer.ts
Both are singleton modules. The logger writes to `~/.pcc/shugu.log` and the tracer to `~/.pcc/traces/`. If the `.pcc` directory becomes unwritable (permissions, disk full), both silently degrade but could cause cascading `EACCES` noise.

### 5. protocol/messages.ts isTextBlock / isToolUseBlock / getToolUseBlocks
These type guard functions are used in 15+ files to extract content from messages. If the MiniMax API changes the response shape (e.g., a new block type or field rename), these guards silently miss content rather than throwing, leading to subtle data loss.

---

## Dependency Health

### What's Good

1. **Clean Layer 0 foundation.** `protocol/` has zero internal imports. All type definitions flow downward. This is textbook good architecture.

2. **Strict layer direction.** The vast majority of imports follow the declared layer ordering. Lower layers never import from higher layers (with a few documented exceptions, mostly type-only).

3. **utils/ is a true leaf.** The 7 utility files (`logger`, `tracer`, `fs`, `git`, `strings`, `ansi`, `random`) have zero internal imports. They cannot create circular dependencies.

4. **Setter injection over constructor coupling.** AgentTool, WebFetchTool, and ObsidianTool all use `.setOrchestrator()` / `.setCredentialProvider()` / `.setVault()` patterns, keeping the tool layer decoupled from agents/credentials at import time.

5. **Type-only imports for cross-layer references.** The engine imports `HookRegistry` as `type` only. The actual instance is injected via `LoopConfig`. Same for `meta/types.ts` importing engine types.

6. **Minimal npm dependencies.** Only 4 runtime dependencies (ink, ink-text-input, react, yaml). The entire system runs on Node.js built-ins for crypto, HTTP, filesystem, and process management.

7. **EventEmitter-based decoupling.** Automation modules (scheduler, daemon, background, triggers) and the plugin system use Node.js EventEmitter for loose coupling rather than direct function calls.

### What's Fragile

1. **tools -> policy/workspace.ts import.** Five tool files import `validateWorkspacePath` from `policy/`. This creates a hidden Layer 3 -> Layer 4 dependency that isn't reflected in the barrel exports. If policy changes path validation rules, tools break silently.

2. **context -> engine upward reach.** `context/tokenBudget.ts` imports `getContextWindow()` from `engine/budget.ts`. This Layer 5 -> Layer 2 reference breaks the "only import downward" rule. The context window constants should live in protocol or a shared constants module.

3. **commands/ is a wide coupling surface.** The commands module imports from 8 other modules (protocol, transport, engine, context, credentials, agents, automation, utils). Each new command potentially adds another cross-module dependency. Commands like `/batch` and `/team` import from agents, creating Layer 7 -> Layer 8 upward references.

4. **meta/ is intentionally cross-cutting but has no formal boundary.** The Meta-Harness imports from protocol, transport, engine, tools, policy, credentials, agents, plugins, and utils. Its `runtime.ts` essentially re-implements `bootstrap.ts` in headless mode, duplicating the wiring logic.

5. **plugins/builtin/knowledge-hook.ts imports context/memory/obsidian.ts and context/memory/extract.ts.** This creates a Layer 14 -> Layer 5 dependency. If the memory subsystem changes its extraction API, the built-in hook breaks.

6. **Ink/React UI is isolated but large.** The `ui/` directory contains both pure-ANSI rendering (`renderer.ts`, `banner.ts`, `buddy.ts`, `statusbar.ts`) and React/Ink components (`App.tsx`, `FullApp.tsx`, `highlight.ts`, `markdown.tsx`, `companion/`). These two paradigms coexist but don't share state cleanly. The companion module has its own persistence (`companion.ts` writes JSON to `~/.pcc/`).

### Recommendations

1. **Extract context window constants** from `engine/budget.ts` into `protocol/` or a shared `constants.ts` to eliminate the `context -> engine` upward import.

2. **Move `validateWorkspacePath`** from `policy/workspace.ts` into a shared `utils/workspace.ts` or `protocol/workspace.ts` so tools don't need to reach up to the policy layer.

3. **Consider a `commands/factories/` pattern** to isolate the heavy commands (`/batch`, `/team`, `/review`) that import from agents. These factory functions already use closures -- making the agents dependency explicit at the factory boundary would clarify the coupling.

4. **Add a barrel export for meta/.** Unlike all other modules, `meta/` has no `index.ts` barrel file. Adding one would make the module's public API explicit and prevent entrypoints from cherry-picking deep imports.

5. **Document the dual-renderer architecture** in `ui/`. The coexistence of pure-ANSI (`renderer.ts`) and React/Ink (`FullApp.tsx`) renderers is intentional but not obvious to new contributors.
