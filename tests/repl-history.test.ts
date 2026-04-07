/**
 * Integration test — History persistence through runLoop
 *
 * Verifies that tool_result messages survive the loop and are
 * available to consumers via history_sync events.
 *
 * Uses a mock MiniMaxClient that returns predictable responses:
 * - Turn 1: assistant returns tool_use (Read) → tool executes → tool_result built
 * - Turn 2: assistant returns end_turn with text
 * - Verify: history_sync contains [user, assistant(tool_use), user(tool_result), assistant(text)]
 * - Verify: ensureToolResultPairing() on this array produces NO synthetic results
 * - Verify: tool_result_message event was yielded
 */

import { describe, it, expect, vi } from 'vitest';
import { runLoop, type LoopConfig, type LoopEvent } from '../src/engine/loop.js';
import { ensureToolResultPairing } from '../src/engine/turns.js';
import type { Message, AssistantMessage, UserMessage } from '../src/protocol/messages.js';
import type { Tool, ToolCall, ToolResult, ToolContext, ToolDefinition } from '../src/protocol/tools.js';
import type { StreamEvent } from '../src/protocol/events.js';
import type { AccumulatedResponse } from '../src/transport/stream.js';

// ─── Mock Client ──────────────────────────────────────────

function createMockClient(responses: AccumulatedResponse[]) {
  let callIndex = 0;

  return {
    model: 'mock-model',
    baseUrl: 'http://mock',

    async *stream(
      _messages: Message[],
      _options?: unknown,
    ): AsyncGenerator<StreamEvent> {
      // Yield nothing — accumulateStream is bypassed since we mock complete()
      // This is never actually called because we override the whole client
    },

    async complete(
      _messages: Message[],
      _options?: unknown,
    ): Promise<AccumulatedResponse> {
      const resp = responses[callIndex];
      if (!resp) throw new Error(`Mock client: no response for call ${callIndex}`);
      callIndex++;
      return resp;
    },
  };
}

// ─── Mock Tool ────────────────────────────────────────────

function createMockReadTool(): Tool {
  return {
    definition: {
      name: 'Read',
      description: 'Read a file',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path' },
        },
        required: ['file_path'],
      },
    },
    async execute(call: ToolCall, _ctx: ToolContext): Promise<ToolResult> {
      return {
        tool_use_id: call.id,
        content: 'file content here',
      };
    },
  };
}

// ─── Fake streaming client that works with runLoop ────────

/**
 * Creates a fake MiniMaxClient where stream() yields SSE events
 * that produce the desired AssistantMessage when accumulated.
 */
function createStreamingMockClient(responses: AssistantMessage[]) {
  let callIndex = 0;

  return {
    model: 'mock-model',
    baseUrl: 'http://mock',

    async *stream(
      _messages: Message[],
      _options?: unknown,
    ): AsyncGenerator<StreamEvent> {
      const resp = responses[callIndex];
      if (!resp) throw new Error(`Mock client: no response for call ${callIndex}`);
      callIndex++;

      // Emit message_start
      yield {
        type: 'message_start',
        message: {
          id: `msg_${callIndex}`,
          model: 'mock-model',
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      } as StreamEvent;

      // Emit content blocks
      for (let i = 0; i < resp.content.length; i++) {
        const block = resp.content[i]!;

        if (block.type === 'tool_use') {
          yield {
            type: 'content_block_start',
            index: i,
            content_block: { type: 'tool_use', id: block.id, name: block.name, input: '' },
          } as StreamEvent;

          yield {
            type: 'content_block_delta',
            index: i,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
          } as StreamEvent;

          yield { type: 'content_block_stop', index: i } as StreamEvent;
        } else if (block.type === 'text') {
          yield {
            type: 'content_block_start',
            index: i,
            content_block: { type: 'text', text: '' },
          } as StreamEvent;

          yield {
            type: 'content_block_delta',
            index: i,
            delta: { type: 'text_delta', text: block.text },
          } as StreamEvent;

          yield { type: 'content_block_stop', index: i } as StreamEvent;
        }
      }

      // Determine stop reason from content
      const hasToolUse = resp.content.some((b) => b.type === 'tool_use');
      const stopReason = hasToolUse ? 'tool_use' : 'end_turn';

      yield {
        type: 'message_delta',
        delta: { stop_reason: stopReason },
        usage: { output_tokens: 50 },
      } as StreamEvent;

      yield { type: 'message_stop' } as StreamEvent;
    },
  };
}

// ─── Tests ────────────────────────────────────────────────

describe('runLoop history persistence', () => {
  it('yields history_sync with complete message history including tool_results', async () => {
    // Turn 1: model returns tool_use
    const turn1Response: AssistantMessage = {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tool_1', name: 'Read', input: { file_path: '/test.ts' } },
      ],
    };

    // Turn 2: model returns text (end_turn)
    const turn2Response: AssistantMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'The file contains test code.' },
      ],
    };

    const mockClient = createStreamingMockClient([turn1Response, turn2Response]);
    const readTool = createMockReadTool();

    const tools = new Map<string, Tool>([['Read', readTool]]);
    const toolDefs: ToolDefinition[] = [readTool.definition];

    const config: LoopConfig = {
      client: mockClient as any,
      tools,
      toolDefinitions: toolDefs,
      toolContext: {
        cwd: '/test',
        abortSignal: new AbortController().signal,
        permissionMode: 'bypass',
      },
      maxTurns: 10,
    };

    const initialMessages: Message[] = [{ role: 'user', content: 'Read test.ts' }];
    const events: LoopEvent[] = [];

    for await (const event of runLoop(initialMessages, config)) {
      events.push(event);
    }

    // Verify tool_result_message event was yielded
    const toolResultMsgEvents = events.filter((e) => e.type === 'tool_result_message');
    expect(toolResultMsgEvents.length).toBe(1);
    const toolResultMsg = (toolResultMsgEvents[0] as { type: 'tool_result_message'; message: UserMessage }).message;
    expect(toolResultMsg.role).toBe('user');
    expect(Array.isArray(toolResultMsg.content)).toBe(true);

    // Verify history_sync event was yielded
    const historySyncEvents = events.filter((e) => e.type === 'history_sync');
    expect(historySyncEvents.length).toBe(1);

    const syncedMessages = (historySyncEvents[0] as { type: 'history_sync'; messages: Message[] }).messages;

    // Should contain: [user, assistant(tool_use), user(tool_result), assistant(text)]
    expect(syncedMessages.length).toBe(4);
    expect(syncedMessages[0]!.role).toBe('user');
    expect(syncedMessages[1]!.role).toBe('assistant');
    expect(syncedMessages[2]!.role).toBe('user');
    expect(syncedMessages[3]!.role).toBe('assistant');

    // The tool_result user message should contain actual tool results, not synthetic
    const toolResultUserMsg = syncedMessages[2] as UserMessage;
    expect(Array.isArray(toolResultUserMsg.content)).toBe(true);
    const resultBlock = (toolResultUserMsg.content as Array<{ type: string; tool_use_id?: string; content?: string }>)[0]!;
    expect(resultBlock.type).toBe('tool_result');
    expect(resultBlock.tool_use_id).toBe('tool_1');
    expect(resultBlock.content).toContain('file content here');

    // Verify ensureToolResultPairing produces NO synthetic results on this history
    const paired = ensureToolResultPairing(syncedMessages);
    expect(paired.length).toBe(syncedMessages.length);
  });

  it('yields history_sync even when loop ends without tool execution', async () => {
    const response: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello!' }],
    };

    const mockClient = createStreamingMockClient([response]);

    const config: LoopConfig = {
      client: mockClient as any,
      tools: new Map(),
      toolDefinitions: [],
      toolContext: {
        cwd: '/test',
        abortSignal: new AbortController().signal,
        permissionMode: 'bypass',
      },
      maxTurns: 10,
    };

    const events: LoopEvent[] = [];
    for await (const event of runLoop([{ role: 'user', content: 'hi' }], config)) {
      events.push(event);
    }

    const historySyncEvents = events.filter((e) => e.type === 'history_sync');
    expect(historySyncEvents.length).toBe(1);

    const syncedMessages = (historySyncEvents[0] as { type: 'history_sync'; messages: Message[] }).messages;
    expect(syncedMessages.length).toBe(2); // user + assistant
  });

  it('history_sync is a copy — mutating it does not affect the loop', async () => {
    const response: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Done' }],
    };

    const mockClient = createStreamingMockClient([response]);

    const config: LoopConfig = {
      client: mockClient as any,
      tools: new Map(),
      toolDefinitions: [],
      toolContext: {
        cwd: '/test',
        abortSignal: new AbortController().signal,
        permissionMode: 'bypass',
      },
      maxTurns: 10,
    };

    const events: LoopEvent[] = [];
    for await (const event of runLoop([{ role: 'user', content: 'test' }], config)) {
      events.push(event);
      if (event.type === 'history_sync') {
        // Mutate the synced messages — should NOT affect anything
        event.messages.length = 0;
      }
    }

    // Loop should still complete normally
    const loopEnd = events.find((e) => e.type === 'loop_end');
    expect(loopEnd).toBeDefined();
  });
});
