/**
 * Layer 14 — Plugins: barrel export
 */

export {
  HookRegistry,
  type HookType,
  type HookHandler,
  type PreToolUsePayload,
  type PreToolUseResult,
  type PostToolUsePayload,
  type PostToolUseResult,
  type CommandPayload,
  type MessagePayload,
} from './hooks.js';

export {
  loadPlugin,
  loadAllPlugins,
  loadManifest,
  discoverPluginDirs,
  type Plugin,
  type PluginManifest,
  type PluginAPI,
  type PluginInit,
} from './loader.js';

export {
  PluginRegistry,
} from './registry.js';
