import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PluginHost } from '../src/plugins/host.js';
import { CapabilityBroker } from '../src/plugins/broker.js';

const MOCK_CHILD = join(__dirname, 'fixtures', 'mock-plugin-child.mjs');

let tempDir: string;

function createTestHost(opts?: { timeoutMs?: number }): PluginHost {
  const broker = new CapabilityBroker(['fs.read'], tempDir, tempDir);
  return new PluginHost({
    manifest: {
      name: 'test-plugin',
      version: '1.0.0',
      description: 'Test plugin',
      entry: 'index.mjs',
    },
    pluginDir: tempDir,
    capabilities: ['fs.read'],
    broker,
    childEntryPath: MOCK_CHILD,
    disableOsSandbox: true,
    timeoutMs: opts?.timeoutMs ?? 10_000,
  });
}

describe('PluginHost', () => {
  let host: PluginHost;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'host-test-'));
  });

  afterEach(async () => {
    if (host && !host.isDead) {
      host.kill();
    }
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('starts and collects tool registrations from mock child', async () => {
    host = createTestHost();
    await host.start();

    expect(host.tools.length).toBe(1);
    expect(host.tools[0]!.definition.name).toBe('mock-tool');
    expect(host.tools[0]!.definition.description).toBe('A mock tool for testing');
  });

  it('starts and collects command registrations from mock child', async () => {
    host = createTestHost();
    await host.start();

    expect(host.commands.length).toBe(1);
    expect(host.commands[0]!.name).toBe('mock-cmd');
    expect(host.commands[0]!.description).toBe('A mock command');
  });

  it('invokes a proxy command and receives callback/info via IPC', async () => {
    host = createTestHost();
    await host.start();

    const cmd = host.commands[0]!;
    const infos: string[] = [];
    const result = await cmd.execute('test-args', {
      cwd: tempDir,
      messages: [],
      info: (msg) => infos.push(msg),
      error: () => {},
    });

    expect(result).toEqual({ type: 'handled' });
    expect(infos.length).toBeGreaterThan(0);
    expect(infos[0]).toContain('mock-cmd');
  });

  it('starts and collects skill registrations with RegExp trigger from mock child', async () => {
    host = createTestHost();
    await host.start();

    expect(host.skills.length).toBe(1);
    expect(host.skills[0]!.name).toBe('mock-skill');
    expect(host.skills[0]!.category).toBe('utility');
    // Verify RegExp trigger was reconstructed
    const patternTrigger = host.skills[0]!.triggers.find(t => t.type === 'pattern');
    expect(patternTrigger).toBeDefined();
    if (patternTrigger?.type === 'pattern') {
      expect(patternTrigger.regex).toBeInstanceOf(RegExp);
      expect(patternTrigger.regex.test('Hello World')).toBe(true);
      expect(patternTrigger.regex.test('goodbye')).toBe(false);
    }
  });

  it('invokes a proxy skill and receives callback/info via IPC', async () => {
    host = createTestHost();
    await host.start();

    const skill = host.skills[0]!;
    const infos: string[] = [];
    const result = await skill.execute({
      input: 'hello world',
      args: '',
      cwd: tempDir,
      messages: [],
      toolContext: { cwd: tempDir, abortSignal: new AbortController().signal, permissionMode: 'default', askPermission: async () => true },
      tools: new Map(),
      info: (msg) => infos.push(msg),
      error: () => {},
      query: async () => 'mock query response',
      runAgent: async () => 'mock agent response',
    });

    expect(result).toEqual({ type: 'handled' });
    expect(infos.length).toBeGreaterThan(0);
    expect(infos[0]).toContain('mock-skill');
  });

  it('starts and collects all 7 hook type registrations from mock child', async () => {
    host = createTestHost();
    await host.start();

    expect(host.hooks.length).toBe(7);
    const types = host.hooks.map(h => h.type).sort();
    expect(types).toEqual(['OnExit', 'OnMessage', 'OnStart', 'PostCommand', 'PostToolUse', 'PreCommand', 'PreToolUse']);
    for (const hook of host.hooks) {
      expect(hook.pluginName).toBe('test-plugin');
      expect(hook.priority).toBe(50);
    }
  });

  it('invokes a proxy tool and gets the result via IPC', async () => {
    host = createTestHost();
    await host.start();

    const tool = host.tools[0]!;
    const result = await tool.execute(
      { id: 'call-1', name: 'mock-tool', input: { query: 'hello world' } },
      { cwd: '/tmp', abortSignal: new AbortController().signal, permissionMode: 'default', askPermission: async () => true },
    );

    expect(result.tool_use_id).toBe('call-1');
    expect(result.content).toContain('Mock result for: hello world');
  });

  it('invokes a proxy PreToolUse hook via IPC', async () => {
    host = createTestHost();
    await host.start();

    const hook = host.hooks.find(h => h.type === 'PreToolUse')!;
    expect(hook).toBeDefined();
    const result = await hook.handler({
      tool: 'Bash',
      call: { id: 'h1', name: 'Bash', input: { command: 'ls' } },
    });

    expect(result).toHaveProperty('proceed', true);
  });

  it('invokes fire-and-forget lifecycle hooks (OnStart, OnExit) via IPC', async () => {
    host = createTestHost();
    await host.start();

    const onStart = host.hooks.find(h => h.type === 'OnStart')!;
    expect(onStart).toBeDefined();
    const startResult = await onStart.handler();
    expect(startResult).toHaveProperty('status', 'ok');

    const onExit = host.hooks.find(h => h.type === 'OnExit')!;
    expect(onExit).toBeDefined();
    const exitResult = await onExit.handler();
    expect(exitResult).toHaveProperty('status', 'ok');
  });

  it('invokes PreCommand/PostCommand hooks via IPC', async () => {
    host = createTestHost();
    await host.start();

    const preCmd = host.hooks.find(h => h.type === 'PreCommand')!;
    expect(preCmd).toBeDefined();
    const preCmdResult = await preCmd.handler({ command: 'review', args: '' });
    expect(preCmdResult).toHaveProperty('status', 'ok');

    const postCmd = host.hooks.find(h => h.type === 'PostCommand')!;
    expect(postCmd).toBeDefined();
    const postCmdResult = await postCmd.handler({ command: 'review', args: '' });
    expect(postCmdResult).toHaveProperty('status', 'ok');
  });

  it('invokes OnMessage hook via IPC', async () => {
    host = createTestHost();
    await host.start();

    const onMsg = host.hooks.find(h => h.type === 'OnMessage')!;
    expect(onMsg).toBeDefined();
    const result = await onMsg.handler({
      message: { role: 'user', content: 'hello' },
      role: 'user',
    });
    expect(result).toHaveProperty('status', 'ok');
  });

  it('gracefully shuts down the child', async () => {
    host = createTestHost();
    await host.start();

    await host.shutdown();
    expect(host.isDead).toBe(true);
  });

  it('rejects calls after plugin is killed', async () => {
    host = createTestHost();
    await host.start();

    // Kill the host first
    host.kill();

    // Now try to call — should reject immediately (plugin is dead)
    await expect(
      host.tools[0]!.execute(
        { id: 'call-dead', name: 'mock-tool', input: { query: 'after kill' } },
        { cwd: tempDir, abortSignal: new AbortController().signal, permissionMode: 'default', askPermission: async () => true },
      ),
    ).rejects.toThrow(/dead/i);
  });
});
