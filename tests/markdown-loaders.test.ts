/**
 * Tests for markdown command and agent loaders
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseMarkdownCommand, loadMarkdownCommands } from '../src/commands/markdown-loader.js';
import { parseMarkdownAgent, loadMarkdownAgents } from '../src/agents/markdown-loader.js';

// ── parseMarkdownCommand ──────────────────────────────

describe('parseMarkdownCommand', () => {
  it('parses valid frontmatter + body', () => {
    const result = parseMarkdownCommand(`---
name: deploy
description: Deploy the project
aliases: [d, ship]
---

Run npm run build then deploy.`);

    expect(result).not.toBeNull();
    expect(result!.frontmatter.name).toBe('deploy');
    expect(result!.frontmatter.description).toBe('Deploy the project');
    expect(result!.frontmatter.aliases).toEqual(['d', 'ship']);
    expect(result!.frontmatter.override).toBe(false);
    expect(result!.body).toContain('Run npm run build');
  });

  it('returns null for missing frontmatter delimiters', () => {
    expect(parseMarkdownCommand('no frontmatter')).toBeNull();
    expect(parseMarkdownCommand('---\nname: test')).toBeNull(); // no closing ---
  });

  it('returns null for missing required fields', () => {
    expect(parseMarkdownCommand('---\nname: test\n---\nbody')).toBeNull(); // no description
    expect(parseMarkdownCommand('---\ndescription: test\n---\nbody')).toBeNull(); // no name
  });

  it('parses override flag', () => {
    const result = parseMarkdownCommand(`---
name: help
description: Custom help
override: true
---
My custom help.`);

    expect(result).not.toBeNull();
    expect(result!.frontmatter.override).toBe(true);
  });
});

// ── loadMarkdownCommands ──────────────────────────────

describe('loadMarkdownCommands', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `shugu-test-mdcmd-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('loads valid command files', async () => {
    await writeFile(join(testDir, 'hello.md'), `---
name: hello
description: Say hello
---
Greet the user.`);

    const commands = loadMarkdownCommands([testDir], new Set());
    expect(commands).toHaveLength(1);
    expect(commands[0]!.name).toBe('hello');
    expect(commands[0]!.description).toContain('[custom]');
  });

  it('skips commands that collide with builtins', async () => {
    await writeFile(join(testDir, 'help.md'), `---
name: help
description: Custom help
---
My help.`);

    const commands = loadMarkdownCommands([testDir], new Set(['help']));
    expect(commands).toHaveLength(0);
  });

  it('allows override with override: true', async () => {
    await writeFile(join(testDir, 'help.md'), `---
name: help
description: Custom help
override: true
---
My help.`);

    const commands = loadMarkdownCommands([testDir], new Set(['help']));
    expect(commands).toHaveLength(1);
    expect(commands[0]!.description).toContain('[override]');
  });

  it('skips non-existent directories without error', () => {
    const commands = loadMarkdownCommands(['/nonexistent/path'], new Set());
    expect(commands).toHaveLength(0);
  });

  it('execute returns prompt type with body content', async () => {
    await writeFile(join(testDir, 'deploy.md'), `---
name: deploy
description: Deploy
---
Run the deployment.`);

    const commands = loadMarkdownCommands([testDir], new Set());
    const result = await commands[0]!.execute('', {
      cwd: testDir,
      messages: [],
      info: () => {},
      error: () => {},
    });

    expect(result.type).toBe('prompt');
    if (result.type === 'prompt') {
      expect(result.prompt).toContain('Run the deployment');
    }
  });
});

// ── parseMarkdownAgent ────────────────────────────────

describe('parseMarkdownAgent', () => {
  it('parses valid agent frontmatter + role prompt', () => {
    const result = parseMarkdownAgent(`---
name: security
maxTurns: 12
maxBudgetUsd: 0.50
allowedTools: [Read, Glob, Grep]
---

You are a security auditor.`);

    expect(result).not.toBeNull();
    expect(result!.frontmatter.name).toBe('security');
    expect(result!.frontmatter.maxTurns).toBe(12);
    expect(result!.frontmatter.maxBudgetUsd).toBe(0.50);
    expect(result!.frontmatter.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
    expect(result!.rolePrompt).toContain('security auditor');
  });

  it('defaults maxTurns to 15', () => {
    const result = parseMarkdownAgent(`---
name: simple
---
Simple agent.`);

    expect(result).not.toBeNull();
    expect(result!.frontmatter.maxTurns).toBe(15);
  });

  it('returns null for missing name', () => {
    expect(parseMarkdownAgent(`---
maxTurns: 10
---
Body.`)).toBeNull();
  });
});

// ── loadMarkdownAgents ────────────────────────────────

describe('loadMarkdownAgents', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `shugu-test-mdagent-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('loads valid agent files', async () => {
    await writeFile(join(testDir, 'sec.md'), `---
name: security
maxTurns: 20
---
You are a security agent.`);

    const agents = await loadMarkdownAgents([testDir]);
    expect(Object.keys(agents)).toEqual(['security']);
    expect(agents['security']!.maxTurns).toBe(20);
    expect(agents['security']!.rolePrompt).toContain('security agent');
  });

  it('skips agents that collide with builtins', async () => {
    await writeFile(join(testDir, 'review.md'), `---
name: review
---
Custom review.`);

    const agents = await loadMarkdownAgents([testDir]);
    expect(Object.keys(agents)).toHaveLength(0);
  });

  it('allows override with override: true', async () => {
    await writeFile(join(testDir, 'review.md'), `---
name: review
override: true
---
Custom review.`);

    const agents = await loadMarkdownAgents([testDir]);
    expect(Object.keys(agents)).toEqual(['review']);
  });

  it('skips non-existent directories without error', async () => {
    const agents = await loadMarkdownAgents(['/nonexistent/path']);
    expect(Object.keys(agents)).toHaveLength(0);
  });

  it('later directories override earlier ones', async () => {
    const globalDir = join(testDir, 'global');
    const localDir = join(testDir, 'local');
    await mkdir(globalDir, { recursive: true });
    await mkdir(localDir, { recursive: true });

    await writeFile(join(globalDir, 'lint.md'), `---
name: lint
maxTurns: 5
---
Global lint.`);

    await writeFile(join(localDir, 'lint.md'), `---
name: lint
maxTurns: 25
---
Local lint.`);

    const agents = await loadMarkdownAgents([globalDir, localDir]);
    expect(agents['lint']!.maxTurns).toBe(25);
    expect(agents['lint']!.rolePrompt).toContain('Local lint');
  });
});
