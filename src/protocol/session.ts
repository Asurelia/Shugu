/**
 * Layer 0 — Protocol: Session types
 *
 * Sessions track the full lifecycle of a conversation,
 * including turns, tool executions, and persistence metadata.
 */

import type { Message, Usage } from './messages.js';

// ─── Session ────────────────────────────────────────────

export interface Session {
  id: string;
  projectDir: string;
  messages: Message[];
  turns: Turn[];
  createdAt: Date;
  updatedAt: Date;
  totalUsage: Usage;
  metadata: SessionMetadata;
}

export interface SessionMetadata {
  model: string;
  version: string;
  resumedFrom?: string;
  tags?: string[];
}

// ─── Turn ───────────────────────────────────────────────

export interface Turn {
  id: string;
  index: number;
  userMessage: Message;
  assistantMessage: Message;
  toolCalls: TurnToolCall[];
  usage: Usage;
  durationMs: number;
  timestamp: Date;
}

export interface TurnToolCall {
  toolName: string;
  toolId: string;
  input: Record<string, unknown>;
  result: string;
  isError: boolean;
  durationMs: number;
}

// ─── Transcript ─────────────────────────────────────────

export interface Transcript {
  sessionId: string;
  turns: TranscriptEntry[];
}

export interface TranscriptEntry {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

// ─── Session State ──────────────────────────────────────

export type SessionState =
  | 'idle'           // Waiting for user input
  | 'streaming'      // Receiving model response
  | 'tool_executing' // Running tool calls
  | 'compacting'     // Compacting context
  | 'paused'         // User paused
  | 'error'          // Error state
  | 'done';          // Session ended
