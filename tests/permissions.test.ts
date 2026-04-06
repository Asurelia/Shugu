/**
 * Tests for Layer 4 — Policy: Permission resolver + risk classifier
 */

import { describe, it, expect } from 'vitest';
import { PermissionResolver } from '../src/policy/permissions.js';
import { classifyBashRisk } from '../src/policy/classifier.js';

describe('PermissionResolver', () => {
  it('bypass mode allows safe commands', () => {
    const resolver = new PermissionResolver('bypass');
    const result = resolver.resolve({ id: 'x', name: 'Bash', input: { command: 'git status' } });
    expect(result.decision).toBe('allow');
  });

  it('bypass mode denies rm -rf / due to builtin rules', () => {
    // Even bypass cannot override the built-in safety rules
    const resolver = new PermissionResolver('bypass');
    const result = resolver.resolve({ id: 'x', name: 'Bash', input: { command: 'rm -rf /' } });
    expect(result.decision).toBe('deny');
    expect(result.source).toBe('builtin');
  });

  it('plan mode asks for all operations', () => {
    const resolver = new PermissionResolver('plan');
    const read = resolver.resolve({ id: 'x', name: 'Read', input: { file_path: '/test.ts' } });
    expect(read.decision).toBe('ask');

    const write = resolver.resolve({ id: 'x', name: 'Write', input: { file_path: '/test.ts' } });
    expect(write.decision).toBe('ask');
  });

  it('default mode allows reads, asks for writes', () => {
    const resolver = new PermissionResolver('default');
    const read = resolver.resolve({ id: 'x', name: 'Read', input: { file_path: '/test.ts' } });
    expect(read.decision).toBe('allow');

    const write = resolver.resolve({ id: 'x', name: 'Write', input: { file_path: '/test.ts' } });
    expect(write.decision).toBe('ask');
  });

  it('default mode asks for bash commands', () => {
    const resolver = new PermissionResolver('default');
    const result = resolver.resolve({ id: 'x', name: 'Bash', input: { command: 'git status' } });
    expect(result.decision).toBe('ask');
  });

  it('acceptEdits mode allows file writes', () => {
    const resolver = new PermissionResolver('acceptEdits');
    const write = resolver.resolve({ id: 'x', name: 'Write', input: { file_path: '/test.ts' } });
    expect(write.decision).toBe('allow');

    const edit = resolver.resolve({ id: 'x', name: 'Edit', input: { file_path: '/test.ts' } });
    expect(edit.decision).toBe('allow');
  });

  it('acceptEdits mode still asks for bash', () => {
    const resolver = new PermissionResolver('acceptEdits');
    const bash = resolver.resolve({ id: 'x', name: 'Bash', input: { command: 'npm test' } });
    expect(bash.decision).toBe('ask');
  });

  it('fullAuto mode allows most tools but asks for bash', () => {
    const resolver = new PermissionResolver('fullAuto');

    // Non-execute tools should be allowed
    const write = resolver.resolve({ id: 'x', name: 'Write', input: { file_path: '/test.ts' } });
    expect(write.decision).toBe('allow');

    const agent = resolver.resolve({ id: 'x', name: 'Agent', input: {} });
    expect(agent.decision).toBe('allow');

    // Bash goes through risk classifier: low risk = allow
    const safeBash = resolver.resolve({ id: 'x', name: 'Bash', input: { command: 'ls' } });
    expect(safeBash.decision).toBe('allow');
  });

  it('can change mode at runtime', () => {
    const resolver = new PermissionResolver('default');
    expect(resolver.getMode()).toBe('default');

    resolver.setMode('bypass');
    expect(resolver.getMode()).toBe('bypass');

    const result = resolver.resolve({ id: 'x', name: 'Write', input: { file_path: '/test.ts' } });
    expect(result.decision).toBe('allow');
  });

  it('denies .env file writes via builtin rules', () => {
    const resolver = new PermissionResolver('bypass');
    const result = resolver.resolve({ id: 'x', name: 'Write', input: { file_path: '/project/.env' } });
    expect(result.decision).toBe('deny');
    expect(result.source).toBe('builtin');
  });
});

describe('classifyBashRisk', () => {
  it('classifies safe commands as low risk', () => {
    const risk = classifyBashRisk('git status');
    expect(risk.level).toBe('low');
  });

  it('classifies ls as low risk', () => {
    const risk = classifyBashRisk('ls -la');
    expect(risk.level).toBe('low');
  });

  it('classifies rm -rf as high risk', () => {
    const risk = classifyBashRisk('rm -rf /tmp/something');
    expect(risk.level).toBe('high');
  });

  it('classifies sudo as high risk', () => {
    const risk = classifyBashRisk('sudo apt update');
    expect(risk.level).toBe('high');
  });

  it('classifies npm install as medium risk', () => {
    const risk = classifyBashRisk('npm install express');
    expect(risk.level).toBe('medium');
  });

  it('classifies git push as medium risk', () => {
    const risk = classifyBashRisk('git push origin main');
    expect(risk.level).toBe('medium');
  });

  it('classifies git push --force as high risk', () => {
    const risk = classifyBashRisk('git push --force origin main');
    expect(risk.level).toBe('high');
  });

  it('classifies unknown commands as medium risk', () => {
    const risk = classifyBashRisk('some-unknown-tool --flag');
    expect(risk.level).toBe('medium');
  });

  it('provides a reason string', () => {
    const risk = classifyBashRisk('sudo rm -rf /');
    expect(risk.reason).toBeTruthy();
    expect(typeof risk.reason).toBe('string');
  });
});
