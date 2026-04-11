/**
 * Layer 7 — Commands: barrel export + default registry
 */

export { CommandRegistry, type Command, type CommandContext, type CommandResult } from './registry.js';
export {
  helpCommand, quitCommand, clearCommand, compactCommand,
  commitCommand, statusCommand, reviewCommand, memoryCommand,
} from './builtins.js';
export { createBgCommand, createProactiveCommand } from './automation.js';
export { initCommand } from './init.js';
export { doctorCommand } from './doctor.js';
export { modelCommand, fastCommand, diffCommand, exportCommand, rewindCommand } from './config.js';
export { traceCommand, healthCommand } from './trace.js';
export { workspaceCommand } from './workspace.js';
export { createFileRevertCommand, createCloneCommand, copyCommand, createSnapshotCommand } from './session.js';
export { createTeamCommand } from './team.js';
export { createReviewCommand } from './review.js';
export { createBatchCommand } from './batch.js';
export { createDreamCommand } from './dream.js';

import { CommandRegistry } from './registry.js';
import {
  helpCommand, quitCommand, clearCommand, compactCommand,
  commitCommand, statusCommand, reviewCommand, memoryCommand,
} from './builtins.js';
import { initCommand } from './init.js';
import { doctorCommand } from './doctor.js';
import { modelCommand, fastCommand, diffCommand, exportCommand, rewindCommand } from './config.js';
import { traceCommand, healthCommand } from './trace.js';
import { workspaceCommand } from './workspace.js';
import { copyCommand } from './session.js';

/**
 * Create a command registry with all builtin commands.
 */
export function createDefaultCommands(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register(helpCommand);
  registry.register(quitCommand);
  registry.register(clearCommand);
  registry.register(compactCommand);
  registry.register(commitCommand);
  registry.register(statusCommand);
  registry.register(reviewCommand);
  registry.register(memoryCommand);
  registry.register(initCommand);
  registry.register(doctorCommand);
  registry.register(modelCommand);
  registry.register(fastCommand);
  registry.register(diffCommand);
  registry.register(exportCommand);
  registry.register(rewindCommand);
  registry.register(traceCommand);
  registry.register(healthCommand);
  registry.register(workspaceCommand);
  registry.register(copyCommand);
  return registry;
}
