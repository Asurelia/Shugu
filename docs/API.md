# Project CC (Shugu) — API Reference

This document covers the public API for every module in the Shugu TypeScript SDK. It is intended for developers who want to extend the system, embed it in another application, or use individual layers as libraries.

**Package name:** `project-cc`  
**Version:** 0.1.0  
**Runtime:** Node.js >= 20.0.0 (ESM only)  
**Primary model:** MiniMax M2.7-highspeed (Anthropic Messages API-compatible)

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Module: protocol](#module-protocol)
3. [Module: transport](#module-transport)
4. [Module: engine](#module-engine)
5. [Module: tools](#module-tools)
6. [Module: policy](#module-policy)
7. [Module: context](#module-context)
8. [Module: agents](#module-agents)
9. [Module: credentials](#module-credentials)
10. [Module: commands](#module-commands)
11. [Module: remote](#module-remote)
12. [Module: voice](#module-voice)
13. [Environment Variables](#environment-variables)
14. [Common Patterns](#common-patterns)
15. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

The codebase is organized into numbered layers. Each layer depends only on layers below it. The numbers in the source comments are not import paths — they describe the dependency order.

```
Layer 0  protocol    — Core types shared by all layers
Layer 1  transport   — HTTP client for MiniMax API
Layer 2  engine      — Agentic loop, budget, interrupts
Layer 3  tools       — Tool implementations and registry
Layer 4  policy      — Permission resolution and risk classification
Layer 5  context     — Token budget, compaction, memory, sessions
Layer 7  commands    — Slash command registry
Layer 8  agents      — Sub-agent orchestration and delegation
Layer 10 remote      — SSH execution and session gateway
Layer 12 voice       — Audio capture and transcription
```

**Import paths** all follow this pattern:

```typescript
import { MiniMaxClient } from 'project-cc/src/transport/index.js';
import { runLoop } from 'project-cc/src/engine/index.js';
```

---

## Module: protocol

**Source:** `src/protocol/index.ts`  
Re-exports from: `messages.ts`, `tools.ts`, `events.ts`, `thinking.ts`, `session.ts`, `actions.ts`

This is the lowest layer. All other modules import from here. No external dependencies.

---

### Messages (`protocol/messages.ts`)

#### `Role`

```typescript
type Role = 'user' | 'assistant';
```

#### Content block types

| Type | Description |
|------|-------------|
| `TextBlock` | Plain text content. Has `type: 'text'` and `text: string`. |
| `ImageBlock` | Image content. Source can be `base64` or `url`. |
| `ToolUseBlock` | A tool call from the assistant. Has `id`, `name`, and `input`. |
| `ToolResultBlock` | The result of a tool call. Has `tool_use_id`, `content`, and optional `is_error`. |
| `ThinkingBlock` | Exposed reasoning from MiniMax. Has `thinking: string` and optional `signature`. |
| `RedactedThinkingBlock` | Opaque reasoning data. Has `data: string`. |

```typescript
type ContentBlock =
  | TextBlock
  | ImageBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | RedactedThinkingBlock;
```

#### `UserMessage` / `AssistantMessage`

```typescript
interface UserMessage {
  role: 'user';
  content: string | ContentBlock[];
}

interface AssistantMessage {
  role: 'assistant';
  content: ContentBlock[];
}

type Message = UserMessage | AssistantMessage;
```

#### `SystemPrompt`

```typescript
type SystemPrompt = string | SystemPromptBlock[];

interface SystemPromptBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}
```

Use the array form to enable prompt caching.

#### `Usage`

```typescript
interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}
```

#### `StopReason`

```typescript
type StopReason =
  | 'end_turn'      // Model finished naturally
  | 'tool_use'      // Model wants to call a tool
  | 'max_tokens'    // Hit output token limit
  | 'stop_sequence' // Hit a stop sequence
  | null;           // Stream still in progress
```

#### `Conversation`

```typescript
interface Conversation {
  id: string;
  messages: Message[];
  systemPrompt: SystemPrompt;
  model: string;
  createdAt: Date;
  updatedAt: Date;
  totalUsage: Usage;
}
```

#### Helper functions

```typescript
// Type guards
function isToolUseBlock(block: ContentBlock): block is ToolUseBlock
function isTextBlock(block: ContentBlock): block is TextBlock
function isThinkingBlock(block: ContentBlock): block is ThinkingBlock
function isToolResultBlock(block: ContentBlock): block is ToolResultBlock

// Extraction utilities
function getTextContent(message: Message): string
function getToolUseBlocks(message: AssistantMessage): ToolUseBlock[]
```

**Example:**

```typescript
import { getTextContent, getToolUseBlocks, isTextBlock } from './src/protocol/index.js';

const text = getTextContent(assistantMessage);
const toolCalls = getToolUseBlocks(assistantMessage);
```

---

### Tools (`protocol/tools.ts`)

Defines the contract between the engine and every tool implementation.

#### `ToolDefinition`

```typescript
interface ToolDefinition {
  name: string;             // Unique tool name, e.g. "Bash"
  description: string;      // Shown to the model
  inputSchema: ToolInputSchema;
  concurrencySafe?: boolean; // If true, can run in parallel with other tools
  deferLoading?: boolean;    // For lazy tool registration
}

interface ToolInputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}
```

#### `Tool`

The interface every tool must implement.

```typescript
interface Tool {
  definition: ToolDefinition;
  execute(call: ToolCall, context: ToolContext): Promise<ToolResult>;
  validateInput?(input: Record<string, unknown>): string | null;
}
```

`validateInput` is optional. Return `null` if valid, or an error string if not.

#### `ToolCall` / `ToolResult`

```typescript
interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResult {
  tool_use_id: string;
  content: string | ToolResultContent[];
  is_error?: boolean;
}

interface ToolResultContent {
  type: 'text' | 'image';
  text?: string;
  source?: { type: 'base64'; media_type: string; data: string };
}
```

#### `ToolContext`

Passed to every `tool.execute()` call. Tools use this to respect cancellation and ask for permissions.

```typescript
interface ToolContext {
  cwd: string;
  abortSignal: AbortSignal;
  permissionMode: PermissionMode;
  askPermission: (tool: string, action: string) => Promise<boolean>;
  onProgress?: (progress: ToolProgress) => void;
}

type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'fullAuto' | 'bypass';

interface ToolProgress {
  type: 'stdout' | 'stderr' | 'status' | 'file';
  content: string;
}
```

#### `ToolRegistry`

```typescript
interface ToolRegistry {
  getAll(): Tool[];
  get(name: string): Tool | undefined;
  register(tool: Tool): void;
  getDefinitions(): ToolDefinition[];
}
```

---

### Events (`protocol/events.ts`)

SSE stream events emitted during a streaming response.

#### `StreamEvent` (union)

```typescript
type StreamEvent =
  | MessageStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageDeltaEvent
  | MessageStopEvent;
```

Key types:

```typescript
interface MessageStartEvent {
  type: 'message_start';
  message: { id: string; model: string; usage: Usage };
}

interface ContentBlockDeltaEvent {
  type: 'content_block_delta';
  index: number;
  delta: ContentDelta;
}

type ContentDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'input_json_delta'; partial_json: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'signature_delta'; signature: string };
```

#### `StreamAccumulator`

Internal state used by `accumulateStream()` to reconstruct complete blocks from deltas.

```typescript
interface StreamAccumulator {
  messageId: string;
  model: string;
  contentBlocks: AccumulatingBlock[];
  stopReason: StopReason;
  usage: Usage;
}

function createEmptyAccumulator(): StreamAccumulator
```

---

### Thinking (`protocol/thinking.ts`)

MiniMax M2.7 has mandatory reasoning. This module documents that behavior and provides helper types.

```typescript
interface ThinkingConfig {
  showThinking: boolean;    // Maps to reasoning_split in the MiniMax request
  budgetTokens?: number;    // Client-side tracking only; not enforced server-side
}

const DEFAULT_THINKING_CONFIG: ThinkingConfig = { showThinking: true };
```

> **MiniMax note:** Reasoning is always active. `reasoning_split: true` controls whether thinking blocks are exposed in the response. The field in streaming deltas is `.text`, not `.content`.

```typescript
interface MiniMaxReasoningDetail {
  type: 'reasoning.text';
  id: string;
  text: string;  // Use .text, not .content
}

interface ReasoningAccumulator {
  details: MiniMaxReasoningDetail[];
  fullText: string;
}

function createReasoningAccumulator(): ReasoningAccumulator
function appendReasoningDelta(
  acc: ReasoningAccumulator,
  detail: MiniMaxReasoningDetail,
): ReasoningAccumulator
```

---

### Session (`protocol/session.ts`)

Types for session lifecycle tracking.

```typescript
interface Session {
  id: string;
  projectDir: string;
  messages: Message[];
  turns: Turn[];
  createdAt: Date;
  updatedAt: Date;
  totalUsage: Usage;
  metadata: SessionMetadata;
}

interface SessionMetadata {
  model: string;
  version: string;
  resumedFrom?: string;
  tags?: string[];
}

interface Turn {
  id: string;
  index: number;
  userMessage: Message;
  assistantMessage: Message;
  toolCalls: TurnToolCall[];
  usage: Usage;
  durationMs: number;
  timestamp: Date;
}

interface TurnToolCall {
  toolName: string;
  toolId: string;
  input: Record<string, unknown>;
  result: string;
  isError: boolean;
  durationMs: number;
}

type SessionState =
  | 'idle' | 'streaming' | 'tool_executing'
  | 'compacting' | 'paused' | 'error' | 'done';
```

---

### Actions (`protocol/actions.ts`)

Audit trail types for tracking who triggered each action.

```typescript
enum ActionTriggerBy {
  User = 1,
  Agent = 2,
  System = 3,
}

interface ActionRecord {
  id: string;
  type: ActionType;
  triggeredBy: ActionTriggerBy;
  toolName?: string;
  input?: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  timestamp: Date;
  durationMs?: number;
}

type ActionType =
  | 'tool_call' | 'file_read' | 'file_write' | 'file_delete'
  | 'command_exec' | 'mcp_call' | 'agent_spawn'
  | 'permission_ask' | 'permission_grant' | 'permission_deny'
  | 'compact' | 'session_resume' | 'custom';
```

---

## Module: transport

**Source:** `src/transport/index.ts`

Handles all HTTP communication with the MiniMax API. The rest of the system never calls MiniMax directly.

---

### `MiniMaxClient`

The single network entry point for the entire system.

#### Constructor

```typescript
new MiniMaxClient(config?: ClientConfig)
```

```typescript
interface ClientConfig {
  model?: string;           // Default: 'MiniMax-M2.7-highspeed'
  maxTokens?: number;       // Default: 16384
  temperature?: number;     // Default: 1.0. MiniMax requires > 0; values <= 0 are clamped to 0.01.
  thinkingConfig?: ThinkingConfig;
  retryConfig?: RetryConfig;
  timeoutMs?: number;       // Default: 600000 (10 minutes)
  abortSignal?: AbortSignal;
}
```

Authentication is resolved automatically from environment variables (see [Environment Variables](#environment-variables)). Do not pass the API key to the constructor.

#### `client.stream()`

```typescript
async *stream(
  messages: Message[],
  options?: StreamOptions,
): AsyncGenerator<StreamEvent>
```

```typescript
interface StreamOptions {
  model?: string;
  maxTokens?: number;
  systemPrompt?: SystemPrompt;
  tools?: ToolDefinition[];
  abortSignal?: AbortSignal;
}
```

Streams raw SSE events. Use `accumulateStream()` to build a complete `AssistantMessage` from these.

#### `client.complete()`

```typescript
async complete(
  messages: Message[],
  options?: StreamOptions & { callbacks?: StreamCallbacks },
): Promise<AccumulatedResponse>
```

Convenience wrapper that calls `stream()` and accumulates the full response. Use this for simple single-turn queries.

```typescript
interface AccumulatedResponse {
  messageId: string;
  model: string;
  message: AssistantMessage;
  stopReason: string | null;
  usage: Usage;
}
```

#### Getters

```typescript
get model(): string   // The configured model name
get baseUrl(): string // The resolved API base URL
```

**Example — single-turn query:**

```typescript
import { MiniMaxClient } from './src/transport/index.js';

const client = new MiniMaxClient({ model: 'MiniMax-M2.7-highspeed' });

const response = await client.complete([
  { role: 'user', content: 'What is 2 + 2?' },
]);

console.log(response.message.content[0]); // TextBlock
```

**Example — streaming with deltas:**

```typescript
for await (const event of client.stream(messages)) {
  if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
    process.stdout.write(event.delta.text);
  }
}
```

---

### `MINIMAX_MODELS` / `DEFAULT_MODEL`

```typescript
const MINIMAX_MODELS = {
  'best':     'MiniMax-M2.7-highspeed',  // 204K context, $0.30/$1.10 per M tokens
  'balanced': 'MiniMax-M2.7',
  'fast':     'MiniMax-M2.5-highspeed',
} as const;

const DEFAULT_MODEL = MINIMAX_MODELS.best;
```

---

### `resolveAuth()`

```typescript
function resolveAuth(): AuthConfig

interface AuthConfig {
  apiKey: string;
  baseUrl: string;
}
```

Resolves credentials from the environment. Priority order:

1. `MINIMAX_API_KEY`
2. `ANTHROPIC_AUTH_TOKEN`
3. `ANTHROPIC_API_KEY`

Base URL priority:

1. `MINIMAX_BASE_URL`
2. `ANTHROPIC_BASE_URL`
3. `https://api.minimax.io/anthropic/v1` (default)

Throws if no key is found.

---

### Stream utilities

#### `parseSSEStream()`

```typescript
async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  abortSignal?: AbortSignal,
): AsyncGenerator<StreamEvent>
```

Parses a raw SSE `ReadableStream` into typed `StreamEvent` objects. Handles MiniMax's `reasoning_details` quirks internally. Terminates on `data: [DONE]`.

#### `accumulateStream()`

```typescript
async function accumulateStream(
  events: AsyncGenerator<StreamEvent>,
  callbacks?: StreamCallbacks,
): Promise<AccumulatedResponse>
```

```typescript
interface StreamCallbacks {
  onContentBlockStart?(index: number, type: string): void;
  onDelta?(index: number, delta: ContentDelta): void;
  onContentBlockComplete?(index: number, block: ContentBlock): void;
}
```

Processes a stream of events into a complete `AccumulatedResponse`. Callbacks fire at each stage for real-time UI updates.

---

### Error types

All transport errors extend `TransportError`.

```typescript
class TransportError extends Error {
  statusCode: number | null;
  retryable: boolean;
  retryAfterMs?: number;
}

class RateLimitError extends TransportError      // 429 — retryable, honors Retry-After
class ContextTooLongError extends TransportError // 400 with context length message — not retryable
class AuthenticationError extends TransportError // 401/403 — not retryable
class StreamTimeoutError extends TransportError  // timeout — retryable
```

#### `withRetry()`

```typescript
async function withRetry<T>(
  fn: () => Promise<T>,
  config?: RetryConfig,
): Promise<T>

interface RetryConfig {
  maxRetries: number;    // Default: 3
  baseDelayMs: number;   // Default: 1000
  maxDelayMs: number;    // Default: 30000
}
```

Exponential backoff with jitter. Respects `TransportError.retryAfterMs` when present. Non-retryable errors are re-thrown immediately.

---

## Module: engine

**Source:** `src/engine/index.ts`

The core agentic loop that drives all agent behavior.

---

### `runLoop()`

The central function of the entire system.

```typescript
async function* runLoop(
  initialMessages: Message[],
  config: LoopConfig,
  interrupt?: InterruptController,
): AsyncGenerator<LoopEvent>
```

```typescript
interface LoopConfig {
  client: MiniMaxClient;
  systemPrompt?: SystemPrompt;
  tools?: Map<string, Tool>;         // Tool name -> Tool instance
  toolDefinitions?: ToolDefinition[]; // What to send to the model
  maxTurns?: number;                  // Default: 100
  maxBudgetUsd?: number;              // Optional spend cap
  toolContext?: ToolContext;
}
```

The loop runs until one of these conditions is met:

- Model returns `stop_reason: 'end_turn'` with no tool calls
- `maxTurns` is reached
- `maxBudgetUsd` is exceeded
- The `InterruptController` is aborted
- An unrecoverable error occurs

Each iteration: stream model response → analyze stop reason → execute tool calls → append results → repeat.

#### `LoopEvent` (union)

All events an observer can receive from `runLoop()`:

```typescript
type LoopEvent =
  | { type: 'turn_start';      turnIndex: number }
  | { type: 'stream_delta';    delta: ContentDelta; blockIndex: number }
  | { type: 'stream_text';     text: string }
  | { type: 'stream_thinking'; thinking: string }
  | { type: 'stream_tool_start'; toolName: string; toolId: string }
  | { type: 'assistant_message'; message: AssistantMessage }
  | { type: 'tool_executing';  call: ToolCall }
  | { type: 'tool_result';     result: ToolResult }
  | { type: 'turn_end';        turnIndex: number; usage: Usage }
  | { type: 'loop_end';        reason: string; totalUsage: Usage; totalCost: number }
  | { type: 'error';           error: Error };
```

`loop_end` reasons: `'end_turn'`, `'max_turns_reached'`, `'budget_exceeded'`, `'aborted'`, `'error'`, `'max_tokens'`.

**Example — run a full agent loop:**

```typescript
import { MiniMaxClient } from './src/transport/index.js';
import { runLoop } from './src/engine/index.js';
import { InterruptController } from './src/engine/index.js';

const client = new MiniMaxClient();
const interrupt = new InterruptController();

const messages = [{ role: 'user' as const, content: 'List files in the current directory.' }];

for await (const event of runLoop(messages, { client, tools, toolDefinitions, toolContext })) {
  if (event.type === 'assistant_message') {
    // render text blocks
  }
  if (event.type === 'tool_executing') {
    console.log(`Running: ${event.call.name}`);
  }
  if (event.type === 'loop_end') {
    console.log(`Done. Cost: $${event.totalCost.toFixed(4)}`);
    break;
  }
}
```

---

### `query()`

Single-turn query without tool execution.

```typescript
async function query(
  prompt: string,
  config: Omit<LoopConfig, 'tools' | 'toolDefinitions'>,
): Promise<AssistantMessage>
```

**Example:**

```typescript
const reply = await query('Summarize this file.', { client, systemPrompt: '...' });
```

---

### `BudgetTracker`

Tracks token usage and cost across turns.

```typescript
class BudgetTracker {
  constructor(model: string, maxBudgetUsd?: number)

  addTurnUsage(usage: Usage): void
  isOverBudget(): boolean
  getTotalCostUsd(): number
  getTotalUsage(): Usage
  getTurnCount(): number
  getSummary(): string  // "3 turns | 12,400 in / 2,100 out | $0.0060"
}
```

#### `calculateCost()`

```typescript
function calculateCost(usage: Usage, model: string): number
```

Returns cost in USD based on `MINIMAX_PRICING`.

#### `MINIMAX_PRICING`

```typescript
const MINIMAX_PRICING: Record<string, ModelPricing>

interface ModelPricing {
  inputPerMillion: number;   // USD per 1M input tokens
  outputPerMillion: number;  // USD per 1M output tokens
}
```

Current rates (as of 2026-04-05):

| Model | Input | Output |
|-------|-------|--------|
| MiniMax-M2.7-highspeed | $0.30 | $1.10 |
| MiniMax-M2.7 | $0.30 | $1.10 |
| MiniMax-M2.5-highspeed | $0.15 | $0.55 |

#### `getContextWindow()`

```typescript
function getContextWindow(model: string): number
// Returns 204800 for all current MiniMax models
```

---

### `InterruptController`

Controls abort, pause, and resume for the agentic loop.

```typescript
class InterruptController {
  constructor()

  get signal(): AbortSignal  // Pass to async operations for cooperative cancellation
  get paused(): boolean
  get aborted(): boolean

  abort(reason?: string): void  // Irreversible; unblocks any paused state
  pause(): void                  // Suspends at next checkpoint
  resume(): void                 // Unblocks a paused loop
  reset(): void                  // Creates a fresh AbortController for reuse

  async checkpoint(): Promise<void>  // Call at await points to respect pause/abort state
}
```

`checkpoint()` returns immediately when running, blocks when paused, and throws `AbortError` when aborted.

#### `AbortError` / `isAbortError()`

```typescript
class AbortError extends Error {
  constructor(message?: string)
}

function isAbortError(error: unknown): error is AbortError
```

`isAbortError` handles `AbortError`, `DOMException` with name `'AbortError'`, and the built-in `Error` with name `'AbortError'`.

---

### Turn utilities

```typescript
interface TurnResult {
  assistantMessage: AssistantMessage;
  stopReason: string | null;
  usage: Usage;
  toolCalls: ToolCall[];
  needsToolExecution: boolean;
}

function analyzeTurn(
  assistantMessage: AssistantMessage,
  stopReason: string | null,
  usage: Usage,
): TurnResult

function buildToolResultMessage(results: ToolResult[]): UserMessage

function ensureToolResultPairing(messages: Message[]): Message[]

function shouldContinue(
  turnResult: TurnResult,
  turnCount: number,
  maxTurns: number,
): { continue: boolean; reason?: string }

const DEFAULT_MAX_TURNS = 100;
```

`ensureToolResultPairing` adds synthetic error results for any `tool_use` blocks that lack a corresponding `tool_result`. This is required by MiniMax's multi-turn protocol.

---

## Module: tools

**Source:** `src/tools/index.ts`

---

### `createDefaultRegistry()`

The recommended way to instantiate all tools.

```typescript
function createDefaultRegistry(credentialProvider?: CredentialProvider): {
  registry: ToolRegistryImpl;
  agentTool: AgentTool;
  webFetchTool: WebFetchTool;
}
```

Returns the registry with all tools registered. `agentTool` and `webFetchTool` are returned separately because the caller must inject additional dependencies (orchestrator and credential provider, respectively) after creation.

**Example:**

```typescript
import { createDefaultRegistry } from './src/tools/index.js';
import { CredentialProvider } from './src/credentials/index.js';

const { registry, agentTool, webFetchTool } = createDefaultRegistry(credentialProvider);

// Inject the orchestrator into AgentTool later
agentTool.setOrchestrator(orchestrator);
```

---

### `ToolRegistryImpl`

```typescript
class ToolRegistryImpl implements ToolRegistry {
  register(tool: Tool): void
  get(name: string): Tool | undefined
  getAll(): Tool[]
  getDefinitions(): ToolDefinition[]
  has(name: string): boolean
  get size(): number
}
```

---

### `executeToolCalls()`

```typescript
interface ExecutionResult {
  results: ToolResult[];
  durationMs: number;
}

async function executeToolCalls(
  calls: ToolCall[],
  registry: ToolRegistryImpl,
  context: ToolContext,
): Promise<ExecutionResult>
```

Executes a batch of tool calls. Tools marked `concurrencySafe: true` in their definition run in parallel via `Promise.all`. All other tools run sequentially. Unknown tool names produce error results rather than throwing.

---

### Built-in tools

All built-in tools are exported individually and can be instantiated and registered manually.

| Class | Tool name | Category | Concurrency safe |
|-------|-----------|----------|-----------------|
| `BashTool` | `Bash` | execute | No |
| `FileReadTool` | `Read` | read | Yes |
| `FileWriteTool` | `Write` | write | No |
| `FileEditTool` | `Edit` | write | No |
| `GlobTool` | `Glob` | read | Yes |
| `GrepTool` | `Grep` | read | Yes |
| `AgentTool` | `Agent` | agent | No |
| `WebFetchTool` | `WebFetch` | network | Yes |
| `WebSearchTool` | `WebSearch` | network | Yes |
| `REPLTool` | `REPL` | execute | No |
| `TaskCreateTool` | `TaskCreate` | system | No |
| `TaskUpdateTool` | `TaskUpdate` | system | No |
| `TaskListTool` | `TaskList` | system | Yes |
| `SleepTool` | `Sleep` | system | Yes |

**Writing a custom tool:**

```typescript
import type { Tool, ToolCall, ToolContext, ToolResult } from './src/protocol/index.js';

const myTool: Tool = {
  definition: {
    name: 'MyTool',
    description: 'Does something useful.',
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'The input value' },
      },
      required: ['input'],
    },
    concurrencySafe: true,
  },

  async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    if (context.abortSignal.aborted) {
      return { tool_use_id: call.id, content: 'Cancelled', is_error: true };
    }
    const input = call.input['input'] as string;
    return { tool_use_id: call.id, content: `Processed: ${input}` };
  },

  validateInput(input) {
    if (typeof input['input'] !== 'string') return 'input must be a string';
    return null;
  },
};

registry.register(myTool);
```

---

## Module: policy

**Source:** `src/policy/index.ts`

Permission resolution for tool calls. Determines whether a call should be allowed, denied, or require user confirmation.

---

### `PermissionResolver`

```typescript
class PermissionResolver {
  constructor(mode: PermissionMode, userRules?: PermissionRule[])

  resolve(call: ToolCall): PermissionResult
  allowForSession(call: ToolCall): void  // Mark as approved for the rest of the session
  setMode(mode: PermissionMode): void
  getMode(): PermissionMode
}

interface PermissionResult {
  decision: PermissionDecision;   // 'allow' | 'ask' | 'deny'
  reason: string;
  source: 'builtin' | 'user' | 'classifier' | 'mode';
  riskLevel?: RiskLevel;          // Only set when source is 'classifier'
}
```

Resolution order for each call:

1. Built-in deny rules (always checked first)
2. User-defined rules (`allow` / `deny` / `ask`)
3. Session-level approvals (from `allowForSession()`)
4. Risk classifier (for `fullAuto` mode + `execute` category only)
5. Mode default matrix

**Example:**

```typescript
import { PermissionResolver } from './src/policy/index.js';

const resolver = new PermissionResolver('default');
const result = resolver.resolve({ id: '1', name: 'Bash', input: { command: 'ls -la' } });

if (result.decision === 'ask') {
  const approved = await promptUser(`Allow Bash: ${result.reason}?`);
  if (approved) resolver.allowForSession(call);
}
```

---

### Permission modes

```typescript
type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'fullAuto' | 'bypass';
```

| Mode | Read | Write | Execute | Network | Agent | System |
|------|------|-------|---------|---------|-------|--------|
| `plan` | ask | ask | ask | ask | ask | ask |
| `default` | allow | ask | ask | allow | ask | ask |
| `acceptEdits` | allow | allow | ask | allow | ask | ask |
| `fullAuto` | allow | allow | classifier | allow | allow | allow |
| `bypass` | allow | allow | allow | allow | allow | allow |

```typescript
const MODE_DESCRIPTIONS: Record<PermissionMode, string>
```

---

### Tool categories

```typescript
type ToolCategory = 'read' | 'write' | 'execute' | 'network' | 'agent' | 'system';

function getToolCategory(toolName: string): ToolCategory
function getDefaultDecision(mode: PermissionMode, category: ToolCategory): PermissionDecision
```

---

### `PermissionRule`

```typescript
interface PermissionRule {
  id: string;
  description?: string;
  // Match criteria (all must match if specified)
  toolName?: string | RegExp;
  inputPattern?: RegExp;
  decision: PermissionDecision;
  reason?: string;
}

function evaluateRules(
  rules: PermissionRule[],
  call: ToolCall,
): { decision: PermissionDecision; rule: PermissionRule } | null

function ruleMatches(rule: PermissionRule, call: ToolCall): boolean

const BUILTIN_RULES: PermissionRule[]  // Safety rules that are always applied
```

---

### `classifyBashRisk()`

Pattern-based risk classifier for shell commands. Used automatically by `PermissionResolver` in `fullAuto` mode.

```typescript
type RiskLevel = 'low' | 'medium' | 'high';

interface RiskClassification {
  level: RiskLevel;
  reason: string;
  patterns: string[];
}

function classifyBashRisk(command: string): RiskClassification
```

High-risk patterns include: `rm -rf`, `sudo`, `mkfs`, `dd of=`, `iptables`, `systemctl start/stop`, `kill -9`, `export PATH=`, writing to `/etc/`, and force-push operations.

Low-risk commands include: `ls`, `cat`, `grep`, `git` (read subcommands), `node`, `pytest`, `jest`, and similar read-only or test-only tools.

---

## Module: context

**Source:** `src/context/index.ts`

Context window management, memory, sessions, and workspace detection.

---

### `TokenBudgetTracker`

Tracks how much of the model's context window is consumed and triggers compaction when needed.

```typescript
class TokenBudgetTracker {
  constructor(config?: Partial<TokenBudgetConfig>)

  updateFromUsage(usage: Usage): void  // Update with actual API-reported token counts
  shouldCompact(): boolean             // True when above compactionThreshold
  isNearLimit(): boolean               // True when within 5% of the safe limit
  getAvailableTokens(): number
  getStatus(): TokenBudgetStatus
  get lastInputTokens(): number
}

interface TokenBudgetConfig {
  model: string;
  compactionThreshold: number;  // Fraction 0-1. Default: 0.75
  reserveForOutput: number;     // Tokens reserved for response. Default: 8192
}

interface TokenBudgetStatus {
  usedTokens: number;
  totalTokens: number;
  availableTokens: number;
  percentUsed: number;
  shouldCompact: boolean;
  isNearLimit: boolean;
}
```

#### `estimateTokens()`

```typescript
function estimateTokens(messages: Message[]): number
```

Rough local estimate (no API call required). Uses ~3.5 chars per token. Intentionally conservative — it overestimates.

---

### `compactConversation()`

Summarizes older turns to free up context window space.

```typescript
async function compactConversation(
  messages: Message[],
  client: MiniMaxClient,
  config?: CompactionConfig,
): Promise<CompactionResult>

interface CompactionConfig {
  keepRecentTurns: number;    // Turns to preserve intact. Default: 4
  summaryMaxTokens: number;   // Max tokens for generated summary. Default: 2048
}

interface CompactionResult {
  messages: Message[];        // The new, compacted message array
  wasCompacted: boolean;
  removedTurns: number;
  summaryLength?: number;
}
```

The function calls the model to generate the summary. The resulting `messages` array replaces the old one in your loop state. Returns `wasCompacted: false` if there are not enough turns to compact.

**Example:**

```typescript
import { TokenBudgetTracker, compactConversation } from './src/context/index.js';

const budget = new TokenBudgetTracker({ model: client.model });
budget.updateFromUsage(latestUsage);

if (budget.shouldCompact()) {
  const result = await compactConversation(messages, client);
  if (result.wasCompacted) {
    messages = result.messages;
    console.log(`Compacted ${result.removedTurns} turns.`);
  }
}
```

---

### `MemoryStore`

Persistent key-value memory using Markdown files with YAML frontmatter.

**Storage locations:**
- Global: `~/.pcc/memory/`
- Project-local: `.pcc/memory/` relative to the project directory

```typescript
class MemoryStore {
  constructor(projectDir?: string)

  async loadAll(): Promise<Memory[]>
  async save(
    memory: Omit<Memory, 'filename'>,
    scope?: 'global' | 'project',  // Default: 'project'
  ): Promise<string>                // Returns the file path
  async loadIndex(scope?: 'global' | 'project'): Promise<string>
  async findRelevant(query: string, limit?: number): Promise<Memory[]>
}

type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

interface Memory {
  name: string;
  description: string;
  type: MemoryType;
  content: string;
  filename: string;
}
```

`findRelevant` scores memories by counting query word matches against name, description, and content. It is keyword-based — no embeddings required.

---

### Memory extraction

```typescript
interface MemoryCandidate {
  type: MemoryType;
  name: string;
  description: string;
  content: string;
  confidence: number;  // 0-1
}

function detectMemoryHints(userMessage: string): MemoryCandidate[]
function formatMemoriesForPrompt(
  memories: Array<{ name: string; type: string; content: string }>,
): string
```

`detectMemoryHints` scans user messages for patterns like "remember that...", "I'm a...", and behavioral preferences ("don't...").

---

### `SessionManager`

Saves and loads conversation sessions to `~/.pcc/sessions/{id}.json`.

```typescript
class SessionManager {
  constructor()

  createSession(projectDir: string, model: string): SessionData
  async save(session: SessionData): Promise<string>  // Returns file path
  async load(sessionId: string): Promise<SessionData | null>
  async loadLatest(projectDir: string): Promise<SessionData | null>
  async listRecent(limit?: number): Promise<SessionSummary[]>
}

interface SessionData {
  id: string;
  projectDir: string;
  messages: Message[];
  model: string;
  totalUsage: Usage;
  turnCount: number;
  createdAt: string;
  updatedAt: string;
}

interface SessionSummary {
  id: string;
  projectDir: string;
  turnCount: number;
  updatedAt: string;
  model: string;
}
```

---

### `ObsidianVault`

Direct filesystem access to an Obsidian Markdown vault. No Obsidian plugin API required.

```typescript
class ObsidianVault {
  constructor(vaultPath: string)

  async isValid(): Promise<boolean>

  // Reading
  async readNote(notePath: string): Promise<ObsidianNote | null>
  async searchContent(query: string, limit?: number): Promise<ObsidianNote[]>
  async searchByTag(tag: string): Promise<ObsidianNote[]>
  async resolveLink(linkName: string): Promise<string | null>
  async getLinkedNotes(notePath: string): Promise<ObsidianNote[]>
  async listNotes(subfolder?: string): Promise<string[]>
  async getRecentNotes(days?: number, limit?: number): Promise<ObsidianNote[]>

  // Writing
  async saveAgentNote(
    title: string,
    body: string,
    metadata?: { tags?: string[]; type?: string; project?: string; links?: string[] },
  ): Promise<string>
  async createNote(
    folder: string,
    title: string,
    body: string,
    frontmatter?: Record<string, unknown>,
  ): Promise<string>

  // Prompt injection
  async getContextSummary(query?: string): Promise<string>

  get vaultPath(): string
}

interface ObsidianNote {
  path: string;           // Relative to vault root
  title: string;
  frontmatter: Record<string, unknown>;
  body: string;
  links: string[];        // Wikilink targets
  tags: string[];
}

interface VaultConfig {
  path: string;
  agentFolder: string;    // Default: 'Agent'
}
```

#### `discoverVault()`

```typescript
async function discoverVault(cwd: string): Promise<string | null>
```

Locates an Obsidian vault using this priority:

1. `PCC_OBSIDIAN_VAULT` environment variable
2. `.pcc/vault.path` file in the project directory
3. `pcc-vault.path` file in the project directory
4. `cwd` itself if it contains a `.obsidian` folder
5. Common paths: `~/Obsidian`, `~/Documents/Obsidian`, `~/Documents/Obsidian Vault`, `~/obsidian-vault`, `~/vault`

---

### Workspace utilities

```typescript
interface GitContext {
  isGitRepo: boolean;
  branch?: string;
  hasUncommittedChanges?: boolean;
  recentCommits?: string[];
  status?: string;
}

async function getGitContext(cwd: string): Promise<GitContext>
function formatGitContext(git: GitContext): string

interface ProjectContext {
  name: string;
  type: ProjectType;      // 'node' | 'python' | 'rust' | 'go' | 'java' | 'dotnet' | 'ruby' | 'unknown'
  configFiles: string[];
  customInstructions?: string;  // Content of CLAUDE.md or PCC.md, up to 5000 chars
}

async function getProjectContext(cwd: string): Promise<ProjectContext>
function formatProjectContext(project: ProjectContext): string
```

`getProjectContext` looks for `CLAUDE.md`, `PCC.md`, `.claude/CLAUDE.md`, and `.pcc/instructions.md` to load per-project instructions.

---

## Module: agents

**Source:** `src/agents/index.ts`

Sub-agent orchestration. Each sub-agent is a nested `runLoop()` call with its own conversation history, budget, and tool set.

---

### `AgentOrchestrator`

```typescript
class AgentOrchestrator {
  constructor(
    client: MiniMaxClient,
    tools: Map<string, Tool>,
    toolContext: ToolContext,
  )

  async spawn(
    task: string,
    agentType?: string,       // Default: 'general'
    options?: SpawnOptions,
  ): Promise<AgentResult>

  abortAll(): void
  get activeCount(): number
}
```

```typescript
interface SpawnOptions {
  allowedTools?: string[];          // Override tool whitelist
  context?: string;                 // Extra text appended to agent system prompt
  cwd?: string;                     // Override working directory
  maxTurns?: number;
  maxBudgetUsd?: number;
  onEvent?: (event: LoopEvent) => void;  // Observe agent events in real time
}

interface AgentResult {
  response: string;     // Final text from the agent's last message
  events: LoopEvent[];  // Full event history
  success: boolean;     // true when endReason === 'end_turn'
  endReason: string;
  costUsd: number;
  turns: number;
}
```

---

### Built-in agent types

Pass the type name as the second argument to `orchestrator.spawn()`.

| Name | Description | Default max turns | Tool restriction |
|------|-------------|-------------------|-----------------|
| `general` | General purpose; all tools | 15 | None (Agent excluded) |
| `explore` | Read-only code exploration | 10 | Read, Glob, Grep, Bash |
| `code` | Write code changes | 20 | None |
| `review` | Read-only code review | 10 | Read, Glob, Grep, Bash |
| `test` | Run and write tests | 15 | None |

```typescript
interface AgentDefinition {
  name: string;
  rolePrompt: string;
  allowedTools?: string[];
  maxTurns: number;
  maxBudgetUsd?: number;
}

const BUILTIN_AGENTS: Record<string, AgentDefinition>
```

**Example:**

```typescript
import { AgentOrchestrator } from './src/agents/index.js';

const orchestrator = new AgentOrchestrator(client, toolMap, toolContext);

const result = await orchestrator.spawn(
  'Find all TODO comments in src/ and list them.',
  'explore',
  { maxTurns: 5 },
);

console.log(result.response);
```

---

### Delegation functions

#### `delegateParallel()`

Run multiple sub-agents concurrently and collect all results.

```typescript
interface ParallelTask {
  id: string;
  prompt: string;
  agentType?: string;
  options?: SpawnOptions;
}

interface ParallelResults {
  results: Map<string, AgentResult>;
  totalCostUsd: number;
  allSucceeded: boolean;
}

async function delegateParallel(
  orchestrator: AgentOrchestrator,
  tasks: ParallelTask[],
): Promise<ParallelResults>
```

**Example:**

```typescript
import { delegateParallel, formatParallelResults } from './src/agents/index.js';

const results = await delegateParallel(orchestrator, [
  { id: 'auth',  prompt: 'Review auth.ts for security issues.', agentType: 'review' },
  { id: 'api',   prompt: 'Review api.ts for security issues.',  agentType: 'review' },
  { id: 'tests', prompt: 'Review tests/ for coverage gaps.',    agentType: 'review' },
]);

console.log(formatParallelResults(results));
```

#### `delegateChain()`

Run sub-agents sequentially, feeding each result into the next step.

```typescript
interface ChainStep {
  id: string;
  prompt: string | ((previousResult: string) => string);
  agentType?: string;
  options?: SpawnOptions;
}

async function delegateChain(
  orchestrator: AgentOrchestrator,
  steps: ChainStep[],
): Promise<AgentResult[]>
```

The chain stops early if any step's `success` is `false`. Use a function for `prompt` to incorporate the previous step's response.

#### `formatParallelResults()`

```typescript
function formatParallelResults(results: ParallelResults): string
```

Returns a human-readable multi-line summary of all agent outcomes.

---

### Git worktree isolation

Isolates sub-agent file changes in a separate git worktree, preventing conflicts with the main workspace.

```typescript
interface Worktree {
  id: string;
  path: string;        // Absolute path to the worktree directory
  branch: string;      // e.g., 'pcc-agent-a3f2b1c4'
  baseBranch: string;  // The branch the worktree was created from
  createdAt: Date;
}

async function createWorktree(repoDir: string, prefix?: string): Promise<Worktree>
async function removeWorktree(repoDir: string, worktree: Worktree, deleteBranch?: boolean): Promise<void>
async function worktreeHasChanges(worktree: Worktree): Promise<boolean>
async function mergeWorktree(
  repoDir: string,
  worktree: Worktree,
  commitMessage?: string,
): Promise<{ merged: boolean; conflicts: boolean }>
```

Worktrees are created inside `.pcc-worktrees/` in the repository root. Requires `git` in `PATH`. `createWorktree` throws if the directory is not a git repository.

**Example:**

```typescript
import { createWorktree, mergeWorktree, removeWorktree } from './src/agents/index.js';

const worktree = await createWorktree('/path/to/repo', 'feature-agent');

try {
  // Run an agent with worktree.path as its cwd
  const result = await orchestrator.spawn(task, 'code', { cwd: worktree.path });

  if (result.success) {
    const { merged, conflicts } = await mergeWorktree('/path/to/repo', worktree);
    if (conflicts) console.warn('Merge conflicts — manual resolution needed');
  }
} finally {
  await removeWorktree('/path/to/repo', worktree);
}
```

---

## Module: credentials

**Source:** `src/credentials/index.ts`

AES-256-GCM encrypted credential storage. Credentials are never injected into LLM context — only tools use them for authenticated requests.

---

### `CredentialVault`

Encrypted at-rest storage using PBKDF2 key derivation (100K iterations, SHA-512).

**Storage:** `~/.pcc/credentials.enc`

```typescript
class CredentialVault {
  constructor(vaultPath?: string)  // Defaults to ~/.pcc/credentials.enc

  async exists(): Promise<boolean>
  async init(masterPassword: string): Promise<void>    // Create new vault
  async unlock(masterPassword: string): Promise<boolean>  // Returns false on wrong password
  get isUnlocked(): boolean
  lock(): void                                          // Clears key from memory

  async add(credential: Credential): Promise<void>
  async remove(service: ServiceType, label?: string): Promise<boolean>
  get(service: ServiceType, label?: string): Credential | undefined
  getValue(service: ServiceType, key: string, label?: string): string | undefined
  getByDomain(domain: string): Credential | undefined
  list(): Array<{ service: ServiceType; label: string; addedAt: string }>
}
```

---

### `CredentialProvider`

High-level API for tools to request credentials. Tools use this, not the vault directly.

```typescript
class CredentialProvider {
  constructor(vault: CredentialVault)

  getToken(service: ServiceType): string | null
  getCredential(service: ServiceType): Record<string, string> | null
  getAuthHeaders(url: string): Record<string, string>  // Auto-detects service from URL domain
  hasCredential(service: ServiceType): boolean
  getVPSConfig(): VPSConfig | null
  get isAvailable(): boolean
}

interface VPSConfig {
  host: string;
  user: string;
  keyPath: string;
  port: number;
}
```

`getAuthHeaders` automatically selects the right auth format per service (Bearer token, GitLab `PRIVATE-TOKEN`, Notion versioned headers, etc.).

---

### Credential types

```typescript
type ServiceType =
  | 'github' | 'gitlab' | 'bitbucket'
  | 'aws' | 'gcp' | 'azure' | 'vercel' | 'supabase' | 'netlify' | 'railway' | 'fly'
  | 'gmail' | 'slack' | 'discord' | 'notion'
  | 'cloudflare' | 'vps'
  | 'custom';

interface Credential {
  service: ServiceType;
  label: string;                   // e.g., "personal github", "work aws"
  values: Record<string, string>;  // key/value pairs; secret keys have secret: true in template
  addedAt: string;
  domains?: string[];              // Domains this credential applies to (for getByDomain)
}

interface ServiceTemplate {
  service: ServiceType;
  description: string;
  fields: Array<{ key: string; label: string; secret: boolean; hint?: string }>;
  domains: string[];
}

const SERVICE_TEMPLATES: Record<string, ServiceTemplate>
```

**Example — unlock vault and use provider:**

```typescript
import { CredentialVault, CredentialProvider } from './src/credentials/index.js';

const vault = new CredentialVault();
const unlocked = await vault.unlock(masterPassword);

if (unlocked) {
  const provider = new CredentialProvider(vault);
  const token = provider.getToken('github');
  const headers = provider.getAuthHeaders('https://api.github.com/repos/...');
}
```

---

## Module: commands

**Source:** `src/commands/index.ts`

Slash command system for the interactive REPL.

---

### `CommandRegistry`

```typescript
class CommandRegistry {
  register(command: Command): void
  get(name: string): Command | undefined
  getAll(): Command[]
  async dispatch(input: string, ctx: CommandContext): Promise<CommandResult | null>
}
```

`dispatch` returns `null` if the input does not start with `/`. Returns a `CommandResult` otherwise.

---

### `createDefaultCommands()`

```typescript
function createDefaultCommands(): CommandRegistry
```

Creates a registry with all built-in commands registered.

---

### Command interface

```typescript
interface Command {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  execute(args: string, ctx: CommandContext): Promise<CommandResult>;
}

interface CommandContext {
  cwd: string;
  messages: Message[];
  info: (msg: string) => void;
  error: (msg: string) => void;
  query?: (prompt: string) => Promise<string>;  // Send a prompt to the model
}

type CommandResult =
  | { type: 'handled' }
  | { type: 'prompt'; prompt: string }   // Inject as user message
  | { type: 'clear' }                    // Clear conversation
  | { type: 'exit'; reason: string }     // Terminate REPL
  | { type: 'error'; message: string };
```

---

### Built-in commands

| Export | Command | Aliases | Description |
|--------|---------|---------|-------------|
| `helpCommand` | `/help` | `/h`, `/?` | Show available commands |
| `quitCommand` | `/quit` | `/exit`, `/q` | Exit the session |
| `clearCommand` | `/clear` | — | Clear conversation history |
| `compactCommand` | `/compact` | — | Trigger context compaction |
| `commitCommand` | `/commit` | — | Generate and run a git commit |
| `statusCommand` | `/status` | `/st` | Show git status |
| `reviewCommand` | `/review` | — | Review recent code changes |
| `memoryCommand` | `/memory` | `/mem`, `/vault` | Obsidian vault operations |

**Registering a custom command:**

```typescript
import { CommandRegistry } from './src/commands/index.js';

const registry = createDefaultCommands();

registry.register({
  name: 'deploy',
  description: 'Deploy to production',
  async execute(args, ctx) {
    return {
      type: 'prompt',
      prompt: `Run the deploy script and report the result: ${args || 'npm run deploy'}`,
    };
  },
});
```

---

## Module: remote

**Source:** `src/remote/index.ts`

Remote execution over SSH and session sharing over WebSocket.

---

### SSH functions

All SSH functions use the system's `ssh` and `scp` binaries. No npm dependencies.

#### `sshExec()`

```typescript
interface SSHResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function sshExec(
  config: VPSConfig,
  command: string,
  options?: { timeoutMs?: number; abortSignal?: AbortSignal },
): Promise<SSHResult>
```

Output is capped at 100KB per stream. Uses `StrictHostKeyChecking=accept-new` and `BatchMode=yes`.

#### `sshTest()`

```typescript
async function sshTest(config: VPSConfig): Promise<boolean>
```

Runs `echo ok` with a 10-second timeout. Returns `true` on success.

#### `scpUpload()` / `scpDownload()`

```typescript
async function scpUpload(config: VPSConfig, localPath: string, remotePath: string): Promise<void>
async function scpDownload(config: VPSConfig, remotePath: string, localPath: string): Promise<void>
```

#### `openSOCKSProxy()`

```typescript
interface SSHTunnel {
  localPort: number;
  kill: () => void;
  ready: Promise<void>;  // Resolves when the tunnel is established
}

function openSOCKSProxy(config: VPSConfig, localPort?: number): SSHTunnel
```

Opens a SOCKS5 dynamic proxy tunnel. Default port: `1080`. The `ready` promise resolves after the first SSH stderr output or after 3 seconds.

---

### `SessionGateway`

WebSocket server for sharing a PCC session over the network.

```typescript
class SessionGateway {
  constructor(config?: Partial<GatewayConfig>)

  async start(sessionId: string): Promise<string>  // Returns ws:// address
  broadcast(message: GatewayMessage): void
  onInput(callback: (text: string) => void): void
  onCommand(callback: (cmd: string, args: string) => void): void
  stop(): void
  get isRunning(): boolean
  get clientCount(): number
}

interface GatewayConfig {
  port: number;      // Default: 9377
  host: string;      // Default: '0.0.0.0'
  password?: string; // Optional: token required in ?token= query parameter
}

type GatewayMessage =
  | { type: 'event';   payload: LoopEvent }
  | { type: 'input';   payload: { text: string } }
  | { type: 'command'; payload: { command: string; args: string } }
  | { type: 'status';  payload: SessionStatus }
  | { type: 'ping' }
  | { type: 'pong' };

interface SessionStatus {
  sessionId: string;
  model: string;
  turnCount: number;
  connected: number;
  uptime: number;     // Seconds since start()
}
```

Requires the `ws` package as an optional runtime dependency: `npm install ws`.

**Example:**

```typescript
import { SessionGateway } from './src/remote/index.js';

const gateway = new SessionGateway({ port: 9377, password: 'secret' });
const address = await gateway.start(sessionId);
console.log(`Share session at: ${address}?token=secret`);

// Forward loop events to remote clients
for await (const event of runLoop(messages, config)) {
  gateway.broadcast({ type: 'event', payload: event });
}

gateway.stop();
```

---

## Module: voice

**Source:** `src/voice/index.ts`

Push-to-talk voice input. Captures microphone audio and transcribes it to text.

---

### `recordAudio()`

```typescript
interface Recording {
  filePath: string;         // Temporary WAV file path
  durationMs: number;
  cleanup: () => Promise<void>;  // Delete the temp file
}

async function recordAudio(
  durationSeconds?: number,  // Default: 30
  abortSignal?: AbortSignal,
): Promise<Recording>
```

Auto-detects the recording backend:
1. `rec` (from SoX) — cross-platform
2. `arecord` — Linux only

Aborting the signal sends `SIGINT` to the recorder, which gracefully finalizes the WAV file.

---

### `transcribe()`

```typescript
async function transcribe(recording: Recording, config: VoiceConfig): Promise<string>
```

```typescript
interface VoiceConfig {
  backend: 'whisper-api' | 'whisper-local' | 'minimax';
  whisperApiKey?: string;         // Required for backend: 'whisper-api'
  minimaxApiKey?: string;         // Required for backend: 'minimax'
  whisperBinaryPath?: string;     // Path to whisper.cpp binary for backend: 'whisper-local'
  sampleRate: number;             // Default: 16000
  maxDuration: number;            // Default: 30
}

const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  backend: 'whisper-api',
  sampleRate: 16000,
  maxDuration: 30,
};
```

Backend behavior:

| Backend | Requirement | Notes |
|---------|-------------|-------|
| `whisper-api` | `OPENAI_API_KEY` or `whisperApiKey` | Calls OpenAI `/v1/audio/transcriptions` with `whisper-1` |
| `whisper-local` | `whisper` binary in PATH or `whisperBinaryPath` | Uses `whisper.cpp` locally |
| `minimax` | `MINIMAX_API_KEY` or `minimaxApiKey` | Falls back to `whisper-local` if MiniMax endpoint unavailable |

**Example:**

```typescript
import { recordAudio, transcribe, DEFAULT_VOICE_CONFIG } from './src/voice/index.js';

const recording = await recordAudio(15);  // Record up to 15 seconds
const text = await transcribe(recording, {
  ...DEFAULT_VOICE_CONFIG,
  whisperApiKey: process.env.OPENAI_API_KEY,
});
await recording.cleanup();
console.log('Transcribed:', text);
```

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MINIMAX_API_KEY` | MiniMax API key (preferred) | — |
| `ANTHROPIC_AUTH_TOKEN` | Fallback API key | — |
| `ANTHROPIC_API_KEY` | Second fallback API key | — |
| `MINIMAX_BASE_URL` | API base URL override | `https://api.minimax.io/anthropic/v1` |
| `ANTHROPIC_BASE_URL` | Fallback base URL override | — |
| `PCC_OBSIDIAN_VAULT` | Absolute path to Obsidian vault | Auto-discovered |

At least one of the first three API key variables must be set. The system throws at startup if none are present.

---

## Common Patterns

### Minimal agent loop

```typescript
import { MiniMaxClient } from './src/transport/index.js';
import { runLoop } from './src/engine/index.js';
import { createDefaultRegistry } from './src/tools/index.js';
import { InterruptController } from './src/engine/index.js';
import type { ToolContext } from './src/protocol/index.js';

const client = new MiniMaxClient();
const interrupt = new InterruptController();
const { registry } = createDefaultRegistry();

const toolContext: ToolContext = {
  cwd: process.cwd(),
  abortSignal: interrupt.signal,
  permissionMode: 'default',
  askPermission: async (tool, action) => {
    // Your UI prompts the user here
    return true;
  },
};

const toolMap = new Map(registry.getAll().map((t) => [t.definition.name, t]));

for await (const event of runLoop(
  [{ role: 'user', content: 'Hello!' }],
  {
    client,
    tools: toolMap,
    toolDefinitions: registry.getDefinitions(),
    toolContext,
  },
  interrupt,
)) {
  if (event.type === 'assistant_message') {
    for (const block of event.message.content) {
      if (block.type === 'text') process.stdout.write(block.text);
    }
  }
  if (event.type === 'loop_end') break;
}
```

### Session resume

```typescript
import { SessionManager } from './src/context/index.js';

const sessions = new SessionManager();
const existing = await sessions.loadLatest(process.cwd());

const session = existing ?? sessions.createSession(process.cwd(), client.model);

// Use session.messages as initialMessages in runLoop
// After each turn, update session.messages and call sessions.save(session)
```

### Permission-aware tool execution

```typescript
import { PermissionResolver } from './src/policy/index.js';

const resolver = new PermissionResolver('default');

const toolContext: ToolContext = {
  cwd: process.cwd(),
  abortSignal: interrupt.signal,
  permissionMode: 'default',
  async askPermission(tool, action) {
    const call = { id: '', name: tool, input: { command: action } };
    const result = resolver.resolve(call);

    if (result.decision === 'allow') return true;
    if (result.decision === 'deny') return false;

    // result.decision === 'ask'
    const answer = await promptUser(`Allow ${tool}: ${action}? (y/n/always) `);
    if (answer === 'always') resolver.allowForSession(call);
    return answer === 'y' || answer === 'always';
  },
};
```

### Parallel sub-agents with worktrees

```typescript
import { AgentOrchestrator, delegateParallel } from './src/agents/index.js';
import { createWorktree, removeWorktree } from './src/agents/index.js';

const orchestrator = new AgentOrchestrator(client, toolMap, toolContext);

// Create isolated worktrees for each agent
const wt1 = await createWorktree(repoDir, 'agent-auth');
const wt2 = await createWorktree(repoDir, 'agent-api');

try {
  const { results } = await delegateParallel(orchestrator, [
    {
      id: 'auth-refactor',
      prompt: 'Refactor auth.ts to use JWT instead of sessions.',
      agentType: 'code',
      options: { cwd: wt1.path },
    },
    {
      id: 'api-refactor',
      prompt: 'Update api.ts to use the new auth helpers.',
      agentType: 'code',
      options: { cwd: wt2.path },
    },
  ]);

  for (const [id, result] of results) {
    if (result.success) {
      console.log(`${id}: succeeded`);
    }
  }
} finally {
  await removeWorktree(repoDir, wt1);
  await removeWorktree(repoDir, wt2);
}
```

---

## Troubleshooting

### "No API key found"

Set `MINIMAX_API_KEY` in your environment or in a `.env` file. The system checks `MINIMAX_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_API_KEY` in that order.

### Authentication errors on streaming

`AuthenticationError` (status 401/403) is not retried. Check that your key is valid and that `MINIMAX_BASE_URL` points to the correct endpoint.

### Context window exceeded

`ContextTooLongError` is thrown when the prompt is too long. Use `TokenBudgetTracker` to monitor usage and call `compactConversation()` before the limit is reached. The default compaction threshold is 75% of the 204,800-token context window.

### Tool result pairing errors

If you build `messages` arrays manually, ensure that every `tool_use` block in an assistant message is followed by a `user` message containing a matching `tool_result` block. Call `ensureToolResultPairing(messages)` before passing to the API if you are uncertain.

### SSH "connection failed"

Ensure `ssh` is in `PATH`. The `sshExec` function uses `BatchMode=yes`, which disables interactive prompts — your key must be added to `ssh-agent` or specified via `key_path` in the `VPSConfig`.

### No audio recorder found

The voice module requires either `rec` (from SoX) or `arecord` (Linux) in `PATH`. Install SoX for cross-platform support: `brew install sox` on macOS, `apt install sox` on Debian/Ubuntu.

### WebSocket server requires "ws"

`SessionGateway` uses the `ws` package as an optional dependency. Install it explicitly: `npm install ws`.

### Vault is locked

`CredentialVault` methods throw `"Vault is locked. Call unlock() first."` if accessed before `unlock()`. Always check `vault.isUnlocked` or handle the thrown error.
