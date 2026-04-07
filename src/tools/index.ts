/**
 * Layer 3 — Tools: barrel export + registration helper
 */

export { ToolRegistryImpl } from './registry.js';
export { executeToolCalls } from './executor.js';
export { BashTool } from './bash/BashTool.js';
export { FileReadTool } from './files/FileReadTool.js';
export { FileWriteTool } from './files/FileWriteTool.js';
export { FileEditTool } from './files/FileEditTool.js';
export { GlobTool } from './search/GlobTool.js';
export { GrepTool } from './search/GrepTool.js';
export { AgentTool } from './agents/AgentTool.js';
export { WebFetchTool } from './web/WebFetchTool.js';
export { WebSearchTool } from './web/WebSearchTool.js';
export { REPLTool } from './repl/REPLTool.js';
export { TaskCreateTool, TaskUpdateTool, TaskListTool } from './tasks/TaskTools.js';
export { SleepTool } from './utility/SleepTool.js';
export { ObsidianTool } from './obsidian/ObsidianTool.js';

import { ToolRegistryImpl } from './registry.js';
import { BashTool } from './bash/BashTool.js';
import { FileReadTool } from './files/FileReadTool.js';
import { FileWriteTool } from './files/FileWriteTool.js';
import { FileEditTool } from './files/FileEditTool.js';
import { GlobTool } from './search/GlobTool.js';
import { GrepTool } from './search/GrepTool.js';
import { AgentTool } from './agents/AgentTool.js';
import { WebFetchTool } from './web/WebFetchTool.js';
import { WebSearchTool } from './web/WebSearchTool.js';
import { REPLTool } from './repl/REPLTool.js';
import { TaskCreateTool, TaskUpdateTool, TaskListTool } from './tasks/TaskTools.js';
import { SleepTool } from './utility/SleepTool.js';
import { ObsidianTool } from './obsidian/ObsidianTool.js';
import type { CredentialProvider } from '../credentials/provider.js';

/**
 * Create a registry with all tools registered.
 */
export function createDefaultRegistry(credentialProvider: CredentialProvider): {
  registry: ToolRegistryImpl;
  agentTool: AgentTool;
  webFetchTool: WebFetchTool;
  obsidianTool: ObsidianTool;
} {
  const registry = new ToolRegistryImpl();

  // Core tools
  registry.register(new BashTool());
  registry.register(new FileReadTool());
  registry.register(new FileWriteTool());
  registry.register(new FileEditTool());
  registry.register(new GlobTool());
  registry.register(new GrepTool());

  // Web tools
  const webFetchTool = new WebFetchTool();
  webFetchTool.setCredentialProvider(credentialProvider);
  registry.register(webFetchTool);
  registry.register(new WebSearchTool());

  // REPL
  registry.register(new REPLTool());

  // Task management
  registry.register(new TaskCreateTool());
  registry.register(new TaskUpdateTool());
  registry.register(new TaskListTool());

  // Utility
  registry.register(new SleepTool());

  // Obsidian vault (second brain)
  const obsidianTool = new ObsidianTool();
  registry.register(obsidianTool);

  // Agent (orchestrator injected later by CLI)
  const agentTool = new AgentTool();
  registry.register(agentTool);

  return { registry, agentTool, webFetchTool, obsidianTool };
}
