/**
 * UI message types — the typed objects rendered by FullApp.
 */

export type UIMessage =
  | { type: 'user'; text: string }
  | { type: 'assistant_header' }
  | { type: 'assistant_text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; name: string; id: string; detail?: string }
  | { type: 'tool_result'; content: string; isError: boolean; toolName?: string; detail?: string; durationMs?: number }
  | { type: 'error'; text: string }
  | { type: 'info'; text: string }
  | { type: 'brew'; durationMs: number; tokens?: number }
  | { type: 'session_end'; reason: string; totalTokens: number; totalCost: number };
