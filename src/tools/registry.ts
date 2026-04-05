/**
 * Layer 3 — Tools: Registry
 *
 * Dynamic tool registration and lookup.
 * Tools register themselves and the registry provides definitions to the model.
 */

import type { Tool, ToolDefinition, ToolRegistry } from '../protocol/tools.js';

export class ToolRegistryImpl implements ToolRegistry {
  private tools = new Map<string, Tool>();

  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  register(tool: Tool): void {
    this.tools.set(tool.definition.name, tool);
  }

  getDefinitions(): ToolDefinition[] {
    return this.getAll().map((t) => t.definition);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get size(): number {
    return this.tools.size;
  }
}
