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
  SystemPromptBlock,
  Usage,
  ContentBlock,
} from '../protocol/messages.js';
import type { ToolDefinition, Tool, ToolCall, ToolResult, ToolContext } from '../protocol/tools.js';
import type { StreamEvent, ContentDelta } from '../protocol/events.js';
import { MiniMaxClient, type StreamOptions } from '../transport/client.js';
import { accumulateStream, streamWithDeltas } from '../transport/stream.js';
import { analyzeTurn, buildToolResultMessage, ensureToolResultPairing, shouldContinue, DEFAULT_MAX_TURNS, ContinuationTracker } from './turns.js';
import { BudgetTracker } from './budget.js';
import { InterruptController, isAbortError } from './interrupts.js';
import type { HookRegistry } from '../plugins/hooks.js';
import { truncateToolResult, enforceMessageLimit } from '../tools/outputLimits.js';
import { ActionTriggerBy } from '../protocol/actions.js';
import { logger } from '../utils/logger.js';
import { shouldReflect, buildReflectionPrompt } from './reflection.js';
import { tracer } from '../utils/tracer.js';
import { sanitizeUntrustedContent } from '../utils/security.js';

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
  /** Runtime overrides for Meta-Harness. Optional — no effect when absent. */
  harnessRuntime?: import('../meta/types.js').HarnessRuntime;
  /** Dynamic tool router — selects relevant tools per model call. Optional. */
  toolRouter?: import('../tools/router.js').ToolRouter;
  /** Task complexity from strategy analysis — used by toolRouter. */
  complexity?: import('./strategy.js').Complexity;
  /** The real human input for routing/refresh — NOT the last message in the array. */
  effectiveInput?: string;
  /**
   * Called every N turns to refresh volatile system prompt parts.
   * Returns updated text blocks, or null to keep current prompt.
   */
  refreshContext?: (query: string, turnIndex: number) => Promise<string[] | null>;
  /** Buddy observer — drains observations into context between turns. */
  buddyObserver?: import('../ui/companion/observer.js').BuddyObserver;
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
  | { type: 'tool_result_message'; message: UserMessage }
  | { type: 'turn_end'; turnIndex: number; usage: Usage }
  | { type: 'history_sync'; messages: Message[] }
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
    tools,
    toolDefinitions,
    maxTurns = DEFAULT_MAX_TURNS,
    maxBudgetUsd,
  } = config;
  let { systemPrompt } = config; // mutable — refreshContext can update it

  const budget = new BudgetTracker(client.model, maxBudgetUsd);
  const continuation = new ContinuationTracker();
  const messages: Message[] = [...initialMessages];
  let turnIndex = 0;

  // Loop detection: track last 3 tool calls to detect stuck loops
  const recentToolCalls: string[] = [];
  // Structured metadata for routing and refresh (separate from debug strings)
  const recentToolMeta: Array<{ name: string; filePath?: string }> = [];

  try {
    while (true) {
      await interrupt.checkpoint();

      yield { type: 'turn_start', turnIndex };
      const turnStartMs = Date.now();
      tracer.log('model_call', { turnIndex, model: client.model, toolCount: toolDefinitions?.length ?? 0 }, undefined, 'model');

      // ── 1. Stream model response ──────────────────

      // Dynamic tool routing: select relevant tools per call
      const effectiveToolDefs = config.toolRouter
        ? config.toolRouter.select({
            input: config.effectiveInput ?? '',
            recentTools: recentToolMeta.map(m => m.name),
            complexity: config.complexity ?? 'simple',
          })
        : toolDefinitions;

      const streamOptions: StreamOptions = {
        systemPrompt,
        tools: effectiveToolDefs,
        abortSignal: interrupt.signal,
      };

      let assistantMessage: AssistantMessage | null = null;
      let stopReason: string | null = null;
      let turnUsage: Usage = { input_tokens: 0, output_tokens: 0 };

      const eventStream = client.stream(
        ensureToolResultPairing(messages),
        streamOptions,
      );

      // Stream deltas in real-time to the UI instead of waiting for the full response.
      // streamWithDeltas yields each text/thinking delta as it arrives from the SSE stream,
      // then yields {type:'complete'} with the full AccumulatedResponse at the end.
      for await (const streamEvent of streamWithDeltas(eventStream)) {
        switch (streamEvent.type) {
          case 'delta':
            if (streamEvent.delta.type === 'text_delta') {
              yield { type: 'stream_text', text: (streamEvent.delta as { text: string }).text };
            }
            break;
          case 'thinking':
            yield { type: 'stream_thinking', thinking: streamEvent.text };
            break;
          case 'block_start':
            if (streamEvent.blockType === 'tool_use' && streamEvent.toolName) {
              yield { type: 'stream_tool_start', toolName: streamEvent.toolName, toolId: streamEvent.toolId ?? '' };
            }
            break;
          case 'complete':
            assistantMessage = streamEvent.response.message;
            stopReason = streamEvent.response.stopReason;
            turnUsage = streamEvent.response.usage;
            break;
        }
      }

      if (!assistantMessage) {
        throw new Error('Stream completed without a response');
      }

      // Yield the complete assistant message (for history sync and tool extraction)
      yield { type: 'assistant_message', message: assistantMessage };
      const modelSpanId = tracer.startSpan();
      tracer.logTimed('model_response', {
        turnIndex,
        input_tokens: turnUsage.input_tokens,
        output_tokens: turnUsage.output_tokens,
        stop_reason: stopReason,
        blocks: assistantMessage.content.length,
      }, turnStartMs, undefined, 'model');

      // Trace thinking blocks (if any)
      for (const block of assistantMessage.content) {
        if ('thinking' in block && typeof block.thinking === 'string') {
          tracer.log('thinking', {
            length: block.thinking.length,
            preview: block.thinking.slice(0, 200),
          });
        }
      }

      // Dedicated per-call log file for deep inspection
      tracer.logModelCall({
        traceId: tracer.traceId ?? 'none',
        spanId: modelSpanId,
        prompt: JSON.stringify(messages.slice(-2)).slice(0, 2000),
        response: JSON.stringify(assistantMessage.content).slice(0, 2000),
        model: client.model,
        inputTokens: turnUsage.input_tokens,
        outputTokens: turnUsage.output_tokens,
        durationMs: Date.now() - turnStartMs,
      });

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
      tracer.logTimed('model_call', { turnIndex, event: 'turn_end', input_tokens: turnUsage.input_tokens, output_tokens: turnUsage.output_tokens }, turnStartMs);

      // ── 2.5. Mid-turn reflection (strategic self-evaluation) ──
      const effectiveReflectionInterval = config.harnessRuntime?.reflectionInterval ?? config.reflectionInterval ?? 0;
      if (effectiveReflectionInterval && shouldReflect(turnIndex, effectiveReflectionInterval, maxTurns)) {
        const reflection = buildReflectionPrompt(turnIndex, maxTurns, config.harnessRuntime?.reflectionTemplate);
        messages.push({ role: 'user', content: reflection });
      }

      // ── 3. Check if we should continue ────────────

      // Budget check
      if (budget.isOverBudget()) {
        yield { type: 'history_sync', messages: [...messages] };
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
        yield { type: 'history_sync', messages: [...messages] };
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

        // ── Partition: concurrency-safe tools (Read, Glob, Grep, Agent) run
        // in parallel; mutating tools (Write, Edit, Bash) run sequentially.
        // This gives ~Nx speedup when the model spawns N agents at once.
        const concurrentBatch: ToolCall[] = [];
        const sequentialCalls: ToolCall[] = [];

        for (const call of turnResult.toolCalls) {
          const tool = tools.get(call.name);
          if (tool?.definition.concurrencySafe && turnResult.toolCalls.length > 1) {
            concurrentBatch.push(call);
          } else {
            sequentialCalls.push(call);
          }
        }

        // ── Phase A: Execute concurrent batch in parallel ──
        if (concurrentBatch.length > 1) {
          // Pre-flight: validate, hooks, permissions (sequential — must be interactive)
          const approved: Array<{ call: ToolCall; tool: Tool }> = [];
          for (const call of concurrentBatch) {
            const tool = tools.get(call.name)!;

            if (tool.validateInput) {
              const error = tool.validateInput(call.input);
              if (error) {
                const result: ToolResult = { tool_use_id: call.id, content: `Validation error: ${error}`, is_error: true };
                toolResults.push(result);
                tracer.log('tool_result', { tool: call.name, is_error: true, reason: 'validation_failed', error }, undefined, 'tool_result');
                yield { type: 'tool_result', result };
                continue;
              }
            }

            let effectiveCall = call;
            if (config.hookRegistry) {
              const hookResult = await config.hookRegistry.runPreToolUse({ tool: call.name, call });
              if (!hookResult.proceed) {
                const result: ToolResult = { tool_use_id: call.id, content: `Blocked by hook: ${hookResult.blockReason ?? 'unknown'}`, is_error: true };
                toolResults.push(result);
                tracer.log('tool_result', { tool: call.name, is_error: true, reason: 'hook_blocked', blockReason: hookResult.blockReason }, undefined, 'tool_result');
                yield { type: 'tool_result', result };
                continue;
              }
              if (hookResult.modifiedCall) effectiveCall = hookResult.modifiedCall;
            }

            if (config.toolContext?.askPermission) {
              const granted = await config.toolContext.askPermission(call.name, summarizeToolAction(effectiveCall));
              if (!granted) {
                const result: ToolResult = { tool_use_id: call.id, content: `Permission denied for ${call.name}`, is_error: true };
                toolResults.push(result);
                tracer.log('tool_result', { tool: call.name, is_error: true, reason: 'permission_denied' }, undefined, 'tool_result');
                yield { type: 'tool_result', result };
                continue;
              }
            }

            approved.push({ call: effectiveCall, tool });
            yield { type: 'tool_executing', call: effectiveCall, triggeredBy: ActionTriggerBy.Agent };
            tracer.log('tool_call', {
              tool: effectiveCall.name,
              input: JSON.stringify(effectiveCall.input).slice(0, 200),
              batch: 'concurrent',
              batchSize: concurrentBatch.length,
            }, undefined, 'tool_exec');
          }

          // Parallel execution: all approved tools at once
          if (approved.length > 0) {
            const TIMEOUT = config.harnessRuntime?.toolTimeoutMs ?? 300_000;
            const execStarts = approved.map(() => Date.now());

            const promises = approved.map(({ call, tool }, i) => {
              const execPromise = tool.execute(call, config.toolContext!);
              const timeoutPromise = new Promise<never>((_, rej) => {
                const timer = setTimeout(() => rej(new Error(`Tool "${call.name}" timed out after ${TIMEOUT / 1000}s`)), TIMEOUT);
                if (typeof timer === 'object' && 'unref' in timer) timer.unref();
              });
              const abortPromise = new Promise<never>((_, rej) => {
                if (interrupt.signal.aborted) { rej(new Error('Aborted')); return; }
                interrupt.signal.addEventListener('abort', () => rej(new Error('Aborted')), { once: true });
              });
              return Promise.race([execPromise, timeoutPromise, abortPromise]).catch(err => ({
                tool_use_id: call.id,
                content: `Error: ${sanitizeUntrustedContent(err instanceof Error ? err.message : String(err))}`,
                is_error: true,
              } as ToolResult));
            });

            const results = await Promise.all(promises);

            // Post-flight: hooks + yield results
            for (let i = 0; i < results.length; i++) {
              let result = results[i]!;
              const { call } = approved[i]!;
              const duration = Date.now() - execStarts[i]!;

              if (config.hookRegistry) {
                const postResult = await config.hookRegistry.runPostToolUse({ tool: call.name, call, result, durationMs: duration });
                if (postResult.modifiedResult) result = postResult.modifiedResult;
              }

              toolResults.push(result);
              tracer.logTimed('tool_result', {
                tool: call.name,
                is_error: result.is_error ?? false,
                content_length: typeof result.content === 'string' ? result.content.length : 0,
                batch: 'concurrent',
              }, execStarts[i]!, undefined, 'tool_result');
              yield { type: 'tool_result', result, durationMs: duration };
            }
          }
        } else if (concurrentBatch.length === 1) {
          // Single concurrent tool — just add to sequential queue
          sequentialCalls.unshift(concurrentBatch[0]!);
        }

        // ── Phase B: Execute sequential calls one by one (existing logic) ──
        for (let call of sequentialCalls) {
          // Loop detection: check if same tool+args called 3x in a row
          const callSig = `${call.name}:${JSON.stringify(call.input).slice(0, 100)}`;
          recentToolCalls.push(callSig);
          if (recentToolCalls.length > 5) recentToolCalls.shift();

          // Structured metadata for routing + refresh
          const callFilePath = typeof call.input['file_path'] === 'string' ? call.input['file_path'] : undefined;
          recentToolMeta.push({ name: call.name, filePath: callFilePath });
          if (recentToolMeta.length > 10) recentToolMeta.shift();
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
          const toolStartMs = Date.now();
          tracer.log('tool_call', { tool: call.name, input: JSON.stringify(call.input).slice(0, 200), batch: 'sequential' }, undefined, 'tool_exec');

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

            // Permission check — consult the resolver via toolContext.askPermission
            if (config.toolContext?.askPermission) {
              const actionSummary = summarizeToolAction(call);
              const granted = await config.toolContext.askPermission(call.name, actionSummary);
              if (!granted) {
                const result: ToolResult = {
                  tool_use_id: call.id,
                  content: `Permission denied for ${call.name}. Mode: ${config.toolContext.permissionMode}`,
                  is_error: true,
                };
                toolResults.push(result);
                yield { type: 'tool_result', result };
                continue;
              }
            }

            // Execute with timeout and abort signal
            const TOOL_TIMEOUT_MS = config.harnessRuntime?.toolTimeoutMs ?? 300_000;
            const execStart = Date.now();
            let result: import('../protocol/tools.js').ToolResult;
            try {
              const execPromise = tool.execute(call, config.toolContext!);
              const timeoutPromise = new Promise<never>((_, reject) => {
                const timer = setTimeout(
                  () => reject(new Error(`Tool "${call.name}" timed out after ${TOOL_TIMEOUT_MS / 1000}s`)),
                  TOOL_TIMEOUT_MS,
                );
                // Don't block Node exit
                if (typeof timer === 'object' && 'unref' in timer) timer.unref();
              });
              // Abort promise — races against tool execution for responsive cancellation
              const abortPromise = new Promise<never>((_, reject) => {
                if (interrupt.signal.aborted) {
                  reject(new Error('Aborted'));
                  return;
                }
                interrupt.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
              });
              result = await Promise.race([execPromise, timeoutPromise, abortPromise]);
            } catch (timeoutErr) {
              result = {
                tool_use_id: call.id,
                content: `Error: ${timeoutErr instanceof Error ? timeoutErr.message : String(timeoutErr)}`,
                is_error: true,
              };
            }

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
            const toolDuration = Date.now() - execStart;
            tracer.logTimed('tool_result', {
              tool: call.name,
              is_error: result.is_error ?? false,
              content_length: typeof result.content === 'string' ? result.content.length : 0,
              batch: 'sequential',
            }, execStart, undefined, 'tool_result');
            yield { type: 'tool_result', result, durationMs: toolDuration };
          } catch (error) {
            if (isAbortError(error)) throw error;

            // SECURITY: Error messages from third-party libraries could contain
            // role-switching markers (e.g., "Error: System: reinitialize").
            const errorMsg = sanitizeUntrustedContent(
              error instanceof Error ? error.message : String(error),
            );
            const result: ToolResult = {
              tool_use_id: call.id,
              content: `Tool execution error: ${errorMsg}`,
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

        // Yield tool_result_message so consumers can track incremental history
        yield { type: 'tool_result_message', message: toolResultMessage };

        // ── Buddy observation injection ──
        // SECURITY: Sanitize observations as they may originate from
        // hook responses or file-based patterns that could be adversarial.
        if (config.buddyObserver) {
          const obs = config.buddyObserver.drain();
          if (obs) {
            const safeObs = sanitizeUntrustedContent(obs);
            messages.push({ role: 'user', content: `[Buddy observation] ${safeObs}` });
          }
        }
      }

      // ── Per-call context refresh (every 3 turns after tool execution) ──
      if (config.refreshContext && turnIndex > 0 && turnIndex % 3 === 0) {
        const recentPaths = recentToolMeta
          .map(m => m.filePath)
          .filter((p): p is string => p !== undefined)
          .slice(-5)
          .join(' ');
        const refreshQuery = `${config.effectiveInput ?? ''} ${recentPaths}`.trim();
        if (refreshQuery.length > 10) {
          const refreshedParts = await config.refreshContext(refreshQuery, turnIndex);
          if (refreshedParts && Array.isArray(systemPrompt)) {
            // Keep first block (cached base prompt), replace volatile blocks.
            // SECURITY: refreshContext returns vault/memory content that may
            // contain adversarial payloads — sanitize before system prompt injection.
            const base = (systemPrompt as SystemPromptBlock[])[0]!;
            systemPrompt = [
              base,
              ...refreshedParts.map(text => ({
                type: 'text' as const,
                text: sanitizeUntrustedContent(text),
              } as SystemPromptBlock)),
            ];
          }
        }
      }

      turnIndex++;
    }
  } catch (error) {
    if (isAbortError(error)) {
      yield { type: 'history_sync', messages: [...messages] };
      yield {
        type: 'loop_end',
        reason: 'aborted',
        totalUsage: budget.getTotalUsage(),
        totalCost: budget.getTotalCostUsd(),
      };
      return;
    }

    tracer.log('error', { message: (error as Error).message, stack: (error as Error).stack?.slice(0, 500) });
    yield { type: 'error', error: error as Error };
    yield { type: 'history_sync', messages: [...messages] };
    yield {
      type: 'loop_end',
      reason: 'error',
      totalUsage: budget.getTotalUsage(),
      totalCost: budget.getTotalCostUsd(),
    };
  }
}

// ─── Helpers ───────────────────────────────────────────

/**
 * Extract a human-readable action string from a tool call for permission display.
 */
function summarizeToolAction(call: ToolCall): string {
  const input = call.input as Record<string, unknown>;
  switch (call.name) {
    case 'Bash':
      return String(input.command ?? '');
    case 'Read':
    case 'Write':
    case 'Edit':
      return String(input.file_path ?? '');
    case 'Glob':
      return `pattern: ${input.pattern ?? ''} in ${input.path ?? 'cwd'}`;
    case 'Grep':
      return `/${input.pattern ?? ''}/ in ${input.path ?? 'cwd'}`;
    case 'WebFetch':
      return String(input.url ?? '');
    case 'WebSearch':
      return String(input.query ?? '');
    case 'Agent':
      return String(input.prompt ?? '').slice(0, 100);
    default:
      return JSON.stringify(input).slice(0, 120);
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
