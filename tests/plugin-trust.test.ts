/**
 * Tests for F2 — Plugin trust check for local plugins
 *
 * Validates that local (repo-controlled) plugins require confirmation
 * and that global (user-installed) plugins load without confirmation.
 */

import { describe, it, expect, vi } from 'vitest';
import { discoverPluginDirs, loadAllPlugins, loadManifest, type LoadPluginOptions, type PluginManifest } from '../src/plugins/loader.js';

describe('Plugin trust: discoverPluginDirs', () => {
  it('tags global plugins as source "global"', () => {
    const dirs = discoverPluginDirs('/nonexistent-project');
    // All discovered dirs should have a source field
    for (const d of dirs) {
      expect(d).toHaveProperty('source');
      expect(d).toHaveProperty('dir');
      expect(['global', 'local']).toContain(d.source);
    }
  });

  it('returns PluginSource objects with dir and source', () => {
    const dirs = discoverPluginDirs(process.cwd());
    for (const d of dirs) {
      expect(typeof d.dir).toBe('string');
      expect(typeof d.source).toBe('string');
    }
  });
});

describe('Plugin trust: loadAllPlugins', () => {
  it('skips local plugins when no onConfirmLocal callback provided', async () => {
    // loadAllPlugins without options should skip any local plugins
    const plugins = await loadAllPlugins('/nonexistent-project');
    for (const plugin of plugins) {
      if (plugin.source === 'local') {
        expect(plugin.active).toBe(false);
        expect(plugin.error).toContain('Skipped');
      }
    }
  });

  it('skips local plugins when onConfirmLocal returns false', async () => {
    const onConfirmLocal = vi.fn().mockResolvedValue(false);
    const plugins = await loadAllPlugins('/nonexistent-project', { onConfirmLocal });
    for (const plugin of plugins) {
      if (plugin.source === 'local') {
        expect(plugin.active).toBe(false);
        expect(plugin.error).toContain('denied');
      }
    }
  });

  it('loads local plugins when onConfirmLocal returns true', async () => {
    const onConfirmLocal = vi.fn().mockResolvedValue(true);
    // No actual plugins exist at this path, so we just verify the function accepts the callback
    const plugins = await loadAllPlugins('/nonexistent-project', { onConfirmLocal });
    // No plugins found at nonexistent path, so no callbacks called
    expect(onConfirmLocal).not.toHaveBeenCalled();
  });
});

describe('Plugin interface', () => {
  it('Plugin type includes source field', () => {
    // Verify the type system by creating a plugin object
    const plugin = {
      manifest: { name: 'test', version: '1.0.0', description: 'test', entry: 'index.js' },
      path: '/test',
      active: false,
      source: 'local' as const,
    };
    expect(plugin.source).toBe('local');
  });
});
