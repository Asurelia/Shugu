/**
 * Layer 14 — Plugins: Loader
 *
 * Loads plugins from:
 * 1. ~/.pcc/plugins/     — user-global plugins
 * 2. .pcc/plugins/       — project-local plugins
 *
 * A plugin is a directory with a plugin.json manifest and entry file:
 *
 *   my-plugin/
 *   ├── plugin.json       Manifest (name, version, description, entry)
 *   └── index.ts/js       Entry point exporting a PluginInit function
 *
 * plugin.json:
 * {
 *   "name": "my-plugin",
 *   "version": "1.0.0",
 *   "description": "What this plugin does",
 *   "entry": "index.js",
 *   "hooks": ["PreToolUse", "PostToolUse"],
 *   "permissions": ["bash", "files"]
 * }
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Tool } from '../protocol/tools.js';
import type { Command } from '../commands/registry.js';
import type { Skill } from '../skills/loader.js';
import type { HookHandler, HookType } from './hooks.js';
import { PluginHost } from './host.js';
import { CapabilityBroker, type CapabilityName } from './broker.js';
import { logger } from '../utils/logger.js';
import { loadPolicy, resolvePluginConfig, type ResolvedPluginConfig, type IsolationInput } from './policy.js';

// ─── Plugin Manifest ───────────────────────────────────

export interface PluginManifest {
  /** Unique plugin name */
  name: string;
  /** Semantic version */
  version: string;
  /** Human-readable description */
  description: string;
  /** Entry file relative to plugin directory */
  entry: string;
  /** Hook types this plugin uses */
  hooks?: HookType[];
  /** Permission scopes for API registration (tools, hooks, commands, skills) */
  permissions?: string[];
  /**
   * Isolation mode:
   *  - 'unrestricted' — in-process, no sandbox (was 'trusted' — legacy name still accepted)
   *  - 'brokered'     — child process with capability IPC
   */
  isolation?: IsolationInput;
  /** Runtime capabilities for brokered mode (fs.read, fs.write, http.fetch, etc.) */
  capabilities?: string[];
  /** Author info */
  author?: string;
}

// ─── Plugin Instance ───────────────────────────────────

export interface Plugin {
  /** The manifest */
  manifest: PluginManifest;
  /** Directory path */
  path: string;
  /** Whether the plugin is loaded and active */
  active: boolean;
  /** Trust source: global (user-installed) or local (repo-controlled) */
  source: 'global' | 'local';
  /** Additional tools provided by this plugin */
  tools?: Tool[];
  /** Additional commands provided */
  commands?: Command[];
  /** Additional skills provided */
  skills?: Skill[];
  /** Hooks registered by this plugin */
  hooks?: HookHandler[];
  /** Error message if loading failed */
  error?: string;
}

// ─── Plugin Init API ───────────────────────────────────

/**
 * The context passed to a plugin's init function.
 * Provides a constrained API for the plugin to register its components.
 */
export interface PluginAPI {
  /** Register a tool */
  registerTool(tool: Tool): void;
  /** Register a command */
  registerCommand(command: Command): void;
  /** Register a skill */
  registerSkill(skill: Skill): void;
  /** Register a hook */
  registerHook(type: HookType, handler: (...args: unknown[]) => Promise<unknown>, priority?: number): void;
  /** Get the plugin's data directory (for storing persistent data) */
  getDataDir(): string;
  /** Log a message from the plugin */
  log(message: string): void;
}

/**
 * The function a plugin's entry file must export as default.
 */
export type PluginInit = (api: PluginAPI) => Promise<void> | void;

// ─── Loader ────────────────────────────────────────────

/**
 * Source of a discovered plugin directory.
 */
export interface PluginSource {
  dir: string;
  source: 'global' | 'local';
}

/**
 * Discover plugin directories with their trust source.
 */
export function discoverPluginDirs(projectDir: string): PluginSource[] {
  const dirs: PluginSource[] = [];

  // 1. Global plugins (user-installed, trusted)
  const globalDir = join(homedir(), '.pcc', 'plugins');
  if (existsSync(globalDir)) {
    dirs.push({ dir: globalDir, source: 'global' });
  }

  // 2. Project-local plugins (repo-controlled, untrusted)
  const localDir = join(projectDir, '.pcc', 'plugins');
  if (existsSync(localDir)) {
    dirs.push({ dir: localDir, source: 'local' });
  }

  return dirs;
}

/**
 * Load a plugin manifest from a directory.
 */
export function loadManifest(pluginDir: string): PluginManifest | null {
  const manifestPath = join(pluginDir, 'plugin.json');
  if (!existsSync(manifestPath)) return null;

  try {
    const raw = readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw) as PluginManifest;

    // Validate required fields
    if (!manifest.name || !manifest.version || !manifest.entry) {
      return null;
    }

    return manifest;
  } catch {
    return null;
  }
}

/**
 * Load a single plugin from a directory.
 * If resolvedConfig is provided (from policy resolution), its values take precedence
 * over the raw manifest values. If not provided (backward compat), resolves from
 * manifest with null policy.
 */
export async function loadPlugin(
  pluginDir: string,
  source: 'global' | 'local' = 'global',
  resolvedConfig?: ResolvedPluginConfig,
): Promise<Plugin> {
  const manifest = loadManifest(pluginDir);
  if (!manifest) {
    return {
      manifest: { name: 'unknown', version: '0.0.0', description: '', entry: '' },
      path: pluginDir,
      active: false,
      source,
      error: `No valid plugin.json found in ${pluginDir}`,
    };
  }

  // Resolve config from policy (or use null policy for backward compat)
  const resolved = resolvedConfig ?? resolvePluginConfig(manifest, null);

  // If disabled by policy, mark as inactive immediately
  if (!resolved.enabled) {
    return {
      manifest,
      path: pluginDir,
      active: false,
      source,
      error: 'Disabled by policy',
    };
  }

  const plugin: Plugin = {
    manifest,
    path: pluginDir,
    active: false,
    source,
    tools: [],
    commands: [],
    skills: [],
    hooks: [],
  };

  // permissions: [] → no capabilities, no code execution (applies to ALL modes)
  // This check is on the manifest declaration, not the resolved config.
  if (Array.isArray(manifest.permissions) && manifest.permissions.length === 0) {
    plugin.active = true;
    return plugin;
  }

  // Brokered isolation: use resolved isolation (policy can override manifest)
  const isolation = resolved.isolation;
  if (isolation === 'brokered') {
    return loadBrokeredPlugin(plugin, resolved.capabilities, resolved.timeoutMs);
  }

  // ─── Unrestricted path: in-process loading ───
  // This mode runs plugin code in the main process with full access to the
  // runtime — no sandbox, no capability broker. Consider 'brokered' for
  // anything you did not author yourself.
  if (manifest.name !== 'unknown') {
    logger.debug(`[plugin:${manifest.name}] Running in unrestricted mode (in-process). Set "isolation": "brokered" in plugin.json for process isolation.`);
  }

  try {
    const entryPath = join(pluginDir, manifest.entry);
    if (!existsSync(entryPath)) {
      plugin.error = `Entry file not found: ${manifest.entry}`;
      return plugin;
    }

    // Dynamic import the plugin's entry file
    const mod = await import(entryPath);
    const init: PluginInit = mod.default ?? mod.init;

    if (typeof init !== 'function') {
      plugin.error = `Entry file does not export a default function or init()`;
      return plugin;
    }

    // Create the API for this plugin
    const api = createPluginAPI(plugin);

    // Run the plugin's init
    await init(api);

    plugin.active = true;
  } catch (error) {
    plugin.error = error instanceof Error ? error.message : String(error);
  }

  return plugin;
}

/**
 * Load a plugin in brokered isolation (child process).
 * V1: only tools + PreToolUse/PostToolUse hooks are supported.
 */
async function loadBrokeredPlugin(
  plugin: Plugin,
  resolvedCapabilities?: string[],
  resolvedTimeoutMs?: number,
): Promise<Plugin> {
  try {
    const caps = (resolvedCapabilities ?? plugin.manifest.capabilities ?? ['fs.read']) as CapabilityName[];
    const broker = new CapabilityBroker(caps, plugin.path, process.cwd());
    const host = new PluginHost({
      manifest: plugin.manifest,
      pluginDir: plugin.path,
      capabilities: caps,
      broker,
      timeoutMs: resolvedTimeoutMs,
    });

    await host.start();

    plugin.tools = host.tools;
    plugin.hooks = host.hooks;
    plugin.commands = host.commands;
    plugin.skills = host.skills;
    plugin.active = true;

    // Store host reference for shutdown/crash cleanup
    (plugin as PluginWithHost)._host = host;
  } catch (error) {
    plugin.error = `Brokered load failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  return plugin;
}

/** Internal extension to store the host reference on brokered plugins. */
export interface PluginWithHost extends Plugin {
  _host?: PluginHost;
}

/**
 * Options for loading plugins.
 */
export interface LoadPluginOptions {
  /**
   * Callback to confirm loading of local (repo-controlled) plugins.
   * If not provided, local plugins are skipped for safety.
   * Global (user-installed) plugins are always loaded without confirmation.
   */
  onConfirmLocal?: (manifest: PluginManifest, pluginDir: string) => Promise<boolean>;
}

/**
 * Load all plugins from discovered directories.
 * Local (repo-controlled) plugins require explicit confirmation via onConfirmLocal callback.
 */
export async function loadAllPlugins(projectDir: string, options: LoadPluginOptions = {}): Promise<Plugin[]> {
  const pluginSources = discoverPluginDirs(projectDir);
  const plugins: Plugin[] = [];

  // Load policy once for the whole batch
  const policy = await loadPolicy(projectDir);

  for (const { dir, source } of pluginSources) {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      if (!statSync(fullPath).isDirectory()) continue;

      // For local plugins, require confirmation before loading
      if (source === 'local') {
        const manifest = loadManifest(fullPath);
        if (!manifest) continue;

        // Resolve config with policy to check enabled state before prompting
        const resolved = resolvePluginConfig(manifest, policy);
        if (!resolved.enabled) {
          plugins.push({
            manifest,
            path: fullPath,
            active: false,
            source: 'local',
            error: 'Disabled by policy',
          });
          continue;
        }

        if (!options.onConfirmLocal) {
          // No confirmation callback — skip local plugins for safety
          plugins.push({
            manifest,
            path: fullPath,
            active: false,
            source: 'local',
            error: 'Skipped: local plugin requires trust confirmation',
          });
          continue;
        }

        const confirmed = await options.onConfirmLocal(manifest, fullPath);
        if (!confirmed) {
          plugins.push({
            manifest,
            path: fullPath,
            active: false,
            source: 'local',
            error: 'Skipped: user denied local plugin',
          });
          continue;
        }

        const plugin = await loadPlugin(fullPath, source, resolved);
        plugins.push(plugin);
        continue;
      }

      // For global plugins: resolve config and pass through
      const manifest = loadManifest(fullPath);
      if (!manifest) {
        const plugin = await loadPlugin(fullPath, source);
        plugins.push(plugin);
        continue;
      }

      const resolved = resolvePluginConfig(manifest, policy);
      const plugin = await loadPlugin(fullPath, source, resolved);
      plugins.push(plugin);
    }
  }

  return plugins;
}

// ─── Private ───────────────────────────────────────────

function createPluginAPI(plugin: Plugin): PluginAPI {
  const dataDir = join(plugin.path, '.data');

  return {
    registerTool(tool: Tool): void {
      plugin.tools!.push(tool);
    },

    registerCommand(command: Command): void {
      plugin.commands!.push(command);
    },

    registerSkill(skill: Skill): void {
      plugin.skills!.push(skill);
    },

    registerHook(type: HookType, handler: (...args: unknown[]) => Promise<unknown>, priority = 50): void {
      plugin.hooks!.push({
        type,
        pluginName: plugin.manifest.name,
        priority,
        handler: handler as HookHandler['handler'],
      });
    },

    getDataDir(): string {
      return dataDir;
    },

    log(message: string): void {
      console.log(`[plugin:${plugin.manifest.name}] ${message}`);
    },
  };
}
