/**
 * Meta-Harness: Structured Query Collector
 *
 * Wraps runLoop() to collect all events and return a StructuredResult.
 * Runs headlessly — no terminal renderer, no REPL.
 *
 * This is the bridge between the MetaEvaluator and the Shugu engine.
 */

import { runLoop } from '../engine/loop.js';
import { InterruptController } from '../engine/interrupts.js';
import type { Message } from '../protocol/messages.js';
import { tracer } from '../utils/tracer.js';
import type { MetaRuntime } from './runtime.js';
import type { StructuredResult, ToolStat } from './types.js';
import type { LoopEvent } from '../engine/loop.js';

/**
 * Execute a prompt through the full Shugu engine and collect structured results.
 *
 * @param prompt - The task prompt to execute
 * @param runtime - A MetaRuntime built by bootstrapMeta()
 * @param options - Optional timeout
 * @returns StructuredResult with messages, events, cost, tool stats, etc.
 */
export async function runStructuredQuery(
  prompt: string,
  runtime: MetaRuntime,
  options?: { timeoutMs?: number },
): Promise<StructuredResult> {
  const traceId = tracer.startTrace();
  const startMs = Date.now();

  const messages: Message[] = [{ role: 'user', content: prompt }];
  const interrupt = new InterruptController();
  const allEvents: LoopEvent[] = [];
  const toolStats: Record<string, ToolStat> = {};

  // Timeout support
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  if (options?.timeoutMs) {
    timeoutHandle = setTimeout(() => {
      interrupt.abort('Meta-Harness evaluation timeout');
    }, options.timeoutMs);
    if (typeof timeoutHandle === 'object' && 'unref' in timeoutHandle) {
      timeoutHandle.unref();
    }
  }

  let turns = 0;
  let endReason = 'unknown';
  let costUsd = 0;
  let totalUsage = { input_tokens: 0, output_tokens: 0 };

  // Track in-flight tool calls for duration matching
  const toolStartTimes = new Map<string, number>();

  try {
    for await (const event of runLoop(messages, runtime.loopConfig, interrupt)) {
      allEvents.push(event);

      switch (event.type) {
        case 'turn_start':
          turns = event.turnIndex + 1;
          break;

        case 'tool_executing': {
          const toolName = event.call.name;
          toolStartTimes.set(event.call.id, Date.now());
          if (!toolStats[toolName]) {
            toolStats[toolName] = { calls: 0, errors: 0, totalMs: 0 };
          }
          toolStats[toolName]!.calls++;
          break;
        }

        case 'tool_result': {
          const stat = findToolStat(toolStats, event.result.tool_use_id, allEvents);
          if (stat) {
            if (event.result.is_error) stat.errors++;
            stat.totalMs += event.durationMs ?? 0;
          }
          break;
        }

        case 'turn_end':
          totalUsage = {
            input_tokens: totalUsage.input_tokens + event.usage.input_tokens,
            output_tokens: totalUsage.output_tokens + event.usage.output_tokens,
          };
          break;

        case 'history_sync':
          messages.length = 0;
          messages.push(...event.messages);
          break;

        case 'loop_end':
          endReason = event.reason;
          costUsd = event.totalCost;
          totalUsage = event.totalUsage;
          break;
      }
    }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  return {
    messages: [...messages],
    events: allEvents,
    costUsd,
    turns,
    endReason,
    toolStats,
    traceId,
    totalUsage,
    durationMs: Date.now() - startMs,
  };
}

/**
 * Find the ToolStat entry for a tool_result event by looking back
 * through events to find the matching tool_executing event.
 */
function findToolStat(
  stats: Record<string, ToolStat>,
  toolUseId: string,
  events: LoopEvent[],
): ToolStat | null {
  // Walk backwards to find the tool_executing event with matching call.id
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === 'tool_executing' && e.call.id === toolUseId) {
      return stats[e.call.name] ?? null;
    }
  }
  return null;
}
