/**
 * Layer 4 — Policy: Permission modes
 *
 * Defines the 5 permission modes and their behavior per tool category.
 *
 * Modes (from most restrictive to least):
 * - plan:        All tool calls require confirmation. Model suggests, user approves.
 * - default:     Read-only tools auto-allowed. Write/exec tools prompt.
 * - acceptEdits: File edits auto-allowed. Bash still prompts.
 * - fullAuto:    Most tools auto-allowed. Only high-risk Bash blocked.
 * - bypass:      Everything auto-allowed. No prompts. Use with care.
 */

import type { PermissionMode } from '../protocol/tools.js';

// ─── Tool Categories ────────────────────────────────────

export type ToolCategory =
  | 'read'     // FileRead, Glob, Grep — observe only
  | 'write'    // FileWrite, FileEdit — modify files
  | 'execute'  // Bash — run arbitrary commands
  | 'network'  // WebFetch, WebSearch — external network
  | 'agent'    // AgentTool, SendMessage — spawn sub-agents
  | 'system';  // MCP, LSP, Cron, etc.

/**
 * Map tool names to categories.
 */
export function getToolCategory(toolName: string): ToolCategory {
  switch (toolName) {
    case 'Read':
    case 'Glob':
    case 'Grep':
      return 'read';

    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return 'write';

    case 'Bash':
    case 'PowerShell':
      return 'execute';

    case 'WebFetch':
    case 'WebSearch':
      return 'network';

    case 'Agent':
    case 'SendMessage':
    case 'TeamCreate':
      return 'agent';

    default:
      return 'system';
  }
}

// ─── Permission Decision ────────────────────────────────

export type PermissionDecision = 'allow' | 'ask' | 'deny';

/**
 * Default permission matrix: mode × category → decision.
 *
 *              | read  | write | execute | network | agent | system
 * ------------|-------|-------|---------|---------|-------|---------
 * plan        | ask   | ask   | ask     | ask     | ask   | ask
 * default     | allow | ask   | ask     | allow   | ask   | ask
 * acceptEdits | allow | allow | ask     | allow   | ask   | ask
 * fullAuto    | allow | allow | auto*   | allow   | allow | allow
 * bypass      | allow | allow | allow   | allow   | allow | allow
 *
 * *fullAuto for execute: decision deferred to the risk classifier
 */
export function getDefaultDecision(
  mode: PermissionMode,
  category: ToolCategory,
): PermissionDecision {
  if (mode === 'bypass') return 'allow';

  if (mode === 'plan') return 'ask';

  if (mode === 'default') {
    if (category === 'read' || category === 'network') return 'allow';
    return 'ask';
  }

  if (mode === 'acceptEdits') {
    if (category === 'read' || category === 'write' || category === 'network') return 'allow';
    return 'ask';
  }

  if (mode === 'fullAuto') {
    if (category === 'execute') return 'ask'; // Deferred to classifier
    return 'allow';
  }

  return 'ask';
}

// ─── Mode Descriptions ──────────────────────────────────

export const MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  plan: 'All actions require confirmation. Safest mode.',
  default: 'Read-only auto-allowed. File changes and commands prompt.',
  acceptEdits: 'File edits auto-allowed. Shell commands still prompt.',
  fullAuto: 'Most actions auto-allowed. Only risky commands prompt.',
  bypass: 'Everything auto-allowed. No prompts. Full trust.',
};
