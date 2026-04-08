# Shugu API Reference -- v0.2.0

This document covers the public API for every module in the Shugu TypeScript SDK. It is intended for developers who want to extend the system, embed it in another application, or use individual layers as libraries.

**Package name:** `shugu`
**Version:** 0.2.0
**Runtime:** Node.js >= 20.0.0 (ESM only)
**Primary model:** MiniMax M2.7-highspeed (Anthropic Messages API-compatible)

---

## Table of Contents

1.  [Architecture Overview](#architecture-overview)
2.  [Module: protocol (Layer 0)](#module-protocol-layer-0)
3.  [Module: transport (Layer 1)](#module-transport-layer-1)
4.  [Module: engine (Layer 2)](#module-engine-layer-2)
5.  [Module: tools (Layer 3)](#module-tools-layer-3)
6.  [Module: policy (Layer 4)](#module-policy-layer-4)
7.  [Module: context (Layer 5)](#module-context-layer-5)
8.  [Module: commands (Layer 7)](#module-commands-layer-7)
9.  [Module: agents (Layer 8)](#module-agents-layer-8)
10. [Module: automation (Layer 9)](#module-automation-layer-9)
11. [Module: credentials](#module-credentials)
12. [Module: skills (Layer 13)](#module-skills-layer-13)
13. [Module: plugins (Layer 14)](#module-plugins-layer-14)
14. [Module: meta (Layer 14+)](#module-meta-layer-14)
15. [Module: entrypoints](#module-entrypoints)
16. [Environment Variables](#environment-variables)
17. [Common Patterns](#common-patterns)
18. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

The codebase is organized into numbered layers. Each layer depends only on layers below it. The numbers describe the dependency order, not import paths.

```
Layer 0   protocol      -- Core types shared by all layers
Layer 1   transport     -- HTTP client for MiniMax API
Layer 2   engine        -- Agentic loop, budget, interrupts, strategy, intelligence
Layer 3   tools         -- Tool registry, executor, output limits
Layer 4   policy        -- Permission resolution, risk classification, modes
Layer 5   context       -- Token budget, compaction, memory, sessions
Layer 7   commands      -- Slash command registry
Layer 8   agents        -- Sub-agent orchestration and delegation
Layer 9   automation    -- Background sessions, scheduler
Layer --  credentials   -- Encrypted vault, credential provider
Layer 13  skills        -- Skill loader, registry, matching
Layer 14  plugins       -- Hook system, plugin registry
Layer 14+ meta          -- Meta-Harness outer-loop optimizer
Layer --  entrypoints   -- Bootstrap, RuntimeServices, CLI
```

**Import paths** follow this pattern:

```typescript
import { MiniMaxClient } from './src/transport/client.js';
import { runLoop } from './src/engine/loop.js';
```

---

## Module: protocol (Layer 0)

**Source:** `src/protocol/`
**Re-exports from:** `messages.ts`, `tools.ts`, `events.ts`, `thinking.ts`, `session.ts`, `actions.ts`

This is the lowest layer. All other modules import from here. No external dependencies.

---

### Messages (`protocol/messages.ts`)

#### `Role`

```typescript
type Role = 'user' | 'assistant';
```

#### Content Block Types

| Type | Description |
|------|-------------|
| `TextBlock` | Plain text content. Has `type: 'text'` and `text: string`. |
| `ImageBlock` | Image content. Source can be `base64` or `url`. |
| `ToolUseBlock` | A tool call from the assistant. Has `id`, `name`, and `input`. |
| `ToolResultBlock` | The result of a tool call. Has `tool_use_id`, `content`, and optional `is_error`. |
| `ThinkingBlock` | Exposed reasoning from MiniMax. Has `thinking: string` and optional `signature`. |
| `RedactedThinkingBlock` | Opaque reasoning data. Has `data: string`. |

```typescript
interface TextBlock {
  type: 'text';
  text: string;
}

interface ImageBlock {
  type: 'image';
  source: {
    type: 'base64' | 'url';
    media_type?: string;
    data?: string;   // base64
    url?: string;
  };
}

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

interface RedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

type ContentBlock =
  | TextBlock
  | ImageBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | RedactedThinkingBlock;
```

#### `UserMessage` / `AssistantMessage` / `Message`

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

#### `StopReason`

```typescript
type StopReason =
  | 'end_turn'      // Model finished naturally
  | 'tool_use'      // Model wants to call a tool
  | 'max_tokens'    // Hit output token limit
  | 'stop_sequence' // Hit a stop sequence
  | null;           // Stream still in progress
```

#### `Usage`

```typescript
interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}
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

#### Helper Functions

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
import { getTextContent, getToolUseBlocks, isTextBlock } from './src/protocol/messages.js';

const text = getTextContent(assistantMessage);
const toolCalls = getToolUseBlocks(assistantMessage);
```

---

### Tools (`protocol/tools.ts`)

Defines the contract between the engine and every tool implementation.

#### `ToolDefinition`

```typescript
interface ToolDefinition {
  name: string;                  // Unique tool name, e.g. "Bash"
  description: string;           // Shown to the model
  inputSchema: ToolInputSchema;
  concurrencySafe?: boolean;     // If true, can run in parallel with other tools
  deferLoading?: boolean;        // For lazy tool registration
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
  | MessageStopEvent
  | ReasoningDelta;
```

#### Individual Event Types

```typescript
interface MessageStartEvent {
  type: 'message_start';
  message: {
    id: string;
    model: string;
    usage: Usage;
    reasoning_details?: Array<{ text: string }>;
  };
}

interface ContentBlockStartEvent {
  type: 'content_block_start';
  index: number;
  content_block: ContentBlockStart;
}

type ContentBlockStart =
  | { type: 'text'; text: '' }
  | { type: 'tool_use'; id: string; name: string; input: '' }
  | { type: 'thinking'; thinking: '' };

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

interface ContentBlockStopEvent {
  type: 'content_block_stop';
  index: number;
}

interface MessageDeltaEvent {
  type: 'message_delta';
  delta: { stop_reason: StopReason };
  usage?: { output_tokens: number };
}

interface MessageStopEvent {
  type: 'message_stop';
}

interface ReasoningDelta {
  type: 'reasoning.text';
  id: string;
  text: string;
}
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

interface AccumulatingBlock {
  type: 'text' | 'tool_use' | 'thinking';
  text: string;
  toolId: string;
  toolName: string;
  inputJson: string;
  thinking: string;
  signature: string;
}

function createEmptyAccumulator(): StreamAccumulator
```

---

### Thinking (`protocol/thinking.ts`)

MiniMax M2.7 has mandatory reasoning. This module documents that behavior and provides helper types.

> **MiniMax note:** Reasoning is always active. `reasoning_split: true` controls whether thinking blocks are exposed in the response. The field in streaming deltas is `.text`, not `.content`.

```typescript
interface ThinkingConfig {
  showThinking: boolean;    // Maps to reasoning_split in the MiniMax request
  budgetTokens?: number;    // Client-side tracking only; not enforced server-side
}

const DEFAULT_THINKING_CONFIG: ThinkingConfig = { showThinking: true };
```

```typescript
interface MiniMaxReasoningDetail {
  type: 'reasoning.text';
  id: string;
  text: string;  // Use .text, NOT .content
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
```

#### `Transcript`

```typescript
interface Transcript {
  sessionId: string;
  turns: TranscriptEntry[];
}

interface TranscriptEntry {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}
```

#### `SessionState`

```typescript
type SessionState =
  | 'idle'           // Waiting for user input
  | 'streaming'      // Receiving model response
  | 'tool_executing' // Running tool calls
  | 'compacting'     // Compacting context
  | 'paused'         // User paused
  | 'error'          // Error state
  | 'done';          // Session ended
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
  | 'tool_call'        // Tool was executed
  | 'file_read'        // File was read
  | 'file_write'       // File was created/modified
  | 'file_delete'      // File was deleted
  | 'command_exec'     // Shell command was executed
  | 'mcp_call'         // MCP tool was called
  | 'agent_spawn'      // Sub-agent was spawned
  | 'permission_ask'   // Permission was requested
  | 'permission_grant' // Permission was granted
  | 'permission_deny'  // Permission was denied
  | 'compact'          // Context was compacted
  | 'session_resume'   // Session was resumed
  | 'custom';          // Custom action type
```

---

## Module: transport (Layer 1)

**Source:** `src/transport/`

Handles all HTTP communication with the MiniMax API. The rest of the system never calls MiniMax directly.

---

### `MiniMaxClient` (`transport/client.ts`)

The single network entry point for the entire system.

#### Constructor

```typescript
new MiniMaxClient(config?: ClientConfig)
```

```typescript
interface ClientConfig {
  model?: string;           // Default: 'MiniMax-M2.7-highspeed'
  maxTokens?: number;       // Default: 16384
  temperature?: number;     // Default: 1.0. MiniMax requires > 0; values <= 0 clamped to 0.01.
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

Streams raw SSE events. Includes automatic model fallback: on `ModelNotFoundError` (HTTP 404) or `ModelFallbackError` (3 consecutive 529 overloads), downgrades to the next model in the chain: best -> balanced -> fast.

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

#### `client.setModel()`

```typescript
setModel(model: string): void
```

Change the active model mid-session. Used by `/model` and `/fast` commands, and by the fallback chain.

#### Getters

```typescript
get model(): string    // The configured model name
get baseUrl(): string  // The resolved API base URL
```

#### `StreamOptions`

```typescript
interface StreamOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;       // MiniMax: must be > 0, range (0, 1]
  systemPrompt?: SystemPrompt;
  tools?: ToolDefinition[];
  abortSignal?: AbortSignal;
}
```

**Example -- single-turn query:**

```typescript
import { MiniMaxClient } from './src/transport/client.js';

const client = new MiniMaxClient({ model: 'MiniMax-M2.7-highspeed' });

const response = await client.complete([
  { role: 'user', content: 'What is 2 + 2?' },
]);

console.log(response.message.content[0]); // TextBlock
```

**Example -- streaming with deltas:**

```typescript
for await (const event of client.stream(messages)) {
  if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
    process.stdout.write(event.delta.text);
  }
}
```

---

### Models and Constants (`transport/client.ts`)

```typescript
const MINIMAX_MODELS = {
  'best':     'MiniMax-M2.7-highspeed',  // 204K context, $0.30/$1.10 per M tokens
  'balanced': 'MiniMax-M2.7',
  'fast':     'MiniMax-M2.5-highspeed',
} as const;

const DEFAULT_MODEL = MINIMAX_MODELS.best;
```

---

### Authentication (`transport/auth.ts`)

```typescript
function resolveAuth(): AuthConfig

interface AuthConfig {
  apiKey: string;
  baseUrl: string;
}
```

Resolves credentials from the environment. Priority order:

**API key:**
1. `MINIMAX_API_KEY`
2. `ANTHROPIC_AUTH_TOKEN`
3. `ANTHROPIC_API_KEY`

**Base URL:**
1. `MINIMAX_BASE_URL`
2. `ANTHROPIC_BASE_URL`
3. `https://api.minimax.io/anthropic/v1` (default)

Throws if no key is found.

---

### Stream Parser (`transport/stream.ts`)

#### `parseSSEStream()`

```typescript
async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  abortSignal?: AbortSignal,
): AsyncGenerator<StreamEvent>
```

Parses Server-Sent Events from MiniMax's Anthropic-compatible endpoint. Handles both standard SSE and the `data: [DONE]` terminator. Skips malformed JSON lines.

#### `accumulateStream()`

```typescript
async function accumulateStream(
  events: AsyncGenerator<StreamEvent>,
  callbacks?: StreamCallbacks,
): Promise<AccumulatedResponse>
```

Processes stream events, builds up complete content blocks, and returns the final `AssistantMessage`. Handles MiniMax-specific `reasoning_details` on `message_start` and `reasoning.text` events.

#### `StreamCallbacks`

```typescript
interface StreamCallbacks {
  onContentBlockStart?(index: number, type: string): void;
  onDelta?(index: number, delta: ContentDelta): void;
  onContentBlockComplete?(index: number, block: ContentBlock): void;
}
```

---

### Errors (`transport/errors.ts`)

#### Error Hierarchy

```typescript
class TransportError extends Error {
  constructor(message: string, statusCode: number | null, retryable: boolean, retryAfterMs?: number)
}

class RateLimitError extends TransportError       // HTTP 429
class ContextTooLongError extends TransportError   // HTTP 400, prompt too long
class AuthenticationError extends TransportError   // HTTP 401/403
class StreamTimeoutError extends TransportError    // Timeout during streaming
class ModelNotFoundError extends TransportError    // HTTP 404, model not found
class ModelFallbackError extends Error             // After MAX_529_RETRIES consecutive 529s
```

#### `classifyHttpError()`

```typescript
function classifyHttpError(status: number, body: string): TransportError
```

Maps HTTP status codes to specific error types with appropriate retry hints.

#### Retry Configuration

```typescript
interface RetryConfig {
  maxRetries: number;     // Default: 10
  baseDelayMs: number;    // Default: 500
  maxDelayMs: number;     // Default: 32000
}

const DEFAULT_RETRY_CONFIG: RetryConfig;
const MAX_529_RETRIES = 3;   // Before triggering model fallback
```

#### `withRetry()`

```typescript
async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  config?: RetryConfig,
  onRetry?: (attempt: number, error: Error, delayMs: number) => void,
): Promise<T>
```

Exponential backoff with 25% jitter. Respects server `Retry-After` headers. Throws `ModelFallbackError` after `MAX_529_RETRIES` consecutive 529 errors.

---

## Module: engine (Layer 2)

**Source:** `src/engine/`

The core agentic loop, turn management, budget tracking, interrupt control, task strategy, and post-turn intelligence.

---

### Agentic Loop (`engine/loop.ts`)

#### `LoopConfig`

```typescript
interface LoopConfig {
  client: MiniMaxClient;
  systemPrompt?: SystemPrompt;
  tools?: Map<string, Tool>;
  toolDefinitions?: ToolDefinition[];
  maxTurns?: number;               // Default: 100
  maxBudgetUsd?: number;
  toolContext?: ToolContext;
  hookRegistry?: HookRegistry;     // Plugin hooks for Pre/PostToolUse and OnMessage
  reflectionInterval?: number;     // Inject reflection prompts every N turns (0 = disabled)
  harnessRuntime?: HarnessRuntime; // Runtime overrides for Meta-Harness
}
```

#### `LoopEvent`

Events yielded by the agentic loop for UI consumption:

```typescript
type LoopEvent =
  | { type: 'turn_start'; turnIndex: number }
  | { type: 'stream_delta'; delta: ContentDelta; blockIndex: number }
  | { type: 'stream_text'; text: string }
  | { type: 'stream_thinking'; thinking: string }
  | { type: 'stream_tool_start'; toolName: string; toolId: string }
  | { type: 'assistant_message'; message: AssistantMessage }
  | { type: 'tool_executing'; call: ToolCall; triggeredBy: ActionTriggerBy }
  | { type: 'tool_result'; result: ToolResult; durationMs?: number }
  | { type: 'tool_result_message'; message: UserMessage }
  | { type: 'turn_end'; turnIndex: number; usage: Usage }
  | { type: 'history_sync'; messages: Message[] }
  | { type: 'loop_end'; reason: string; totalUsage: Usage; totalCost: number }
  | { type: 'error'; error: Error };
```

#### `runLoop()`

```typescript
async function* runLoop(
  initialMessages: Message[],
  config: LoopConfig,
  interrupt?: InterruptController,
): AsyncGenerator<LoopEvent>
```

The core while(true) loop that powers the agent:

1. Stream model response
2. Check stop reason
3. If `tool_use` -> execute tools -> append results -> continue
4. If `end_turn` -> done

**Features:**
- Loop detection: detects 3 identical consecutive tool calls and injects a corrective message
- Hook integration: runs `PreToolUse` (can block/modify), `PostToolUse` (can modify result), `OnMessage` (fire-and-forget)
- Permission checks: delegates to `ToolContext.askPermission`
- Auto-continuation: on `max_tokens` without tool use, if budget allows, auto-sends a continuation prompt
- Mid-turn reflection: injects reflection prompts at configurable intervals
- Tool timeout: configurable per-tool timeout (default 300s), overridable via `harnessRuntime.toolTimeoutMs`

**Example:**

```typescript
import { runLoop } from './src/engine/loop.js';
import { MiniMaxClient } from './src/transport/client.js';
import { InterruptController } from './src/engine/interrupts.js';

const client = new MiniMaxClient();
const interrupt = new InterruptController();

const messages = [{ role: 'user' as const, content: 'Hello' }];

for await (const event of runLoop(messages, { client }, interrupt)) {
  if (event.type === 'assistant_message') {
    console.log('Response:', event.message);
  }
  if (event.type === 'loop_end') {
    console.log(`Done: ${event.reason}, cost: $${event.totalCost.toFixed(4)}`);
  }
}
```

#### `query()`

```typescript
async function query(
  prompt: string,
  config: Omit<LoopConfig, 'tools' | 'toolDefinitions'>,
): Promise<AssistantMessage>
```

Single-turn query without tool execution. Useful for simple prompts and testing.

---

### Turn Management (`engine/turns.ts`)

#### `TurnResult`

```typescript
interface TurnResult {
  assistantMessage: AssistantMessage;
  stopReason: string | null;
  usage: Usage;
  toolCalls: ToolCall[];
  needsToolExecution: boolean;
}
```

#### `analyzeTurn()`

```typescript
function analyzeTurn(
  assistantMessage: AssistantMessage,
  stopReason: string | null,
  usage: Usage,
): TurnResult
```

Analyze an assistant response and determine what to do next. Extracts tool calls from `ToolUseBlock`s.

#### `buildToolResultMessage()`

```typescript
function buildToolResultMessage(results: ToolResult[]): UserMessage
```

Build a `tool_result` user message from executed tool results. The full assistant response (including reasoning) must be preserved in conversation history -- this function only appends.

#### `ensureToolResultPairing()`

```typescript
function ensureToolResultPairing(messages: Message[]): Message[]
```

Ensures all `tool_use` blocks in assistant messages have matching `tool_result` blocks in the following user message. Orphaned `tool_use`s get synthetic error results. Also removes orphaned `tool_result`s that have no matching `tool_use`.

#### `shouldContinue()`

```typescript
function shouldContinue(
  turnResult: TurnResult,
  turnCount: number,
  maxTurns: number,
  budgetAllowsContinuation?: boolean,
): { continue: boolean; reason?: string; autoContinue?: boolean }
```

Determines whether the loop should continue based on stop reason, turn count, and budget.

#### `ContinuationTracker`

```typescript
class ContinuationTracker {
  shouldContinue(usedTokens: number, contextWindow: number): boolean
  recordContinuation(outputTokens: number): void
  reset(): void
  get count(): number
}
```

Tracks auto-continuation state. Stops after `MAX_CONTINUATIONS` (5) or when diminishing returns are detected (last 2 continuations each added fewer than 500 tokens).

**Constants:**

```typescript
const DEFAULT_MAX_TURNS = 100;
const CONTINUATION_THRESHOLD = 0.9;         // 90% of budget
const DIMINISHING_RETURNS_THRESHOLD = 500;
const MAX_CONTINUATIONS = 5;
```

---

### Budget Tracker (`engine/budget.ts`)

#### `BudgetTracker`

```typescript
class BudgetTracker {
  constructor(model: string, maxBudgetUsd?: number)
  addTurnUsage(usage: Usage): void
  isOverBudget(): boolean
  getTotalCostUsd(): number
  getTotalUsage(): Usage
  getTurnCount(): number
  getSummary(): string  // e.g., "5 turns | 12,345 in / 6,789 out | $0.0142"
}
```

#### Pricing

```typescript
interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheWritePerMillion?: number;
  cacheReadPerMillion?: number;
}

const MINIMAX_PRICING: Record<string, ModelPricing> = {
  'MiniMax-M2.7-highspeed': { inputPerMillion: 0.30, outputPerMillion: 1.10 },
  'MiniMax-M2.7':           { inputPerMillion: 0.30, outputPerMillion: 1.10 },
  'MiniMax-M2.5-highspeed': { inputPerMillion: 0.15, outputPerMillion: 0.55 },
};
```

#### `calculateCost()`

```typescript
function calculateCost(usage: Usage, model: string): number
```

Returns the cost in USD for the given usage. Falls back to M2.7-highspeed pricing for unknown models.

#### Context Windows

```typescript
const MINIMAX_CONTEXT_WINDOWS: Record<string, number> = {
  'MiniMax-M2.7-highspeed': 204_800,
  'MiniMax-M2.7':           204_800,
  'MiniMax-M2.5-highspeed': 204_800,
  'MiniMax-M2.5':           204_800,
};

function getContextWindow(model: string): number  // Default: 204_800
```

---

### Interrupt Controller (`engine/interrupts.ts`)

#### `InterruptController`

```typescript
class InterruptController {
  get signal(): AbortSignal
  get paused(): boolean
  get aborted(): boolean

  abort(reason?: string): void     // Abort. Cannot be resumed.
  pause(): void                    // Pause. Next checkpoint() blocks.
  resume(): void                   // Resume a paused loop.
  async checkpoint(): Promise<void>  // Call at await points. Blocks if paused, throws if aborted.
  reset(): void                    // Reset for a new operation.
}
```

#### Error Types

```typescript
class AbortError extends Error {
  constructor(message?: string)
}

function isAbortError(error: unknown): error is AbortError
```

Returns true for `AbortError`, native `AbortError`, and `DOMException` with name `AbortError`.

---

### Task Strategy (`engine/strategy.ts`)

The "brain" layer that classifies task complexity and generates strategic hints injected into the system prompt.

#### Types

```typescript
type Complexity = 'trivial' | 'simple' | 'complex' | 'epic';

interface TaskStrategy {
  complexity: Complexity;
  strategyPrompt: string | null;   // null = no injection
  reflectionInterval: number;      // 0 = never
  classifiedBy: 'heuristic' | 'llm';
}

interface StrategyOverrides {
  complexityOverride?: Complexity;
  strategyPrompts?: Partial<Record<Complexity, string | null>>;
  reflectionIntervals?: Partial<Record<Complexity, number>>;
}
```

#### `classifyByHeuristics()`

```typescript
function classifyByHeuristics(input: string): Complexity | null
```

Zero-token heuristic classifier. Returns `null` for ambiguous inputs (defers to LLM). Supports both English and French keywords.

#### `analyzeTask()`

```typescript
async function analyzeTask(
  input: string,
  messages: Message[],
  client: MiniMaxClient,
  overrides?: StrategyOverrides,
): Promise<TaskStrategy>
```

Main entry point. Heuristic-first (0 tokens), LLM-fallback (~150 tokens via M2.5) for ambiguous tasks. Skips analysis for slash commands and inputs shorter than 5 characters.

**Reflection intervals by complexity:**
| Complexity | Reflection Interval |
|------------|-------------------|
| trivial    | 0 (disabled)      |
| simple     | 5                 |
| complex    | 3                 |
| epic       | 3                 |

---

### Post-Turn Intelligence (`engine/intelligence.ts`)

Three background agent forks that run AFTER each model turn, all asynchronous (fire-and-forget).

#### `generatePromptSuggestion()`

```typescript
async function generatePromptSuggestion(
  client: MiniMaxClient,
  messages: Message[],
  model?: string,
): Promise<string | null>
```

Predicts what the user might type next. Returns null if no good suggestion. Uses last 4 messages for context. Applies a 13-filter pipeline to reject evaluative, question-form, or Claude-voiced suggestions.

#### `speculate()`

```typescript
async function speculate(
  client: MiniMaxClient,
  suggestedPrompt: string,
  recentMessages: Message[],
  model?: string,
): Promise<SpeculationResult | null>

interface SpeculationResult {
  analysis: string;
  suggestedPrompt: string;
}
```

Read-only pre-execution of a suggested prompt. Determines what the user wants and plans the first 2-3 tool calls using only read-only tools.

#### `extractMemories()`

```typescript
async function extractMemories(
  client: MiniMaxClient,
  messages: Message[],
  model?: string,
): Promise<ExtractedMemory[]>

interface ExtractedMemory {
  title: string;
  content: string;
}
```

Extracts knowledge-worthy facts from recent conversation. Highly selective: 0-3 items per turn. Rejects secrets, PII, and ephemeral details.

#### `runPostTurnIntelligence()`

```typescript
async function runPostTurnIntelligence(
  config: IntelligenceConfig,
  onResult: (result: IntelligenceResult) => void,
): Promise<void>

interface IntelligenceConfig {
  client: MiniMaxClient;
  messages: Message[];
  enableSuggestion?: boolean;          // Default: true
  enableSpeculation?: boolean;         // Default: true
  enableMemoryExtraction?: boolean;    // Default: true
  intelligenceModel?: string;          // Override model (e.g., cheaper M2.5)
}

interface IntelligenceResult {
  suggestion: string | null;
  speculation: SpeculationResult | null;
  memories: ExtractedMemory[];
}
```

Runs all 3 intelligence layers in parallel. Speculation only runs if a suggestion was generated.

---

## Module: tools (Layer 3)

**Source:** `src/tools/`

---

### Tool Registry (`tools/registry.ts`)

#### `ToolRegistryImpl`

```typescript
class ToolRegistryImpl implements ToolRegistry {
  getAll(): Tool[]
  get(name: string): Tool | undefined
  register(tool: Tool): void
  getDefinitions(): ToolDefinition[]
  has(name: string): boolean
  get size(): number
}
```

Dynamic tool registration and lookup. Tools register themselves and the registry provides definitions to the model.

---

### Tool Executor (`tools/executor.ts`)

#### Execution Strategy

Tools are partitioned into batches following the OpenClaude pattern:
- **Read-only tools** (`concurrencySafe: true`): grouped and run in parallel (max 10 concurrent)
- **Mutating tools**: run alone, sequentially

#### `partitionToolCalls()`

```typescript
function partitionToolCalls(
  calls: ToolCall[],
  registry: ToolRegistryImpl,
): Array<{ calls: Array<{ call: ToolCall; tool: Tool | null }>; parallel: boolean }>
```

#### `executeToolCalls()`

```typescript
async function executeToolCalls(
  calls: ToolCall[],
  registry: ToolRegistryImpl,
  context: ToolContext,
): Promise<ExecutionResult>

interface ExecutionResult {
  results: ToolResult[];
  durationMs: number;
}
```

Execute a batch of tool calls from a single assistant turn with automatic batching, validation, and error handling.

---

## Module: policy (Layer 4)

**Source:** `src/policy/`

---

### Permission Modes (`policy/modes.ts`)

#### Tool Categories

```typescript
type ToolCategory =
  | 'read'     // FileRead, Glob, Grep -- observe only
  | 'write'    // FileWrite, FileEdit -- modify files
  | 'execute'  // Bash -- run arbitrary commands
  | 'network'  // WebFetch, WebSearch -- external network
  | 'agent'    // AgentTool, SendMessage -- spawn sub-agents
  | 'system';  // MCP, LSP, Cron, etc.
```

#### `getToolCategory()`

```typescript
function getToolCategory(toolName: string): ToolCategory
```

Maps tool names to categories. Known mappings: Read/Glob/Grep -> read, Write/Edit/NotebookEdit -> write, Bash/PowerShell -> execute, WebFetch/WebSearch -> network, Agent/SendMessage/TeamCreate -> agent. Everything else -> system.

#### Permission Decision Matrix

```typescript
type PermissionDecision = 'allow' | 'ask' | 'deny';
```

|             | read  | write | execute | network | agent | system |
|-------------|-------|-------|---------|---------|-------|--------|
| plan        | ask   | ask   | ask     | ask     | ask   | ask    |
| default     | allow | ask   | ask     | allow   | ask   | ask    |
| acceptEdits | allow | allow | ask     | allow   | ask   | ask    |
| fullAuto    | allow | allow | auto*   | allow   | allow | allow  |
| bypass      | allow | allow | allow   | allow   | allow | allow  |

*fullAuto for execute: decision deferred to the bash risk classifier

#### `getDefaultDecision()`

```typescript
function getDefaultDecision(mode: PermissionMode, category: ToolCategory): PermissionDecision
```

#### Mode Descriptions

```typescript
const MODE_DESCRIPTIONS: Record<PermissionMode, string>;
// plan:        "All actions require confirmation. Safest mode."
// default:     "Read-only auto-allowed. File changes and commands prompt."
// acceptEdits: "File edits auto-allowed. Shell commands still prompt."
// fullAuto:    "Most actions auto-allowed. Only risky commands prompt."
// bypass:      "Everything auto-allowed. No prompts. Full trust."
```

---

### Permission Resolver (`policy/permissions.ts`)

#### `PermissionResult`

```typescript
interface PermissionResult {
  decision: PermissionDecision;
  reason: string;
  source: 'builtin' | 'user' | 'classifier' | 'mode';
  riskLevel?: RiskLevel;
}
```

#### `PermissionResolver`

```typescript
class PermissionResolver {
  constructor(mode: PermissionMode, userRules?: PermissionRule[])

  resolve(call: ToolCall): PermissionResult
  allowForSession(call: ToolCall): void
  setMode(mode: PermissionMode): void
  getMode(): PermissionMode
}
```

**Resolution order:**
1. Built-in deny rules (always checked first)
2. User rules (allow/deny/ask)
3. Session-level "always allow" (user said "yes, always" during session)
4. Tool category + mode default matrix
5. For `fullAuto` + `execute` category: deferred to bash risk classifier

---

## Module: context (Layer 5)

**Source:** `src/context/`

---

### Session Persistence (`context/session/persistence.ts`)

#### `SessionData`

```typescript
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
```

#### `SessionManager`

Storage: `~/.pcc/sessions/{sessionId}.json`

```typescript
class SessionManager {
  createSession(projectDir: string, model: string): SessionData
  async save(session: SessionData): Promise<string>           // Returns file path
  async load(sessionId: string): Promise<SessionData | null>
  async loadLatest(projectDir: string): Promise<SessionData | null>
  async listRecent(limit?: number): Promise<SessionSummary[]> // Default: 10
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

### Memory Agent (`context/memory/agent.ts`)

Unified coordinator for ALL memory operations. Obsidian vault = source of truth (if available), `index.json` = fast local cache.

#### `MemoryItem`

```typescript
interface MemoryItem {
  title: string;
  content: string;
  type: 'decision' | 'preference' | 'project_fact' | 'error_solution' | 'reference' | 'user_role';
  confidence: number;
  source: 'hint' | 'llm' | 'manual';
  tags: string[];
  timestamp: string;
  vaultPath?: string;
}
```

#### `MemoryAgent`

```typescript
class MemoryAgent {
  constructor(vault: ObsidianVault | null, projectDir: string)

  // Lifecycle
  async loadIndex(): Promise<void>
  async flushIndex(): Promise<void>

  // Extraction
  extractHints(userMessage: string): MemoryItem[]
  async saveLLMExtracted(memories: Array<{ title: string; content: string }>): Promise<number>

  // Save (deduplicates, Obsidian-first + index cache)
  async save(item: MemoryItem): Promise<boolean>

  // Search
  async getRelevantContext(query: string, limit?: number): Promise<string>   // Default: 5
  getStartupContext(): string     // Top 10 most recent, no query filter

  // Maintenance (archive stale, generate digest)
  async maintenance(): Promise<{ archived: number; digestCreated: boolean }>

  get count(): number
}
```

**Features:**
- Query expansion: "database" also matches "postgresql", "mongodb", etc.
- Sensitive data redaction: rejects memories containing secrets/PII via pattern matching
- Deduplication via title slug and content prefix comparison
- Relevance scoring with title (3x), tag (2x), and content (1x) weights plus recency boost

#### `redactSensitive()` / `isSuspiciousMemory()`

```typescript
function redactSensitive(text: string): string
function isSuspiciousMemory(content: string): boolean
```

Detects and redacts API keys (sk-*, ghp_*, ghu_*, glpat-*, xoxb-*, AKIA*), Bearer tokens, connection strings, and password patterns.

---

### Compaction (`context/compactor.ts`)

#### `CompactionConfig`

```typescript
interface CompactionConfig {
  keepRecentTurns: number;     // Default: 6
  summaryMaxTokens: number;    // Default: 2048
}

const DEFAULT_COMPACTION_CONFIG: CompactionConfig;
```

#### `compactConversation()`

```typescript
async function compactConversation(
  messages: Message[],
  client: MiniMaxClient,
  config?: CompactionConfig,
): Promise<CompactionResult>

interface CompactionResult {
  messages: Message[];
  wasCompacted: boolean;
  removedTurns: number;
  summaryLength?: number;
}
```

Strategy:
1. Keep the system prompt untouched
2. Keep the last N turns intact (recent context)
3. Summarize everything before that into a structured action log
4. Preserve tool_use/tool_result pairing in kept turns
5. On summary generation failure, return original messages (never lose context)

---

### Token Budget Tracker (`context/tokenBudget.ts`)

#### `TokenBudgetConfig`

```typescript
interface TokenBudgetConfig {
  model: string;
  compactionThreshold: number;   // Default: 0.75 (75% of context window)
  reserveForOutput: number;      // Default: 8192
}
```

#### `TokenBudgetTracker`

```typescript
class TokenBudgetTracker {
  constructor(config?: Partial<TokenBudgetConfig>)

  updateFromUsage(usage: Usage): void
  reset(): void
  shouldCompact(): boolean
  isNearLimit(): boolean
  getAvailableTokens(): number
  getStatus(): TokenBudgetStatus
  shouldAutoCompact(): boolean       // Buffer-based (within 13K of limit)
  recordCompactSuccess(): void       // Reset circuit breaker
  recordCompactFailure(): void       // Increment circuit breaker
  get compactCircuitBroken(): boolean
  get lastInputTokens(): number
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

**Constants:**

```typescript
const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
const WARNING_BUFFER_TOKENS = 20_000;
const MAX_COMPACT_FAILURES = 3;
```

#### `estimateTokens()`

```typescript
function estimateTokens(messages: Message[]): number
```

Local heuristic: ~3.5 chars per token average. Intentionally conservative (overestimates).

---

## Module: commands (Layer 7)

**Source:** `src/commands/`

---

### Command Registry (`commands/registry.ts`)

#### `Command`

```typescript
interface Command {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  execute: (args: string, ctx: CommandContext) => Promise<CommandResult>;
}
```

#### `CommandContext`

```typescript
interface CommandContext {
  cwd: string;
  messages: Message[];
  info: (msg: string) => void;
  error: (msg: string) => void;
  query?: (prompt: string) => Promise<string>;
  client?: MiniMaxClient;
}
```

#### `CommandResult`

```typescript
type CommandResult =
  | { type: 'handled' }                    // Command handled, nothing more needed
  | { type: 'prompt'; prompt: string }     // Inject as user message to the model
  | { type: 'clear' }                      // Clear conversation
  | { type: 'exit'; reason: string }       // Exit the REPL
  | { type: 'error'; message: string };    // Error occurred
```

#### `CommandRegistry`

```typescript
class CommandRegistry {
  register(command: Command): void
  get(name: string): Command | undefined
  getAll(): Command[]   // Deduplicated (aliases map to same command)
  async dispatch(input: string, ctx: CommandContext): Promise<CommandResult | null>
}
```

`dispatch()` returns `null` if the input is not a command (does not start with `/`).

---

## Module: agents (Layer 8)

**Source:** `src/agents/`

---

### Agent Orchestrator (`agents/orchestrator.ts`)

Spawns and manages sub-agents. A sub-agent is simply another `runLoop()` with its own conversation, budget, and restricted tool set.

#### Limits

```typescript
const MAX_AGENT_DEPTH = 3;       // Maximum recursion depth for nested agents
const MAX_ACTIVE_AGENTS = 15;    // Maximum concurrent active agents across all depths
```

#### `AgentDefinition`

```typescript
interface AgentDefinition {
  name: string;
  rolePrompt: string;
  allowedTools?: string[];   // null = all available
  maxTurns: number;
  maxBudgetUsd?: number;
}
```

#### Built-in Agent Types

| Name      | Role | Allowed Tools | Max Turns |
|-----------|------|---------------|-----------|
| `general` | Execute any task with all tools | all | 15 |
| `explore` | Search, read, understand code (read-only) | Read, Glob, Grep, Bash | 10 |
| `code`    | Execute code changes precisely | all | 20 |
| `review`  | Analyze code for bugs, security, quality (read-only) | Read, Glob, Grep, Bash | 10 |
| `test`    | Write and run tests | all | 15 |

#### `AgentResult`

```typescript
interface AgentResult {
  response: string;
  events: LoopEvent[];
  messages?: Message[];       // Canonical history at loop end
  success: boolean;
  endReason: string;
  costUsd: number;
  turns: number;
  worktree?: Worktree;       // If isolation='worktree' and changes were made
  cleanupWarnings?: string[];
}
```

#### `AgentOrchestrator`

```typescript
class AgentOrchestrator {
  constructor(
    client: MiniMaxClient,
    tools: Map<string, Tool>,
    toolContext: ToolContext,
    agentRegistry?: Record<string, AgentDefinition>,
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

#### `SpawnOptions`

```typescript
interface SpawnOptions {
  allowedTools?: string[];
  context?: string;              // Additional context for the agent's system prompt
  cwd?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  onEvent?: (event: LoopEvent) => void;
  depth?: number;                // Current recursion depth (0 = top-level)
  isolation?: 'worktree';       // Creates a git worktree for the agent
}
```

**Depth-aware tool handling:** At `MAX_AGENT_DEPTH`, the Agent tool is removed entirely. Below max depth, the Agent tool is cloned with an incremented depth counter.

**Worktree isolation:** When `isolation: 'worktree'` is set, the agent runs in a fresh git worktree. If no changes were made, the worktree is auto-cleaned. If changes remain, the `worktree` metadata is returned in `AgentResult` so the caller can merge/inspect.

---

## Module: automation (Layer 9)

**Source:** `src/automation/`

---

### Background Manager (`automation/background.ts`)

Run agentic loops in the background within the same process.

#### `BackgroundSession`

```typescript
interface BackgroundSession {
  id: string;
  name: string;
  prompt: string;
  status: 'running' | 'completed' | 'error' | 'aborted';
  startedAt: string;
  endedAt?: string;
  turns: number;
  costUsd: number;
  response?: string;
  error?: string;
  log: string[];     // Output log buffer (recent 200 lines)
}
```

#### `BackgroundManager`

Extends `EventEmitter`.

```typescript
class BackgroundManager extends EventEmitter {
  async start(
    name: string,
    prompt: string,
    config: LoopConfig,
  ): Promise<BackgroundSession>

  abort(id: string): boolean
  attach(id: string, listener: (line: string) => void): (() => void) | null  // Returns unsub fn
  getSession(id: string): BackgroundSession | undefined
  list(status?: BackgroundSession['status']): BackgroundSession[]
  remove(id: string): boolean      // Only for completed/errored/aborted
  get activeCount(): number
}
```

**Events:**
- `session:start` -- emitted with `BackgroundSession`
- `session:end` -- emitted with `BackgroundSession`

---

### Scheduler (`automation/scheduler.ts`)

Cron-like scheduling for recurring agent tasks.

#### `ScheduledJob`

```typescript
interface ScheduledJob {
  id: string;
  name: string;
  prompt: string;
  schedule: { type: 'cron'; expression: string } | { type: 'interval'; ms: number };
  timeoutMs?: number;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastResult?: string;
  runCount: number;
  cwd?: string;
  agentType?: string;
}
```

#### `Scheduler`

Extends `EventEmitter`.

```typescript
class Scheduler extends EventEmitter {
  setExecutor(executor: JobExecutor): void   // Must be called before start()
  start(): void        // Starts tick timer (60s) and interval jobs
  stop(): void         // Stops all timers

  addJob(config: Omit<ScheduledJob, 'id' | 'createdAt' | 'runCount'>): ScheduledJob
  removeJob(id: string): boolean
  setJobEnabled(id: string, enabled: boolean): void
  listJobs(): ScheduledJob[]
  getJob(id: string): ScheduledJob | undefined
  isRunning(id: string): boolean
  async runNow(id: string): Promise<string>  // Force-run immediately
}

type JobExecutor = (job: ScheduledJob) => Promise<string>;
```

**Events:**
- `job:start` -- emitted with `ScheduledJob`
- `job:complete` -- emitted with `ScheduledJob`, result string
- `job:error` -- emitted with `ScheduledJob`, `Error`
- `tick` -- emitted with `Date`

#### Cron Expression Parser

```typescript
function parseCron(expr: string): CronSchedule
function cronMatches(schedule: CronSchedule, date: Date): boolean
```

Supports 5-field cron (minute hour dom month dow). Supports: numbers, `*`, `/step`, and comma-separated values. Does NOT support: ranges (1-5), L, W, #.

---

## Module: credentials

**Source:** `src/credentials/`

---

### Credential Vault (`credentials/vault.ts`)

AES-256-GCM encryption with PBKDF2 key derivation (100K iterations, SHA-512).

Storage: `~/.pcc/credentials.enc`

#### `CredentialVault`

```typescript
class CredentialVault {
  constructor(vaultPath?: string)     // Default: ~/.pcc/credentials.enc

  get path(): string
  get isUnlocked(): boolean

  async exists(): Promise<boolean>
  async init(masterPassword: string): Promise<void>
  async unlock(masterPassword: string): Promise<void>

  async add(credential: Credential): Promise<void>
  async remove(service: ServiceType, label?: string): Promise<boolean>
  get(service: ServiceType, label?: string): Credential | undefined
  getValue(service: ServiceType, key: string, label?: string): string | undefined
  getByDomain(domain: string): Credential | undefined
  list(): Array<{ service: ServiceType; label: string; addedAt: string }>
  async changePassword(currentPassword: string, newPassword: string): Promise<void>
  lock(): void
}
```

**Error types:**
- `WrongPasswordError` -- password doesn't match
- `CorruptedVaultError` -- file is malformed or unsupported version
- `VaultNotFoundError` -- vault file doesn't exist
- `VaultDiskError` -- IO/permission error
- `VaultAlreadyExistsError` -- vault file already exists on `init()`

Zero silent errors: every failure throws a typed error subclass.

---

### Credential Provider (`credentials/provider.ts`)

High-level API for tools to request credentials. Tools NEVER see the vault directly.

```typescript
class CredentialProvider {
  constructor(vault: CredentialVault)

  getToken(service: ServiceType): string | null
  getCredential(service: ServiceType): Record<string, string> | null
  getAuthHeaders(url: string): Record<string, string>   // Auto-detects service from domain
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

**Security:** Credentials are NEVER injected into LLM context. Only the tool's execution result (e.g., API response content) is returned.

**Supported services with auto-header building:** github, gitlab, vercel, supabase, cloudflare, notion, slack. All others default to Bearer token.

---

## Module: skills (Layer 13)

**Source:** `src/skills/`

---

### Skill Registry (`skills/loader.ts`)

Skills are domain-specific workflows that extend the agent's capabilities.

#### `Skill`

```typescript
interface Skill {
  name: string;
  description: string;
  category: SkillCategory;
  triggers: SkillTrigger[];
  execute: (ctx: SkillContext) => Promise<SkillResult>;
  requiredTools?: string[];
  background?: boolean;
}

type SkillCategory =
  | 'workflow'     // Multi-step generation pipelines
  | 'analysis'     // Code analysis, review, exploration
  | 'automation'   // Recurring/proactive tasks
  | 'knowledge'    // Second brain, Obsidian, memory
  | 'utility'      // One-shot utilities
  | 'custom';      // User-defined
```

#### Trigger Types

```typescript
type SkillTrigger =
  | { type: 'command'; command: string }     // Matches /skillname
  | { type: 'keyword'; keywords: string[] }  // Matches if any keyword present
  | { type: 'pattern'; regex: RegExp }       // Matches a regex
  | { type: 'always' };                      // Always active
```

#### `SkillContext`

```typescript
interface SkillContext {
  input: string;
  args: string;
  cwd: string;
  messages: Message[];
  toolContext: ToolContext;
  tools: Map<string, Tool>;
  info: (msg: string) => void;
  error: (msg: string) => void;
  query: (prompt: string) => Promise<string>;
  runAgent: (prompt: string) => Promise<string>;
}
```

#### `SkillResult`

```typescript
type SkillResult =
  | { type: 'handled' }
  | { type: 'prompt'; prompt: string }
  | { type: 'error'; message: string };
```

#### `SkillRegistry`

```typescript
class SkillRegistry extends EventEmitter {
  register(skill: Skill): void
  unregister(name: string): boolean
  get(name: string): Skill | undefined
  getAll(): Skill[]
  getByCategory(category: SkillCategory): Skill[]
  match(input: string): { skill: Skill; args: string } | null
  getAlwaysActive(): Skill[]
  get size(): number
}
```

**Match order:** command triggers (exact) -> keyword triggers -> pattern triggers.

#### Loader Functions

```typescript
function loadBundledSkills(registry: SkillRegistry): void
async function loadExternalSkills(registry: SkillRegistry, directory: string): Promise<number>
function generateSkillsPrompt(registry: SkillRegistry): string
```

`loadExternalSkills` loads `.ts`, `.js`, and `.mjs` files that export a `skill` object.

---

## Module: plugins (Layer 14)

**Source:** `src/plugins/`

---

### Hook System (`plugins/hooks.ts`)

#### Hook Types

```typescript
type HookType =
  | 'PreToolUse'    // Before a tool executes (can modify input or block)
  | 'PostToolUse'   // After a tool executes (can modify output)
  | 'PreCommand'    // Before a slash command
  | 'PostCommand'   // After a slash command
  | 'OnMessage'     // When a new message is added
  | 'OnStart'       // When PCC starts
  | 'OnExit';       // When PCC is about to exit
```

#### Hook Payloads and Results

```typescript
interface PreToolUsePayload {
  tool: string;
  call: ToolCall;
}

interface PreToolUseResult {
  proceed: boolean;
  modifiedCall?: ToolCall;
  blockReason?: string;
}

interface PostToolUsePayload {
  tool: string;
  call: ToolCall;
  result: ToolResult;
  durationMs: number;
}

interface PostToolUseResult {
  modifiedResult?: ToolResult;
}

interface CommandPayload {
  command: string;
  args: string;
}

interface MessagePayload {
  message: Message;
  role: 'user' | 'assistant';
}
```

#### Handler Types

```typescript
type PreToolUseHandler = (payload: PreToolUsePayload) => Promise<PreToolUseResult>;
type PostToolUseHandler = (payload: PostToolUsePayload) => Promise<PostToolUseResult>;
type CommandHandler = (payload: CommandPayload) => Promise<void>;
type MessageHandler = (payload: MessagePayload) => Promise<void>;
type LifecycleHandler = () => Promise<void>;

interface HookHandler {
  type: HookType;
  pluginName: string;
  priority: number;    // Lower = runs first (0-100)
  handler: PreToolUseHandler | PostToolUseHandler | CommandHandler | MessageHandler | LifecycleHandler;
}
```

#### `HookRegistry`

Extends `EventEmitter`.

```typescript
class HookRegistry extends EventEmitter {
  register(hook: HookHandler): void
  unregisterPlugin(pluginName: string): void

  async runPreToolUse(payload: PreToolUsePayload): Promise<PreToolUseResult>
  async runPostToolUse(payload: PostToolUsePayload): Promise<PostToolUseResult>
  async runCommandHook(type: 'PreCommand' | 'PostCommand', payload: CommandPayload): Promise<void>
  async runMessageHook(payload: MessagePayload): Promise<void>
  async runLifecycleHook(type: 'OnStart' | 'OnExit'): Promise<void>

  getHooks(type: HookType): HookHandler[]
  getAllHooks(): HookHandler[]
  get totalCount(): number
}
```

**Events:**
- `hook:blocked` -- emitted with `(pluginName, type, reason)`
- `hook:error` -- emitted with `(pluginName, type, error)`

**PreToolUse** hooks run in priority order. The first to return `proceed: false` blocks execution. Each hook may mutate the `ToolCall` via `modifiedCall`.

**PostToolUse** hooks run in priority order. Each may replace the `ToolResult` via `modifiedResult`.

---

### Plugin Registry (`plugins/registry.ts`)

Central registry that manages loaded plugins and integrates their contributions (tools, commands, skills, hooks) into the main system.

#### `PluginRegistry`

Extends `EventEmitter`.

```typescript
class PluginRegistry extends EventEmitter {
  async loadAll(
    projectDir: string,
    toolRegistry: ToolRegistry,
    commandRegistry: CommandRegistry,
    skillRegistry: SkillRegistry,
    pluginOptions?: LoadPluginOptions,
  ): Promise<{ loaded: number; failed: number }>

  getHookRegistry(): HookRegistry
  get(name: string): Plugin | undefined
  list(): Plugin[]
  listActive(): Plugin[]
  unload(name: string): boolean
  getSummary(): string
  get size(): number
  get activeCount(): number
}
```

**Events:**
- `plugin:loaded` -- emitted with plugin name
- `plugin:unloaded` -- emitted with plugin name
- `plugin:error` -- emitted with `(pluginName, error)`
- `plugin:hook-error` -- forwarded from HookRegistry
- `plugin:hook-blocked` -- forwarded from HookRegistry

---

## Module: meta (Layer 14+)

**Source:** `src/meta/`

The Meta-Harness outer-loop optimizer. Reference: "Meta-Harness: End-to-End Optimization of Model Harnesses" (Lee et al., arXiv 2603.28052).

---

### Meta Types (`meta/types.ts`)

#### `HarnessConfig`

The mutable configuration knobs around the Shugu engine. The proposer edits these; the evaluator applies them.

**V1 restrictions:** BASE_SYSTEM_PROMPT is IMMUTABLE (no systemPromptOverride). Model name is fixed per run. Transport/protocol/policy/credentials are IMMUTABLE zones.

```typescript
interface HarnessConfig {
  name: string;
  version: string;
  parent?: string;

  // Prompt mutations (base is immutable)
  systemPromptAppend?: string;
  promptFragments?: Record<string, string>;

  // Strategy mutations
  strategy?: {
    classifyPrompt?: string;
    complexityOverride?: Complexity;
    strategyPrompts?: Partial<Record<Complexity, string | null>>;
    reflectionIntervals?: Partial<Record<Complexity, number>>;
  };

  // Reflection mutations
  reflection?: {
    promptTemplate?: string;   // Use {{turnIndex}} and {{maxTurns}}
    forceInterval?: number;
  };

  // Agent profile mutations
  agents?: Record<string, Partial<AgentDefinition>>;

  // Limits
  limits?: {
    maxTurns?: number;
    maxBudgetUsd?: number;
    toolTimeoutMs?: number;
  };

  // Model settings
  model?: {
    temperature?: number;
    maxTokens?: number;
  };

  // Hook activation
  hooks?: {
    enable?: string[];
    disable?: string[];
  };
}
```

#### `HarnessRuntime`

Runtime overrides threaded into the engine loop:

```typescript
interface HarnessRuntime {
  toolTimeoutMs?: number;
  reflectionInterval?: number;
  reflectionTemplate?: string;
  maxContinuations?: number;
}
```

#### `EvalTask`

```typescript
interface EvalTask {
  id: string;
  prompt: string;
  cwd?: string;
  setupCommand?: string;
  timeoutMs?: number;
  tags?: string[];
  scorer: TaskScorer;
}

type TaskScorer =
  | { type: 'criteria'; criteria: SuccessCriterion[] }
  | { type: 'command'; command: string; parseScore: 'exit_code' | 'stdout_float' }
  | { type: 'llm_judge'; prompt: string; rubric: string };

interface SuccessCriterion {
  type: 'file_exists' | 'file_contains' | 'command_succeeds' | 'output_contains' | 'cost_under' | 'turns_under';
  value: string | number;
  weight?: number;
}
```

#### `EvalResult`

```typescript
interface EvalResult {
  taskId: string;
  candidateId: string;
  runId: string;
  repeatIndex: number;
  success: boolean;
  score: number;               // 0.0 to 1.0
  criteriaResults: CriterionResult[];
  costUsd: number;
  turns: number;
  totalTokens: { input: number; output: number };
  endReason: string;
  durationMs: number;
  traceId: string;
  toolStats: Record<string, ToolStat>;
  error?: string;
}

interface ToolStat {
  calls: number;
  errors: number;
  totalMs: number;
}
```

#### `CandidateManifest`

```typescript
interface CandidateManifest {
  candidateId: string;
  runId: string;
  generation: number;
  parentId?: string;
  config: HarnessConfig;
  aggregateScore: number;
  costUsd: number;
  avgTurns: number;
  avgTokens: number;
  taskCount: number;
  successRate: number;
  paretoRank?: number;
  createdAt: string;
}
```

#### `RunManifest`

```typescript
interface RunManifest {
  runId: string;
  status: 'running' | 'paused' | 'completed' | 'aborted';
  generation: number;
  maxGenerations: number;
  candidatesPerGeneration: number;
  dataset: string;
  searchSetIds: string[];
  holdoutSetIds: string[];
  startedAt: string;
  updatedAt: string;
  candidates: string[];
  currentBest?: string;
  totalCostUsd: number;
  holdoutResults?: Record<string, CandidateManifest>;
}
```

#### `ScoredCandidate`

```typescript
interface ScoredCandidate {
  candidateId: string;
  objectives: {
    accuracy: number;    // Higher is better (0-1)
    cost: number;        // Lower is better (USD)
    tokens: number;      // Lower is better
    turns: number;       // Lower is better
    errorRate: number;   // Lower is better (0-1)
  };
}
```

#### `EvaluatorOptions`

```typescript
interface EvaluatorOptions {
  repeatCount: number;
  aggregation: 'median' | 'mean' | 'best' | 'worst';
  temperature?: number;              // Default: 0.01
  maxCandidateBudgetUsd?: number;
}
```

#### `MetaRuntimeConfig`

```typescript
interface MetaRuntimeConfig {
  harnessConfig: HarnessConfig;
  cwd: string;
  permissionMode?: 'fullAuto' | 'bypass';
  archivePath: string;
}
```

#### `DatasetSplit`

```typescript
interface DatasetSplit {
  searchSet: EvalTask[];
  holdoutSet: EvalTask[];
}
```

#### `StructuredResult`

```typescript
interface StructuredResult {
  messages: Message[];
  events: LoopEvent[];
  costUsd: number;
  turns: number;
  endReason: string;
  toolStats: Record<string, ToolStat>;
  traceId: string;
  totalUsage: Usage;
  durationMs: number;
}
```

---

### Meta Runtime (`meta/runtime.ts`)

#### `bootstrapMeta()`

```typescript
async function bootstrapMeta(config: MetaRuntimeConfig): Promise<MetaRuntime>

interface MetaRuntime {
  loopConfig: LoopConfig;
  orchestrator: AgentOrchestrator;
  systemPrompt: string;
  dispose(): Promise<void>;
}
```

Bootstraps a non-interactive Shugu runtime for Meta-Harness evaluation. Replicates the full pipeline of `bootstrap()` without interactive components:
- No TTY vault password prompt (uses `PCC_VAULT_PASSWORD` env var)
- No terminal renderer, REPL, or banner
- fullAuto permission mode (no askPermission prompts)
- Auto-accept for local plugins
- Merges harness agent profiles with BUILTIN_AGENTS
- Applies all HarnessConfig mutations (prompt append, strategy overrides, reflection, limits)

---

## Module: entrypoints

**Source:** `src/entrypoints/`

---

### RuntimeServices (`entrypoints/services.ts`)

Single container for all services needed by the CLI entrypoint.

```typescript
interface RuntimeServices {
  readonly client: MiniMaxClient;
  readonly registry: ToolRegistryImpl;
  readonly toolContext: ToolContext;
  readonly permResolver: PermissionResolver;
  readonly hookRegistry: HookRegistry;
  readonly skillRegistry: SkillRegistry;
  readonly commands: CommandRegistry;
  readonly sessionMgr: SessionManager;
  readonly bgManager: BackgroundManager;
  readonly scheduler: Scheduler;
  readonly memoryAgent: MemoryAgent;
  readonly obsidianVault: ObsidianVault | null;
  readonly credentialProvider: CredentialProvider;
  readonly kairos: Kairos;
  readonly renderer: TerminalRenderer;

  dispose(): Promise<void>;
}
```

---

### Bootstrap (`entrypoints/bootstrap.ts`)

#### CLI Arguments

```typescript
interface CliArgs {
  mode: PermissionMode;
  prompt: string | null;
  continueSession: boolean;
  resumeSession: string | true | false;
  verbose: boolean;
  model: string | null;
}

function parseArgs(): CliArgs
```

**CLI usage:**

```
shugu "prompt"              Single-shot query
shugu                       Interactive REPL
shugu --continue            Resume last session in current directory
shugu --resume              Pick a session to resume
shugu --resume=<id>         Resume specific session
shugu --mode=<mode>         Set permission mode
shugu --model=<name>        Set model (overrides MINIMAX_MODEL env)
```

**Mode aliases:** `plan`, `default`, `accept-edits` (-> acceptEdits), `auto` (-> fullAuto), `bypass`.

#### `bootstrap()`

```typescript
async function bootstrap(cliArgs: CliArgs): Promise<BootstrapResult>

interface BootstrapResult {
  services: RuntimeServices;
  systemPrompt: string;
  needsHatchCeremony: boolean;
  resumedMessages: Message[] | null;
}
```

Full service construction pipeline:
1. MiniMaxClient construction
2. Credential vault (unlock existing or initialize new)
3. Tool registry with all built-in tools
4. Permission resolver
5. Plugin loading (local plugins require user confirmation unless bypass mode)
6. Built-in hook registration (behavior hooks, verification hook)
7. Obsidian vault discovery
8. Memory agent initialization
9. Automation services (BackgroundManager, Scheduler, Kairos)
10. Agent orchestrator wiring
11. System prompt building
12. Session resume handling

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MINIMAX_API_KEY` | MiniMax API key (highest priority) | -- (required) |
| `ANTHROPIC_AUTH_TOKEN` | Alternative auth token (2nd priority) | -- |
| `ANTHROPIC_API_KEY` | Alternative auth token (3rd priority) | -- |
| `MINIMAX_BASE_URL` | Custom API base URL (highest priority) | -- |
| `ANTHROPIC_BASE_URL` | Custom API base URL (2nd priority) | -- |
| (default base URL) | -- | `https://api.minimax.io/anthropic/v1` |
| `MINIMAX_MODEL` | Default model name (used when `--model` not set) | `MiniMax-M2.7-highspeed` |
| `PCC_VAULT_PASSWORD` | Master password for headless vault unlock (CI, Meta-Harness) | -- |

---

## Common Patterns

### Creating a Client and Running a Query

```typescript
import { MiniMaxClient } from './src/transport/client.js';

const client = new MiniMaxClient();

const response = await client.complete([
  { role: 'user', content: 'Explain the visitor pattern in 3 sentences.' },
]);

const text = response.message.content
  .filter(b => b.type === 'text')
  .map(b => b.text)
  .join('');

console.log(text);
```

### Running the Agentic Loop with Tools

```typescript
import { runLoop, type LoopConfig } from './src/engine/loop.js';
import { MiniMaxClient } from './src/transport/client.js';
import { ToolRegistryImpl } from './src/tools/registry.js';
import { InterruptController } from './src/engine/interrupts.js';

const client = new MiniMaxClient();
const registry = new ToolRegistryImpl();
// ... register tools ...

const toolMap = new Map(registry.getAll().map(t => [t.definition.name, t]));

const config: LoopConfig = {
  client,
  systemPrompt: 'You are a helpful coding assistant.',
  tools: toolMap,
  toolDefinitions: registry.getDefinitions(),
  toolContext: {
    cwd: process.cwd(),
    abortSignal: new AbortController().signal,
    permissionMode: 'fullAuto',
    askPermission: async () => true,
  },
  maxTurns: 25,
};

const messages = [{ role: 'user' as const, content: 'Read package.json and tell me the version.' }];

for await (const event of runLoop(messages, config)) {
  switch (event.type) {
    case 'assistant_message':
      console.log('[assistant]', event.message.content.filter(b => b.type === 'text').map(b => b.text).join(''));
      break;
    case 'tool_executing':
      console.log(`[tool] ${event.call.name}`);
      break;
    case 'loop_end':
      console.log(`[done] ${event.reason} | $${event.totalCost.toFixed(4)}`);
      break;
  }
}
```

### Spawning a Sub-Agent

```typescript
import { AgentOrchestrator } from './src/agents/orchestrator.js';

const orchestrator = new AgentOrchestrator(client, toolMap, toolContext);

const result = await orchestrator.spawn(
  'Search the codebase for all uses of the deprecated API and list them.',
  'explore',
  { maxTurns: 10 },
);

console.log(result.response);
console.log(`Cost: $${result.costUsd.toFixed(4)} | Turns: ${result.turns}`);
```

### Implementing a Custom Tool

```typescript
import type { Tool, ToolCall, ToolResult, ToolContext } from './src/protocol/tools.js';

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
    concurrencySafe: true,  // Safe to run in parallel
  },

  async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const input = call.input['input'] as string;

    // Respect abort signal
    if (context.abortSignal.aborted) {
      return { tool_use_id: call.id, content: 'Aborted', is_error: true };
    }

    return {
      tool_use_id: call.id,
      content: `Processed: ${input}`,
    };
  },

  validateInput(input: Record<string, unknown>): string | null {
    if (typeof input['input'] !== 'string') return 'input must be a string';
    return null;
  },
};
```

### Registering a Plugin Hook

```typescript
import type { HookHandler, PreToolUsePayload, PreToolUseResult } from './src/plugins/hooks.js';

const myHook: HookHandler = {
  type: 'PreToolUse',
  pluginName: 'my-safety-plugin',
  priority: 10,
  handler: async (payload: PreToolUsePayload): Promise<PreToolUseResult> => {
    // Block any Bash command containing 'rm -rf /'
    if (payload.tool === 'Bash') {
      const cmd = (payload.call.input['command'] as string) ?? '';
      if (cmd.includes('rm -rf /')) {
        return { proceed: false, blockReason: 'Destructive command blocked.' };
      }
    }
    return { proceed: true };
  },
};

hookRegistry.register(myHook);
```

### Scheduling a Recurring Task

```typescript
import { Scheduler } from './src/automation/scheduler.js';

const scheduler = new Scheduler();
scheduler.setExecutor(async (job) => {
  // Run the prompt through your agentic loop and return the result
  return 'Task completed';
});

scheduler.addJob({
  name: 'Daily Health Check',
  prompt: 'Run npm test and report any failures.',
  schedule: { type: 'cron', expression: '0 9 * * 1-5' },  // 9 AM weekdays
  enabled: true,
});

scheduler.start();
```

---

## Troubleshooting

### "No API key found"

Set one of: `MINIMAX_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or `ANTHROPIC_API_KEY`. The `.env` file is NOT automatically loaded -- use `dotenv` or export variables manually.

### HTTP 429 (Rate Limited)

The client retries automatically with exponential backoff (up to 10 retries, 32s max delay). If you still hit limits, reduce concurrent agents or add `maxBudgetUsd` to your `LoopConfig`.

### HTTP 529 (Server Overloaded)

After 3 consecutive 529 errors, the client automatically falls back to the next model: `M2.7-highspeed` -> `M2.7` -> `M2.5-highspeed`. No action required.

### Model Not Found (404)

The model name might be incorrect or deprecated. Check `MINIMAX_MODELS` for valid names. The fallback chain will automatically try the next model.

### Context Too Long (400)

Your conversation exceeded the 204,800 token context window. The `TokenBudgetTracker` should trigger auto-compaction before this happens. If it still occurs:
- Ensure `shouldAutoCompact()` is checked after each turn
- Reduce `keepRecentTurns` in `CompactionConfig`
- Split large tasks across sub-agents

### Vault "Wrong Password"

The vault allows 3 attempts in interactive mode. For CI/headless use, set `PCC_VAULT_PASSWORD`. If you have forgotten the password, delete `~/.pcc/credentials.enc` and reinitialize with `shugu` (you will need to re-add all credentials).

### Tool Timeout

Default timeout is 300 seconds (5 minutes). For long-running operations, increase via `harnessRuntime.toolTimeoutMs` in your `LoopConfig`.

### Loop Stuck on Same Tool Call

The engine detects 3 identical consecutive tool calls and injects a corrective message. If the agent still loops, it will eventually hit `maxTurns` (default 100) and stop.

### Plugin Loading Failures

Plugin load errors are non-fatal. Check `pluginRegistry.getSummary()` for details. Plugins that fail to load are marked inactive. In bypass mode, local plugins are auto-accepted; otherwise the user is prompted.

### Windows Path Issues

Shugu runs on Windows via bash shell. Use forward slashes in paths when configuring the engine. The tools handle path normalization internally.
