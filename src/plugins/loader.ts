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
  /** Permission scopes this plugin needs */
  permissions?: string[];
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
 * Discover plugin directories.
 */
export function discoverPluginDirs(projectDir: string): string[] {
  const dirs: string[] = [];

  // 1. Global plugins
  const globalDir = join(homedir(), '.pcc', 'plugins');
  if (existsSync(globalDir)) {
    dirs.push(globalDir);
  }

  // 2. Project-local plugins
  const localDir = join(projectDir, '.pcc', 'plugins');
  if (existsSync(localDir)) {
    dirs.push(localDir);
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
 */
export async function loadPlugin(pluginDir: string): Promise<Plugin> {
  const manifest = loadManifest(pluginDir);
  if (!manifest) {
    return {
      manifest: { name: 'unknown', version: '0.0.0', description: '', entry: '' },
      path: pluginDir,
      active: false,
      error: `No valid plugin.json found in ${pluginDir}`,
    };
  }

  const plugin: Plugin = {
    manifest,
    path: pluginDir,
    active: false,
    tools: [],
    commands: [],
    skills: [],
    hooks: [],
  };

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
 * Load all plugins from discovered directories.
 */
export async function loadAllPlugins(projectDir: string): Promise<Plugin[]> {
  const pluginDirs = discoverPluginDirs(projectDir);
  const plugins: Plugin[] = [];

  for (const dir of pluginDirs) {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      if (!statSync(fullPath).isDirectory()) continue;

      const plugin = await loadPlugin(fullPath);
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
