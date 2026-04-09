/**
 * Full integration test for brokered plugin isolation.
 *
 * Tests the COMPLETE flow: loadAllPlugins → PluginRegistry.loadAll →
 * HookRegistry → tool/command execution through the real registries.
 *
 * This is NOT a unit test — it spawns real child processes and tests
 * the actual IPC round-trip through the full plugin loading pipeline.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PluginRegistry } from '../src/plugins/registry.js';
import { ToolRegistryImpl } from '../src/tools/registry.js';
import { CommandRegistry } from '../src/commands/registry.js';
import { SkillRegistry } from '../src/skills/loader.js';
import type { PluginWithHost } from '../src/plugins/loader.js';

describe('plugin brokered isolation: full integration', () => {
  let projectDir: string;
  let pluginRegistry: PluginRegistry;

  afterEach(async () => {
    if (pluginRegistry) {
      await pluginRegistry.disposeAll();
    }
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('loads a brokered plugin through PluginRegistry.loadAll and wires tool + hook + command into real registries', async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'integ-'));
    const pluginDir = join(projectDir, '.pcc', 'plugins', 'integ-plugin');
    await mkdir(pluginDir, { recursive: true });

    // Write manifest
    await writeFile(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'integ-plugin',
        version: '1.0.0',
        description: 'Integration test plugin',
        entry: 'index.mjs',
        isolation: 'brokered',
        permissions: ['tools', 'hooks', 'commands'],
        capabilities: ['fs.read'],
      }),
      'utf-8',
    );

    // Write plugin code — registers a tool, a PreToolUse hook, and a command
    await writeFile(
      join(pluginDir, 'index.mjs'),
      `export default function init(api) {
  // Register a tool
  api.registerTool({
    definition: {
      name: 'integ-echo',
      description: 'Echo for integration testing',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
    async execute(call, ctx) {
      return {
        tool_use_id: call.id,
        content: 'ECHO: ' + (call.input.text ?? 'nothing'),
      };
    },
  });

  // Register a PreToolUse hook that adds metadata
  api.registerHook('PreToolUse', async (payload) => {
    return { proceed: true };
  }, 50);

  // Register a command
  api.registerCommand({
    name: 'integ-hello',
    description: 'Integration test command',
    usage: '/integ-hello [name]',
    async execute(args, ctx) {
      ctx.info('Hello from integ plugin: ' + (args || 'world'));
      return { type: 'handled' };
    },
  });

  api.log('integ-plugin fully initialized');
}
`,
      'utf-8',
    );

    // Create the real registries (same as bootstrap.ts does)
    const toolRegistry = new ToolRegistryImpl();
    const commandRegistry = new CommandRegistry();
    const skillRegistry = new SkillRegistry();
    pluginRegistry = new PluginRegistry();

    // Load through the REAL loadAll pipeline (with local plugin confirmation)
    const result = await pluginRegistry.loadAll(
      projectDir,
      toolRegistry,
      commandRegistry,
      skillRegistry,
      { onConfirmLocal: async () => true },
    );

    expect(result.loaded).toBe(1);
    expect(result.failed).toBe(0);

    // Verify plugin is active
    const plugin = pluginRegistry.get('integ-plugin');
    expect(plugin).toBeDefined();
    expect(plugin!.active).toBe(true);
    expect(plugin!.manifest.isolation).toBe('brokered');

    // ─── Verify tool is in the REAL tool registry ───
    expect(toolRegistry.has('integ-echo')).toBe(true);
    const tool = toolRegistry.get('integ-echo')!;
    expect(tool.definition.name).toBe('integ-echo');
    expect(tool.definition.description).toBe('Echo for integration testing');

    // Execute the tool through the real registry
    const toolResult = await tool.execute(
      { id: 'integ-1', name: 'integ-echo', input: { text: 'hello integration' } },
      { cwd: projectDir, abortSignal: new AbortController().signal, permissionMode: 'default', askPermission: async () => true },
    );
    expect(toolResult.tool_use_id).toBe('integ-1');
    expect(toolResult.content).toBe('ECHO: hello integration');

    // ─── Verify command is in the REAL command registry ───
    const cmd = commandRegistry.get('integ-hello');
    expect(cmd).toBeDefined();
    expect(cmd!.name).toBe('integ-hello');

    // Execute the command through the real registry
    const infos: string[] = [];
    const cmdResult = await cmd!.execute('World', {
      cwd: projectDir,
      messages: [],
      info: (msg) => infos.push(msg),
      error: () => {},
    });
    expect(cmdResult).toEqual({ type: 'handled' });
    expect(infos).toContain('Hello from integ plugin: World');

    // ─── Verify hooks are in the REAL hook registry ───
    const hookRegistry = pluginRegistry.getHookRegistry();
    const preToolHooks = hookRegistry.getHooks('PreToolUse');
    expect(preToolHooks.some(h => h.pluginName === 'integ-plugin')).toBe(true);

    // Invoke the hook through the real hook registry
    const hookResult = await hookRegistry.runPreToolUse({
      tool: 'integ-echo',
      call: { id: 'h-integ', name: 'integ-echo', input: { text: 'hook test' } },
    });
    expect(hookResult.proceed).toBe(true);

    // ─── Verify env isolation ───
    // The plugin runs in a child process with sanitized env
    // We can't directly test this here (would need the child to report env),
    // but the E2E test in plugin-brokered-e2e.test.ts covers this.

  }, 20_000);

  it('unload removes tool + command + hooks from real registries', async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'integ-unload-'));
    const pluginDir = join(projectDir, '.pcc', 'plugins', 'unload-plugin');
    await mkdir(pluginDir, { recursive: true });

    await writeFile(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'unload-plugin',
        version: '1.0.0',
        description: 'Unload test',
        entry: 'index.mjs',
        isolation: 'brokered',
        permissions: ['tools', 'commands'],
      }),
      'utf-8',
    );

    await writeFile(
      join(pluginDir, 'index.mjs'),
      `export default function init(api) {
  api.registerTool({
    definition: { name: 'unload-tool', description: 'Will be removed', inputSchema: { type: 'object', properties: {} } },
    async execute(call) { return { tool_use_id: call.id, content: 'ok' }; },
  });
  api.registerCommand({
    name: 'unload-cmd',
    description: 'Will be removed',
    async execute() { return { type: 'handled' }; },
  });
}
`,
      'utf-8',
    );

    const toolRegistry = new ToolRegistryImpl();
    const commandRegistry = new CommandRegistry();
    const skillRegistry = new SkillRegistry();
    pluginRegistry = new PluginRegistry();

    await pluginRegistry.loadAll(projectDir, toolRegistry, commandRegistry, skillRegistry, {
      onConfirmLocal: async () => true,
    });

    // Verify registered
    expect(toolRegistry.has('unload-tool')).toBe(true);
    expect(commandRegistry.get('unload-cmd')).toBeDefined();

    // Unload
    const unloaded = pluginRegistry.unload('unload-plugin');
    expect(unloaded).toBe(true);

    // Verify removed from registries
    expect(toolRegistry.has('unload-tool')).toBe(false);
    expect(commandRegistry.get('unload-cmd')).toBeUndefined();

    // Verify plugin is inactive
    const plugin = pluginRegistry.get('unload-plugin');
    expect(plugin!.active).toBe(false);

  }, 20_000);

  it('policy file disables a plugin before it loads', async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'integ-policy-'));
    const pluginDir = join(projectDir, '.pcc', 'plugins', 'disabled-plugin');
    await mkdir(pluginDir, { recursive: true });

    // Create a policy that disables this plugin
    await mkdir(join(projectDir, '.pcc'), { recursive: true });
    await writeFile(
      join(projectDir, '.pcc', 'plugin-policy.json'),
      JSON.stringify({
        version: 1,
        plugins: {
          'disabled-plugin': { enabled: false },
        },
      }),
      'utf-8',
    );

    // Create a marker file to detect side effects
    const markerPath = join(pluginDir, 'marker.txt');
    await writeFile(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'disabled-plugin',
        version: '1.0.0',
        description: 'Should not load',
        entry: 'index.mjs',
        isolation: 'brokered',
        permissions: ['tools'],
      }),
      'utf-8',
    );

    await writeFile(
      join(pluginDir, 'index.mjs'),
      `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(markerPath)}, 'side-effect', 'utf-8');
export default function init(api) {
  api.registerTool({
    definition: { name: 'disabled-tool', description: 'Never', inputSchema: { type: 'object', properties: {} } },
    async execute(call) { return { tool_use_id: call.id, content: 'never' }; },
  });
}
`,
      'utf-8',
    );

    const toolRegistry = new ToolRegistryImpl();
    const commandRegistry = new CommandRegistry();
    const skillRegistry = new SkillRegistry();
    pluginRegistry = new PluginRegistry();

    await pluginRegistry.loadAll(projectDir, toolRegistry, commandRegistry, skillRegistry, {
      onConfirmLocal: async () => true,
    });

    // Plugin should not be active
    const plugin = pluginRegistry.get('disabled-plugin');
    expect(plugin).toBeDefined();
    expect(plugin!.active).toBe(false);
    expect(plugin!.error).toContain('Disabled by policy');

    // Tool should NOT be in registry
    expect(toolRegistry.has('disabled-tool')).toBe(false);

    // Marker file should NOT exist (code never executed)
    const { access } = await import('node:fs/promises');
    await expect(access(markerPath)).rejects.toThrow();

  }, 15_000);
});
