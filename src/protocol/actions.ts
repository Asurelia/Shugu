/**
 * Layer 0 — Protocol: Action tracking types
 *
 * Adapted from OpenRoom's Action Protocol.
 * Tracks WHO triggered each action (user, agent, or system)
 * for auditability and policy decisions.
 */

// ─── Action Trigger ─────────────────────────────────────

export enum ActionTriggerBy {
  User = 1,
  Agent = 2,
  System = 3,
}

// ─── Action Record ──────────────────────────────────────

export interface ActionRecord {
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

export type ActionType =
  | 'tool_call'       // Tool was executed
  | 'file_read'       // File was read
  | 'file_write'      // File was created/modified
  | 'file_delete'     // File was deleted
  | 'command_exec'    // Shell command was executed
  | 'mcp_call'        // MCP tool was called
  | 'agent_spawn'     // Sub-agent was spawned
  | 'permission_ask'  // Permission was requested
  | 'permission_grant'// Permission was granted
  | 'permission_deny' // Permission was denied
  | 'compact'         // Context was compacted
  | 'session_resume'  // Session was resumed
  | 'custom';         // Custom action type
