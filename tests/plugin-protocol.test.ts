import { describe, expect, it } from 'vitest';
import type {
  JsonRpcRequest, JsonRpcResponse, JsonRpcNotification,
  InitParams, InvokeToolParams, InvokeHookParams,
  RegisterToolParams, RegisterHookParams,
} from '../src/plugins/protocol.js';

describe('plugin protocol: JSON-RPC types', () => {
  it('round-trips a request through JSON', () => {
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'invoke_tool',
      params: {
        toolName: 'my-tool',
        call: { id: 'c1', name: 'my-tool', input: { query: 'test' } },
        context: { cwd: '/project', permissionMode: 'default' },
      } satisfies InvokeToolParams,
    };
    const json = JSON.stringify(req);
    const parsed = JSON.parse(json) as JsonRpcRequest;
    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.id).toBe(1);
    expect(parsed.method).toBe('invoke_tool');
    const params = parsed.params as InvokeToolParams;
    expect(params.toolName).toBe('my-tool');
    expect(params.call.input).toEqual({ query: 'test' });
  });

  it('round-trips a response through JSON', () => {
    const res: JsonRpcResponse = {
      jsonrpc: '2.0',
      id: 1,
      result: { tool_use_id: 'c1', content: 'result text' },
    };
    const parsed = JSON.parse(JSON.stringify(res)) as JsonRpcResponse;
    expect(parsed.id).toBe(1);
    expect(parsed.result).toEqual({ tool_use_id: 'c1', content: 'result text' });
    expect(parsed.error).toBeUndefined();
  });

  it('round-trips an error response', () => {
    const res: JsonRpcResponse = {
      jsonrpc: '2.0',
      id: 2,
      error: { code: -32601, message: 'Method not found' },
    };
    const parsed = JSON.parse(JSON.stringify(res)) as JsonRpcResponse;
    expect(parsed.error?.code).toBe(-32601);
    expect(parsed.error?.message).toBe('Method not found');
  });

  it('round-trips registration notifications', () => {
    const notif: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'register_tool',
      params: {
        definition: {
          name: 'test-tool',
          description: 'A test',
          inputSchema: { type: 'object', properties: {} },
        },
      } satisfies RegisterToolParams,
    };
    const parsed = JSON.parse(JSON.stringify(notif)) as JsonRpcNotification;
    expect(parsed.method).toBe('register_tool');
    const params = parsed.params as RegisterToolParams;
    expect(params.definition.name).toBe('test-tool');
  });

  it('handles empty params', () => {
    const req: JsonRpcRequest = { jsonrpc: '2.0', id: 99, method: 'shutdown' };
    const parsed = JSON.parse(JSON.stringify(req)) as JsonRpcRequest;
    expect(parsed.params).toBeUndefined();
  });
});
