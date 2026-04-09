/**
 * Mock plugin child process for testing PluginHost.
 * Responds to JSON-RPC init/invoke_tool/invoke_hook/shutdown.
 */
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.method === 'init') {
    // Register a mock tool
    send({
      jsonrpc: '2.0',
      method: 'register_tool',
      params: {
        definition: {
          name: 'mock-tool',
          description: 'A mock tool for testing',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        },
      },
    });
    // Register all 7 hook types
    const hookTypes = ['PreToolUse', 'PostToolUse', 'PreCommand', 'PostCommand', 'OnMessage', 'OnStart', 'OnExit'];
    for (const hookType of hookTypes) {
      send({
        jsonrpc: '2.0',
        method: 'register_hook',
        params: { hookType, priority: 50 },
      });
    }
    // Register a mock command
    send({
      jsonrpc: '2.0',
      method: 'register_command',
      params: { name: 'mock-cmd', description: 'A mock command', usage: '/mock-cmd [args]' },
    });
    // Register a mock skill with RegExp trigger
    send({
      jsonrpc: '2.0',
      method: 'register_skill',
      params: {
        name: 'mock-skill',
        description: 'A mock skill',
        category: 'utility',
        triggers: [
          { type: 'command', command: 'mock-skill' },
          { type: 'pattern', pattern: 'hello\\s+world', flags: 'i' },
        ],
      },
    });
    // Respond to init
    send({ jsonrpc: '2.0', id: msg.id, result: { status: 'ok' } });
  }

  if (msg.method === 'invoke_tool') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tool_use_id: msg.params.call.id,
        content: `Mock result for: ${msg.params.call.input.query ?? 'unknown'}`,
      },
    });
  }

  if (msg.method === 'invoke_hook') {
    if (msg.params.hookType === 'PreToolUse') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { proceed: true },
      });
    } else if (msg.params.hookType === 'PostToolUse') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { modifiedResult: undefined },
      });
    } else {
      // PreCommand, PostCommand, OnMessage, OnStart, OnExit — fire-and-forget, ack
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { status: 'ok' },
      });
    }
  }

  if (msg.method === 'invoke_skill') {
    send({ jsonrpc: '2.0', method: 'callback/info', params: { message: `Skill executing: ${msg.params.skillName}` } });
    send({ jsonrpc: '2.0', id: msg.id, result: { type: 'handled' } });
  }

  if (msg.method === 'invoke_command') {
    // Call info callback, then return handled
    send({ jsonrpc: '2.0', method: 'callback/info', params: { message: `Executing: ${msg.params.commandName} ${msg.params.args}` } });
    send({ jsonrpc: '2.0', id: msg.id, result: { type: 'handled' } });
  }

  if (msg.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: msg.id, result: { status: 'ok' } });
    setTimeout(() => process.exit(0), 50);
  }
});
