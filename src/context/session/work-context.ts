/**
 * Layer 5 — Context: Work context extraction and rehydration
 *
 * Extracts structured working context from a conversation for session persistence.
 * On resume, the formatted block tells the model exactly what it was doing:
 * goal, active files, recent actions, and pending work.
 *
 * Design decisions:
 * - currentGoal comes from rawGoal (the raw user input), NOT from messages
 *   (messages contain file-expanded content that would bloat the block)
 * - lastHumanInputIdx is explicit (from REPL tracking), NOT inferred
 *   (runLoop injects synthetic user messages that are indistinguishable by type)
 * - If lastHumanInputIdx is negative, extraction is skipped (preserve existing workContext)
 */

import type { Message, ContentBlock } from '../../protocol/messages.js';

// ─── Types ──────────────────────────────────────────────

export interface WorkContext {
  /** Files touched in recent tool calls (deduped, last 10) */
  activeFiles: string[];
  /** The user's goal — raw input text, not expanded */
  currentGoal: string;
  /** Recent tool call history with outcomes */
  toolHistory: ToolHistoryEntry[];
  /** What was unfinished (heuristic from last assistant message) */
  pendingWork: string;
  /** Session statistics */
  stats: {
    totalTurns: number;
    lastTurnTimestamp: string;
  };
}

export interface ToolHistoryEntry {
  tool: string;
  path?: string;
  outcome: 'success' | 'error';
  summary: string;
}

// ─── Extraction ─────────────────────────────────────────

/**
 * Extract WorkContext from a conversation.
 *
 * @param messages - The full conversation history
 * @param lastHumanInputIdx - Index of the last real human message (from REPL tracking)
 * @param rawGoal - Raw user input text (before file expansion)
 * @param maxHistory - Max tool history entries (default 10)
 */
export function extractWorkContext(
  messages: Message[],
  lastHumanInputIdx: number,
  rawGoal: string,
  maxHistory: number = 10,
): WorkContext {
  const activeFilesSet = new Set<string>();
  const toolHistory: ToolHistoryEntry[] = [];

  // Design: activeFiles and toolHistory scan session-wide recent messages (not bounded
  // to lastHumanInputIdx). This is intentional — rehydration should show which files
  // are "hot" across the session, not just the last turn. currentGoal is the only
  // field scoped to the specific human input (via rawGoal parameter).
  for (let i = messages.length - 1; i >= 0 && toolHistory.length < maxHistory; i--) {
    const msg = messages[i]!;

    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === 'tool_use') {
          const toolUse = block as { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
          const filePath = typeof toolUse.input['file_path'] === 'string'
            ? toolUse.input['file_path']
            : typeof toolUse.input['path'] === 'string'
              ? toolUse.input['path']
              : undefined;

          if (filePath) activeFilesSet.add(filePath);

          // Find matching tool_result by tool_use_id in the next user message
          const nextMsg = messages[i + 1];
          let outcome: 'success' | 'error' = 'success';
          let summary = '';

          if (nextMsg && nextMsg.role === 'user' && Array.isArray(nextMsg.content)) {
            for (const resultBlock of nextMsg.content as ContentBlock[]) {
              if (resultBlock.type === 'tool_result') {
                const result = resultBlock as { type: 'tool_result'; tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean };
                // Match by tool_use_id to handle multi-tool-use messages correctly
                if (result.tool_use_id !== toolUse.id) continue;
                if (result.is_error) outcome = 'error';
                const text = typeof result.content === 'string'
                  ? result.content
                  : '';
                summary = text.slice(0, 80).replace(/\n/g, ' ');
                break;
              }
            }
          }

          if (toolHistory.length < maxHistory) {
            toolHistory.unshift({
              tool: toolUse.name,
              path: filePath,
              outcome,
              summary,
            });
          }
        }
      }
    }
  }

  // Extract pending work from the last assistant message
  const pendingWork = extractPendingWork(messages);

  return {
    activeFiles: Array.from(activeFilesSet).slice(0, 10),
    currentGoal: rawGoal.slice(0, 500),
    toolHistory,
    pendingWork,
    stats: {
      totalTurns: messages.filter(m => m.role === 'user').length,
      lastTurnTimestamp: new Date().toISOString(),
    },
  };
}

// ─── Pending Work Heuristic ─────────────────────────────

function extractPendingWork(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

    // Check for tool_use without matching tool_result (interrupted)
    const hasToolUse = (msg.content as ContentBlock[]).some(b => b.type === 'tool_use');
    const nextMsg = messages[i + 1];
    const hasResult = nextMsg && nextMsg.role === 'user' && Array.isArray(nextMsg.content) &&
      (nextMsg.content as ContentBlock[]).some(b => b.type === 'tool_result');

    if (hasToolUse && !hasResult) {
      const toolNames = (msg.content as ContentBlock[])
        .filter(b => b.type === 'tool_use')
        .map(b => (b as { name: string }).name)
        .join(', ');
      return `Interrupted during tool use (${toolNames})`;
    }

    // Extract text and look for forward-looking patterns
    const text = (msg.content as ContentBlock[])
      .filter(b => b.type === 'text')
      .map(b => (b as { text: string }).text)
      .join('\n');

    if (!text) continue;

    const patterns = [
      /(?:next|ensuite|puis),?\s+(?:I'll|I will|je vais|on va)(.{10,100})/i,
      /(?:remaining|restant|TODO|still need to)(.{10,100})/i,
      /(?:step \d+ of \d+)(.{0,100})/i,
    ];

    for (const pattern of patterns) {
      const match = pattern.exec(text);
      if (match) {
        return match[0].slice(0, 200);
      }
    }

    const lastLine = text.trim().split('\n').pop() ?? '';
    if (/(?:done|complete|success|merged|pushed)/i.test(lastLine)) {
      return '';
    }

    return text.slice(-200).trim();
  }

  return '';
}

// ─── Formatting ─────────────────────────────────────────

export function formatRehydrationBlock(ctx: WorkContext): string {
  const lines: string[] = ['# Resumed Session Context', ''];

  if (ctx.currentGoal) {
    lines.push(`**Goal:** ${ctx.currentGoal}`, '');
  }

  if (ctx.activeFiles.length > 0) {
    lines.push(`**Active files:** ${ctx.activeFiles.join(', ')}`, '');
  }

  if (ctx.toolHistory.length > 0) {
    lines.push('**Recent actions:**');
    for (const h of ctx.toolHistory.slice(-5)) {
      const pathStr = h.path ? ` ${h.path}` : '';
      const summaryStr = h.summary ? `: ${h.summary}` : '';
      lines.push(`- [${h.tool}]${pathStr} -> ${h.outcome}${summaryStr}`);
    }
    lines.push('');
  }

  if (ctx.pendingWork) {
    lines.push(`**Pending:** ${ctx.pendingWork}`, '');
  }

  lines.push(`**Session:** ${ctx.stats.totalTurns} turns, last active ${ctx.stats.lastTurnTimestamp}`);

  return lines.join('\n');
}
