# Architecture Analysis: Project CC (Shugu)

## Overview

Project CC is a **14-layer, mono-provider CLI agent** built as a clean-room reimplementation of Claude Code targeting MiniMax M2.7. The architecture follows a strict **layered dependency graph** where each layer only imports from lower layers, with Layer 0 (Protocol) having zero dependencies. This contrasts sharply with its reference codebase (OpenClaude, ~487K lines) which is a monolith with 89 feature flags and 344 user-type gates.

The core insight: **a sub-agent is not a process — it's a nested `runLoop()` call**. This single decision eliminates React, IPC, process management, and most of the original's complexity.

**9,707 lines of TypeScript. 70 files. 14 tools. 5 agent types. 0 feature flags.**

---

## Primary Patterns Identified

### 1. Strict Layered Architecture (Dependency Inversion)

**What it is**: Each module belongs to a numbered layer. A layer may only import from layers with a lower number. Layer 0 has zero runtime imports.

**Where it's used**: Every `index.ts` barrel export is annotated with its layer number. Every file's JSDoc header declares its layer.

**Why it's used**: The original codebase suffers from circular dependencies and deep coupling between API transport, React UI, and tool execution. This layered approach ensures that `protocol/` types can be used anywhere without pulling in HTTP clients or UI frameworks.

```
Layer 0:  protocol/       ← ZERO dependencies (pure types)
Layer 1:  transport/      ← protocol/
Layer 2:  engine/         ← protocol/, transport/
Layer 3:  tools/          ← protocol/, engine/ (NOT transport!)
Layer 4:  policy/         ← protocol/, tools/
Layer 5:  context/        ← protocol/, engine/
Layer 6:  integrations/   ← protocol/, tools/
Layer 7:  commands/       ← protocol/, engine/, tools/, context/, integrations/
Layer 8:  agents/         ← engine/, tools/, policy/, context/
Layer 10: remote/         ← engine/, context/
Layer 11: ui/             ← protocol/, engine/
Layer 12: voice/          ← engine/
```

**Critical rule**: Tools (Layer 3) never import from Transport (Layer 1). They speak the Protocol types, and the Engine mediates. This means swapping MiniMax for another provider only changes `transport/client.ts`.

```
┌─────────────┐
│  Protocol   │ ← Pure types, zero deps
├─────────────┤
│  Transport  │ ← Only layer that knows MiniMax
├─────────────┤
│   Engine    │ ← Agentic loop, agnostic to provider
├─────────────┤
│   Tools     │ ← Never see the network
├─────────────┤
│   Policy    │ ← Permission decisions
├─────────────┤
│  Context    │ ← Memory, sessions, workspace
├─────────────┤
│ Integrations│ ← CLI discovery (no MCP)
├─────────────┤
│  Commands   │ ← Slash commands
├─────────────┤
│   Agents    │ ← Multi-agent orchestration
├─────────────┤
│  Remote     │ ← SSH/VPS, session gateway
├─────────────┤
│    UI       │ ← Terminal rendering
├─────────────┤
│   Voice     │ ← Audio capture
├─────────────┤
│ Credentials │ ← Encrypted vault (cross-cutting)
├─────────────┤
│ Entrypoints │ ← CLI main (wires everything)
└─────────────┘
```

---

### 2. AsyncGenerator Event Stream (Observer Pattern)

**What it is**: The agentic loop (`engine/loop.ts`) is an `AsyncGenerator<LoopEvent>` that yields typed events at each step. Consumers (UI, session persistence, budget tracking) observe without coupling.

**Where it's used**: `runLoop()` in `engine/loop.ts`, consumed by `cli.ts` and `agents/orchestrator.ts`

**Why it's used**: The original uses React hooks and mutable state (`AppState.tsx`) to coordinate between the query loop and UI. AsyncGenerator provides the same observability with zero framework dependency.

```typescript
// engine/loop.ts — the core pattern
export async function* runLoop(
  initialMessages: Message[],
  config: LoopConfig,
  interrupt: InterruptController,
): AsyncGenerator<LoopEvent> {
  while (true) {
    yield { type: 'turn_start', turnIndex };
    // ... stream, accumulate ...
    yield { type: 'assistant_message', message };
    // ... execute tools ...
    yield { type: 'tool_result', result };
    yield { type: 'turn_end', turnIndex, usage };
    yield { type: 'loop_end', reason, totalUsage, totalCost };
  }
}
```

```
                    ┌──────────────┐
                    │   runLoop()  │ AsyncGenerator<LoopEvent>
                    └──────┬───────┘
                           │ yields events
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │   CLI    │ │  Budget  │ │ Session  │
        │ renderer │ │ tracker  │ │  saver   │
        └──────────┘ └──────────┘ └──────────┘
```

---

### 3. Strategy Pattern (Tool System)

**What it is**: Every tool implements the `Tool` interface from `protocol/tools.ts`. The registry stores them by name. The executor dispatches calls without knowing implementations.

**Where it's used**: `tools/registry.ts`, `tools/executor.ts`, every `*Tool.ts` file

```typescript
// protocol/tools.ts — the contract
export interface Tool {
  definition: ToolDefinition;
  execute(call: ToolCall, context: ToolContext): Promise<ToolResult>;
  validateInput?(input: Record<string, unknown>): string | null;
}
```

```
┌────────────┐     ┌──────────────┐     ┌──────────┐
│   Engine   │────▶│   Registry   │────▶│ BashTool │
│ (executor) │     │  (Map<Tool>) │     │ ReadTool │
└────────────┘     └──────────────┘     │ EditTool │
                                        │  ...×14  │
                                        └──────────┘
```

---

### 4. Chain of Responsibility (Permission System)

**What it is**: Permission resolution follows a priority chain: builtin deny rules → user rules → risk classifier → mode default matrix. First match wins.

```
Request ──▶ Builtin Deny ──▶ User Rules ──▶ Classifier ──▶ Mode Default
  │              │                │              │              │
  │          [deny]           [match]        [low=allow]    [matrix]
  ▼              ▼                ▼              ▼              ▼
              BLOCKED          MATCHED       CLASSIFIED      DEFAULT
```

---

### 5. Recursive Composition (Multi-Agent)

**What it is**: A sub-agent is a nested `runLoop()` call with its own conversation, budget, and restricted tool set. No process spawning, no IPC.

```
┌─────────────────────────────────┐
│        Parent runLoop()          │
│  ┌───────────────────────────┐  │
│  │  AgentTool.execute()      │  │
│  │  ┌─────────────────────┐  │  │
│  │  │  Child runLoop()    │  │  │
│  │  │  (own conversation) │  │  │
│  │  │  (own budget)       │  │  │
│  │  │  (restricted tools) │  │  │
│  │  └─────────────────────┘  │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

---

### 6. Adapter Pattern (CLI-first Integrations)

```
MCP approach (rejected):                    CLI-first approach (adopted):
┌──────────┐  JSON-RPC  ┌──────────┐       ┌──────────┐  hint   ┌──────────┐
│  Model   │──────────▶│MCP Server│       │  Model   │───────▶│ BashTool │
│(+1300 tok│  per turn  │  (proc)  │       │(+150 tok)│  once   │  (exec)  │
│ per srv) │           └──────────┘       │          │        └──────────┘
└──────────┘                               └──────────┘
```

---

## Request Data Flow (Complete Trace)

```
User types: "List all TODO comments in src/"
    │
    ▼
[cli.ts] Parse input → not a /command → add to conversation
    │
    ▼
[cli.ts] buildSystemPrompt() → workspace + CLI hints + memories
    │
    ▼
[tokenBudget.ts] Context at 15% of 204.8K → OK, no compaction
    │
    ▼
[loop.ts] runLoop() starts → yield turn_start
    │
    ▼
[client.ts] POST api.minimax.io/anthropic/v1/messages
            {messages, tools: 14 defs, reasoning_split:true, temp:1.0}
    │
    ▼
[stream.ts] SSE: thinking_delta... → tool_use(Grep) → input_json_delta
    │
    ▼
[turns.ts] stop_reason:"tool_use" → toolCalls:[{Grep, {pattern:"TODO"}}]
    │
    ▼
[permissions.ts] Grep → category:"read" → mode:"default" → ALLOW
    │
    ▼
[executor.ts] GrepTool → spawns `rg TODO src/` → results
    │
    ▼
[turns.ts] buildToolResultMessage() → append to messages
    │
    ▼
[loop.ts] LOOP BACK → second request with tool results
    │
    ▼
[stream.ts] text_delta... → stop_reason:"end_turn"
    │
    ▼
[loop.ts] yield loop_end → generator completes
    │
    ▼
[cli.ts] Render + brew timer + save session
```

---

## Design Decisions

| Decision | Why |
|----------|-----|
| **Anthropic-compat transport** | MiniMax speaks Anthropic natively. The OpenAI shim (800 lines) was a lossy converter that stripped thinking blocks. |
| **No React/Ink** | 800 lines ANSI vs 40K lines React. No virtual DOM for a CLI. |
| **Nested loops for agents** | `runLoop()` already has everything a sub-agent needs. Processes would add IPC for no benefit. |
| **CLI-first over MCP** | MCP = 1300 tokens/server/turn. CLI hints = 150 tokens once. Same success rate in benchmarks. |
| **AES-256-GCM vault** | Same as 1Password. PBKDF2 100K iterations. Credentials never in LLM context. |
| **Pattern-based risk classifier** | 0ms vs ~500ms for LLM-based classification. Deterministic. Built-in deny rules as safety net. |

---

## Strengths

- **Testability**: Each layer testable in isolation — protocol has zero deps
- **Swappability**: Changing LLM provider only touches 5 files in `transport/`
- **No feature flags**: Everything always on. Zero gating complexity.
- **9.7K lines replaces 487K lines** by eliminating multi-provider, React, analytics, telemetry, OAuth, GrowthBook, and feature gating
- **Security**: Credentials never enter LLM context

## Trade-offs

- **No real-time token streaming to UI** (accumulates full response first)
- **No structured output validation** at engine level (each tool validates its own input)
- **Single-threaded tools** (mitigated by VPS/SSH for heavy work)
- **Pattern-based classifier** may miss novel dangerous commands (mitigated by built-in deny rules)
