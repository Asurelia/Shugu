/**
 * Layer 14 — Plugins: Registry
 *
 * Central registry that manages loaded plugins and integrates their
 * contributions (tools, commands, skills, hooks) into the main system.
 */

import { EventEmitter } from 'node:events';
import type { Plugin, PluginManifest } from './loader.js';
import { loadAllPlugins } from './loader.js';
import { HookRegistry } from './hooks.js';
import type { ToolRegistry, Tool } from '../protocol/tools.js';
import type { CommandRegistry } from '../commands/registry.js';
import type { SkillRegistry } from '../skills/loader.js';

// ─── Plugin Registry ───────────────────────────────────

export class PluginRegistry extends EventEmitter {
  private plugins = new Map<string, Plugin>();
  private hookRegistry: HookRegistry;

  constructor() {
    super();
    this.hookRegistry = new HookRegistry();

    // Forward hook events
    this.hookRegistry.on('hook:error', (plugin, type, error) => {
      this.emit('plugin:hook-error', plugin, type, error);
    });
    this.hookRegistry.on('hook:blocked', (plugin, type, reason) => {
      this.emit('plugin:hook-blocked', plugin, type, reason);
    });
  }

  /**
   * Load all plugins and integrate them.
   */
  async loadAll(
    projectDir: string,
    toolRegistry: ToolRegistry,
    commandRegistry: CommandRegistry,
    skillRegistry: SkillRegistry,
  ): Promise<{ loaded: number; failed: number }> {
    const plugins = await loadAllPlugins(projectDir);
    let loaded = 0;
    let failed = 0;

    for (const plugin of plugins) {
      this.plugins.set(plugin.manifest.name, plugin);

      if (!plugin.active) {
        failed++;
        this.emit('plugin:error', plugin.manifest.name, plugin.error);
        continue;
      }

      // Integrate tools
      if (plugin.tools) {
        for (const tool of plugin.tools) {
          toolRegistry.register(tool);
        }
      }

      // Integrate commands
      if (plugin.commands) {
        for (const command of plugin.commands) {
          commandRegistry.register(command);
        }
      }

      // Integrate skills
      if (plugin.skills) {
        for (const skill of plugin.skills) {
          skillRegistry.register(skill);
        }
      }

      // Integrate hooks
      if (plugin.hooks) {
        for (const hook of plugin.hooks) {
          this.hookRegistry.register(hook);
        }
      }

      loaded++;
      this.emit('plugin:loaded', plugin.manifest.name);
    }

    return { loaded, failed };
  }

  /**
   * Get the hook registry for intercepting tool/command execution.
   */
  getHookRegistry(): HookRegistry {
    return this.hookRegistry;
  }

  /**
   * Get a plugin by name.
   */
  get(name: string): Plugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * List all plugins.
   */
  list(): Plugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * List active plugins.
   */
  listActive(): Plugin[] {
    return this.list().filter((p) => p.active);
  }

  /**
   * Unload a specific plugin.
   */
  unload(name: string): boolean {
    const plugin = this.plugins.get(name);
    if (!plugin) return false;

    // Remove hooks
    this.hookRegistry.unregisterPlugin(name);

    // Mark as inactive (tools/commands/skills remain registered for this session)
    plugin.active = false;
    this.emit('plugin:unloaded', name);

    return true;
  }

  /**
   * Get summary info about all plugins.
   */
  getSummary(): string {
    const all = this.list();
    if (all.length === 0) return 'No plugins loaded.';

    const lines = [`Plugins (${all.length}):`];
    for (const plugin of all) {
      const status = plugin.active ? '✓' : '✗';
      const extras: string[] = [];
      if (plugin.tools?.length) extras.push(`${plugin.tools.length} tools`);
      if (plugin.commands?.length) extras.push(`${plugin.commands.length} commands`);
      if (plugin.skills?.length) extras.push(`${plugin.skills.length} skills`);
      if (plugin.hooks?.length) extras.push(`${plugin.hooks.length} hooks`);
      const extrasStr = extras.length > 0 ? ` (${extras.join(', ')})` : '';
      const errorStr = plugin.error ? ` — ${plugin.error}` : '';
      lines.push(`  ${status} ${plugin.manifest.name}@${plugin.manifest.version}${extrasStr}${errorStr}`);
    }
    return lines.join('\n');
  }

  get size(): number {
    return this.plugins.size;
  }

  get activeCount(): number {
    return this.listActive().length;
  }
}
