/**
 * Tests for dynamic tool routing
 */

import { describe, it, expect } from 'vitest';
import { ToolRouter } from '../src/tools/router.js';
import type { ToolDefinition } from '../src/protocol/tools.js';

const MOCK_TOOLS: ToolDefinition[] = [
  { name: 'Bash', description: '', inputSchema: { type: 'object', properties: {} }, categories: ['core'] },
  { name: 'Read', description: '', inputSchema: { type: 'object', properties: {} }, categories: ['core', 'file-ops'] },
  { name: 'Write', description: '', inputSchema: { type: 'object', properties: {} }, categories: ['core', 'file-ops'] },
  { name: 'Edit', description: '', inputSchema: { type: 'object', properties: {} }, categories: ['core', 'file-ops'] },
  { name: 'Glob', description: '', inputSchema: { type: 'object', properties: {} }, categories: ['core', 'search'] },
  { name: 'Grep', description: '', inputSchema: { type: 'object', properties: {} }, categories: ['core', 'search'] },
  { name: 'WebFetch', description: '', inputSchema: { type: 'object', properties: {} }, categories: ['web'] },
  { name: 'WebSearch', description: '', inputSchema: { type: 'object', properties: {} }, categories: ['web'] },
  { name: 'Agent', description: '', inputSchema: { type: 'object', properties: {} }, categories: ['agent'] },
  { name: 'TaskCreate', description: '', inputSchema: { type: 'object', properties: {} }, categories: ['task'] },
  { name: 'Obsidian', description: '', inputSchema: { type: 'object', properties: {} }, categories: ['memory'] },
  { name: 'SemSearch', description: '', inputSchema: { type: 'object', properties: {} }, categories: ['search'] },
];

describe('ToolRouter', () => {
  it('returns all tools for epic complexity', () => {
    const router = new ToolRouter(MOCK_TOOLS);
    const result = router.select({ input: 'hello', recentTools: [], complexity: 'epic' });
    expect(result).toHaveLength(MOCK_TOOLS.length);
  });

  it('returns only core tools for trivial complexity', () => {
    const router = new ToolRouter(MOCK_TOOLS);
    const result = router.select({ input: 'what is a pointer?', recentTools: [], complexity: 'trivial' });
    const names = result.map(d => d.name);
    expect(names).toContain('Bash');
    expect(names).toContain('Read');
    expect(names).not.toContain('WebFetch');
    expect(names).not.toContain('Agent');
    expect(names).not.toContain('Obsidian');
  });

  it('includes web tools when input mentions "fetch" or "url"', () => {
    const router = new ToolRouter(MOCK_TOOLS);
    const result = router.select({ input: 'fetch the page at this url', recentTools: [], complexity: 'simple' });
    const names = result.map(d => d.name);
    expect(names).toContain('WebFetch');
    expect(names).toContain('WebSearch');
  });

  it('includes task tools when input mentions "task" or "track"', () => {
    const router = new ToolRouter(MOCK_TOOLS);
    const result = router.select({ input: 'create a task to track progress', recentTools: [], complexity: 'simple' });
    const names = result.map(d => d.name);
    expect(names).toContain('TaskCreate');
  });

  it('includes agent tools when input mentions "delegate"', () => {
    const router = new ToolRouter(MOCK_TOOLS);
    const result = router.select({ input: 'delegate this to a sub-agent', recentTools: [], complexity: 'complex' });
    const names = result.map(d => d.name);
    expect(names).toContain('Agent');
  });

  it('includes memory tools when input mentions "obsidian" or "vault"', () => {
    const router = new ToolRouter(MOCK_TOOLS);
    const result = router.select({ input: 'check the obsidian vault', recentTools: [], complexity: 'simple' });
    const names = result.map(d => d.name);
    expect(names).toContain('Obsidian');
  });

  it('preserves recently used tools even if category not matched', () => {
    const router = new ToolRouter(MOCK_TOOLS);
    const result = router.select({ input: 'fix the bug', recentTools: ['WebFetch'], complexity: 'simple' });
    const names = result.map(d => d.name);
    // WebFetch was recently used — keep it available
    expect(names).toContain('WebFetch');
  });

  it('does not include non-core tools without keyword match or recent use', () => {
    const router = new ToolRouter(MOCK_TOOLS);
    const result = router.select({ input: 'fix the bug in auth', recentTools: [], complexity: 'simple' });
    const names = result.map(d => d.name);
    expect(names).not.toContain('WebFetch');
    expect(names).not.toContain('Agent');
    expect(names).not.toContain('Obsidian');
    expect(names).not.toContain('TaskCreate');
  });
});

describe('ToolRouter.validateCategories', () => {
  it('passes when all tools have categories', () => {
    expect(() => ToolRouter.validateCategories(MOCK_TOOLS)).not.toThrow();
  });

  it('throws when a tool is missing categories', () => {
    const bad: ToolDefinition[] = [
      ...MOCK_TOOLS,
      { name: 'NoCat', description: '', inputSchema: { type: 'object', properties: {} } },
    ];
    expect(() => ToolRouter.validateCategories(bad)).toThrow('missing categories');
    expect(() => ToolRouter.validateCategories(bad)).toThrow('NoCat');
  });

  it('throws for empty categories array', () => {
    const bad: ToolDefinition[] = [
      { name: 'EmptyCat', description: '', inputSchema: { type: 'object', properties: {} }, categories: [] },
    ];
    expect(() => ToolRouter.validateCategories(bad)).toThrow('EmptyCat');
  });

  it('catches plugin-registered tools without categories (simulates post-plugin load)', () => {
    // Simulates the scenario where a plugin registers a tool without categories
    const allToolsIncludingPlugin: ToolDefinition[] = [
      ...MOCK_TOOLS,
      { name: 'PluginTool', description: 'From plugin', inputSchema: { type: 'object', properties: {} } },
    ];
    expect(() => ToolRouter.validateCategories(allToolsIncludingPlugin)).toThrow('PluginTool');
  });
});
