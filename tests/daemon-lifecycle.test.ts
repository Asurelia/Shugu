/**
 * Regression lock: DaemonController and PluginHost must detach listeners
 * on child stdio/IPC during shutdown. Without this, start/stop cycles leak
 * listeners onto long-lived parent processes.
 *
 * These tests inspect the source code for the presence of the cleanup
 * function and its wiring — they do not spawn real child processes (that
 * would be flaky in CI). If the cleanup is removed, both tests fail
 * immediately, signalling the regression.
 */

import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

describe('DaemonController listener cleanup', () => {
  let source = '';

  it('loads source', async () => {
    source = await readFile(resolve('src/automation/daemon.ts'), 'utf-8');
    expect(source.length).toBeGreaterThan(0);
  });

  it('declares detachChildListeners in DaemonController', () => {
    expect(source).toMatch(/private detachChildListeners\(\): void/);
  });

  it('calls detachChildListeners before nulling child in stop()', () => {
    // Match the stop() body — look for the detach call + this.child = null adjacency
    expect(source).toMatch(/this\.detachChildListeners\(\);[\s\S]{0,80}this\.child = null;/);
  });

  it('removes listeners on stdout, stderr, message, exit, error', () => {
    const match = source.match(/private detachChildListeners\(\): void \{[\s\S]*?\n  \}/);
    expect(match).toBeTruthy();
    const body = match![0];
    expect(body).toMatch(/this\.child\.stdout\?\.removeAllListeners/);
    expect(body).toMatch(/this\.child\.stderr\?\.removeAllListeners/);
    expect(body).toMatch(/this\.child\.removeAllListeners\('message'\)/);
    expect(body).toMatch(/this\.child\.removeAllListeners\('exit'\)/);
    expect(body).toMatch(/this\.child\.removeAllListeners\('error'\)/);
  });

  it('DaemonWorker stores message handler as a field and removes it on stop', () => {
    expect(source).toMatch(/private messageHandler: \(\(msg: DaemonMessage\) => void\) \| null/);
    expect(source).toMatch(/process\.off\('message', this\.messageHandler\)/);
  });
});

describe('PluginHost listener cleanup', () => {
  let source = '';

  it('loads source', async () => {
    source = await readFile(resolve('src/plugins/host.ts'), 'utf-8');
    expect(source.length).toBeGreaterThan(0);
  });

  it('declares detachChildListeners in PluginHost', () => {
    expect(source).toMatch(/private detachChildListeners\(\): void/);
  });

  it("child 'exit' handler triggers listener cleanup", () => {
    // Cleanup must happen AFTER child exits, not from shutdown/kill directly —
    // otherwise pending requests never reject when shutdown RPC succeeds but
    // the child takes time to actually exit.
    const exitHandlerMatch = source.match(/this\.child\.on\('exit'[\s\S]*?\n    \}\);/);
    expect(exitHandlerMatch, "child.on('exit') handler").toBeTruthy();
    expect(exitHandlerMatch![0]).toMatch(/this\.detachChildListeners\(\)/);
  });

  it('closes readline interface and clears child stdio listeners', () => {
    const match = source.match(/private detachChildListeners\(\): void \{[\s\S]*?\n  \}/);
    expect(match).toBeTruthy();
    const body = match![0];
    expect(body).toMatch(/this\.readline\.removeAllListeners\('line'\)/);
    expect(body).toMatch(/this\.readline\.close\(\)/);
    expect(body).toMatch(/this\.child\.stdout\?\.removeAllListeners/);
    expect(body).toMatch(/this\.child\.stderr\?\.removeAllListeners/);
    expect(body).toMatch(/this\.child\.removeAllListeners\('exit'\)/);
  });
});
