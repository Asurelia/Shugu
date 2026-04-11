/**
 * Layer 3 — Tools: SleepTool
 *
 * Wait for a specified duration. Used by proactive/autonomous mode.
 * Was feature-gated behind PROACTIVE/KAIROS in the original.
 */

import type { Tool, ToolCall, ToolResult, ToolContext, ToolDefinition } from '../../protocol/tools.js';

export const SleepToolDefinition: ToolDefinition = {
  name: 'Sleep',
  description: `Wait for a specified number of seconds. Maximum: 300 seconds (5 minutes).

Use sparingly — only when genuinely waiting for an external process, a build to complete, or polling for state changes. Do not use sleep between commands that can run immediately. If waiting for a background task, prefer checking its status directly.`,
  inputSchema: {
    type: 'object',
    properties: {
      seconds: {
        type: 'number',
        description: 'Number of seconds to wait (max 300)',
      },
      reason: {
        type: 'string',
        description: 'Why you are waiting',
      },
    },
    required: ['seconds'],
  },
  concurrencySafe: true,
  categories: ['automation'],
};

export class SleepTool implements Tool {
  definition = SleepToolDefinition;

  validateInput(input: Record<string, unknown>): string | null {
    const seconds = input['seconds'] as number;
    if (typeof seconds !== 'number' || seconds <= 0) return 'seconds must be a positive number';
    if (seconds > 300) return 'seconds cannot exceed 300 (5 minutes)';
    return null;
  }

  async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const seconds = Math.min(call.input['seconds'] as number, 300);
    const reason = (call.input['reason'] as string) ?? 'waiting';

    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));

    return {
      tool_use_id: call.id,
      content: `Waited ${seconds}s (${reason})`,
    };
  }
}
