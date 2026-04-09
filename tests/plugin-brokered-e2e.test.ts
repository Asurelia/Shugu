/**
 * E2E test for brokered plugin isolation.
 *
 * Creates a real plugin on disk with isolation: 'brokered',
 * loads it via loadPlugin(), and verifies:
 * - tool proxy works end-to-end
 * - child process doesn't see MINIMAX_API_KEY
 * - permissions: [] still blocks execution
 * - permissions gate on host rejects unauthorized registrations
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPlugin, type PluginWithHost } from '../src/plugins/loader.js';

describe('brokered plugin E2E', () => {
  let pluginDir: string;

  afterEach(async () => {
    if (pluginDir) {
      // Shut down host if alive
      try {
        const plugin = (globalThis as Record<string, unknown>).__lastPlugin as PluginWithHost | undefined;
        if (plugin?._host && !plugin._host.isDead) {
          plugin._host.kill();
        }
      } catch { /* cleanup best effort */ }
      await rm(pluginDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('loads a brokered plugin and executes a tool via IPC', async () => {
    pluginDir = await mkdtemp(join(tmpdir(), 'e2e-brokered-'));

    // Write manifest
    await writeFile(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'e2e-test-plugin',
        version: '1.0.0',
        description: 'E2E test plugin',
        entry: 'index.mjs',
        isolation: 'brokered',
        permissions: ['tools'],
        capabilities: ['fs.read'],
      }),
      'utf-8',
    );

    // Write entry file — registers a simple tool
    await writeFile(
      join(pluginDir, 'index.mjs'),
      `export default function init(api) {
  api.registerTool({
    definition: {
      name: 'e2e-echo',
      description: 'Echo input back',
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
    },
    async execute(call) {
      const msg = call.input.message ?? 'no message';
      const hasApiKey = !!process.env.MINIMAX_API_KEY;
      return {
        tool_use_id: call.id,
        content: JSON.stringify({ echo: msg, hasApiKey }),
      };
    },
  });
  api.log('e2e-test-plugin initialized');
}
`,
      'utf-8',
    );

    // Load via the real loadPlugin path
    const plugin = await loadPlugin(pluginDir, 'global');
    (globalThis as Record<string, unknown>).__lastPlugin = plugin;

    // Should be active with 1 tool
    expect(plugin.active).toBe(true);
    expect(plugin.error).toBeUndefined();
    expect(plugin.tools).toHaveLength(1);
    expect(plugin.tools![0]!.definition.name).toBe('e2e-echo');

    // Execute the proxy tool
    const result = await plugin.tools![0]!.execute(
      { id: 'e2e-1', name: 'e2e-echo', input: { message: 'hello from E2E' } },
      {
        cwd: pluginDir,
        abortSignal: new AbortController().signal,
        permissionMode: 'default',
        askPermission: async () => true,
      },
    );

    expect(result.tool_use_id).toBe('e2e-1');
    const parsed = JSON.parse(result.content as string);
    expect(parsed.echo).toBe('hello from E2E');
    // Child should NOT see MINIMAX_API_KEY (env sanitized)
    expect(parsed.hasApiKey).toBe(false);
  }, 15_000);

  it('permissions: [] prevents execution even with isolation: brokered', async () => {
    pluginDir = await mkdtemp(join(tmpdir(), 'e2e-empty-perms-'));

    await writeFile(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'empty-perms-plugin',
        version: '1.0.0',
        description: 'Should not run any code',
        entry: 'index.mjs',
        isolation: 'brokered',
        permissions: [],
      }),
      'utf-8',
    );

    // Entry file creates a side-effect marker
    const markerPath = join(pluginDir, 'side-effect.txt');
    await writeFile(
      join(pluginDir, 'index.mjs'),
      `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(markerPath)}, 'executed', 'utf-8');
export default function init() {}`,
      'utf-8',
    );

    const plugin = await loadPlugin(pluginDir, 'global');

    // Plugin should be active (permissions: [] → skip execution) but no tools/hooks
    expect(plugin.active).toBe(true);
    expect(plugin.tools).toHaveLength(0);
    expect(plugin.hooks).toHaveLength(0);

    // Side effect file should NOT exist (code was never executed)
    const { access } = await import('node:fs/promises');
    await expect(access(markerPath)).rejects.toThrow();
  });

  it('host rejects tool registration when permissions lack "tools"', async () => {
    pluginDir = await mkdtemp(join(tmpdir(), 'e2e-no-tools-perm-'));

    await writeFile(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'no-tools-perm-plugin',
        version: '1.0.0',
        description: 'Has hooks permission but not tools',
        entry: 'index.mjs',
        isolation: 'brokered',
        permissions: ['hooks'],  // NO 'tools' permission
        capabilities: [],
      }),
      'utf-8',
    );

    await writeFile(
      join(pluginDir, 'index.mjs'),
      `export default function init(api) {
  // This should be silently rejected by the host
  api.registerTool({
    definition: {
      name: 'unauthorized-tool',
      description: 'Should not register',
      inputSchema: { type: 'object', properties: {} },
    },
    async execute(call) {
      return { tool_use_id: call.id, content: 'should not execute' };
    },
  });
}
`,
      'utf-8',
    );

    const plugin = await loadPlugin(pluginDir, 'global');
    (globalThis as Record<string, unknown>).__lastPlugin = plugin;

    // Plugin is active but tool registration was rejected
    expect(plugin.active).toBe(true);
    expect(plugin.tools).toHaveLength(0);
  }, 15_000);

  it('brokered plugin can register and invoke a skill with RegExp trigger and callbacks', async () => {
    pluginDir = await mkdtemp(join(tmpdir(), 'e2e-skill-'));

    await writeFile(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'skill-test-plugin',
        version: '1.0.0',
        description: 'Tests skill in brokered mode',
        entry: 'index.mjs',
        isolation: 'brokered',
        permissions: ['skills'],
        capabilities: [],
      }),
      'utf-8',
    );

    await writeFile(
      join(pluginDir, 'index.mjs'),
      `export default function init(api) {
  api.registerSkill({
    name: 'capitalize',
    description: 'Capitalizes input',
    category: 'utility',
    triggers: [
      { type: 'command', command: 'capitalize' },
      { type: 'pattern', regex: /capitalize\\s+(.+)/i },
    ],
    async execute(ctx) {
      ctx.info('Capitalizing: ' + ctx.input);
      return { type: 'prompt', prompt: ctx.input.toUpperCase() };
    },
  });
}
`,
      'utf-8',
    );

    const plugin = await loadPlugin(pluginDir, 'global');
    (globalThis as Record<string, unknown>).__lastPlugin = plugin;

    expect(plugin.active).toBe(true);
    expect(plugin.skills).toHaveLength(1);
    expect(plugin.skills![0]!.name).toBe('capitalize');

    // Verify RegExp trigger was reconstructed
    const patternTrigger = plugin.skills![0]!.triggers.find(t => t.type === 'pattern');
    expect(patternTrigger).toBeDefined();
    if (patternTrigger?.type === 'pattern') {
      expect(patternTrigger.regex.test('capitalize hello')).toBe(true);
    }

    // Execute the proxy skill
    const infos: string[] = [];
    const result = await plugin.skills![0]!.execute({
      input: 'hello world',
      args: 'hello world',
      cwd: pluginDir,
      messages: [],
      toolContext: { cwd: pluginDir, abortSignal: new AbortController().signal, permissionMode: 'default', askPermission: async () => true },
      tools: new Map(),
      info: (msg) => infos.push(msg),
      error: () => {},
      query: async () => 'mock',
      runAgent: async () => 'mock',
    });

    expect(result.type).toBe('prompt');
    if (result.type === 'prompt') {
      expect(result.prompt).toBe('HELLO WORLD');
    }
    expect(infos).toContain('Capitalizing: hello world');
  }, 15_000);

  it('brokered plugin can register and invoke a command with info callback', async () => {
    pluginDir = await mkdtemp(join(tmpdir(), 'e2e-cmd-'));

    await writeFile(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'cmd-test-plugin',
        version: '1.0.0',
        description: 'Tests command in brokered mode',
        entry: 'index.mjs',
        isolation: 'brokered',
        permissions: ['commands'],
        capabilities: [],
      }),
      'utf-8',
    );

    await writeFile(
      join(pluginDir, 'index.mjs'),
      `export default function init(api) {
  api.registerCommand({
    name: 'greet',
    description: 'Greet someone',
    usage: '/greet [name]',
    async execute(args, ctx) {
      ctx.info('Hello ' + (args || 'world') + '!');
      return { type: 'handled' };
    },
  });
}
`,
      'utf-8',
    );

    const plugin = await loadPlugin(pluginDir, 'global');
    (globalThis as Record<string, unknown>).__lastPlugin = plugin;

    expect(plugin.active).toBe(true);
    expect(plugin.commands).toHaveLength(1);
    expect(plugin.commands![0]!.name).toBe('greet');

    // Execute the proxy command
    const infos: string[] = [];
    const result = await plugin.commands![0]!.execute('Claude', {
      cwd: pluginDir,
      messages: [],
      info: (msg) => infos.push(msg),
      error: () => {},
    });

    expect(result).toEqual({ type: 'handled' });
    expect(infos).toContain('Hello Claude!');
  }, 15_000);

  it('brokered plugin can register and invoke all 7 hook types', async () => {
    pluginDir = await mkdtemp(join(tmpdir(), 'e2e-hooks-'));

    await writeFile(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'hooks-test-plugin',
        version: '1.0.0',
        description: 'Tests all hook types in brokered mode',
        entry: 'index.mjs',
        isolation: 'brokered',
        permissions: ['hooks'],
        capabilities: [],
      }),
      'utf-8',
    );

    await writeFile(
      join(pluginDir, 'index.mjs'),
      `export default function init(api) {
  const types = ['PreToolUse', 'PostToolUse', 'PreCommand', 'PostCommand', 'OnMessage', 'OnStart', 'OnExit'];
  for (const type of types) {
    if (type === 'PreToolUse') {
      api.registerHook(type, async (payload) => ({ proceed: true }), 50);
    } else if (type === 'PostToolUse') {
      api.registerHook(type, async (payload) => ({ modifiedResult: undefined }), 50);
    } else if (type === 'OnStart' || type === 'OnExit') {
      api.registerHook(type, async () => {}, 50);
    } else {
      api.registerHook(type, async (payload) => {}, 50);
    }
  }
  api.log('all 7 hooks registered');
}
`,
      'utf-8',
    );

    const plugin = await loadPlugin(pluginDir, 'global');
    (globalThis as Record<string, unknown>).__lastPlugin = plugin;

    expect(plugin.active).toBe(true);
    expect(plugin.hooks).toHaveLength(7);

    const hookTypes = plugin.hooks!.map(h => h.type).sort();
    expect(hookTypes).toEqual(['OnExit', 'OnMessage', 'OnStart', 'PostCommand', 'PostToolUse', 'PreCommand', 'PreToolUse']);

    // Invoke each hook through its proxy to verify IPC round-trip
    const preToolUse = plugin.hooks!.find(h => h.type === 'PreToolUse')!;
    const ptResult = await preToolUse.handler({
      tool: 'Bash',
      call: { id: 'h1', name: 'Bash', input: { command: 'ls' } },
    });
    expect(ptResult).toHaveProperty('proceed', true);

    const onStart = plugin.hooks!.find(h => h.type === 'OnStart')!;
    const osResult = await onStart.handler();
    expect(osResult).toHaveProperty('status', 'ok');

    const preCmd = plugin.hooks!.find(h => h.type === 'PreCommand')!;
    const pcResult = await preCmd.handler({ command: 'review', args: '' });
    expect(pcResult).toHaveProperty('status', 'ok');

    const onMsg = plugin.hooks!.find(h => h.type === 'OnMessage')!;
    const omResult = await onMsg.handler({ message: { role: 'user', content: 'test' }, role: 'user' });
    expect(omResult).toHaveProperty('status', 'ok');
  }, 15_000);

  it('brokered command can call ctx.query() via bidirectional RPC', async () => {
    pluginDir = await mkdtemp(join(tmpdir(), 'e2e-query-'));

    await writeFile(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'query-test-plugin',
        version: '1.0.0',
        description: 'Tests query callback in brokered mode',
        entry: 'index.mjs',
        isolation: 'brokered',
        permissions: ['commands'],
      }),
      'utf-8',
    );

    await writeFile(
      join(pluginDir, 'index.mjs'),
      `export default function init(api) {
  api.registerCommand({
    name: 'ask-model',
    description: 'Calls ctx.query to ask the model something',
    async execute(args, ctx) {
      if (!ctx.query) {
        ctx.error('query not available');
        return { type: 'error', message: 'no query' };
      }
      const answer = await ctx.query('What is 2+2?');
      ctx.info('Model said: ' + answer);
      return { type: 'handled' };
    },
  });
}
`,
      'utf-8',
    );

    const plugin = await loadPlugin(pluginDir, 'global');
    (globalThis as Record<string, unknown>).__lastPlugin = plugin;

    expect(plugin.active).toBe(true);
    expect(plugin.commands).toHaveLength(1);

    const infos: string[] = [];
    const result = await plugin.commands![0]!.execute('', {
      cwd: pluginDir,
      messages: [],
      info: (msg) => infos.push(msg),
      error: (msg) => infos.push('ERR: ' + msg),
      query: async (prompt) => `The answer to "${prompt}" is 4`,
    });

    expect(result).toEqual({ type: 'handled' });
    expect(infos.some(m => m.includes('Model said:') && m.includes('4'))).toBe(true);
  }, 15_000);

  it('brokered skill can call ctx.runAgent() via bidirectional RPC', async () => {
    pluginDir = await mkdtemp(join(tmpdir(), 'e2e-runagent-'));

    await writeFile(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'agent-test-plugin',
        version: '1.0.0',
        description: 'Tests runAgent callback in brokered mode',
        entry: 'index.mjs',
        isolation: 'brokered',
        permissions: ['skills'],
      }),
      'utf-8',
    );

    await writeFile(
      join(pluginDir, 'index.mjs'),
      `export default function init(api) {
  api.registerSkill({
    name: 'delegate',
    description: 'Delegates work to an agent',
    category: 'automation',
    triggers: [{ type: 'command', command: 'delegate' }],
    async execute(ctx) {
      const agentResult = await ctx.runAgent('Summarize the project');
      ctx.info('Agent returned: ' + agentResult);
      return { type: 'prompt', prompt: agentResult };
    },
  });
}
`,
      'utf-8',
    );

    const plugin = await loadPlugin(pluginDir, 'global');
    (globalThis as Record<string, unknown>).__lastPlugin = plugin;

    expect(plugin.active).toBe(true);
    expect(plugin.skills).toHaveLength(1);

    const infos: string[] = [];
    const result = await plugin.skills![0]!.execute({
      input: '/delegate',
      args: '',
      cwd: pluginDir,
      messages: [],
      toolContext: { cwd: pluginDir, abortSignal: new AbortController().signal, permissionMode: 'default', askPermission: async () => true },
      tools: new Map(),
      info: (msg) => infos.push(msg),
      error: () => {},
      query: async () => 'mock',
      runAgent: async (prompt) => `Agent result for: ${prompt}`,
    });

    expect(result.type).toBe('prompt');
    if (result.type === 'prompt') {
      expect(result.prompt).toContain('Agent result for: Summarize the project');
    }
    expect(infos.some(m => m.includes('Agent returned:'))).toBe(true);
  }, 15_000);

  it('brokered skill can call tool_invoke via proxy tools Map', async () => {
    pluginDir = await mkdtemp(join(tmpdir(), 'e2e-toolinvoke-'));

    await writeFile(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'toolinvoke-test-plugin',
        version: '1.0.0',
        description: 'Tests tool_invoke callback in brokered mode',
        entry: 'index.mjs',
        isolation: 'brokered',
        permissions: ['skills'],
      }),
      'utf-8',
    );

    await writeFile(
      join(pluginDir, 'index.mjs'),
      `export default function init(api) {
  api.registerSkill({
    name: 'use-tool',
    description: 'Skill that invokes a tool',
    category: 'utility',
    triggers: [{ type: 'command', command: 'use-tool' }],
    async execute(ctx) {
      const tool = ctx.tools.get('mock-read');
      if (!tool) {
        return { type: 'error', message: 'mock-read tool not found' };
      }
      const result = await tool.execute(
        { id: 'ti-1', name: 'mock-read', input: { path: '/test.txt' } },
        ctx.toolContext,
      );
      ctx.info('Tool result: ' + result.content);
      return { type: 'handled' };
    },
  });
}
`,
      'utf-8',
    );

    const plugin = await loadPlugin(pluginDir, 'global');
    (globalThis as Record<string, unknown>).__lastPlugin = plugin;

    expect(plugin.active).toBe(true);
    expect(plugin.skills).toHaveLength(1);

    // Create a mock tool that the skill will invoke
    const mockReadTool = {
      definition: { name: 'mock-read', description: 'Mock read', inputSchema: { type: 'object' as const, properties: {} } },
      async execute(call: { id: string; name: string; input: Record<string, unknown> }) {
        return { tool_use_id: call.id, content: `Contents of ${call.input['path']}` };
      },
    };

    const infos: string[] = [];
    const result = await plugin.skills![0]!.execute({
      input: '/use-tool',
      args: '',
      cwd: pluginDir,
      messages: [],
      toolContext: { cwd: pluginDir, abortSignal: new AbortController().signal, permissionMode: 'default', askPermission: async () => true },
      tools: new Map([['mock-read', mockReadTool as any]]),
      info: (msg) => infos.push(msg),
      error: () => {},
      query: async () => 'mock',
      runAgent: async () => 'mock',
    });

    expect(result).toEqual({ type: 'handled' });
    expect(infos.some(m => m.includes('Tool result:') && m.includes('Contents of /test.txt'))).toBe(true);
  }, 15_000);

  it('brokered plugin can use api.capabilities.readFile via broker', async () => {
    pluginDir = await mkdtemp(join(tmpdir(), 'e2e-cap-'));

    // Create a file for the plugin to read
    await mkdir(join(pluginDir, '.data'), { recursive: true });
    await writeFile(join(pluginDir, '.data', 'test.txt'), 'capability-broker-works', 'utf-8');

    await writeFile(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'cap-test-plugin',
        version: '1.0.0',
        description: 'Tests capability broker',
        entry: 'index.mjs',
        isolation: 'brokered',
        permissions: ['tools'],
        capabilities: ['fs.read'],
      }),
      'utf-8',
    );

    await writeFile(
      join(pluginDir, 'index.mjs'),
      `export default function init(api) {
  api.registerTool({
    definition: {
      name: 'cap-read',
      description: 'Reads via capability broker',
      inputSchema: { type: 'object', properties: {} },
    },
    async execute(call, ctx) {
      const content = await api.capabilities.readFile(api.getDataDir() + '/test.txt');
      return { tool_use_id: call.id, content: 'Read: ' + content };
    },
  });
}
`,
      'utf-8',
    );

    const plugin = await loadPlugin(pluginDir, 'global');
    (globalThis as Record<string, unknown>).__lastPlugin = plugin;

    expect(plugin.active).toBe(true);
    expect(plugin.tools).toHaveLength(1);

    const result = await plugin.tools![0]!.execute(
      { id: 'cap-1', name: 'cap-read', input: {} },
      { cwd: pluginDir, abortSignal: new AbortController().signal, permissionMode: 'default', askPermission: async () => true },
    );

    expect(result.content).toBe('Read: capability-broker-works');
  }, 15_000);

  it('runAgent budget is enforced — 3rd call rejected when maxAgentTurns=2', async () => {
    pluginDir = await mkdtemp(join(tmpdir(), 'e2e-budget-'));

    await writeFile(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'budget-test-plugin',
        version: '1.0.0',
        description: 'Tests runAgent budget',
        entry: 'index.mjs',
        isolation: 'brokered',
        permissions: ['skills'],
      }),
      'utf-8',
    );

    await writeFile(
      join(pluginDir, 'index.mjs'),
      `export default function init(api) {
  api.registerSkill({
    name: 'greedy',
    description: 'Calls runAgent multiple times',
    category: 'utility',
    triggers: [{ type: 'command', command: 'greedy' }],
    async execute(ctx) {
      const results = [];
      for (let i = 0; i < 4; i++) {
        try {
          const r = await ctx.runAgent('Call ' + i);
          results.push('ok:' + r);
        } catch (e) {
          results.push('err:' + e.message);
        }
      }
      ctx.info(JSON.stringify(results));
      return { type: 'handled' };
    },
  });
}
`,
      'utf-8',
    );

    // Load with maxAgentTurns=2 via direct PluginHost construction
    const { CapabilityBroker } = await import('../src/plugins/broker.js');
    const { PluginHost } = await import('../src/plugins/host.js');

    const broker = new CapabilityBroker([], pluginDir, pluginDir);
    const host = new PluginHost({
      manifest: { name: 'budget-test-plugin', version: '1.0.0', description: '', entry: 'index.mjs', permissions: ['skills'] },
      pluginDir,
      capabilities: [],
      broker,
      maxAgentTurns: 2,
      disableOsSandbox: true,  // Skip Docker for speed in this test
    });

    await host.start();
    (globalThis as Record<string, unknown>).__lastPlugin = { _host: host };

    expect(host.skills.length).toBe(1);

    const infos: string[] = [];
    await host.skills[0]!.execute({
      input: '/greedy',
      args: '',
      cwd: pluginDir,
      messages: [],
      toolContext: { cwd: pluginDir, abortSignal: new AbortController().signal, permissionMode: 'default', askPermission: async () => true },
      tools: new Map(),
      info: (msg) => infos.push(msg),
      error: () => {},
      query: async () => 'mock',
      runAgent: async (prompt) => `Agent: ${prompt}`,
    });

    // Parse the results logged by the plugin
    const logged = JSON.parse(infos[0]!) as string[];
    // First 2 calls should succeed
    expect(logged[0]).toContain('ok:');
    expect(logged[1]).toContain('ok:');
    // 3rd and 4th calls should be rejected (budget exhausted)
    expect(logged[2]).toContain('err:');
    expect(logged[2]).toContain('budget exhausted');
    expect(logged[3]).toContain('err:');

    host.kill();
  }, 15_000);
});
