/**
 * Tests for Layer 3 — Tools: Registry
 */

import { describe, it, expect } from 'vitest';
import { ToolRegistryImpl } from '../src/tools/registry.js';
import type { Tool, ToolCall, ToolContext, ToolResult } from '../src/protocol/tools.js';

function createMockTool(name: string): Tool {
  return {
    definition: {
      name,
      description: `Mock tool: ${name}`,
      inputSchema: { type: 'object', properties: {} },
    },
    execute: async (call: ToolCall, ctx: ToolContext): Promise<ToolResult> => ({
      tool_use_id: call.id,
      content: `Result from ${name}`,
    }),
  };
}

describe('ToolRegistryImpl', () => {
  it('registers and retrieves tools', () => {
    const registry = new ToolRegistryImpl();
    const tool = createMockTool('Bash');

    registry.register(tool);
    expect(registry.get('Bash')).toBe(tool);
    expect(registry.has('Bash')).toBe(true);
    expect(registry.size).toBe(1);
  });

  it('returns undefined for unregistered tools', () => {
    const registry = new ToolRegistryImpl();
    expect(registry.get('NonExistent')).toBeUndefined();
    expect(registry.has('NonExistent')).toBe(false);
  });

  it('lists all tools', () => {
    const registry = new ToolRegistryImpl();
    registry.register(createMockTool('Bash'));
    registry.register(createMockTool('Read'));
    registry.register(createMockTool('Write'));

    const all = registry.getAll();
    expect(all).toHaveLength(3);
    expect(all.map((t) => t.definition.name).sort()).toEqual(['Bash', 'Read', 'Write']);
  });

  it('generates definitions for the model', () => {
    const registry = new ToolRegistryImpl();
    registry.register(createMockTool('Bash'));
    registry.register(createMockTool('Grep'));

    const defs = registry.getDefinitions();
    expect(defs).toHaveLength(2);
    expect(defs[0]!.name).toBe('Bash');
    expect(defs[1]!.name).toBe('Grep');
    expect(defs[0]!.inputSchema.type).toBe('object');
  });

  it('overwrites tools with the same name', () => {
    const registry = new ToolRegistryImpl();
    const tool1 = createMockTool('Bash');
    const tool2 = createMockTool('Bash');

    registry.register(tool1);
    registry.register(tool2);

    expect(registry.size).toBe(1);
    expect(registry.get('Bash')).toBe(tool2);
  });
});
