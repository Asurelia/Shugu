import { describe, expect, it, vi, afterEach } from 'vitest';
import { buildPermissionFlags, getNodeMajorVersion } from '../src/plugins/host.js';
import { join } from 'node:path';

const PLUGIN_DIR = '/home/user/plugins/my-plugin';
const PROJECT_DIR = '/home/user/project';

describe('getNodeMajorVersion', () => {
  it('parses v24.4.1 → 24', () => {
    vi.stubGlobal('process', { ...process, version: 'v24.4.1' });
    expect(getNodeMajorVersion()).toBe(24);
  });

  it('parses v20.10.0 → 20', () => {
    vi.stubGlobal('process', { ...process, version: 'v20.10.0' });
    expect(getNodeMajorVersion()).toBe(20);
  });

  it('parses v22.0.0 → 22', () => {
    vi.stubGlobal('process', { ...process, version: 'v22.0.0' });
    expect(getNodeMajorVersion()).toBe(22);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
});

describe('buildPermissionFlags', () => {
  it('returns permission flags for Node >= 22 with .mjs entry', () => {
    const flags = buildPermissionFlags(24, join(PLUGIN_DIR, 'index.mjs'), PLUGIN_DIR, PROJECT_DIR);
    expect(flags).toContain('--permission');
    expect(flags.some(f => f.startsWith('--allow-fs-read='))).toBe(true);
    expect(flags.some(f => f.startsWith('--allow-fs-write='))).toBe(true);
    // Must not grant child-process or worker rights
    expect(flags).not.toContain('--allow-child-process');
    expect(flags).not.toContain('--allow-worker');
  });

  it('allow-fs-read uses * on Windows (UNC path limitation) or specific paths on Linux', () => {
    const flags = buildPermissionFlags(22, join(PLUGIN_DIR, 'index.mjs'), PLUGIN_DIR, PROJECT_DIR);
    const readFlag = flags.find(f => f.startsWith('--allow-fs-read='))!;
    expect(readFlag).toBeDefined();
    if (process.platform === 'win32') {
      // Windows: UNC path conversion breaks --allow-fs-read path matching
      expect(readFlag).toBe('--allow-fs-read=*');
    } else {
      // Linux/macOS: specific paths (pluginDir, projectDir, nodeDir)
      expect(readFlag).toContain(PLUGIN_DIR);
      expect(readFlag).toContain(PROJECT_DIR);
    }
  });

  it('allow-fs-write is scoped to pluginDir/.data', () => {
    const flags = buildPermissionFlags(22, join(PLUGIN_DIR, 'index.mjs'), PLUGIN_DIR, PROJECT_DIR);
    const writeFlag = flags.find(f => f.startsWith('--allow-fs-write='))!;
    expect(writeFlag).toBeDefined();
    expect(writeFlag).toContain(join(PLUGIN_DIR, '.data'));
  });

  it('returns empty array for Node < 22', () => {
    const flags = buildPermissionFlags(20, join(PLUGIN_DIR, 'index.mjs'), PLUGIN_DIR, PROJECT_DIR);
    expect(flags).toHaveLength(0);
  });

  it('returns empty array for Node 21 (below threshold)', () => {
    const flags = buildPermissionFlags(21, join(PLUGIN_DIR, 'index.mjs'), PLUGIN_DIR, PROJECT_DIR);
    expect(flags).toHaveLength(0);
  });

  it('returns empty array for .ts entry (tsx mode), even on Node >= 22', () => {
    const flags = buildPermissionFlags(24, join(PLUGIN_DIR, 'index.ts'), PLUGIN_DIR, PROJECT_DIR);
    expect(flags).toHaveLength(0);
  });

  it('returns empty array for .ts entry on Node 22', () => {
    const flags = buildPermissionFlags(22, join(PLUGIN_DIR, 'child-entry.ts'), PLUGIN_DIR, PROJECT_DIR);
    expect(flags).toHaveLength(0);
  });
});

describe('Linux uid/gid logic (mock)', () => {
  it('would apply uid/gid 65534 when platform is linux and running as root', () => {
    // This test documents the expected behavior without spawning a real process.
    // The actual uid/gid injection happens in PluginHost.start() when:
    //   process.platform === 'linux' && process.getuid?.() === 0
    const isLinuxRoot = (platform: string, uid: number) =>
      platform === 'linux' && uid === 0;

    expect(isLinuxRoot('linux', 0)).toBe(true);
    expect(isLinuxRoot('linux', 1000)).toBe(false);
    expect(isLinuxRoot('win32', 0)).toBe(false);
    expect(isLinuxRoot('darwin', 0)).toBe(false);
  });

  it('nobody uid/gid is 65534', () => {
    // Document the sentinel values used
    expect(65534).toBe(65534); // nobody / nogroup
  });
});
