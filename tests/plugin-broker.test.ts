import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CapabilityBroker, type CapabilityName } from '../src/plugins/broker.js';

describe('CapabilityBroker', () => {
  let pluginDir: string;
  let projectDir: string;

  afterEach(async () => {
    if (pluginDir) await rm(pluginDir, { recursive: true, force: true }).catch(() => {});
    if (projectDir) await rm(projectDir, { recursive: true, force: true }).catch(() => {});
  });

  async function setup(capabilities: CapabilityName[]) {
    pluginDir = await mkdtemp(join(tmpdir(), 'broker-plugin-'));
    projectDir = await mkdtemp(join(tmpdir(), 'broker-project-'));
    await mkdir(join(pluginDir, '.data'), { recursive: true });
    return new CapabilityBroker(capabilities, pluginDir, projectDir);
  }

  it('allows fs.read within plugin data directory', async () => {
    const broker = await setup(['fs.read']);
    const testFile = join(pluginDir, '.data', 'test.txt');
    await writeFile(testFile, 'hello', 'utf-8');

    const result = await broker.handle({
      capability: 'fs.read',
      operation: 'read',
      args: { path: testFile },
    }) as { content: string };
    expect(result.content).toBe('hello');
  });

  it('allows fs.read within project directory', async () => {
    const broker = await setup(['fs.read']);
    const testFile = join(projectDir, 'readme.txt');
    await writeFile(testFile, 'project file', 'utf-8');

    const result = await broker.handle({
      capability: 'fs.read',
      operation: 'read',
      args: { path: testFile },
    }) as { content: string };
    expect(result.content).toBe('project file');
  });

  it('denies fs.read outside workspace', async () => {
    const broker = await setup(['fs.read']);
    await expect(broker.handle({
      capability: 'fs.read',
      operation: 'read',
      args: { path: '/etc/passwd' },
    })).rejects.toThrow(/path denied|outside/i);
  });

  it('denies path traversal', async () => {
    const broker = await setup(['fs.read', 'fs.write']);
    await expect(broker.handle({
      capability: 'fs.write',
      operation: 'write',
      args: { path: join(pluginDir, '.data', '..', '..', '..', 'etc', 'evil.txt'), content: 'bad' },
    })).rejects.toThrow(/path denied|outside/i);
  });

  it('denies capabilities not in the allowed list', async () => {
    const broker = await setup(['fs.read']); // no fs.write
    await expect(broker.handle({
      capability: 'fs.write',
      operation: 'write',
      args: { path: join(pluginDir, '.data', 'test.txt'), content: 'nope' },
    })).rejects.toThrow(/denied/i);
  });

  it('denies http.fetch to localhost (SSRF)', async () => {
    const broker = await setup(['http.fetch']);
    await expect(broker.handle({
      capability: 'http.fetch',
      operation: 'fetch',
      args: { url: 'http://127.0.0.1:8080/internal' },
    })).rejects.toThrow(/blocked|ssrf/i);
  });

  it('denies http.fetch to metadata endpoints', async () => {
    const broker = await setup(['http.fetch']);
    await expect(broker.handle({
      capability: 'http.fetch',
      operation: 'fetch',
      args: { url: 'http://169.254.169.254/latest/meta-data/' },
    })).rejects.toThrow(/blocked|ssrf|metadata/i);
  });

  it('allows fs.list within workspace', async () => {
    const broker = await setup(['fs.list']);
    await writeFile(join(pluginDir, '.data', 'a.txt'), 'a', 'utf-8');
    await writeFile(join(pluginDir, '.data', 'b.txt'), 'b', 'utf-8');

    const result = await broker.handle({
      capability: 'fs.list',
      operation: 'list',
      args: { path: join(pluginDir, '.data') },
    }) as { entries: string[] };
    expect(result.entries).toContain('a.txt');
    expect(result.entries).toContain('b.txt');
  });
});
