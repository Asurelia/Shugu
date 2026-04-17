import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPolicy, resolvePluginConfig, type PluginPolicy } from '../src/plugins/policy.js';
import { loadPlugin } from '../src/plugins/loader.js';
import type { PluginManifest } from '../src/plugins/loader.js';

// ─── Helpers ───────────────────────────────────────────

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: 'test-plugin',
    version: '1.0.0',
    description: 'A test plugin',
    entry: 'index.js',
    ...overrides,
  };
}

// ─── loadPolicy ────────────────────────────────────────

describe('loadPolicy', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'policy-test-'));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true }).catch(() => {});
  });

  it('returns null when .pcc/plugin-policy.json does not exist', async () => {
    const result = await loadPolicy(projectDir);
    expect(result).toBeNull();
  });

  it('returns parsed policy when file contains valid JSON', async () => {
    await mkdir(join(projectDir, '.pcc'), { recursive: true });
    const policy: PluginPolicy = {
      version: 1,
      defaults: { isolation: 'brokered', timeoutMs: 5000 },
    };
    await writeFile(join(projectDir, '.pcc', 'plugin-policy.json'), JSON.stringify(policy), 'utf-8');

    const result = await loadPolicy(projectDir);
    expect(result).not.toBeNull();
    expect(result!.version).toBe(1);
    expect(result!.defaults?.isolation).toBe('brokered');
    expect(result!.defaults?.timeoutMs).toBe(5000);
  });

  it('returns null and logs warning when file contains invalid JSON', async () => {
    await mkdir(join(projectDir, '.pcc'), { recursive: true });
    await writeFile(join(projectDir, '.pcc', 'plugin-policy.json'), '{ not valid json }', 'utf-8');

    // Spy on logger.warn to confirm it was called
    const { logger } = await import('../src/utils/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn');

    const result = await loadPolicy(projectDir);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('plugin-policy'),
      expect.any(String),
    );

    warnSpy.mockRestore();
  });
});

// ─── resolvePluginConfig ───────────────────────────────

describe('resolvePluginConfig', () => {
  it('returns manifest values with defaults when policy is null', () => {
    const m = manifest({ isolation: 'brokered', capabilities: ['fs.read', 'http.fetch'] });
    const result = resolvePluginConfig(m, null);

    expect(result.enabled).toBe(true);
    expect(result.isolation).toBe('brokered');
    expect(result.capabilities).toEqual(['fs.read', 'http.fetch']);
    expect(result.permissions).toEqual([]);
    expect(result.timeoutMs).toBe(30_000);
    expect(result.maxAgentTurns).toBe(10);
  });

  it('applies policy defaults over manifest values', () => {
    const m = manifest({ isolation: 'trusted', capabilities: ['fs.read'] });
    const policy: PluginPolicy = {
      version: 1,
      defaults: {
        isolation: 'brokered',
        capabilities: ['fs.read', 'fs.write'],
        timeoutMs: 60_000,
        maxAgentTurns: 20,
      },
    };
    const result = resolvePluginConfig(m, policy);

    expect(result.isolation).toBe('brokered');
    expect(result.capabilities).toEqual(['fs.read', 'fs.write']);
    expect(result.timeoutMs).toBe(60_000);
    expect(result.maxAgentTurns).toBe(20);
  });

  it('per-plugin override takes precedence over policy defaults', () => {
    const m = manifest({ name: 'my-plugin', isolation: 'unrestricted' });
    const policy: PluginPolicy = {
      version: 1,
      defaults: { isolation: 'brokered', timeoutMs: 60_000 },
      plugins: {
        'my-plugin': { isolation: 'unrestricted', timeoutMs: 15_000 },
      },
    };
    const result = resolvePluginConfig(m, policy);

    expect(result.isolation).toBe('unrestricted');
    expect(result.timeoutMs).toBe(15_000);
  });

  it('legacy "trusted" is accepted and normalized to "unrestricted"', () => {
    // Back-compat: existing manifests/policies using 'trusted' should
    // keep working. Normalization happens in resolvePluginConfig.
    const m = manifest({ name: 'legacy-plugin', isolation: 'trusted' as const });
    const policy: PluginPolicy = {
      version: 1,
      defaults: { isolation: 'trusted' as const, timeoutMs: 60_000 },
      plugins: {
        'legacy-plugin': { isolation: 'trusted' as const },
      },
    };
    const result = resolvePluginConfig(m, policy);

    expect(result.isolation).toBe('unrestricted');
  });

  it('capabilitiesDeny removes capabilities from the final list', () => {
    const m = manifest({ capabilities: ['fs.read', 'fs.write', 'http.fetch'] });
    const policy: PluginPolicy = {
      version: 1,
      plugins: {
        'test-plugin': { capabilitiesDeny: ['fs.write', 'http.fetch'] },
      },
    };
    const result = resolvePluginConfig(m, policy);

    expect(result.capabilities).toEqual(['fs.read']);
    expect(result.capabilities).not.toContain('fs.write');
    expect(result.capabilities).not.toContain('http.fetch');
  });

  it('capabilitiesAdd appends to the final list', () => {
    const m = manifest({ capabilities: ['fs.read'] });
    const policy: PluginPolicy = {
      version: 1,
      plugins: {
        'test-plugin': { capabilitiesAdd: ['fs.write'] },
      },
    };
    const result = resolvePluginConfig(m, policy);

    expect(result.capabilities).toContain('fs.read');
    expect(result.capabilities).toContain('fs.write');
  });

  it('capabilitiesDeny wins over capabilitiesAdd for the same capability', () => {
    const m = manifest({ capabilities: ['fs.read'] });
    const policy: PluginPolicy = {
      version: 1,
      plugins: {
        'test-plugin': {
          capabilitiesAdd: ['fs.write'],
          capabilitiesDeny: ['fs.write'],
        },
      },
    };
    const result = resolvePluginConfig(m, policy);

    // capabilitiesDeny is applied AFTER capabilitiesAdd — deny always wins.
    // fs.write is added by capabilitiesAdd, then removed by capabilitiesDeny.
    expect(result.capabilities).not.toContain('fs.write');
    expect(result.capabilities).toContain('fs.read');
  });

  it('enabled:false sets resolved.enabled to false', () => {
    const m = manifest({ name: 'disabled-plugin' });
    const policy: PluginPolicy = {
      version: 1,
      plugins: {
        'disabled-plugin': { enabled: false },
      },
    };
    const result = resolvePluginConfig(m, policy);

    expect(result.enabled).toBe(false);
  });
});

// ─── E2E: loadPlugin with policy enabled:false ─────────

describe('loadPlugin with policy disabled', () => {
  let pluginDir: string;

  beforeEach(async () => {
    pluginDir = await mkdtemp(join(tmpdir(), 'policy-e2e-'));
    // Create a valid plugin.json
    await writeFile(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'e2e-plugin',
        version: '1.0.0',
        description: 'E2E test plugin',
        entry: 'index.js',
      }),
      'utf-8',
    );
    // Create a trivial entry file
    await writeFile(join(pluginDir, 'index.js'), 'module.exports = { default: async () => {} }', 'utf-8');
  });

  afterEach(async () => {
    await rm(pluginDir, { recursive: true, force: true }).catch(() => {});
  });

  it('does not load the plugin when resolvedConfig.enabled is false', async () => {
    const { resolvePluginConfig } = await import('../src/plugins/policy.js');
    const m: PluginManifest = {
      name: 'e2e-plugin',
      version: '1.0.0',
      description: 'E2E test plugin',
      entry: 'index.js',
    };
    const policy: PluginPolicy = {
      version: 1,
      plugins: { 'e2e-plugin': { enabled: false } },
    };
    const resolved = resolvePluginConfig(m, policy);

    const plugin = await loadPlugin(pluginDir, 'global', resolved);

    expect(plugin.active).toBe(false);
    expect(plugin.error).toBe('Disabled by policy');
  });
});
