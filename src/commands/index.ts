/**
 * Layer 7 — Commands: barrel export + default registry
 */

export { CommandRegistry, type Command, type CommandContext, type CommandResult } from './registry.js';
export {
  helpCommand, quitCommand, clearCommand, compactCommand,
  commitCommand, statusCommand, reviewCommand, memoryCommand,
} from './builtins.js';

import { CommandRegistry } from './registry.js';
import {
  helpCommand, quitCommand, clearCommand, compactCommand,
  commitCommand, statusCommand, reviewCommand, memoryCommand,
} from './builtins.js';

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
  return registry;
}
