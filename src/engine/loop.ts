/**
 * Layer 2 — Engine: Agentic loop
 *
 * The core while(true) loop that powers the agent:
 * 1. Stream model response
 * 2. Check stop reason
 * 3. If tool_use → execute tools → append results → continue
 * 4. If end_turn → done
 *
 * This is an AsyncGenerator that yields events at each step,
 * allowing the UI layer to observe without coupling.
 *
 * In the original (src/query.ts:219-550), this logic is buried in 1400 lines
 * with 14 feature-gated codepaths. The actual loop is ~60 lines.
 */

import type {
  Message,
  AssistantMessage,
  UserMessage,
  SystemPrompt,
  Usage,
  ContentBlock,
} from '../protocol/messages.js';
import type { ToolDefinition, Tool, ToolCall, ToolResult, ToolContext } from '../protocol/tools.js';
import type { StreamEvent, ContentDelta } from '../protocol/events.js';
import { MiniMaxClient, type StreamOptions } from '../transport/client.js';
import { accumulateStream } from '../transport/stream.js';
import { analyzeTurn, buildToolResultMessage, ensureToolResultPairing, shouldContinue, DEFAULT_MAX_TURNS, ContinuationTracker } from './turns.js';
import { BudgetTracker } from './budget.js';
import { InterruptController, isAbortError } from './interrupts.js';
import type { HookRegistry } from '../plugins/hooks.js';
import { truncateToolResult, enforceMessageLimit } from '../tools/outputLimits.js';
import { ActionTriggerBy } from '../protocol/actions.js';
import { logger } from '../utils/logger.js';
import { shouldReflect, buildReflectionPrompt } from './reflection.js';

// ─── Loop Configuration ─────────────────────────────────

export interface LoopConfig {
  client: MiniMaxClient;
  systemPrompt?: SystemPrompt;
  tools?: Map<string, Tool>;
  toolDefinitions?: ToolDefinition[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  toolContext?: ToolContext;
  /** Plugin hook registry for Pre/PostToolUse and OnMessage hooks */
  hookRegistry?: HookRegistry;
  /** Inject reflection prompts every N turns (0 = disabled). Set by strategy layer. */
  reflectionInterval?: number;
}

// ─── Loop Events ────────────────────────────────────────

export type LoopEvent =
  | { type: 'turn_start'; turnIndex: number }
  | { type: 'stream_delta'; delta: ContentDelta; blockIndex: number }
  | { type: 'stream_text'; text: string }
  | { type: 'stream_thinking'; thinking: string }
  | { type: 'stream_tool_start'; toolName: string; toolId: string }
  | { type: 'assistant_message'; message: AssistantMessage }
  | { type: 'tool_executing'; call: ToolCall; triggeredBy: ActionTriggerBy }
  | { type: 'tool_result'; result: ToolResult; durationMs?: number }
  | { type: 'turn_end'; turnIndex: number; usage: Usage }
  | { type: 'loop_end'; reason: string; totalUsage: Usage; totalCost: number }
  | { type: 'error'; error: Error };

// ─── Agentic Loop ───────────────────────────────────────

/**
 * Run the agentic loop.
 *
 * Takes initial messages and yields events as the loop progresses.
 * The caller collects events for UI rendering.
 *
 * @param initialMessages - The conversation history so far (at minimum, the user's message)
 * @param config - Loop configuration
 * @param interrupt - Interrupt controller for abort/pause/resume
 */
export async function* runLoop(
  initialMessages: Message[],
  config: LoopConfig,
  interrupt: InterruptController = new InterruptController(),
): AsyncGenerator<LoopEvent> {
  const {
    client,
    systemPrompt,
    tools,
    toolDefinitions,
    maxTurns = DEFAULT_MAX_TURNS,
    maxBudgetUsd,
  } = config;

  const budget = new BudgetTracker(client.model, maxBudgetUsd);
  const continuation = new ContinuationTracker();
  const messages: Message[] = [...initialMessages];
  let turnIndex = 0;

  // Loop detection: track last 3 tool calls to detect stuck loops
  const recentToolCalls: string[] = [];

  try {
    while (true) {
      await interrupt.checkpoint();

      yield { type: 'turn_start', turnIndex };

      // ── 1. Stream model response ──────────────────

      const streamOptions: StreamOptions = {
        systemPrompt,
        tools: toolDefinitions,
        abortSignal: interrupt.signal,
      };

      let assistantMessage: AssistantMessage | null = null;
      let stopReason: string | null = null;
      let turnUsage: Usage = { input_tokens: 0, output_tokens: 0 };

      const eventStream = client.stream(
        ensureToolResultPairing(messages),
        streamOptions,
      );

      const accumulated = await accumulateStream(eventStream, {
        onDelta(index, delta) {
          // Forward deltas to the UI
          if (delta.type === 'text_delta') {
            // We can't yield from a callback, so we buffer these.
            // The accumulated result will have the full text.
          }
        },
        onContentBlockStart(index, type) {
          // Tracked by accumulator
        },
        onContentBlockComplete(index, block) {
          // Tracked by accumulator
        },
      });

      assistantMessage = accumulated.message;
      stopReason = accumulated.stopReason;
      turnUsage = accumulated.usage;

      // Yield the complete assistant message
      yield { type: 'assistant_message', message: assistantMessage };

      // OnMessage hook (fire-and-forget — does not block)
      if (config.hookRegistry) {
        config.hookRegistry.runMessageHook({
          message: assistantMessage,
          role: 'assistant',
        }).catch((err) => {
          logger.debug('OnMessage hook error', err instanceof Error ? err.message : String(err));
        });
      }

      // Add assistant message to history
      // CRITICAL: preserve FULL response including reasoning for MiniMax multi-turn
      messages.push(assistantMessage);

      // ── 2. Analyze the turn ───────────────────────

      const turnResult = analyzeTurn(assistantMessage, stopReason, turnUsage);
      budget.addTurnUsage(turnUsage);

      yield { type: 'turn_end', turnIndex, usage: turnUsage };

      // ── 2.5. Mid-turn reflection (strategic self-evaluation) ──
      if (config.reflectionInterval && shouldReflect(turnIndex, config.reflectionInterval, maxTurns)) {
        const reflection = buildReflectionPrompt(turnIndex, maxTurns);
        messages.push({ role: 'user', content: reflection });
      }

      // ── 3. Check if we should continue ────────────

      // Budget check
      if (budget.isOverBudget()) {
        yield {
          type: 'loop_end',
          reason: 'budget_exceeded',
          totalUsage: budget.getTotalUsage(),
          totalCost: budget.getTotalCostUsd(),
        };
        return;
      }

      // Check if budget allows auto-continuation on max_tokens
      const contextWindow = 204_800; // MiniMax M2.7 context
      const totalUsed = budget.getTotalUsage();
      const budgetAllows = continuation.shouldContinue(
        totalUsed.input_tokens + totalUsed.output_tokens,
        contextWindow,
      );

      const decision = shouldContinue(turnResult, turnIndex, maxTurns, budgetAllows);
      if (!decision.continue) {
        yield {
          type: 'loop_end',
          reason: decision.reason ?? 'end_turn',
          totalUsage: budget.getTotalUsage(),
          totalCost: budget.getTotalCostUsd(),
        };
        return;
      }

      // Auto-continuation: model hit max_tokens but budget has room
      if (decision.autoContinue) {
        continuation.recordContinuation(turnUsage.output_tokens);
        // Nudge message to continue where it left off
        messages.push({
          role: 'user',
          content: '[System: Your response was cut off due to length. Continue exactly where you left off. Do not repeat what you already said.]',
        });
        turnIndex++;
        continue; // Skip tool execution, go straight to next model call
      }

      // ── 4. Execute tools ──────────────────────────

      if (turnResult.needsToolExecution && tools) {
        await interrupt.checkpoint();

        const toolResults: ToolResult[] = [];

        for (let call of turnResult.toolCalls) {
          // Loop detection: check if same tool+args called 3x in a row
          const callSig = `${call.name}:${JSON.stringify(call.input).slice(0, 100)}`;
          recentToolCalls.push(callSig);
          if (recentToolCalls.length > 5) recentToolCalls.shift();
          if (recentToolCalls.length >= 3 &&
              recentToolCalls[recentToolCalls.length - 1] === recentToolCalls[recentToolCalls.length - 2] &&
              recentToolCalls[recentToolCalls.length - 2] === recentToolCalls[recentToolCalls.length - 3]) {
            messages.push({
              role: 'user',
              content: '[LOOP DETECTED] You have called the same tool 3 times with identical arguments. This is not productive. Change your approach or explain what is blocking you.',
            });
            recentToolCalls.length = 0; // Reset after injection
          }

          yield { type: 'tool_executing', call, triggeredBy: ActionTriggerBy.Agent };

          const tool = tools.get(call.name);
          if (!tool) {
            const result: ToolResult = {
              tool_use_id: call.id,
              content: `Error: Unknown tool "${call.name}"`,
              is_error: true,
            };
            toolResults.push(result);
            yield { type: 'tool_result', result };
            continue;
          }

          try {
            // Validate input
            if (tool.validateInput) {
              const error = tool.validateInput(call.input);
              if (error) {
                const result: ToolResult = {
                  tool_use_id: call.id,
                  content: `Validation error: ${error}`,
                  is_error: true,
                };
                toolResults.push(result);
                yield { type: 'tool_result', result };
                continue;
              }
            }

            // PreToolUse hook — can block or modify the call
            if (config.hookRegistry) {
              const hookResult = await config.hookRegistry.runPreToolUse({
                tool: call.name,
                call,
              });
              if (!hookResult.proceed) {
                const result: ToolResult = {
                  tool_use_id: call.id,
                  content: `Blocked by hook: ${hookResult.blockReason ?? 'unknown reason'}`,
                  is_error: true,
                };
                toolResults.push(result);
                yield { type: 'tool_result', result };
                continue;
              }
              if (hookResult.modifiedCall) {
                call = hookResult.modifiedCall;
              }
            }

            // Execute
            const execStart = Date.now();
            let result = await tool.execute(call, config.toolContext!);

            // PostToolUse hook — can modify the result
            if (config.hookRegistry) {
              const postResult = await config.hookRegistry.runPostToolUse({
                tool: call.name,
                call,
                result,
                durationMs: Date.now() - execStart,
              });
              if (postResult.modifiedResult) {
                result = postResult.modifiedResult;
              }
            }

            toolResults.push(result);
            yield { type: 'tool_result', result, durationMs: Date.now() - execStart };
          } catch (error) {
            if (isAbortError(error)) throw error;

            const result: ToolResult = {
              tool_use_id: call.id,
              content: `Tool execution error: ${error instanceof Error ? error.message : String(error)}`,
              is_error: true,
            };
            toolResults.push(result);
            yield { type: 'tool_result', result };
          }
        }

        // Enforce per-message aggregate output limit (spill large results to disk)
        const limitedResults = await enforceMessageLimit(toolResults);

        // Append tool results as user message
        const toolResultMessage = buildToolResultMessage(limitedResults);
        messages.push(toolResultMessage);
      }

      turnIndex++;
    }
  } catch (error) {
    if (isAbortError(error)) {
      yield {
        type: 'loop_end',
        reason: 'aborted',
        totalUsage: budget.getTotalUsage(),
        totalCost: budget.getTotalCostUsd(),
      };
      return;
    }

    yield { type: 'error', error: error as Error };
    yield {
      type: 'loop_end',
      reason: 'error',
      totalUsage: budget.getTotalUsage(),
      totalCost: budget.getTotalCostUsd(),
    };
  }
}

// ─── Simple query (no tool loop) ────────────────────────

/**
 * Single-turn query without tool execution.
 * Useful for simple prompts and testing.
 */
export async function query(
  prompt: string,
  config: Omit<LoopConfig, 'tools' | 'toolDefinitions'>,
): Promise<AssistantMessage> {
  const messages: Message[] = [{ role: 'user', content: prompt }];

  const result = await config.client.complete(messages, {
    systemPrompt: config.systemPrompt,
  });

  return result.message;
}
