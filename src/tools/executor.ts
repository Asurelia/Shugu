/**
 * Layer 3 — Tools: Executor / Orchestration
 *
 * Executes tool calls with proper concurrency control.
 * Adapted from OpenClaude src/services/tools/toolOrchestration.ts (180 lines).
 *
 * Strategy:
 * - Tools marked concurrencySafe run in parallel
 * - Others run sequentially
 * - All results are collected in order
 */

import type { Tool, ToolCall, ToolResult, ToolContext } from '../protocol/tools.js';
import type { ToolRegistryImpl } from './registry.js';

export interface ExecutionResult {
  results: ToolResult[];
  durationMs: number;
}

/**
 * Execute a batch of tool calls from a single assistant turn.
 */
export async function executeToolCalls(
  calls: ToolCall[],
  registry: ToolRegistryImpl,
  context: ToolContext,
): Promise<ExecutionResult> {
  const start = Date.now();

  if (calls.length === 0) {
    return { results: [], durationMs: 0 };
  }

  // Partition into concurrent-safe and sequential
  const concurrent: Array<{ call: ToolCall; tool: Tool }> = [];
  const sequential: Array<{ call: ToolCall; tool: Tool }> = [];

  for (const call of calls) {
    const tool = registry.get(call.name);
    if (!tool) {
      // Unknown tool — will be handled as error result
      sequential.push({ call, tool: null as unknown as Tool });
      continue;
    }

    if (tool.definition.concurrencySafe) {
      concurrent.push({ call, tool });
    } else {
      sequential.push({ call, tool });
    }
  }

  const results: ToolResult[] = [];

  // Run concurrent-safe tools in parallel
  if (concurrent.length > 0) {
    const concurrentResults = await Promise.all(
      concurrent.map(({ call, tool }) => executeSingle(call, tool, context)),
    );
    results.push(...concurrentResults);
  }

  // Run sequential tools one by one
  for (const { call, tool } of sequential) {
    const result = await executeSingle(call, tool, context);
    results.push(result);
  }

  return {
    results,
    durationMs: Date.now() - start,
  };
}

/**
 * Execute a single tool call with error handling.
 */
async function executeSingle(
  call: ToolCall,
  tool: Tool | null,
  context: ToolContext,
): Promise<ToolResult> {
  if (!tool) {
    return {
      tool_use_id: call.id,
      content: `Error: Unknown tool "${call.name}". Available tools can be listed with /help.`,
      is_error: true,
    };
  }

  // Validate input
  if (tool.validateInput) {
    const error = tool.validateInput(call.input);
    if (error) {
      return {
        tool_use_id: call.id,
        content: `Validation error: ${error}`,
        is_error: true,
      };
    }
  }

  try {
    return await tool.execute(call, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      tool_use_id: call.id,
      content: `Tool execution error: ${message}`,
      is_error: true,
    };
  }
}
