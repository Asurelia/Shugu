/**
 * Layer 3 — Tools: Executor / Orchestration
 *
 * Ported from OpenClaude src/services/tools/toolOrchestration.ts.
 *
 * Strategy (OpenClaude pattern):
 * - Partition tool calls into batches
 * - Batch of ALL read-only (concurrencySafe) tools → run in parallel (max 10)
 * - Single non-read-only tool → run alone
 * - This prevents race conditions while maximizing throughput
 */

import type { Tool, ToolCall, ToolResult, ToolContext } from '../protocol/tools.js';
import type { ToolRegistryImpl } from './registry.js';

/** Max concurrent tool executions (from OpenClaude) */
const MAX_CONCURRENCY = 10;

export interface ExecutionResult {
  results: ToolResult[];
  durationMs: number;
}

/**
 * Partition tool calls into batches for execution.
 * Read-only tools are grouped together; mutating tools run alone.
 */
export function partitionToolCalls(
  calls: ToolCall[],
  registry: ToolRegistryImpl,
): Array<{ calls: Array<{ call: ToolCall; tool: Tool | null }>; parallel: boolean }> {
  const batches: Array<{ calls: Array<{ call: ToolCall; tool: Tool | null }>; parallel: boolean }> = [];
  let currentReadBatch: Array<{ call: ToolCall; tool: Tool | null }> = [];

  for (const call of calls) {
    const tool = registry.get(call.name);

    if (tool?.definition.concurrencySafe) {
      currentReadBatch.push({ call, tool });
    } else {
      // Flush any pending read batch
      if (currentReadBatch.length > 0) {
        batches.push({ calls: currentReadBatch, parallel: true });
        currentReadBatch = [];
      }
      // Mutating tool runs alone
      batches.push({ calls: [{ call, tool: tool ?? null }], parallel: false });
    }
  }

  // Flush trailing read batch
  if (currentReadBatch.length > 0) {
    batches.push({ calls: currentReadBatch, parallel: true });
  }

  return batches;
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

  const batches = partitionToolCalls(calls, registry);
  const results: ToolResult[] = [];

  for (const batch of batches) {
    if (batch.parallel && batch.calls.length > 1) {
      // Run parallel batch with concurrency limit
      const batchResults = await runParallel(
        batch.calls.map(({ call, tool }) => () => executeSingle(call, tool, context)),
        MAX_CONCURRENCY,
      );
      results.push(...batchResults);
    } else {
      // Run sequentially (single tool or serial batch)
      for (const { call, tool } of batch.calls) {
        const result = await executeSingle(call, tool, context);
        results.push(result);
      }
    }
  }

  return {
    results,
    durationMs: Date.now() - start,
  };
}

/**
 * Run async functions in parallel with a concurrency limit.
 */
async function runParallel<T>(fns: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(fns.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < fns.length) {
      const index = nextIndex++;
      results[index] = await fns[index]!();
    }
  }

  const workers = Array.from({ length: Math.min(limit, fns.length) }, () => worker());
  await Promise.all(workers);
  return results;
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
