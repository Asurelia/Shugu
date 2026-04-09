/**
 * JSON-RPC protocol types for brokered plugin isolation.
 *
 * Defines all messages between the host (main process) and child (plugin process).
 * V1 scope: tools + PreToolUse/PostToolUse hooks only.
 * Wire format: NDJSON (one JSON object per line) on stdin/stdout.
 */

import type { ToolCall, ToolResult, ToolDefinition } from '../protocol/tools.js';
import type {
  PreToolUsePayload, PreToolUseResult,
  PostToolUsePayload, PostToolUseResult,
  CommandPayload, MessagePayload,
} from './hooks.js';

// ─── JSON-RPC Base Types ──────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// ─── Error Codes ──────────────────────────────────────

export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_TIMEOUT = -32000;
export const RPC_CHILD_CRASHED = -32001;
export const RPC_CAPABILITY_DENIED = -32002;

// ─── Host → Child: Init ───────────────────────────────

export interface InitParams {
  pluginDir: string;
  entryFile: string;
  dataDir: string;
  capabilities: string[];
}

// ─── Host → Child: Invoke Tool ────────────────────────

export interface InvokeToolParams {
  toolName: string;
  call: ToolCall;
  context: SerializedToolContext;
}

// ─── Host → Child: Invoke Hook ────────────────────────

export interface InvokeHookParams {
  hookType: 'PreToolUse' | 'PostToolUse' | 'PreCommand' | 'PostCommand' | 'OnMessage' | 'OnStart' | 'OnExit';
  payload?: PreToolUsePayload | PostToolUsePayload | CommandPayload | MessagePayload | undefined;
}

export type InvokeHookResult = PreToolUseResult | PostToolUseResult | { status: 'ok' };

// ─── Child → Host: Registrations (notifications during init) ──

export interface RegisterToolParams {
  definition: ToolDefinition;
}

export interface RegisterHookParams {
  hookType: 'PreToolUse' | 'PostToolUse' | 'PreCommand' | 'PostCommand' | 'OnMessage' | 'OnStart' | 'OnExit';
  priority: number;
}

export interface LogParams {
  message: string;
}

// ─── Child → Host: Capability Requests ────────────────

export interface CapabilityRequestParams {
  capability: string;
  operation: string;
  args: unknown;
}

// ─── Host → Child: Invoke Command ─────────────────────

export interface InvokeCommandParams {
  commandName: string;
  args: string;
  context: SerializedCommandContext;
}

export interface SerializedCommandContext {
  cwd: string;
  messages: import('../protocol/messages.js').Message[];
  hasQuery: boolean;
}

// ─── Child → Host: Command Registration ───────────────

export interface RegisterCommandParams {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
}

// ─── Child → Host: Callback Requests (bidirectional RPC) ──

export interface CallbackInfoParams {
  message: string;
}

export interface CallbackErrorParams {
  message: string;
}

export interface CallbackQueryParams {
  prompt: string;
}

// ─── Host → Child: Invoke Skill ──────────────────────

export interface InvokeSkillParams {
  skillName: string;
  input: string;
  args: string;
  context: SerializedSkillContext;
}

export interface SerializedSkillContext {
  cwd: string;
  messages: import('../protocol/messages.js').Message[];
  permissionMode: string;
  availableToolNames: string[];
  hasQuery: boolean;
  hasRunAgent: boolean;
}

// ─── Child → Host: Skill Registration ─────────────────

export interface RegisterSkillParams {
  name: string;
  description: string;
  category: string;
  triggers: SerializedSkillTrigger[];
  requiredTools?: string[];
  background?: boolean;
}

export type SerializedSkillTrigger =
  | { type: 'command'; command: string }
  | { type: 'keyword'; keywords: string[] }
  | { type: 'pattern'; pattern: string; flags: string }
  | { type: 'always' };

// ─── Child → Host: Skill Callback Requests ────────────

export interface CallbackRunAgentParams {
  prompt: string;
}

export interface CallbackToolInvokeParams {
  toolName: string;
  call: import('../protocol/tools.js').ToolCall;
}

// ─── Serialized Contexts (non-serializable fields stripped) ──

export interface SerializedToolContext {
  cwd: string;
  permissionMode: string;
}
