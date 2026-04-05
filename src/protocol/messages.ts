/**
 * Layer 0 — Protocol: Message types
 *
 * Internal message format, Anthropic-compatible by design (MiniMax speaks this natively).
 * These types are OURS — not imported from the SDK. The SDK is dev-only for type-checking.
 */

// ─── Roles ──────────────────────────────────────────────

export type Role = 'user' | 'assistant';

// ─── Content Blocks ─────────────────────────────────────

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ImageBlock {
  type: 'image';
  source: {
    type: 'base64' | 'url';
    media_type?: string;
    data?: string; // base64
    url?: string;
  };
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface RedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | RedactedThinkingBlock;

// ─── Messages ───────────────────────────────────────────

export interface UserMessage {
  role: 'user';
  content: string | ContentBlock[];
}

export interface AssistantMessage {
  role: 'assistant';
  content: ContentBlock[];
}

export type Message = UserMessage | AssistantMessage;

// ─── System Prompt ──────────────────────────────────────

export interface SystemPromptBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export type SystemPrompt = string | SystemPromptBlock[];

// ─── Stop Reasons ───────────────────────────────────────

export type StopReason =
  | 'end_turn'       // Model finished naturally
  | 'tool_use'       // Model wants to call a tool
  | 'max_tokens'     // Hit output token limit
  | 'stop_sequence'  // Hit a stop sequence
  | null;            // Stream still in progress

// ─── Usage ──────────────────────────────────────────────

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// ─── Conversation ───────────────────────────────────────

export interface Conversation {
  id: string;
  messages: Message[];
  systemPrompt: SystemPrompt;
  model: string;
  createdAt: Date;
  updatedAt: Date;
  totalUsage: Usage;
}

// ─── Helpers ────────────────────────────────────────────

export function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return block.type === 'tool_use';
}

export function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === 'text';
}

export function isThinkingBlock(block: ContentBlock): block is ThinkingBlock {
  return block.type === 'thinking';
}

export function isToolResultBlock(block: ContentBlock): block is ToolResultBlock {
  return block.type === 'tool_result';
}

export function getTextContent(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter(isTextBlock)
    .map((b) => b.text)
    .join('');
}

export function getToolUseBlocks(message: AssistantMessage): ToolUseBlock[] {
  return message.content.filter(isToolUseBlock);
}
