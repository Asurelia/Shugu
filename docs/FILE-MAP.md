# Shugu File Map — Complete Source Cartography

> 165 TypeScript source files across 19 modules. Every file documented.

## How to Read This Document
- **Layer**: Architectural layer number (0 = no deps on other Shugu modules, higher = more deps)
- **Imports**: Internal Shugu modules this file depends on
- **Exports**: Public API surface (types, classes, functions, constants)
- **Called by**: Files/modules that import from this file
- **Calls**: Files/modules this file imports from
- **External imports**: Notable third-party or Node.js built-in imports

---

## Module: protocol/ (Layer 0 — 7 files)

The protocol module defines all shared types and interfaces. It has ZERO internal dependencies — every other module imports from here.

### `src/protocol/messages.ts`
- **Layer:** 0
- **Role:** Defines immutable message types for the conversation protocol. Anthropic-compatible format that MiniMax speaks natively.
- **Exports:** `Role`, `TextBlock`, `ImageBlock`, `ToolUseBlock`, `ToolResultBlock`, `ThinkingBlock`, `RedactedThinkingBlock`, `ContentBlock`, `UserMessage`, `AssistantMessage`, `Message`, `SystemPromptBlock`, `SystemPrompt`, `StopReason`, `Usage`, `Conversation`, `isToolUseBlock()`, `isTextBlock()`, `isThinkingBlock()`, `isToolResultBlock()`, `getTextContent()`, `getToolUseBlocks()`
- **Internal imports:** (none — Layer 0)
- **External imports:** (none)
- **Called by:** Nearly all modules (engine, transport, tools, context, ui, meta, agents, automation, plugins, skills, commands, entrypoints)

### `src/protocol/tools.ts`
- **Layer:** 0
- **Role:** Defines the contract between the engine and tool implementations. Tools are decoupled from transport.
- **Exports:** `ToolDefinition`, `ToolInputSchema`, `ToolCall`, `ToolResult`, `ToolResultContent`, `Tool`, `ToolContext`, `PermissionMode`, `ToolProgress`, `ToolRegistry`
- **Internal imports:** (none — Layer 0)
- **External imports:** (none)
- **Called by:** engine/loop, engine/turns, tools/*, policy/*, plugins/hooks, plugins/loader, agents/orchestrator, entrypoints/services, meta/runtime, commands/registry

### `src/protocol/events.ts`
- **Layer:** 0
- **Role:** SSE stream event types mirroring Anthropic format with MiniMax reasoning extensions.
- **Exports:** `MessageStartEvent`, `ContentBlockStartEvent`, `ContentBlockStart`, `ContentBlockDeltaEvent`, `ContentDelta`, `ContentBlockStopEvent`, `MessageDeltaEvent`, `MessageStopEvent`, `ReasoningDelta`, `StreamEvent`, `StreamAccumulator`, `AccumulatingBlock`
- **Internal imports:** `./messages.js` (ContentBlock, StopReason, Usage)
- **External imports:** (none)
- **Called by:** transport/client, transport/stream, engine/loop

### `src/protocol/thinking.ts`
- **Layer:** 0
- **Role:** MiniMax M2.7 mandatory reasoning types. Handles the `reasoning_split: true` protocol and the `.text` (NOT `.content`) streaming quirk.
- **Exports:** `ThinkingConfig`, `DEFAULT_THINKING_CONFIG`, `MiniMaxReasoningDetail`, `ReasoningAccumulator`, `createReasoningAccumulator()`, `appendReasoningDelta()`
- **Internal imports:** (none — Layer 0)
- **External imports:** (none)
- **Called by:** transport/client, transport/stream

### `src/protocol/session.ts`
- **Layer:** 0
- **Role:** Session lifecycle types: turns, transcripts, session state tracking.
- **Exports:** `Session`, `SessionMetadata`, `Turn`, `TurnToolCall`, `Transcript`, `TranscriptEntry`, `SessionState`
- **Internal imports:** `./messages.js` (Message, Usage)
- **External imports:** (none)
- **Called by:** context/session/persistence, entrypoints/repl

### `src/protocol/actions.ts`
- **Layer:** 0
- **Role:** Action tracking for auditability. Tracks WHO triggered each action (user, agent, system).
- **Exports:** `ActionTriggerBy` (enum), `ActionRecord`, `ActionType`
- **Internal imports:** (none — Layer 0)
- **External imports:** (none)
- **Called by:** engine/loop

### `src/protocol/index.ts`
- **Layer:** 0
- **Role:** Barrel export for the entire protocol module.
- **Exports:** Re-exports everything from messages, tools, events, thinking, session, actions
- **Internal imports:** All protocol submodules
- **External imports:** (none)
- **Called by:** Any module importing from `../protocol/index.js`

---

## Module: transport/ (Layer 1 — 5 files)

The transport module is the sole network contact point. Nothing else talks to MiniMax directly.

### `src/transport/client.ts`
- **Layer:** 1
- **Role:** MiniMax Anthropic-compatible HTTP client. Handles request construction, streaming, model selection, and MiniMax quirks (mandatory reasoning, temperature constraints).
- **Exports:** `MINIMAX_MODELS`, `DEFAULT_MODEL`, `ClientConfig`, `MiniMaxClient`, `StreamOptions`
- **Internal imports:** `../protocol/messages.js` (Message, SystemPrompt, Usage), `../protocol/tools.js` (ToolDefinition), `../protocol/thinking.js` (ThinkingConfig), `../protocol/events.js` (StreamEvent), `./auth.js` (resolveAuth, AuthConfig), `./stream.js` (parseSSEStream, accumulateStream, AccumulatedResponse, StreamCallbacks), `./errors.js` (classifyHttpError, withRetry, ModelNotFoundError, ModelFallbackError, RetryConfig, DEFAULT_RETRY_CONFIG)
- **External imports:** (none — uses native `fetch`)
- **Called by:** engine/loop, engine/strategy, engine/intelligence, context/compactor, agents/orchestrator, meta/runtime, meta/proposer, meta/cli, entrypoints/bootstrap, entrypoints/repl, commands/config

### `src/transport/stream.ts`
- **Layer:** 1
- **Role:** SSE stream parser. Parses `data:` lines from MiniMax's Anthropic-compatible endpoint. Handles reasoning_details with `.text` field.
- **Exports:** `parseSSEStream()`, `accumulateStream()`, `AccumulatedResponse`, `StreamCallbacks`
- **Internal imports:** `../protocol/events.js` (StreamEvent, StreamAccumulator, AccumulatingBlock, ContentDelta), `../protocol/messages.js` (AssistantMessage, ContentBlock, Usage)
- **External imports:** (none)
- **Called by:** transport/client

### `src/transport/auth.ts`
- **Layer:** 1
- **Role:** API key resolution from environment variables. Priority: MINIMAX_API_KEY > ANTHROPIC_AUTH_TOKEN > ANTHROPIC_API_KEY.
- **Exports:** `AuthConfig`, `resolveAuth()`
- **Internal imports:** (none)
- **External imports:** (none — uses `process.env`)
- **Called by:** transport/client

### `src/transport/errors.ts`
- **Layer:** 1
- **Role:** Error classification, structured error types, and exponential backoff retry logic with jitter.
- **Exports:** `TransportError`, `RateLimitError`, `ContextTooLongError`, `AuthenticationError`, `StreamTimeoutError`, `ModelNotFoundError`, `ModelFallbackError`, `classifyHttpError()`, `RetryConfig`, `DEFAULT_RETRY_CONFIG`, `MAX_529_RETRIES`, `withRetry()`
- **Internal imports:** (none)
- **External imports:** (none)
- **Called by:** transport/client, transport/index

### `src/transport/index.ts`
- **Layer:** 1
- **Role:** Barrel export for the transport module.
- **Exports:** Re-exports from client, auth, stream, errors
- **Internal imports:** All transport submodules
- **External imports:** (none)
- **Called by:** Any module importing from `../transport/index.js`

---

## Module: engine/ (Layer 2 — 8 files)

The engine module contains the core agentic loop and supporting concerns (turns, budget, interrupts, strategy, intelligence, reflection).

### `src/engine/loop.ts`
- **Layer:** 2
- **Role:** The core `while(true)` agentic loop. Streams model responses, executes tools, manages turns. Yields events for UI observation without coupling.
- **Exports:** `LoopConfig`, `LoopEvent`, `runLoop()`, `query()`
- **Internal imports:** `../protocol/messages.js` (Message, AssistantMessage, UserMessage, SystemPrompt, Usage, ContentBlock), `../protocol/tools.js` (ToolDefinition, Tool, ToolCall, ToolResult, ToolContext), `../protocol/events.js` (StreamEvent, ContentDelta), `../protocol/actions.js` (ActionTriggerBy), `../transport/client.js` (MiniMaxClient, StreamOptions), `../transport/stream.js` (accumulateStream), `./turns.js` (analyzeTurn, buildToolResultMessage, ensureToolResultPairing, shouldContinue, DEFAULT_MAX_TURNS, ContinuationTracker), `./budget.js` (BudgetTracker), `./interrupts.js` (InterruptController, isAbortError), `./reflection.js` (shouldReflect, buildReflectionPrompt), `../plugins/hooks.js` (HookRegistry), `../tools/outputLimits.js` (truncateToolResult, enforceMessageLimit), `../utils/logger.js` (logger), `../utils/tracer.js` (tracer)
- **External imports:** (none)
- **Called by:** agents/orchestrator, automation/background, automation/proactive, meta/collect, entrypoints/repl, entrypoints/single-shot

### `src/engine/turns.ts`
- **Layer:** 2
- **Role:** Turn lifecycle management. Analyzes stop reasons, builds tool result messages, ensures tool_use/tool_result pairing, tracks continuations.
- **Exports:** `TurnResult`, `analyzeTurn()`, `buildToolResultMessage()`, `ensureToolResultPairing()`, `DEFAULT_MAX_TURNS`, `shouldContinue()`, `CONTINUATION_THRESHOLD`, `DIMINISHING_RETURNS_THRESHOLD`, `MAX_CONTINUATIONS`, `ContinuationTracker`
- **Internal imports:** `../protocol/messages.js` (Message, AssistantMessage, UserMessage, ContentBlock, ToolUseBlock, ToolResultBlock, Usage, isToolUseBlock, getToolUseBlocks), `../protocol/tools.js` (ToolCall, ToolResult)
- **External imports:** (none)
- **Called by:** engine/loop

### `src/engine/budget.ts`
- **Layer:** 2
- **Role:** Token budget and cost tracking. MiniMax M2.7 pricing: $0.30/1M input, $1.10/1M output.
- **Exports:** `ModelPricing`, `MINIMAX_PRICING`, `BudgetTracker`, `calculateCost()`, `getContextWindow()`, `MINIMAX_CONTEXT_WINDOWS`
- **Internal imports:** `../protocol/messages.js` (Usage)
- **External imports:** (none)
- **Called by:** engine/loop, context/tokenBudget, entrypoints/repl, entrypoints/repl-commands

### `src/engine/interrupts.ts`
- **Layer:** 2
- **Role:** Abort, pause, and resume control for the agentic loop using AbortController.
- **Exports:** `InterruptController`, `AbortError`, `isAbortError()`
- **Internal imports:** (none)
- **External imports:** (none)
- **Called by:** engine/loop, automation/background, automation/proactive, meta/collect, entrypoints/repl, entrypoints/single-shot

### `src/engine/strategy.ts`
- **Layer:** 2
- **Role:** Strategic task analysis. Classifies task complexity (trivial/simple/complex/epic) via heuristics or LLM fallback. Generates strategy hints and sets reflection intervals. Supports French keywords.
- **Exports:** `Complexity`, `TaskStrategy`, `classifyByHeuristics()`, `analyzeTask()`
- **Internal imports:** `../transport/client.js` (MiniMaxClient, MINIMAX_MODELS), `../protocol/messages.js` (Message, isTextBlock), `../utils/logger.js` (logger), `../utils/tracer.js` (tracer)
- **External imports:** (none)
- **Called by:** engine/index, meta/types, entrypoints/repl

### `src/engine/intelligence.ts`
- **Layer:** 2
- **Role:** Three background agent forks after each turn: prompt suggestion, speculation (pre-execution), and memory extraction. All async fire-and-forget to avoid blocking the REPL.
- **Exports:** `generatePromptSuggestion()`, `speculate()`, `extractMemories()`, `runPostTurnIntelligence()`, `IntelligenceConfig`, `IntelligenceResult`, `SpeculationResult`, `ExtractedMemory`
- **Internal imports:** `../protocol/messages.js` (Message, AssistantMessage, isTextBlock), `../transport/client.js` (MiniMaxClient)
- **External imports:** (none)
- **Called by:** entrypoints/repl

### `src/engine/reflection.ts`
- **Layer:** 2
- **Role:** Mid-turn self-evaluation injection. Zero extra LLM calls — reflection is injected as a user message that the model processes in its next thinking step.
- **Exports:** `buildReflectionPrompt()`, `shouldReflect()`
- **Internal imports:** (none)
- **External imports:** (none)
- **Called by:** engine/loop

### `src/engine/index.ts`
- **Layer:** 2
- **Role:** Barrel export for the engine module.
- **Exports:** Re-exports from loop, turns, budget, interrupts, intelligence, strategy, reflection
- **Internal imports:** All engine submodules
- **External imports:** (none)
- **Called by:** Any module importing from `../engine/index.js`

---

## Module: tools/ (Layer 3 — 16 files)

Every tool implements the `Tool` interface from protocol. Tools are registered in a registry and dispatched by the executor.

### `src/tools/registry.ts`
- **Layer:** 3
- **Role:** Dynamic tool registration and lookup. `ToolRegistryImpl` holds all registered tools and provides definitions to the model.
- **Exports:** `ToolRegistryImpl`
- **Internal imports:** `../protocol/tools.js` (Tool, ToolDefinition, ToolRegistry)
- **External imports:** (none)
- **Called by:** tools/executor, tools/index, entrypoints/services

### `src/tools/executor.ts`
- **Layer:** 3
- **Role:** Tool call orchestration. Partitions calls into batches: read-only tools run in parallel (max 10), mutating tools run alone.
- **Exports:** `ExecutionResult`, `partitionToolCalls()`, `executeToolCalls()`
- **Internal imports:** `../protocol/tools.js` (Tool, ToolCall, ToolResult, ToolContext), `./registry.js` (ToolRegistryImpl)
- **External imports:** (none)
- **Called by:** engine/loop (indirectly via tools/index)

### `src/tools/outputLimits.ts`
- **Layer:** 3
- **Role:** Output size limits and disk spill. Prevents token explosion: per-tool 50K chars, per-message 200K chars, Bash 30K chars. Spills to temp files when exceeded.
- **Exports:** `MAX_RESULT_CHARS`, `MAX_RESULTS_PER_MESSAGE_CHARS`, `BASH_MAX_OUTPUT_CHARS`, `BASH_MAX_STDERR_CHARS`, `truncateToolResult()`, `enforceMessageLimit()`, `truncateBashOutput()`, `isSpillPath()`
- **Internal imports:** `../protocol/tools.js` (ToolResult)
- **External imports:** `node:fs/promises`, `node:path`, `node:os`
- **Called by:** engine/loop, tools/bash/BashTool, tools/files/FileReadTool

### `src/tools/index.ts`
- **Layer:** 3
- **Role:** Barrel export + `createDefaultRegistry()` factory that registers all tools.
- **Exports:** All individual tool classes, `ToolRegistryImpl`, `executeToolCalls`, `createDefaultRegistry()`
- **Internal imports:** All tool submodules, `../credentials/provider.js` (CredentialProvider)
- **External imports:** (none)
- **Called by:** meta/runtime, entrypoints/bootstrap

### `src/tools/bash/BashTool.ts`
- **Layer:** 3
- **Role:** Shell command execution with timeout, streaming, and working directory support. 2-minute default timeout.
- **Exports:** `BashToolDefinition`, `BashTool`
- **Internal imports:** `../../protocol/tools.js` (Tool, ToolCall, ToolResult, ToolContext, ToolDefinition), `../outputLimits.js` (BASH_MAX_OUTPUT_CHARS, BASH_MAX_STDERR_CHARS, truncateBashOutput)
- **External imports:** `node:child_process` (spawn)
- **Called by:** tools/index (registration)

### `src/tools/files/FileReadTool.ts`
- **Layer:** 3
- **Role:** File reader with offset/limit for large files. Returns content with line numbers (cat -n format). Enforces workspace boundary via policy.
- **Exports:** `FileReadToolDefinition`, `FileReadTool`
- **Internal imports:** `../../protocol/tools.js`, `../../policy/workspace.js` (validateWorkspacePath), `../outputLimits.js` (isSpillPath)
- **External imports:** `node:fs/promises`, `node:path`
- **Called by:** tools/index (registration)

### `src/tools/files/FileWriteTool.ts`
- **Layer:** 3
- **Role:** File creator/overwriter. Creates parent directories as needed. Enforces workspace boundary.
- **Exports:** `FileWriteToolDefinition`, `FileWriteTool`
- **Internal imports:** `../../protocol/tools.js`, `../../policy/workspace.js` (validateWorkspacePath)
- **External imports:** `node:fs/promises`, `node:path`
- **Called by:** tools/index (registration)

### `src/tools/files/FileEditTool.ts`
- **Layer:** 3
- **Role:** Exact string replacement in files. old_string must be unique unless replace_all is true. Enforces workspace boundary.
- **Exports:** `FileEditToolDefinition`, `FileEditTool`
- **Internal imports:** `../../protocol/tools.js`, `../../policy/workspace.js` (validateWorkspacePath)
- **External imports:** `node:fs/promises`, `node:path`
- **Called by:** tools/index (registration)

### `src/tools/search/GlobTool.ts`
- **Layer:** 3
- **Role:** Fast file pattern matching using Node.js native fs or recursive readdir with picomatch fallback.
- **Exports:** `GlobToolDefinition`, `GlobTool`
- **Internal imports:** `../../protocol/tools.js`, `../../policy/workspace.js` (validateWorkspacePath)
- **External imports:** `node:fs/promises`, `node:path`
- **Called by:** tools/index (registration)

### `src/tools/search/GrepTool.ts`
- **Layer:** 3
- **Role:** Content search using ripgrep (rg) if available, or native Node.js fallback. Supports regex and file type filtering.
- **Exports:** `GrepToolDefinition`, `GrepTool`
- **Internal imports:** `../../protocol/tools.js`, `../../policy/workspace.js` (validateWorkspacePath)
- **External imports:** `node:child_process` (spawn), `node:fs/promises`, `node:path`
- **Called by:** tools/index (registration)

### `src/tools/web/WebFetchTool.ts`
- **Layer:** 3
- **Role:** HTTP GET/POST with automatic HTML-to-Markdown conversion. Auto-injects credentials from vault when domain matches a known service.
- **Exports:** `WebFetchToolDefinition`, `WebFetchTool`
- **Internal imports:** `../../protocol/tools.js`, `../../credentials/provider.js` (CredentialProvider)
- **External imports:** (uses native `fetch`)
- **Called by:** tools/index (registration)

### `src/tools/web/WebSearchTool.ts`
- **Layer:** 3
- **Role:** Web search via MiniMax Search API (code-oriented), DuckDuckGo (general fallback), or Google Custom Search.
- **Exports:** `WebSearchToolDefinition`, `WebSearchTool`
- **Internal imports:** `../../protocol/tools.js`
- **External imports:** (uses native `fetch`)
- **Called by:** tools/index (registration)

### `src/tools/agents/AgentTool.ts`
- **Layer:** 3
- **Role:** The tool the model calls to spawn sub-agents. Orchestrator is injected at registration time to keep Layer 3 decoupled from Layer 8.
- **Exports:** `AgentToolDefinition`, `AgentTool`
- **Internal imports:** `../../protocol/tools.js`, `../../protocol/messages.js` (isTextBlock), `../../agents/orchestrator.js` (AgentOrchestrator, SpawnOptions), `../../utils/tracer.js` (tracer)
- **External imports:** (none)
- **Called by:** tools/index (registration)

### `src/tools/tasks/TaskTools.ts`
- **Layer:** 3
- **Role:** In-memory task list with status tracking. Agent uses this to break down complex work into trackable steps.
- **Exports:** `Task`, `TaskStore`, `TaskCreateTool`, `TaskUpdateTool`, `TaskListTool`
- **Internal imports:** `../../protocol/tools.js`
- **External imports:** (none)
- **Called by:** tools/index (registration)

### `src/tools/repl/REPLTool.ts`
- **Layer:** 3
- **Role:** JavaScript/TypeScript execution in a Node.js context via `node -e`.
- **Exports:** `REPLToolDefinition`, `REPLTool`
- **Internal imports:** `../../protocol/tools.js`
- **External imports:** `node:child_process` (spawn)
- **Called by:** tools/index (registration)

### `src/tools/utility/SleepTool.ts`
- **Layer:** 3
- **Role:** Wait for a specified duration (max 300s). Used by proactive/autonomous mode.
- **Exports:** `SleepToolDefinition`, `SleepTool`
- **Internal imports:** `../../protocol/tools.js`
- **External imports:** (none)
- **Called by:** tools/index (registration)

### `src/tools/obsidian/ObsidianTool.ts`
- **Layer:** 3
- **Role:** First-class Obsidian vault tool. Supports search, read, save, update, delete, archive, list, tags, recent, ingest, and lint operations.
- **Exports:** `ObsidianTool`
- **Internal imports:** `../../protocol/tools.js`, `../../context/memory/obsidian.js` (ObsidianVault, discoverVault, ObsidianNote)
- **External imports:** (none)
- **Called by:** tools/index (registration)

---

## Module: policy/ (Layer 4 — 6 files)

Permission enforcement layer. Decides whether tool calls are allowed, denied, or need user confirmation.

### `src/policy/permissions.ts`
- **Layer:** 4
- **Role:** Central permission resolver. Resolution order: built-in deny rules > user rules > risk classifier > mode default matrix.
- **Exports:** `PermissionResult`, `PermissionResolver`
- **Internal imports:** `../protocol/tools.js` (ToolCall, PermissionMode), `./modes.js` (getToolCategory, getDefaultDecision, PermissionDecision), `./rules.js` (evaluateRules, BUILTIN_RULES, PermissionRule), `./classifier.js` (classifyBashRisk, RiskLevel)
- **External imports:** (none)
- **Called by:** entrypoints/bootstrap, meta/runtime, entrypoints/repl-commands

### `src/policy/modes.ts`
- **Layer:** 4
- **Role:** Defines 5 permission modes (plan, default, acceptEdits, fullAuto, bypass) and their behavior per tool category (read, write, execute, network, agent, system).
- **Exports:** `ToolCategory`, `getToolCategory()`, `PermissionDecision`, `getDefaultDecision()`, `MODE_DESCRIPTIONS`
- **Internal imports:** `../protocol/tools.js` (PermissionMode)
- **External imports:** (none)
- **Called by:** policy/permissions, policy/rules, entrypoints/bootstrap, entrypoints/repl-commands

### `src/policy/classifier.ts`
- **Layer:** 4
- **Role:** Bash risk classifier. Pure pattern matching (no LLM). Classifies commands as low/medium/high risk by checking all sub-commands in pipelines.
- **Exports:** `RiskLevel`, `RiskClassification`, `classifyBashRisk()`
- **Internal imports:** (none)
- **External imports:** (none)
- **Called by:** policy/permissions

### `src/policy/rules.ts`
- **Layer:** 4
- **Role:** Rule-based permission overrides. Users configure allow/deny/ask rules matching on tool name, command patterns, or file paths.
- **Exports:** `PermissionRule`, `ruleMatches()`, `evaluateRules()`, `BUILTIN_RULES`
- **Internal imports:** `../protocol/tools.js` (ToolCall), `./modes.js` (PermissionDecision)
- **External imports:** (none)
- **Called by:** policy/permissions

### `src/policy/workspace.ts`
- **Layer:** 4
- **Role:** Workspace boundary enforcement. Validates file paths stay within the workspace directory. Prevents path traversal and symlink escapes.
- **Exports:** `WorkspaceValidation`, `validateWorkspacePath()`
- **Internal imports:** (none)
- **External imports:** `node:path`, `node:fs/promises`
- **Called by:** tools/files/FileReadTool, tools/files/FileWriteTool, tools/files/FileEditTool, tools/search/GlobTool, tools/search/GrepTool

### `src/policy/index.ts`
- **Layer:** 4
- **Role:** Barrel export for the policy module.
- **Exports:** Re-exports from modes, rules, permissions, classifier
- **Internal imports:** All policy submodules
- **External imports:** (none)

---

## Module: context/ (Layer 5 — 11 files)

Context management: token budgets, conversation compaction, memory stores, session persistence, and workspace detection.

### `src/context/compactor.ts`
- **Layer:** 5
- **Role:** Summarizes older conversation turns when approaching context window limits. Keeps last N turns intact, preserves tool_use/tool_result pairing.
- **Exports:** `CompactionConfig`, `DEFAULT_COMPACTION_CONFIG`, `compactConversation()`, `CompactionResult`
- **Internal imports:** `../protocol/messages.js` (Message, UserMessage, AssistantMessage, ContentBlock, isToolUseBlock, isToolResultBlock), `../transport/client.js` (MiniMaxClient)
- **External imports:** (none)
- **Called by:** entrypoints/repl, entrypoints/repl-commands

### `src/context/tokenBudget.ts`
- **Layer:** 5
- **Role:** Token usage tracking against 204,800 context window. Compaction threshold at 75%. Uses API-reported usage for accuracy.
- **Exports:** `TokenBudgetConfig`, `DEFAULT_TOKEN_BUDGET_CONFIG`, `AUTOCOMPACT_BUFFER_TOKENS`, `WARNING_BUFFER_TOKENS`, `MAX_COMPACT_FAILURES`, `TokenBudgetTracker`, `estimateTokens()`, `TokenBudgetStatus`
- **Internal imports:** `../protocol/messages.js` (Message, ContentBlock, Usage), `../engine/budget.js` (getContextWindow)
- **External imports:** (none)
- **Called by:** entrypoints/repl, entrypoints/repl-commands

### `src/context/promptCache.ts`
- **Layer:** 5
- **Role:** System prompt caching. Memoizes expensive sections (git context, vault reads, file discovery) and only recomputes volatile ones.
- **Exports:** `PromptSection`, `CachedPromptBuilder`
- **Internal imports:** (none)
- **External imports:** (none)
- **Called by:** entrypoints/prompt-builder (conceptually; may be used directly)

### `src/context/index.ts`
- **Layer:** 5
- **Role:** Barrel export for the context module.
- **Exports:** Re-exports from tokenBudget, compactor, memory/store, memory/extract, memory/agent, session/persistence, workspace/git, workspace/project, memory/obsidian
- **Internal imports:** All context submodules

### `src/context/memory/agent.ts`
- **Layer:** 5
- **Role:** Unified memory agent. Single coordinator for all memory operations. Obsidian vault = source of truth; index.json = fast local cache. Handles extraction, deduplication, and per-turn relevance search.
- **Exports:** `MemoryItem`, `MemoryAgent`
- **Internal imports:** `./obsidian.js` (ObsidianVault), `./extract.js` (detectMemoryHints, MemoryCandidate), `../../utils/logger.js` (logger), `../../utils/strings.js` (slugify)
- **External imports:** `node:fs/promises`, `node:path`, `node:os`
- **Called by:** entrypoints/bootstrap, entrypoints/repl, entrypoints/services, entrypoints/prompt-builder

### `src/context/memory/extract.ts`
- **Layer:** 5
- **Role:** Automatic memory extraction from conversations. Detects patterns like "remember that...", "note that...", "I'm a...".
- **Exports:** `MemoryCandidate`, `detectMemoryHints()`, `formatMemoriesForPrompt()`
- **Internal imports:** `../../protocol/messages.js` (Message), `./store.js` (MemoryType)
- **External imports:** (none)
- **Called by:** context/memory/agent, plugins/builtin/knowledge-hook, engine/intelligence

### `src/context/memory/obsidian.ts`
- **Layer:** 5
- **Role:** Obsidian vault filesystem integration. Direct access to .md files with YAML frontmatter, wikilinks, and atomic notes. No MCP dependency.
- **Exports:** `ObsidianNote`, `VaultConfig`, `ObsidianVault`, `discoverVault()`
- **Internal imports:** `../../utils/strings.js` (slugify)
- **External imports:** `node:fs/promises`, `node:path`, `node:os`
- **Called by:** context/memory/agent, tools/obsidian/ObsidianTool, plugins/builtin/knowledge-hook, skills/bundled/secondbrain, automation/obsidian-agent, entrypoints/bootstrap, entrypoints/prompt-builder, commands/builtins

### `src/context/memory/store.ts`
- **Layer:** 5
- **Role:** Persistent memory using MEMORY.md index + individual memory files. Storage: ~/.pcc/memory/ (global) or .pcc/memory/ (project-local).
- **Exports:** `MemoryType`, `Memory`, `MemoryStore`
- **Internal imports:** (none)
- **External imports:** `node:fs/promises`, `node:path`, `node:os`
- **Called by:** context/memory/extract, context/index

### `src/context/session/persistence.ts`
- **Layer:** 5
- **Role:** Save and load conversation sessions to disk (~/.pcc/sessions/{sessionId}.json).
- **Exports:** `SessionData`, `SessionSummary`, `SessionManager`
- **Internal imports:** `../../protocol/messages.js` (Message, Usage)
- **External imports:** `node:fs/promises`, `node:path`, `node:os`, `node:crypto`
- **Called by:** entrypoints/bootstrap, entrypoints/repl, entrypoints/services, entrypoints/repl-commands

### `src/context/workspace/git.ts`
- **Layer:** 5
- **Role:** Git workspace detection. Detects branch, status, recent commits for context injection.
- **Exports:** `GitContext`, `getGitContext()`, `formatGitContext()`
- **Internal imports:** (none)
- **External imports:** `node:child_process` (spawn), `node:path`
- **Called by:** entrypoints/prompt-builder, entrypoints/repl

### `src/context/workspace/project.ts`
- **Layer:** 5
- **Role:** Project type detection (node, python, rust, etc.) and CLAUDE.md/SHUGU.md loading for system prompt injection.
- **Exports:** `ProjectContext`, `ProjectType`, `getProjectContext()`, `formatProjectContext()`, `loadReviewRules()`
- **Internal imports:** `../../utils/fs.js` (fileExists)
- **External imports:** `node:fs/promises`, `node:path`
- **Called by:** entrypoints/prompt-builder, commands/review, commands/team

---

## Module: credentials/ (Layer 4 — 6 files)

Encrypted credential vault. AES-256-GCM with PBKDF2. Credentials are NEVER sent to LLM context.

### `src/credentials/vault.ts`
- **Layer:** 4
- **Role:** AES-256-GCM encrypted vault with PBKDF2 key derivation (100K iterations). Storage: ~/.pcc/credentials.enc.
- **Exports:** `CredentialVault`
- **Internal imports:** `./types.js` (Credential, ServiceType), `./errors.js` (WrongPasswordError, CorruptedVaultError, VaultNotFoundError, VaultDiskError, VaultAlreadyExistsError, isNodeError)
- **External imports:** `node:crypto`, `node:fs/promises`, `node:path`, `node:os`
- **Called by:** credentials/provider, commands/vault, entrypoints/bootstrap, meta/runtime

### `src/credentials/provider.ts`
- **Layer:** 4
- **Role:** High-level credential API for tools. Tools NEVER see the vault directly. Auto-detects service from domain for HTTP auth headers.
- **Exports:** `CredentialProvider`, `VPSConfig`
- **Internal imports:** `./vault.js` (CredentialVault), `./types.js` (ServiceType, Credential, SERVICE_TEMPLATES)
- **External imports:** (none)
- **Called by:** tools/web/WebFetchTool, tools/index, remote/ssh, entrypoints/bootstrap, entrypoints/services, meta/runtime

### `src/credentials/prompt.ts`
- **Layer:** 4
- **Role:** Masked password input using readline _writeToOutput override.
- **Exports:** `PasswordMismatchError`, `EmptyPasswordError`, `NoTTYError`, `PasswordPromptOptions`, `promptPassword()`, `promptText()`
- **Internal imports:** (none)
- **External imports:** `node:readline`
- **Called by:** commands/vault, entrypoints/bootstrap

### `src/credentials/errors.ts`
- **Layer:** 4
- **Role:** Structured vault error types. Every operation throws a typed error on failure.
- **Exports:** `VaultErrorCode`, `VaultError`, `WrongPasswordError`, `CorruptedVaultError`, `VaultNotFoundError`, `VaultDiskError`, `VaultAlreadyExistsError`, `isVaultError()`, `isNodeError()`
- **Internal imports:** (none)
- **External imports:** (none)
- **Called by:** credentials/vault, commands/vault, entrypoints/bootstrap

### `src/credentials/types.ts`
- **Layer:** 4
- **Role:** Credential type definitions. 20+ service types (github, aws, slack, etc.) with field templates and domain mappings.
- **Exports:** `ServiceType`, `Credential`, `ServiceTemplate`, `SERVICE_TEMPLATES`
- **Internal imports:** (none)
- **External imports:** (none)
- **Called by:** credentials/vault, credentials/provider, commands/vault

### `src/credentials/index.ts`
- **Layer:** 4
- **Role:** Barrel export for the credentials module.
- **Exports:** Re-exports from vault, provider, types, errors, prompt
- **Internal imports:** All credentials submodules

---

## Module: integrations/ (Layer 6 — 3 files)

CLI discovery and adapter system. Auto-detects installed CLIs and generates compact hints for system prompt injection.

### `src/integrations/discovery.ts`
- **Layer:** 6
- **Role:** Auto-detects installed CLIs (git, node, gh, docker, etc.) and loads project-level pcc-tools.yaml. Returns available adapters with hints.
- **Exports:** `discoverTools()`, `getDiscoverySummary()`
- **Internal imports:** `./adapter.js` (CliAdapter, ProjectToolConfig, mergeProjectTools)
- **External imports:** `node:child_process` (spawn), `node:fs/promises`, `node:path`, `node:url`, `yaml` (parseYaml)
- **Called by:** entrypoints/bootstrap, entrypoints/prompt-builder

### `src/integrations/adapter.ts`
- **Layer:** 6
- **Role:** Parses adapter definitions and generates compact hint strings (~100-200 tokens) for system prompt injection.
- **Exports:** `CliAdapter`, `ProjectToolConfig`, `generateHints()`, `mergeProjectTools()`
- **Internal imports:** (none)
- **External imports:** (none)
- **Called by:** integrations/discovery, entrypoints/prompt-builder

### `src/integrations/index.ts`
- **Layer:** 6
- **Role:** Barrel export for the integrations module.
- **Exports:** Re-exports from discovery, adapter
- **Internal imports:** discovery, adapter

---

## Module: commands/ (Layer 7 — 12 files)

Slash command system. Registry, builtin commands, and factory commands that receive service instances.

### `src/commands/registry.ts`
- **Layer:** 7
- **Role:** Slash command registration and dispatch. Commands are typed functions with access to full application context.
- **Exports:** `Command`, `CommandContext`, `CommandResult`, `CommandRegistry`
- **Internal imports:** `../protocol/messages.js` (Message), `../transport/client.js` (MiniMaxClient)
- **External imports:** (none)
- **Called by:** commands/*, plugins/loader, plugins/registry, entrypoints/services, entrypoints/bootstrap

### `src/commands/builtins.ts`
- **Layer:** 7
- **Role:** Core slash commands: /help, /quit, /clear, /compact, /commit, /status, /review, /memory.
- **Exports:** `helpCommand`, `quitCommand`, `clearCommand`, `compactCommand`, `commitCommand`, `statusCommand`, `reviewCommand`, `memoryCommand`
- **Internal imports:** `./registry.js` (Command, CommandContext, CommandResult), `../context/memory/obsidian.js` (ObsidianVault, discoverVault), `../utils/strings.js` (slugify)
- **External imports:** (none)
- **Called by:** commands/index

### `src/commands/index.ts`
- **Layer:** 7
- **Role:** Barrel export + `createDefaultCommands()` factory that registers all builtin commands.
- **Exports:** All command exports, `CommandRegistry`, `createDefaultCommands()`
- **Internal imports:** All commands submodules
- **External imports:** (none)
- **Called by:** entrypoints/bootstrap, entrypoints/repl

### `src/commands/automation.ts`
- **Layer:** 7
- **Role:** Factory functions for /bg (background sessions) and /proactive (autonomous goal pursuit) commands.
- **Exports:** `createBgCommand()`, `createProactiveCommand()`
- **Internal imports:** `./registry.js`, `../automation/background.js` (BackgroundManager), `../engine/loop.js` (LoopConfig)
- **External imports:** (none)
- **Called by:** commands/index, entrypoints/bootstrap

### `src/commands/batch.ts`
- **Layer:** 7
- **Role:** /batch command. Decomposes tasks into parallel worktree-isolated units via the model, executes concurrently, then lets user merge or discard.
- **Exports:** `createBatchCommand()`, `extractJSON()`
- **Internal imports:** `./registry.js`, `../agents/orchestrator.js` (AgentOrchestrator, AgentResult), `../agents/worktree.js` (Worktree, mergeWorktree, removeWorktree), `../agents/delegation.js` (delegateParallel, ParallelTask), `../transport/client.js` (MiniMaxClient), `../protocol/messages.js` (isTextBlock), `../utils/git.js` (resolveGitRoot)
- **External imports:** `node:path`
- **Called by:** commands/index, entrypoints/bootstrap

### `src/commands/config.ts`
- **Layer:** 7
- **Role:** Configuration and utility commands: /model, /fast, /diff, /export, /rewind.
- **Exports:** `modelCommand`, `fastCommand`, `diffCommand`, `exportCommand`, `rewindCommand`
- **Internal imports:** `../protocol/messages.js` (isTextBlock), `../transport/client.js` (MINIMAX_MODELS), `./registry.js`
- **External imports:** `node:fs/promises`, `node:child_process`, `node:util`
- **Called by:** commands/index

### `src/commands/doctor.ts`
- **Layer:** 7
- **Role:** /doctor diagnostic health check. Tests API connectivity, Node.js version, git, vault, and disk.
- **Exports:** `doctorCommand`
- **Internal imports:** `./registry.js`
- **External imports:** `node:fs/promises`, `node:path`, `node:os`, `node:child_process`, `node:util`
- **Called by:** commands/index

### `src/commands/init.ts`
- **Layer:** 7
- **Role:** /init project initialization. Analyzes cwd and generates SHUGU.md + .pcc/ directory.
- **Exports:** `initCommand`
- **Internal imports:** `./registry.js`, `../utils/fs.js` (fileExists)
- **External imports:** `node:fs/promises`, `node:path`
- **Called by:** commands/index

### `src/commands/review.ts`
- **Layer:** 7
- **Role:** /review parallel code review with 3 specialist agents (security, logic, architecture).
- **Exports:** `createReviewCommand()`
- **Internal imports:** `./registry.js`, `../agents/orchestrator.js` (AgentOrchestrator), `../agents/delegation.js` (delegateParallel, ParallelTask, ParallelResults), `../utils/git.js` (git), `../context/workspace/project.js` (loadReviewRules)
- **External imports:** (none)
- **Called by:** commands/index, entrypoints/bootstrap

### `src/commands/team.ts`
- **Layer:** 7
- **Role:** /team command. Agent team dispatch with predefined templates (default, parallel, review).
- **Exports:** `createTeamCommand()`
- **Internal imports:** `./registry.js`, `../agents/orchestrator.js` (AgentOrchestrator), `../agents/teams.js` (AgentTeam, TEAM_TEMPLATES), `../context/workspace/project.js` (loadReviewRules)
- **External imports:** (none)
- **Called by:** commands/index, entrypoints/bootstrap

### `src/commands/trace.ts`
- **Layer:** 7
- **Role:** /trace and /health observability commands. Shows recent trace events and session health dashboard.
- **Exports:** `traceCommand`, `healthCommand`
- **Internal imports:** `./registry.js`, `../utils/tracer.js` (tracer)
- **External imports:** (none)
- **Called by:** commands/index

### `src/commands/vault.ts`
- **Layer:** 7
- **Role:** /vault credential management. Factory pattern with closure over vault instance. Subcommands: status, list, add, remove, change-password, services.
- **Exports:** `createVaultCommand()`
- **Internal imports:** `./registry.js`, `../credentials/vault.js` (CredentialVault), `../credentials/types.js` (SERVICE_TEMPLATES, ServiceType, Credential), `../credentials/errors.js` (WrongPasswordError), `../credentials/prompt.js` (promptPassword, promptText)
- **External imports:** (none)
- **Called by:** entrypoints/bootstrap

---

## Module: agents/ (Layer 8 — 5 files)

Sub-agent spawning, delegation patterns, team coordination, and git worktree isolation.

### `src/agents/orchestrator.ts`
- **Layer:** 8
- **Role:** Spawns and manages sub-agents. A sub-agent is another runLoop() with its own conversation, budget, and tool set. Supports worktree isolation. Max depth: 3, max concurrent: 15.
- **Exports:** `MAX_AGENT_DEPTH`, `MAX_ACTIVE_AGENTS`, `AgentDefinition`, `BUILTIN_AGENTS`, `AgentResult`, `AgentOrchestrator`, `SpawnOptions`
- **Internal imports:** `../engine/loop.js` (runLoop, LoopConfig, LoopEvent), `../transport/client.js` (MiniMaxClient), `../engine/interrupts.js` (InterruptController), `../protocol/messages.js` (Message, AssistantMessage, isTextBlock), `../protocol/tools.js` (Tool, ToolContext), `./worktree.js` (createWorktree, removeWorktree, worktreeHasChanges, Worktree, WorktreeCleanupResult), `../utils/git.js` (resolveGitRoot, relativeToCwd)
- **External imports:** `node:path`
- **Called by:** tools/agents/AgentTool, commands/batch, commands/review, commands/team, meta/cli, meta/proposer, meta/runtime, entrypoints/bootstrap

### `src/agents/delegation.ts`
- **Layer:** 8
- **Role:** Higher-level patterns for delegating work: parallel execution, sequential chains, and result aggregation.
- **Exports:** `ParallelTask`, `ParallelResults`, `delegateParallel()`, `ChainStep`, `delegateChain()`, `formatParallelResults()`
- **Internal imports:** `./orchestrator.js` (AgentOrchestrator, AgentResult, SpawnOptions)
- **External imports:** (none)
- **Called by:** commands/batch, commands/review, agents/teams

### `src/agents/teams.ts`
- **Layer:** 8
- **Role:** Team coordination (swarms). Predefined templates: default (explore-code-review chain), parallel workers, review team.
- **Exports:** `TeamMember`, `TeamConfig`, `TeamResult`, `TEAM_TEMPLATES`, `AgentTeam`
- **Internal imports:** `./orchestrator.js` (AgentOrchestrator, AgentResult, SpawnOptions, MAX_ACTIVE_AGENTS), `./delegation.js` (delegateParallel, delegateChain, formatParallelResults, ParallelTask, ChainStep)
- **External imports:** (none)
- **Called by:** commands/team

### `src/agents/worktree.ts`
- **Layer:** 8
- **Role:** Git worktree isolation for sub-agents. Create worktree from current branch, agent works in isolation, merge back or discard.
- **Exports:** `Worktree`, `WorktreeCleanupResult`, `MergeResult`, `createWorktree()`, `removeWorktree()`, `worktreeHasChanges()`, `mergeWorktree()`
- **Internal imports:** `../utils/git.js` (git, resolveGitRoot)
- **External imports:** `node:fs/promises`, `node:path`, `node:crypto`
- **Called by:** agents/orchestrator, commands/batch, meta/evaluator

### `src/agents/index.ts`
- **Layer:** 8
- **Role:** Barrel export for the agents module.
- **Exports:** Re-exports from orchestrator, delegation, worktree, teams
- **Internal imports:** All agents submodules

---

## Module: automation/ (Layer 9 — 8 files)

Background sessions, scheduling, daemon mode, proactive loops, triggers, and vault maintenance.

### `src/automation/background.ts`
- **Layer:** 9
- **Role:** In-process background sessions. Lightweight concurrent agentic loops sharing the Node.js process with the REPL.
- **Exports:** `BackgroundSession`, `BackgroundManager`
- **Internal imports:** `../engine/loop.js` (runLoop, LoopConfig, LoopEvent), `../engine/interrupts.js` (InterruptController), `../protocol/messages.js` (Message, isTextBlock), `../protocol/tools.js` (Tool, ToolContext), `../utils/logger.js` (logger)
- **External imports:** `node:events`
- **Called by:** commands/automation, entrypoints/bootstrap, entrypoints/services

### `src/automation/scheduler.ts`
- **Layer:** 9
- **Role:** Cron-like scheduling for recurring agent tasks. Simple tick-based approach, no external dependencies.
- **Exports:** `parseCron()`, `CronSchedule`, `cronMatches()`, `ScheduledJob`, `JobExecutor`, `Scheduler`
- **Internal imports:** `../utils/logger.js` (logger)
- **External imports:** `node:events`
- **Called by:** skills/bundled/schedule, entrypoints/bootstrap, entrypoints/services

### `src/automation/daemon.ts`
- **Layer:** 9
- **Role:** Detached execution mode. Runs PCC as a background process with auto-restart, state persistence, and JSON-lines IPC via Unix socket.
- **Exports:** `DaemonConfig`, `DaemonState`, `DaemonMessage`, `DaemonController`, `DaemonWorker`
- **Internal imports:** (none — uses child_process fork)
- **External imports:** `node:child_process`, `node:fs`, `node:path`, `node:net`, `node:events`
- **Called by:** automation/index

### `src/automation/kairos.ts`
- **Layer:** 9
- **Role:** KAIROS time awareness agent. Tracks session time, suggests breaks after 45min, generates away summaries after 10min idle, provides time context injection.
- **Exports:** `KairosState`, `Kairos`, `KairosNotification`
- **Internal imports:** `../protocol/messages.js` (Message, isTextBlock)
- **External imports:** (none)
- **Called by:** entrypoints/bootstrap, entrypoints/repl, entrypoints/services

### `src/automation/proactive.ts`
- **Layer:** 9
- **Role:** Proactive loop. Agent continues working without user prompts, generating its own continuation prompts. Detects goal achievement via [GOAL_ACHIEVED] marker.
- **Exports:** `ProactiveConfig`, `ProactiveLoop`, `ProactiveResult`
- **Internal imports:** `../engine/loop.js` (runLoop, LoopConfig, LoopEvent), `../engine/interrupts.js` (InterruptController), `../protocol/messages.js` (Message, AssistantMessage, isTextBlock)
- **External imports:** `node:events`
- **Called by:** commands/automation

### `src/automation/triggers.ts`
- **Layer:** 9
- **Role:** Remote trigger HTTP server. External systems (webhooks, CI, scripts) can kick off agent tasks via REST API.
- **Exports:** `TriggerDefinition`, `TriggerRequest`, `TriggerExecutor`, `TriggerServer`
- **Internal imports:** (none)
- **External imports:** `node:http`, `node:events`
- **Called by:** automation/index

### `src/automation/obsidian-agent.ts`
- **Layer:** 9
- **Role:** Scheduled background agent for Obsidian vault maintenance. Archives stale notes (>30 days), generates .schema.md convention file, creates weekly digests.
- **Exports:** `runVaultMaintenance()`, `ensureSchema()`, `archiveStaleNotes()`, `generateDigest()`, `MaintenanceResult`
- **Internal imports:** `../context/memory/obsidian.js` (ObsidianVault), `../utils/logger.js` (logger)
- **External imports:** (none)
- **Called by:** automation/index

### `src/automation/index.ts`
- **Layer:** 9
- **Role:** Barrel export for the automation module.
- **Exports:** Re-exports from scheduler, daemon, background, triggers, proactive, obsidian-agent, kairos
- **Internal imports:** All automation submodules

---

## Module: remote/ (Layer 10 — 3 files)

Session sharing over WebSocket and SSH execution on remote VPS.

### `src/remote/gateway.ts`
- **Layer:** 10
- **Role:** WebSocket session gateway. Share a PCC session for remote observation/interaction. JSON-RPC style protocol. Default port 9377.
- **Exports:** `GatewayMessage`, `SessionStatus`, `GatewayConfig`, `DEFAULT_GATEWAY_CONFIG`, `SessionGateway`
- **Internal imports:** `../engine/loop.js` (LoopEvent)
- **External imports:** `node:http`
- **Called by:** remote/index

### `src/remote/ssh.ts`
- **Layer:** 10
- **Role:** SSH command execution on remote VPS via system's ssh binary. No npm dependency. Credentials from vault.
- **Exports:** `SSHResult`, `SSHTunnel`, `sshExec()`, `sshTest()`, `scpUpload()`, `scpDownload()`, `openSOCKSProxy()`
- **Internal imports:** `../credentials/provider.js` (VPSConfig)
- **External imports:** `node:child_process` (spawn)
- **Called by:** remote/index

### `src/remote/index.ts`
- **Layer:** 10
- **Role:** Barrel export for the remote module.
- **Exports:** Re-exports from ssh, gateway
- **Internal imports:** ssh, gateway

---

## Module: ui/ (Layer 11 — 23 files)

Terminal UI layer. React/Ink components, ANSI renderer, companion system, syntax highlighting, and markdown rendering.

### `src/ui/App.tsx`
- **Layer:** 11
- **Role:** Original Ink application component with output lines, input, mode cycling, and status bar.
- **Exports:** `AppState`, `App` (component)
- **Internal imports:** (none — standalone React component)
- **External imports:** `react`, `ink`, `ink-text-input`

### `src/ui/FullApp.tsx`
- **Layer:** 11
- **Role:** Full Ink application using `<Static>` for message history (native terminal scroll). Live area for spinner, input, mode, status. This is the primary UI.
- **Exports:** `ExternalState`, `AppHandle`, `launchFullApp()`
- **Internal imports:** `./components/Messages.js` (UIMessage), `./companion/CompanionSprite.js`, `./companion/types.js` (Companion), `./paste.js` (createPasteHandler), `./highlight.js` (colorizeCode, detectLanguage), `./markdown.js` (renderMarkdown, renderInline), `./parsers.js` (parseReadOutput, parseGrepOutput, parseWebFetchOutput, parseGlobOutput)
- **External imports:** `react`, `ink`, `ink-text-input`
- **Called by:** entrypoints/repl, entrypoints/repl-commands, entrypoints/cli-handlers

### `src/ui/PromptArea.tsx`
- **Layer:** 11
- **Role:** Mount/unmount Ink-based prompt area with bars, mode indicator, and status line.
- **Exports:** `PromptArea` (component)
- **Internal imports:** (none)
- **External imports:** `react`, `ink`, `ink-text-input`

### `src/ui/renderer.ts`
- **Layer:** 11
- **Role:** Pure ANSI terminal renderer. Full-featured with ASCII art banner, persistent status bar, buddy companion, brew timer, box-drawing, and permission prompts. No React/Ink dependency.
- **Exports:** `TerminalRenderer`
- **Internal imports:** `./banner.js` (renderBanner, renderSeparator, renderStatusLine, BannerInfo), `./statusbar.js` (StatusBar, StatusBarState), `./buddy.js` (Buddy)
- **External imports:** `node:readline`
- **Called by:** entrypoints/bootstrap, entrypoints/services, entrypoints/repl, entrypoints/single-shot, entrypoints/cli-handlers, entrypoints/repl-commands

### `src/ui/banner.ts`
- **Layer:** 11
- **Role:** Startup banner with braille face + SHUGU ASCII gradient art, framed with box-drawing characters.
- **Exports:** `renderBanner()`, `renderSeparator()`, `renderStatusLine()`, `BannerInfo`
- **Internal imports:** `../utils/ansi.js` (visL)
- **External imports:** (none)
- **Called by:** ui/renderer, entrypoints/bootstrap, entrypoints/repl

### `src/ui/buddy.ts`
- **Layer:** 11
- **Role:** ASCII buddy companion with speech bubbles that reacts to events (thinking, working, happy, error, sleeping, searching). Positioned in right margin.
- **Exports:** `BuddyState`, `Buddy`
- **Internal imports:** `../utils/random.js` (pick)
- **External imports:** (none)
- **Called by:** ui/renderer

### `src/ui/highlight.ts`
- **Layer:** 11
- **Role:** Multi-language regex tokenizer for syntax highlighting. Returns React/Ink elements. Languages: javascript, python, json, shell, markdown, generic.
- **Exports:** `TokenType`, `Token`, `LanguageRules`, `colorizeCode()`, `detectLanguage()`
- **Internal imports:** (none)
- **External imports:** `react`, `ink`
- **Called by:** ui/FullApp, ui/markdown

### `src/ui/markdown.tsx`
- **Layer:** 11
- **Role:** Markdown-to-React/Ink renderer. Handles headings, code fences, inline code, bold, italic, links, lists, tables.
- **Exports:** `parseInlineSegments()`, `renderMarkdown()`, `renderInline()`
- **Internal imports:** `./highlight.js` (colorizeCode, detectLanguage)
- **External imports:** `react`, `ink`
- **Called by:** ui/FullApp

### `src/ui/parsers.ts`
- **Layer:** 11
- **Role:** Tool output parsers. Parse structured output from each tool type for per-surface syntax highlighting.
- **Exports:** `ReadLine`, `ReadOutput`, `parseReadOutput()`, `GrepOutput`, `parseGrepOutput()`, `WebFetchOutput`, `parseWebFetchOutput()`, `GlobOutput`, `parseGlobOutput()`
- **Internal imports:** (none)
- **External imports:** (none)
- **Called by:** ui/FullApp

### `src/ui/paste.ts`
- **Layer:** 11
- **Role:** Bracketed paste mode handler. Intercepts terminal paste sequences (ESC[200~/ESC[201~) for atomic paste blocks.
- **Exports:** `PasteHandler`, `createPasteHandler()`
- **Internal imports:** (none)
- **External imports:** (none — uses `process.stdout/stdin`)
- **Called by:** ui/FullApp

### `src/ui/statusbar.ts`
- **Layer:** 11
- **Role:** Status bar state container and ANSI renderer. Displays model, context%, cost, uptime, mode.
- **Exports:** `StatusBarState`, `StatusBar`
- **Internal imports:** `../utils/ansi.js` (visL)
- **External imports:** (none)
- **Called by:** ui/renderer

### `src/ui/components/Messages.tsx`
- **Layer:** 11
- **Role:** React component for rendering conversation messages. Each message is a typed object (user, assistant_text, thinking, tool_call, tool_result, error, info, brew).
- **Exports:** `UIMessage`, `Messages` (component)
- **Internal imports:** `./ThinkingBlock.js`, `./ToolCallBlock.js` (ToolCallHeader, ToolResultBlock), `./Spinner.js` (Spinner, BrewTimer)
- **External imports:** `react`, `ink`
- **Called by:** ui/FullApp

### `src/ui/components/ScrollBox.tsx`
- **Layer:** 11
- **Role:** Scrollable container with sticky-scroll support. Simplified version of Claude Code's ScrollBox.
- **Exports:** `ScrollBoxHandle`, `ScrollBox` (component)
- **Internal imports:** (none)
- **External imports:** `react`, `ink`

### `src/ui/components/Spinner.tsx`
- **Layer:** 11
- **Role:** Streaming indicator with rotating verbs (Thinking, Hatching, Brewing...) and elapsed time/token display. Plus BrewTimer for post-response timing.
- **Exports:** `Spinner` (component), `BrewTimer` (component)
- **Internal imports:** (none)
- **External imports:** `react`, `ink`
- **Called by:** ui/components/Messages

### `src/ui/components/ThinkingBlock.tsx`
- **Layer:** 11
- **Role:** Renders the model's reasoning/thinking content with dim magenta styling.
- **Exports:** `ThinkingBlock` (component)
- **Internal imports:** (none)
- **External imports:** `react`, `ink`
- **Called by:** ui/components/Messages

### `src/ui/components/ToolCallBlock.tsx`
- **Layer:** 11
- **Role:** Tool call header and result blocks with box-drawing frame (yellow borders).
- **Exports:** `ToolCallHeader` (component), `ToolResultBlock` (component)
- **Internal imports:** (none)
- **External imports:** `react`, `ink`
- **Called by:** ui/components/Messages

### `src/ui/companion/CompanionSprite.tsx`
- **Layer:** 11
- **Role:** React/Ink companion sprite with idle animation (500ms fidget ticks), speech bubbles with rounded border, fade-out effect, and pet hearts animation.
- **Exports:** `CompanionSprite` (component), `CompanionSpriteProps`
- **Internal imports:** `./types.js` (Companion), `./sprites.js` (renderSprite, renderFace, spriteFrameCount)
- **External imports:** `react`, `ink`
- **Called by:** ui/FullApp

### `src/ui/companion/companion.ts`
- **Layer:** 11
- **Role:** Deterministic companion generation from seed string using seeded PRNG. Persists companion to ~/.pcc/companion.json.
- **Exports:** `generateBones()`, `getCompanion()`, `getStoredCompanion()`, `saveCompanion()`, `renderBuddyCompact()`, `renderBuddyCard()`
- **Internal imports:** `./types.js` (CompanionBones, Companion, Rarity, Species, Eye, Hat, SPECIES, EYES, HATS, RARITIES, RARITY_WEIGHTS, RARITY_STARS), `./sprites.js` (renderSprite, renderFace)
- **External imports:** `node:os`, `node:path`, `node:fs`
- **Called by:** ui/companion/index, entrypoints/bootstrap, entrypoints/prompt-builder, entrypoints/cli-handlers, entrypoints/repl-commands

### `src/ui/companion/index.ts`
- **Layer:** 11
- **Role:** Barrel export for the companion module.
- **Exports:** Re-exports from CompanionSprite, companion, prompt, sprites, types
- **Internal imports:** All companion submodules
- **Called by:** entrypoints/bootstrap, entrypoints/prompt-builder, entrypoints/cli-handlers

### `src/ui/companion/prompt.ts`
- **Layer:** 11
- **Role:** Companion system prompt integration. Generates prompt section introducing the companion to the model. Also generates heuristic-based reactions (no LLM call).
- **Exports:** `getCompanionPrompt()`, `generateReaction()`, `CompanionEvent`
- **Internal imports:** `./types.js` (Companion, RARITY_STARS), `../../utils/random.js` (pick)
- **External imports:** (none)
- **Called by:** ui/companion/index, entrypoints/prompt-builder

### `src/ui/companion/sprites.ts`
- **Layer:** 11
- **Role:** ASCII sprite definitions for 18 species. Each sprite is 5 lines tall, ~12 chars wide, with 3 animation frames. {E} replaced with eye character at render time.
- **Exports:** `renderSprite()`, `renderFace()`, `spriteFrameCount()`
- **Internal imports:** `./types.js` (Species, Eye, Hat, CompanionBones)
- **External imports:** (none)
- **Called by:** ui/companion/CompanionSprite, ui/companion/companion

### `src/ui/companion/types.ts`
- **Layer:** 11
- **Role:** Companion type definitions. 18 species, 6 eye styles, 8 hats, 5 rarity tiers with weighted probabilities.
- **Exports:** `SPECIES`, `Species`, `EYES`, `Eye`, `HATS`, `Hat`, `RARITIES`, `Rarity`, `RARITY_WEIGHTS`, `RARITY_STARS`, `CompanionBones`, `CompanionSoul`, `Companion`
- **Internal imports:** (none)
- **External imports:** (none)
- **Called by:** ui/companion/CompanionSprite, ui/companion/companion, ui/companion/prompt, ui/companion/sprites

---

## Module: voice/ (Layer 12 — 2 files)

Push-to-talk voice input with multiple transcription backends.

### `src/voice/capture.ts`
- **Layer:** 12
- **Role:** Audio capture via system utilities (arecord, sox) and transcription via MiniMax, OpenAI Whisper API, or local whisper.cpp.
- **Exports:** `VoiceConfig`, `DEFAULT_VOICE_CONFIG`, `Recording`, `recordAudio()`, `transcribe()`
- **Internal imports:** (none)
- **External imports:** `node:child_process` (spawn), `node:fs/promises`, `node:path`, `node:os`, `node:crypto`

### `src/voice/index.ts`
- **Layer:** 12
- **Role:** Barrel export for the voice module.
- **Exports:** Re-exports from capture
- **Internal imports:** capture

---

## Module: skills/ (Layer 13 — 9 files)

Domain-specific workflows that extend agent capabilities. Bundled skills ship with PCC; external skills load from disk.

### `src/skills/loader.ts`
- **Layer:** 13
- **Role:** Skill definition, registry, trigger matching, and loading from bundled + external directories.
- **Exports:** `Skill`, `SkillCategory`, `SkillTrigger`, `SkillContext`, `SkillResult`, `SkillRegistry`, `loadBundledSkills()`, `loadExternalSkills()`, `generateSkillsPrompt()`
- **Internal imports:** `../protocol/messages.js` (Message), `../protocol/tools.js` (ToolContext, Tool)
- **External imports:** `node:fs`, `node:path`, `node:events`
- **Called by:** skills/index, skills/generator, skills/bundled/*, plugins/loader, plugins/registry

### `src/skills/generator.ts`
- **Layer:** 13
- **Role:** Generates new skill files from descriptions. Creates properly structured skill source code.
- **Exports:** `generateSkillSource()`, `saveGeneratedSkill()`, `skillCreatorSkill`
- **Internal imports:** `./loader.js` (Skill, SkillContext, SkillResult)
- **External imports:** `node:fs`, `node:path`
- **Called by:** skills/index

### `src/skills/index.ts`
- **Layer:** 13
- **Role:** Barrel export + `createDefaultSkillRegistry()` factory.
- **Exports:** Re-exports from loader, generator, and all bundled skills. `createDefaultSkillRegistry()`
- **Internal imports:** All skills submodules
- **Called by:** entrypoints/bootstrap, entrypoints/repl, entrypoints/prompt-builder, entrypoints/services, plugins/registry

### `src/skills/bundled/vibe.ts`
- **Layer:** 13
- **Role:** Vibe Workflow — 6-stage pipeline (analysis, architecture, planning, codegen, validate, ship) for generating complete codebases from project descriptions. Supports resume and re-run from specific stage.
- **Exports:** `vibeSkill`
- **Internal imports:** `../loader.js` (Skill, SkillContext, SkillResult)
- **External imports:** `node:fs`, `node:path`
- **Called by:** skills/index

### `src/skills/bundled/dream.ts`
- **Layer:** 13
- **Role:** Dream mode — read-only exploration/brainstorming. Agent investigates codebase, identifies patterns, generates insights without modifying files.
- **Exports:** `dreamSkill`
- **Internal imports:** `../loader.js` (Skill, SkillContext, SkillResult)
- **External imports:** (none)
- **Called by:** skills/index

### `src/skills/bundled/hunter.ts`
- **Layer:** 13
- **Role:** Bug Hunter — systematic scanning for bugs, security issues, and code quality problems with severity ratings and fix suggestions.
- **Exports:** `hunterSkill`
- **Internal imports:** `../loader.js` (Skill, SkillContext, SkillResult)
- **External imports:** (none)
- **Called by:** skills/index

### `src/skills/bundled/loop.ts`
- **Layer:** 13
- **Role:** Loop skill — run a prompt or command on a recurring interval. Supports seconds/minutes/hours.
- **Exports:** `loopSkill`
- **Internal imports:** `../loader.js` (Skill, SkillContext, SkillResult)
- **External imports:** (none)
- **Called by:** skills/index

### `src/skills/bundled/schedule.ts`
- **Layer:** 13
- **Role:** Schedule skill — create, list, and manage scheduled agent tasks using the automation scheduler. Cron expression support.
- **Exports:** `getSharedScheduler()`, `scheduleSkill`
- **Internal imports:** `../loader.js` (Skill, SkillContext, SkillResult), `../../automation/scheduler.js` (Scheduler, ScheduledJob)
- **External imports:** (none)
- **Called by:** skills/index

### `src/skills/bundled/secondbrain.ts`
- **Layer:** 13
- **Role:** Second Brain — deep Obsidian vault integration. Contextual knowledge retrieval, graph-aware navigation, Zettelkasten-style note creation.
- **Exports:** `secondBrainSkill`
- **Internal imports:** `../loader.js` (Skill, SkillContext, SkillResult), `../../context/memory/obsidian.js` (ObsidianVault, discoverVault), `../../utils/strings.js` (slugify)
- **External imports:** (none)
- **Called by:** skills/index

---

## Module: plugins/ (Layer 14 — 11 files)

Plugin system with hooks for intercepting tool execution, command dispatch, and lifecycle events. Supports trusted (in-process) and brokered (Docker sandbox or Node `--permission`) isolation modes.

### `src/plugins/hooks.ts`
- **Layer:** 14
- **Role:** Hook system backbone. 7 hook types: PreToolUse, PostToolUse, PreCommand, PostCommand, OnMessage, OnStart, OnExit. Hooks can modify inputs/outputs or block operations.
- **Exports:** `HookType`, `PreToolUsePayload`, `PreToolUseResult`, `PostToolUsePayload`, `PostToolUseResult`, `CommandPayload`, `MessagePayload`, `HookHandler`, `HookRegistry`
- **Internal imports:** `../protocol/tools.js` (ToolCall, ToolResult), `../protocol/messages.js` (Message), `../utils/tracer.js` (tracer), `../utils/logger.js` (logger)
- **External imports:** `node:events`
- **Called by:** engine/loop, plugins/registry, plugins/builtin/*, entrypoints/services

### `src/plugins/loader.ts`
- **Layer:** 14
- **Role:** Plugin loader from ~/.pcc/plugins/ (global) and .pcc/plugins/ (project-local). Plugins have plugin.json manifest and JS/TS entry. Routes trusted plugins to dynamic `import()` and brokered plugins to `PluginHost`.
- **Exports:** `PluginManifest`, `Plugin`, `PluginAPI`, `PluginInit`, `LoadPluginOptions`, `loadPlugin()`, `loadAllPlugins()`, `loadManifest()`, `discoverPluginDirs()`
- **Internal imports:** `../protocol/tools.js` (Tool), `../commands/registry.js` (Command), `../skills/loader.js` (Skill), `./hooks.js` (HookHandler, HookType), `./host.js` (PluginHost), `./broker.js` (CapabilityBroker), `./policy.js` (resolvePluginConfig)`
- **External imports:** `node:fs`, `node:path`, `node:os`
- **Called by:** plugins/registry

### `src/plugins/registry.ts`
- **Layer:** 14
- **Role:** Central registry that manages loaded plugins and integrates their contributions (tools, commands, skills, hooks) into the main system.
- **Exports:** `PluginRegistry`
- **Internal imports:** `./loader.js` (Plugin, PluginManifest, LoadPluginOptions, loadAllPlugins), `./hooks.js` (HookRegistry), `../protocol/tools.js` (ToolRegistry, Tool), `../commands/registry.js` (CommandRegistry), `../skills/loader.js` (SkillRegistry)
- **External imports:** `node:events`
- **Called by:** entrypoints/bootstrap, meta/runtime

### `src/plugins/protocol.ts`
- **Layer:** 14
- **Role:** JSON-RPC message type definitions for host↔child brokered IPC. Defines request, response, and notification shapes for all IPC methods: init, invoke_tool, invoke_hook, invoke_command, invoke_skill, register_tool, register_hook, register_command, register_skill, capability_request, and callback variants (info, error, query, run_agent, tool_invoke).
- **Exports:** `JsonRpcRequest`, `JsonRpcResponse`, `JsonRpcNotification`, `JsonRpcError`, `JsonRpcMessage`, `RPC_PARSE_ERROR`, `RPC_INVALID_REQUEST`, `RPC_METHOD_NOT_FOUND`, `RPC_TIMEOUT`, `RPC_CHILD_CRASHED`, `RPC_CAPABILITY_DENIED`, `InitParams`, `InvokeToolParams`, `InvokeHookParams`, `InvokeHookResult`, `RegisterToolParams`, `RegisterHookParams`, `LogParams`, `CapabilityRequestParams`, `InvokeCommandParams`, `SerializedCommandContext`, `RegisterCommandParams`, `CallbackInfoParams`, `CallbackErrorParams`, `CallbackQueryParams`, `InvokeSkillParams`, `SerializedSkillContext`, `RegisterSkillParams`, `SerializedSkillTrigger`, `CallbackRunAgentParams`, `CallbackToolInvokeParams`, `SerializedToolContext`
- **Internal imports:** `./hooks.js` (PreToolUseResult, PostToolUseResult)
- **External imports:** (none — Layer 0 equivalent within plugins)
- **Called by:** plugins/host, plugins/child-entry

### `src/plugins/host.ts`
- **Layer:** 14
- **Role:** `PluginHost` manages the lifecycle of a single brokered plugin child process. Spawns a Docker container (`--net=none --read-only --cap-drop=ALL`) when Docker is available, or a Node child process with `--permission` flags otherwise. Sends JSON-RPC messages over stdio, handles capability requests via the `CapabilityBroker`, and creates proxy `Tool`, `HookHandler`, `Command`, and `Skill` objects that route invocations to the child.
- **Exports:** `PluginHostOptions`, `isDockerAvailable()`, `buildDockerArgs()`, `getNodeMajorVersion()`, `buildPermissionFlags()`, `PluginHost`
- **Internal imports:** `./protocol.js` (all RPC types), `./broker.js` (CapabilityBroker), `./hooks.js` (HookHandler, HookType), `./loader.js` (PluginManifest), `../protocol/tools.js` (Tool, ToolCall, ToolResult, ToolContext, ToolDefinition), `../commands/registry.js` (Command, CommandContext, CommandResult), `../skills/loader.js` (Skill, SkillContext, SkillResult, SkillTrigger, SkillCategory), `../utils/logger.js` (logger)
- **External imports:** `node:child_process` (spawn, execFileSync), `node:readline`, `node:events`, `node:fs` (existsSync), `node:path`
- **Called by:** plugins/loader

### `src/plugins/child-entry.ts`
- **Layer:** 14
- **Role:** Entry point that runs inside the isolated child process. Reads JSON-RPC messages from stdin, dispatches `invoke_tool`, `invoke_hook`, `invoke_command`, and `invoke_skill` calls to plugin-registered handlers, and routes `capability_request` messages to the host via stdout. Imports the plugin's entry module and calls its `init(api)` export during the initialization handshake.
- **Exports:** (none — side-effect entry point, self-contained)
- **Internal imports (type-only):** `../protocol/tools.js`, `./hooks.js`, `../commands/registry.js`, `../skills/loader.js`, `./protocol.js`
- **External imports:** `node:readline`
- **Called by:** plugins/host (spawns as child process)

### `src/plugins/broker.ts`
- **Layer:** 14
- **Role:** `CapabilityBroker` gates all filesystem and network requests from brokered plugins. Path validation resolves symlinks and rejects writes outside `.data/`. Network validation rejects RFC1918 addresses, localhost, and cloud metadata endpoints via `isBlockedUrl()`. Supports `fs.read`, `fs.write`, `fs.list`, and `http.fetch` capability names.
- **Exports:** `CapabilityName`, `CapabilityRequest`, `CapabilityBroker`
- **Internal imports:** `../utils/network.js` (isBlockedUrl), `../utils/logger.js` (logger)
- **External imports:** `node:fs/promises` (readFile, writeFile, readdir, mkdir, realpath), `node:path` (resolve, relative, isAbsolute)
- **Called by:** plugins/host, plugins/loader

### `src/plugins/policy.ts`
- **Layer:** 14
- **Role:** Loads per-plugin policy configuration from `.pcc/plugin-policy.json` in the project directory. `resolvePluginConfig()` merges manifest defaults with policy overrides to produce a final `PluginConfig` with isolation mode, allowed capabilities, allowed paths, and `maxAgentTurns`.
- **Exports:** `PluginPolicy`, `PluginConfig`, `loadPolicy()`, `resolvePluginConfig()`
- **Internal imports:** `./loader.js` (PluginManifest)
- **External imports:** `node:fs/promises`, `node:path`
- **Called by:** plugins/loader

### `src/plugins/index.ts`
- **Layer:** 14
- **Role:** Barrel export for the plugins module.
- **Exports:** Re-exports from hooks, loader, registry, protocol, host, broker, policy
- **Internal imports:** All plugins submodules

### `src/plugins/builtin/behavior-hooks.ts`
- **Layer:** 14
- **Role:** Built-in PostToolUse hooks. Anti-laziness detection (TODO/stub/truncation in Write/Edit), secret scanning (API keys in Bash output), truncation marking. Zero token cost.
- **Exports:** `SECRET_PATTERNS`, `registerBehaviorHooks()`
- **Internal imports:** `../hooks.js` (HookRegistry, PostToolUsePayload, PostToolUseResult, PreToolUsePayload, PreToolUseResult)
- **External imports:** (none)
- **Called by:** entrypoints/bootstrap, meta/runtime, meta/redact

### `src/plugins/builtin/knowledge-hook.ts`
- **Layer:** 14
- **Role:** Built-in OnMessage hook. Detects memory-worthy hints in assistant messages and saves to Obsidian vault. Uses detectMemoryHints() from extract.ts.
- **Exports:** `registerKnowledgeHooks()`
- **Internal imports:** `../hooks.js` (HookRegistry, MessagePayload), `../../context/memory/obsidian.js` (ObsidianVault), `../../context/memory/extract.js` (detectMemoryHints)
- **External imports:** (none)
- **Called by:** entrypoints/bootstrap

### `src/plugins/builtin/verification-hook.ts`
- **Layer:** 14
- **Role:** PostToolUse hook that auto-verifies TypeScript files after Write/Edit by running `tsc --noEmit`. Appends warnings to result so model auto-corrects. Zero LLM cost.
- **Exports:** `registerVerificationHook()`
- **Internal imports:** `../hooks.js` (HookRegistry, PostToolUsePayload, PostToolUseResult), `../../utils/logger.js` (logger)
- **External imports:** `node:child_process`, `node:util`
- **Called by:** entrypoints/bootstrap, meta/runtime

---

## Module: meta/ (Layer 15 — 12 files)

Meta-Harness outer-loop optimizer. Evaluates and evolves harness configurations via automated search over prompt/strategy/reflection knobs.

### `src/meta/types.ts`
- **Layer:** 15
- **Role:** All interfaces for the Meta-Harness: HarnessConfig, EvalTask, EvalResult, CandidateManifest, RunManifest, ScoredCandidate, StructuredResult, and scorer types.
- **Exports:** `HarnessConfig`, `EvalTask`, `SuccessCriterion`, `Scorer`, `EvalResult`, `CriterionResult`, `StructuredResult`, `ToolStat`, `CandidateManifest`, `ScoredCandidate`, `RunManifest`, `DatasetSplit`, `EvaluatorOptions`, `MetaRuntimeConfig`, `HarnessRuntime`
- **Internal imports:** `../protocol/messages.js` (Message, Usage), `../engine/loop.js` (LoopEvent), `../engine/strategy.js` (Complexity), `../agents/orchestrator.js` (AgentDefinition)
- **External imports:** (none)
- **Called by:** meta/cli, meta/runtime, meta/evaluator, meta/proposer, meta/config, meta/dataset, meta/selector, meta/collect, meta/archive, meta/report, engine/loop

### `src/meta/cli.ts`
- **Layer:** 15
- **Role:** /meta CLI command with subcommands: init, run, resume, status, top, inspect, diff, validate, promote, abort. Factory pattern with closure over orchestrator and client.
- **Exports:** `createMetaCommand()`
- **Internal imports:** `../commands/registry.js` (Command, CommandContext, CommandResult), `../agents/orchestrator.js` (AgentOrchestrator), `../transport/client.js` (MiniMaxClient), `./archive.js` (MetaArchive), `./evaluator.js` (MetaEvaluator), `./proposer.js` (MetaProposer), `./config.js` (loadHarnessConfig, validateHarnessConfig), `./dataset.js` (loadDataset, createDefaultDataset, splitDataset), `./selector.js` (computeParetoFrontier, selectParents, rankByWeightedScore), `./report.js` (generateRunReport, generateCandidateReport, generateDiffReport), `./types.js` (RunManifest, HarnessConfig, ScoredCandidate, EvaluatorOptions)
- **External imports:** `node:crypto`, `node:fs/promises`, `node:path`, `node:os`, `yaml` (stringify)
- **Called by:** entrypoints/bootstrap

### `src/meta/runtime.ts`
- **Layer:** 15
- **Role:** Non-interactive runtime factory. Replicates the full bootstrap pipeline without TTY, renderer, REPL, or session resume. fullAuto mode for headless evaluation.
- **Exports:** `MetaRuntime`, `bootstrapMeta()`
- **Internal imports:** `../protocol/tools.js` (ToolContext), `../transport/client.js` (MiniMaxClient), `../tools/index.js` (createDefaultRegistry), `../policy/permissions.js` (PermissionResolver), `../credentials/vault.js` (CredentialVault), `../credentials/provider.js` (CredentialProvider), `../plugins/registry.js` (PluginRegistry), `../plugins/builtin/behavior-hooks.js` (registerBehaviorHooks), `../plugins/builtin/verification-hook.js` (registerVerificationHook), `../agents/orchestrator.js` (AgentOrchestrator, AgentDefinition), `../entrypoints/prompt-builder.js` (buildSystemPrompt), `../engine/loop.js` (LoopConfig), `./types.js` (MetaRuntimeConfig, HarnessRuntime), `../utils/tracer.js` (tracer)
- **External imports:** (none)
- **Called by:** meta/evaluator

### `src/meta/evaluator.ts`
- **Layer:** 15
- **Role:** Runs candidate configs against task suites. Each task runs in a fresh git worktree. Traces are redacted before archival.
- **Exports:** `MetaEvaluator`
- **Internal imports:** `../agents/worktree.js` (createWorktree, removeWorktree, Worktree), `../utils/git.js` (resolveGitRoot), `../utils/tracer.js` (tracer), `./runtime.js` (bootstrapMeta), `./collect.js` (runStructuredQuery), `./redact.js` (redactMessages, redactTraceEvents), `./archive.js` (MetaArchive), `./types.js` (HarnessConfig, EvalTask, EvalResult, CandidateManifest, EvaluatorOptions, SuccessCriterion, CriterionResult, StructuredResult, ToolStat)
- **External imports:** `node:crypto`, `node:child_process`, `node:util`, `node:fs/promises`, `node:path`
- **Called by:** meta/cli

### `src/meta/proposer.ts`
- **Layer:** 15
- **Role:** Agentic proposer. Uses Shugu itself (via AgentOrchestrator.spawn()) to propose new harness configurations by analyzing prior candidates.
- **Exports:** `MetaProposer`
- **Internal imports:** `../agents/orchestrator.js` (AgentOrchestrator), `../transport/client.js` (MiniMaxClient), `./archive.js` (MetaArchive), `./types.js` (HarnessConfig, CandidateManifest, ScoredCandidate), `./selector.js` (computeParetoFrontier, rankByWeightedScore), `./config.js` (validateHarnessConfig), `../utils/tracer.js` (tracer)
- **External imports:** `yaml` (parse), `node:fs/promises`, `node:path`
- **Called by:** meta/cli

### `src/meta/config.ts`
- **Layer:** 15
- **Role:** Config loader and validator. Loads HarnessConfig from YAML, validates V1 restrictions (immutable base prompt, immutable zones), rejects shell metacharacters.
- **Exports:** `loadHarnessConfig()`, `validateHarnessConfig()`
- **Internal imports:** `./types.js` (HarnessConfig)
- **External imports:** `node:fs/promises`, `node:path`, `yaml` (parse)
- **Called by:** meta/cli, meta/proposer

### `src/meta/dataset.ts`
- **Layer:** 15
- **Role:** Dataset management. Loads evaluation task suites from YAML and splits into search/holdout sets with deterministic hash-based partitioning.
- **Exports:** `loadDataset()`, `splitDataset()`, `createDefaultDataset()`
- **Internal imports:** `./types.js` (EvalTask, DatasetSplit)
- **External imports:** `node:fs/promises`, `node:crypto`, `yaml` (parse)
- **Called by:** meta/cli

### `src/meta/selector.ts`
- **Layer:** 15
- **Role:** Pareto frontier selection over 5 objectives (accuracy, cost, tokens, turns, errorRate). Standard Pareto dominance with weighted score ranking.
- **Exports:** `computeParetoFrontier()`, `selectParents()`, `rankByWeightedScore()`
- **Internal imports:** `./types.js` (ScoredCandidate)
- **External imports:** (none)
- **Called by:** meta/cli, meta/proposer

### `src/meta/collect.ts`
- **Layer:** 15
- **Role:** Structured query collector. Wraps runLoop() to collect all events and return a StructuredResult. Runs headlessly.
- **Exports:** `runStructuredQuery()`
- **Internal imports:** `../engine/loop.js` (runLoop, LoopEvent), `../engine/interrupts.js` (InterruptController), `../protocol/messages.js` (Message), `../utils/tracer.js` (tracer), `./runtime.js` (MetaRuntime), `./types.js` (StructuredResult, ToolStat)
- **External imports:** (none)
- **Called by:** meta/evaluator

### `src/meta/archive.ts`
- **Layer:** 15
- **Role:** Filesystem archive at ~/.pcc/meta/. Stores candidates, configs, evaluation results, and redacted traces. Structured for proposer agent filesystem access.
- **Exports:** `MetaArchive`
- **Internal imports:** `./types.js` (RunManifest, CandidateManifest, HarnessConfig, EvalResult), `../utils/tracer.js` (TraceEvent)
- **External imports:** `node:fs/promises`, `node:path`, `yaml` (stringify)
- **Called by:** meta/cli, meta/evaluator, meta/proposer

### `src/meta/report.ts`
- **Layer:** 15
- **Role:** Human-readable Markdown report generator for runs, candidates, and config diffs.
- **Exports:** `generateRunReport()`, `generateCandidateReport()`, `generateDiffReport()`
- **Internal imports:** `./types.js` (RunManifest, CandidateManifest, EvalResult, HarnessConfig, ScoredCandidate)
- **External imports:** (none)
- **Called by:** meta/cli

### `src/meta/redact.ts`
- **Layer:** 15
- **Role:** Trace redaction before archival. Sanitizes secrets, credentials, and sensitive paths from messages and trace events. Reuses SECRET_PATTERNS from behavior-hooks.
- **Exports:** `redactMessages()`, `redactTraceEvents()`
- **Internal imports:** `../plugins/builtin/behavior-hooks.js` (SECRET_PATTERNS), `../protocol/messages.js` (Message, ContentBlock), `../utils/tracer.js` (TraceEvent)
- **External imports:** (none)
- **Called by:** meta/evaluator

---

## Module: utils/ (Layer 0 — 8 files)

Shared utility functions. No internal Shugu dependencies (true Layer 0).

### `src/utils/logger.ts`
- **Layer:** 0
- **Role:** Micro file logger. Writes to ~/.pcc/shugu.log with rotation at 1 MB. All methods are fire-and-forget (never throws).
- **Exports:** `logger` (singleton with info, warn, error, debug methods)
- **Internal imports:** (none)
- **External imports:** `node:fs/promises`, `node:os`, `node:path`
- **Called by:** engine/loop, engine/strategy, plugins/hooks, automation/scheduler, automation/obsidian-agent, context/memory/agent, plugins/builtin/verification-hook, entrypoints/bootstrap, entrypoints/repl, entrypoints/prompt-builder

### `src/utils/tracer.ts`
- **Layer:** 0
- **Role:** Structured trace logger. Captures everything: user inputs, model calls, tool calls, agent spawns, errors. Correlation via traceId/spanId. Storage: ~/.pcc/traces/{date}.jsonl. NEVER transmits data online.
- **Exports:** `TraceEventType`, `TraceEvent`, `tracer` (singleton with startTrace, log, endTrace, getRecentEvents, getTraceEvents methods)
- **Internal imports:** (none)
- **External imports:** `node:fs/promises`, `node:path`, `node:os`, `node:crypto`
- **Called by:** engine/loop, engine/strategy, tools/agents/AgentTool, plugins/hooks, commands/trace, meta/runtime, meta/evaluator, meta/proposer, meta/collect, meta/archive, meta/redact, entrypoints/bootstrap, entrypoints/repl

### `src/utils/ansi.ts`
- **Layer:** 0
- **Role:** ANSI escape sequence utilities. visL() returns visible string length after stripping escape codes.
- **Exports:** `visL()`
- **Internal imports:** (none)
- **External imports:** (none)
- **Called by:** ui/banner, ui/statusbar

### `src/utils/fs.ts`
- **Layer:** 0
- **Role:** Filesystem utility. fileExists() checks if a file or directory exists.
- **Exports:** `fileExists()`
- **Internal imports:** (none)
- **External imports:** `node:fs/promises`
- **Called by:** context/workspace/project, commands/init

### `src/utils/git.ts`
- **Layer:** 0
- **Role:** Git command runner and path resolution. git() runs commands, resolveGitRoot() finds repo root, relativeToCwd() computes relative path.
- **Exports:** `git()`, `resolveGitRoot()`, `relativeToCwd()`
- **Internal imports:** (none)
- **External imports:** `node:child_process` (spawn), `node:path`
- **Called by:** agents/orchestrator, agents/worktree, commands/batch, commands/review, meta/evaluator

### `src/utils/strings.ts`
- **Layer:** 0
- **Role:** String utilities. slugify() converts text to URL/filename-safe slugs (max 80 chars).
- **Exports:** `slugify()`
- **Internal imports:** (none)
- **External imports:** (none)
- **Called by:** context/memory/agent, context/memory/obsidian, commands/builtins, skills/bundled/secondbrain

### `src/utils/random.ts`
- **Layer:** 0
- **Role:** Random utilities. pick() selects a random element from a non-empty array.
- **Exports:** `pick()`
- **Internal imports:** (none)
- **External imports:** (none)
- **Called by:** ui/buddy, ui/companion/prompt

### `src/utils/network.ts`
- **Layer:** 0
- **Role:** Shared SSRF protection. `isBlockedUrl()` inspects a URL string and returns a human-readable denial reason if the target resolves to localhost, a loopback address, an RFC1918 private range, IPv6 link-local/loopback, or a cloud metadata endpoint (169.254.169.254, fd00:ec2::/32, etc.). Returns `null` if the URL is safe to fetch.
- **Exports:** `isBlockedUrl()`
- **Internal imports:** (none)
- **External imports:** `node:url` (URL — for parsing)
- **Called by:** plugins/broker, tools/web/WebFetchTool

---

## Module: entrypoints/ (Layer 16 — 8 files)

Top-level entry points that wire everything together. Highest layer — imports from all modules.

### `src/entrypoints/cli.ts`
- **Layer:** 16
- **Role:** Main entry point for `shugu`/`pcc` command. Parses args, bootstraps services, dispatches to single-shot or REPL mode.
- **Exports:** (none — side-effect entry point, calls main())
- **Internal imports:** `./bootstrap.js` (parseArgs, bootstrap), `./single-shot.js` (runSingleQuery), `./repl.js` (runREPL)
- **External imports:** (none)

### `src/entrypoints/bootstrap.ts`
- **Layer:** 16
- **Role:** CLI argument parsing, help text, and full service construction. Builds the RuntimeServices container from CLI args. Wires up client, tools, permissions, credentials, plugins, commands, skills, agents, automation, renderer, companion.
- **Exports:** `CliArgs`, `parseArgs()`, `bootstrap()`
- **Internal imports:** `../protocol/tools.js`, `../protocol/messages.js`, `../transport/client.js`, `../ui/renderer.js`, `../tools/index.js`, `../policy/permissions.js`, `../policy/modes.js`, `../context/session/persistence.js`, `../context/memory/agent.js`, `../context/memory/obsidian.js`, `../credentials/vault.js`, `../credentials/provider.js`, `../credentials/errors.js`, `../credentials/prompt.js`, `../skills/index.js`, `../plugins/registry.js`, `../automation/background.js`, `../automation/scheduler.js`, `../commands/automation.js`, `../commands/team.js`, `../commands/vault.js`, `../commands/index.js`, `../commands/review.js`, `../commands/batch.js`, `../meta/cli.js`, `../plugins/builtin/behavior-hooks.js`, `../plugins/builtin/verification-hook.js`, `../agents/orchestrator.js`, `../integrations/discovery.js`, `../engine/loop.js`, `../ui/banner.js`, `../ui/companion/index.js`, `../automation/kairos.js`, `../utils/logger.js`, `../utils/tracer.js`, `./prompt-builder.js`, `./services.js`, `./cli-handlers.js`
- **External imports:** (none)
- **Called by:** entrypoints/cli

### `src/entrypoints/repl.ts`
- **Layer:** 16
- **Role:** Interactive REPL loop. Manages conversation state, delegates to commands and the agentic loop, handles token tracking, compaction, strategy analysis, and intelligence.
- **Exports:** `runREPL()`
- **Internal imports:** `../protocol/messages.js`, `../engine/loop.js`, `../engine/interrupts.js`, `../engine/budget.js`, `../context/tokenBudget.js`, `../context/compactor.js`, `../protocol/tools.js`, `../commands/index.js`, `../skills/index.js`, `../context/workspace/git.js`, `../ui/banner.js`, `../transport/client.js`, `../engine/strategy.js`, `../engine/intelligence.js`, `../utils/logger.js`, `../utils/tracer.js`, `./services.js`, `./cli-handlers.js`, `./repl-commands.js`, `./prompt-builder.js`
- **External imports:** (none)
- **Called by:** entrypoints/cli

### `src/entrypoints/single-shot.ts`
- **Layer:** 16
- **Role:** Single-shot query runner. Executes one prompt through the agentic loop and exits.
- **Exports:** `runSingleQuery()`
- **Internal imports:** `../engine/loop.js` (runLoop, LoopConfig), `../engine/interrupts.js` (InterruptController), `../protocol/messages.js` (Message), `./cli-handlers.js` (handleEvent), `./services.js` (RuntimeServices)
- **External imports:** (none)
- **Called by:** entrypoints/cli

### `src/entrypoints/services.ts`
- **Layer:** 16
- **Role:** RuntimeServices interface. Single container for all 15+ services (client, registry, toolContext, permResolver, hookRegistry, skillRegistry, commands, sessionMgr, bgManager, scheduler, memoryAgent, obsidianVault, credentialProvider, kairos, renderer).
- **Exports:** `RuntimeServices`
- **Internal imports:** Type-only imports from `../transport/client.js`, `../tools/registry.js`, `../protocol/tools.js`, `../policy/permissions.js`, `../plugins/hooks.js`, `../skills/index.js`, `../commands/registry.js`, `../context/session/persistence.js`, `../automation/background.js`, `../automation/scheduler.js`, `../context/memory/agent.js`, `../context/memory/obsidian.js`, `../credentials/provider.js`, `../automation/kairos.js`, `../ui/renderer.js`
- **External imports:** (none)
- **Called by:** entrypoints/bootstrap, entrypoints/repl, entrypoints/single-shot, entrypoints/cli-handlers

### `src/entrypoints/prompt-builder.ts`
- **Layer:** 16
- **Role:** System prompt assembly. Builds the static base prompt (~2K tokens) and dynamic context sections (git, project, tools, skills, companion, memory, vault).
- **Exports:** `BASE_SYSTEM_PROMPT`, `PromptBuildResult`, `buildSystemPrompt()`, `buildVolatilePromptParts()`
- **Internal imports:** `../context/workspace/git.js`, `../context/workspace/project.js`, `../context/memory/obsidian.js`, `../context/memory/agent.js`, `../integrations/discovery.js`, `../integrations/adapter.js`, `../skills/index.js`, `../ui/companion/index.js`, `../utils/logger.js`
- **External imports:** (none)
- **Called by:** entrypoints/bootstrap, entrypoints/repl, meta/runtime

### `src/entrypoints/repl-commands.ts`
- **Layer:** 16
- **Role:** Inline REPL commands that need direct state access (companion, budget, tokens, mode, compaction, thinking toggle, session resume). Cannot go through generic CommandRegistry.
- **Exports:** `ReplState`, `handleInlineCommand()`
- **Internal imports:** `../ui/FullApp.js` (AppHandle), `../engine/budget.js` (BudgetTracker), `../context/tokenBudget.js` (TokenBudgetTracker), `../ui/renderer.js` (TerminalRenderer), `../policy/permissions.js` (PermissionResolver), `../protocol/tools.js` (PermissionMode), `../protocol/messages.js` (Message), `../context/session/persistence.js` (SessionData, SessionManager), `../policy/modes.js` (MODE_DESCRIPTIONS), `../context/compactor.js` (compactConversation), `../transport/client.js` (MiniMaxClient), `./cli-handlers.js` (getCompanionInstance, setCompanionMuted, formatTimeAgo)
- **External imports:** (none)
- **Called by:** entrypoints/repl

### `src/entrypoints/cli-handlers.ts`
- **Layer:** 16
- **Role:** Converts LoopEvents into UI actions for both TerminalRenderer and Ink AppHandle. Manages companion singleton.
- **Exports:** `getCompanionInstance()`, `setCompanionMuted()`, `isCompanionMuted()`, `handleEvent()`, `handleEventForApp()`, `extractToolDetail()`, `formatTimeAgo()`
- **Internal imports:** `../engine/loop.js` (LoopEvent), `../ui/renderer.js` (TerminalRenderer), `../ui/FullApp.js` (AppHandle), `../protocol/messages.js` (ContentBlock, isTextBlock, isThinkingBlock, isToolUseBlock), `../engine/budget.js` (BudgetTracker), `../ui/companion/index.js` (getCompanion, Companion)
- **External imports:** (none)
- **Called by:** entrypoints/repl, entrypoints/single-shot, entrypoints/repl-commands

---

## Root (Layer 0 — 1 file)

### `src/brand.ts`
- **Layer:** 0
- **Role:** Brand constants. Single source of truth for project identity: name ("Shugu"), CLI name ("shugu"), package name, config dir (.pcc), version (0.2.0), provider (MiniMax).
- **Exports:** `BRAND` (const object)
- **Internal imports:** (none)
- **External imports:** (none)
- **Called by:** entrypoints/bootstrap (indirectly for version display)

---

## Layer Summary

| Layer | Module(s) | Files | Description |
|-------|-----------|-------|-------------|
| 0 | protocol/, utils/, brand | 16 | Types, shared utilities (incl. SSRF protection), brand constants |
| 1 | transport/ | 5 | Network layer — sole MiniMax contact point |
| 2 | engine/ | 8 | Agentic loop, turns, budget, interrupts, strategy, intelligence, reflection |
| 3 | tools/ | 16 | Tool implementations (Bash, files, search, web, agents, tasks, REPL, sleep, Obsidian) |
| 4 | policy/, credentials/ | 12 | Permission enforcement, encrypted credential vault |
| 5 | context/ | 11 | Token budgets, compaction, memory stores, session persistence, workspace detection |
| 6 | integrations/ | 3 | CLI discovery and adapter hints |
| 7 | commands/ | 12 | Slash command system |
| 8 | agents/ | 5 | Sub-agent orchestration, delegation, teams, worktrees |
| 9 | automation/ | 8 | Background sessions, scheduling, daemon, proactive loops, triggers |
| 10 | remote/ | 3 | WebSocket gateway, SSH execution |
| 11 | ui/ | 23 | Terminal UI (Ink components, ANSI renderer, companion, highlighting, markdown) |
| 12 | voice/ | 2 | Push-to-talk voice input |
| 13 | skills/ | 9 | Domain-specific workflows (vibe, dream, hunter, loop, schedule, secondbrain) |
| 14 | plugins/ | 11 | Plugin system: hooks, brokered isolation (Docker/Node), capability broker, policy |
| 15 | meta/ | 12 | Meta-Harness outer-loop optimizer |
| 16 | entrypoints/ | 8 | CLI, bootstrap, REPL, services wiring |
| **Total** | **19 modules** | **165** | |

## Dependency Graph (simplified)

```
entrypoints (16)
  ├── meta (15)
  │     ├── agents (8)
  │     ├── plugins (14)
  │     └── engine (2)
  ├── plugins (14)
  │     ├── skills (13)
  │     ├── commands (7)
  │     └── hooks → protocol (0)
  ├── commands (7)
  │     ├── agents (8)
  │     ├── credentials (4)
  │     └── context (5)
  ├── ui (11)
  │     └── utils (0)
  ├── automation (9)
  │     └── engine (2)
  ├── skills (13)
  │     ├── automation (9)
  │     └── context (5)
  ├── context (5)
  │     ├── transport (1)
  │     └── protocol (0)
  ├── tools (3)
  │     ├── policy (4)
  │     ├── credentials (4)
  │     └── protocol (0)
  ├── integrations (6)
  ├── engine (2)
  │     ├── transport (1)
  │     └── protocol (0)
  ├── transport (1)
  │     └── protocol (0)
  └── protocol (0) + utils (0) + brand (0)
```

---

## Test Suite (`tests/` — 51 files)

All tests run with Vitest. Integration tests use real emitters and consumers; mocking is limited to network boundaries.

### Plugin System Tests

| File | What it covers |
|------|----------------|
| `tests/plugin-protocol.test.ts` | JSON-RPC message serialization and round-trip validation for all IPC method types |
| `tests/plugin-broker.test.ts` | `CapabilityBroker`: path validation (allowlist, traversal rejection), SSRF blocking, deny-by-default |
| `tests/plugin-host.test.ts` | `PluginHost`: IPC handshake, tool/hook registration, invoke routing, child crash handling, graceful shutdown |
| `tests/plugin-brokered-e2e.test.ts` | End-to-end brokered plugin flow: real plugin loaded into a real child process, tool invocation, capability broker round-trip |
| `tests/plugin-sandbox-os.test.ts` | `buildPermissionFlags()` and `buildDockerArgs()`: correct `--permission` flag construction for Node fallback mode |
| `tests/plugin-policy.test.ts` | `loadPolicy()` and `resolvePluginConfig()`: YAML parsing, manifest merging, deny-by-default for missing policies |
| `tests/plugin-integration.test.ts` | Full `PluginRegistry.loadAll()` → tool execution → `PluginRegistry.unloadAll()` integration path |

### Security Tests

| File | What it covers |
|------|----------------|
| `tests/security-audit-gaps.test.ts` | 9 targeted security validations: env stripping in BashTool, SSRF blocking in WebFetch and broker, TriggerServer malformed-JSON rejection (400), scheduler AbortSignal propagation, hook fail-closed on crash (PreToolUse), vault atomic write, credential file permissions (0o600), and `redactSensitive()` for in-memory trace redaction |

### Core + Integration Tests

| File | What it covers |
|------|----------------|
| `tests/protocol.test.ts` | Protocol type guards and message helpers |
| `tests/budget.test.ts` | BudgetTracker cost calculation, M2.7 pricing |
| `tests/interrupts.test.ts` | InterruptController abort/pause/resume |
| `tests/permissions.test.ts` | PermissionResolver: mode matrix, rule evaluation, classifier integration |
| `tests/classifier-evasion.test.ts` | Bash risk classifier against evasion patterns |
| `tests/tools-registry.test.ts` | ToolRegistryImpl register/get/definitions |
| `tests/tool-router.test.ts` | Tool call routing and parallel/serial execution partitioning |
| `tests/skills.test.ts` | SkillRegistry load, match, bundled skill triggers |
| `tests/commands.test.ts` | CommandRegistry dispatch, builtin commands |
| `tests/hooks.test.ts` | HookRegistry: 7 hook types, modification, blocking |
| `tests/scheduler.test.ts` | Cron scheduler: add, remove, fire, AbortSignal |
| `tests/transport-errors.test.ts` | Retry logic, error classification, model fallback |
| `tests/minimax-reasoning.test.ts` | Reasoning split parsing and accumulation |
| `tests/model-routing.test.ts` | Model alias resolution and fallback chain |
| `tests/vault.test.ts` | CredentialVault AES-256-GCM encrypt/decrypt, atomic write |
| `tests/credential-domain.test.ts` | CredentialProvider domain matching |
| `tests/workspace.test.ts` | Project context detection |
| `tests/project-context.test.ts` | CLAUDE.md loading and instruction merge |
| `tests/vault-discovery.test.ts` | Obsidian vault auto-discovery priority order |
| `tests/obsidian-boundary.test.ts` | Obsidian path traversal protection |
| `tests/search-boundary.test.ts` | GrepTool/GlobTool workspace boundary enforcement |
| `tests/permission-gating.test.ts` | End-to-end permission gate across all 5 modes |
| `tests/plugin-trust.test.ts` | Plugin trust prompting and builtin protection |
| `tests/agent-depth.test.ts` | Sub-agent depth limits and budget propagation |
| `tests/agent-teams.test.ts` | AgentTeam named configurations |
| `tests/worktree-integration.test.ts` | Git worktree create/remove |
| `tests/batch-command.test.ts` | /batch parallel execution |
| `tests/compaction-failure.test.ts` | Compaction fallback when LLM summary fails |
| `tests/tool-result-pairing.test.ts` | tool_use / tool_result turn pairing validation |
| `tests/session-features.test.ts` | Session save/load/resume |
| `tests/repl-history.test.ts` | REPL input history |
| `tests/meta-config.test.ts` | HarnessConfig YAML load and validation |
| `tests/meta-dataset.test.ts` | Dataset load and search/holdout split |
| `tests/meta-selector.test.ts` | Pareto frontier and weighted score ranking |
| `tests/meta-redact.test.ts` | Secret redaction from traces and messages |
| `tests/review-command.test.ts` | /review git error surfacing |
| `tests/retry-command.test.ts` | /retry last-turn re-execution |
| `tests/work-context.test.ts` | Work context preservation across /resume |
| `tests/markdown.test.ts` | Markdown renderer output |
| `tests/markdown-loaders.test.ts` | Markdown file parsing utilities |
| `tests/parsers.test.ts` | Content parser correctness |
| `tests/highlight.test.ts` | Syntax highlighting for supported languages |
| `tests/file-tags.test.ts` | File tag extraction and indexing |
