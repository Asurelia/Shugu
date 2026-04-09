/**
 * Layer 7 — Commands: Registry
 *
 * Slash command registration and dispatch.
 * Commands are typed functions that execute synchronously or async,
 * with access to the full application context.
 */

import type { Message } from '../protocol/messages.js';
import type { MiniMaxClient } from '../transport/client.js';

// ─── Command Types ──────────────────────────────────────

export interface Command {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  execute: (args: string, ctx: CommandContext) => Promise<CommandResult>;
}

export interface CommandContext {
  cwd: string;
  messages: Message[];
  /** Callback to display info to the user */
  info: (msg: string) => void;
  /** Callback to display errors */
  error: (msg: string) => void;
  /** Access to the model for commands that need it (e.g., /commit) */
  query?: (prompt: string) => Promise<string>;
  /** Access to the client for commands that need to switch models */
  client?: MiniMaxClient;
}

export type CommandResult =
  | { type: 'handled' }                           // Command handled, nothing more needed
  | { type: 'prompt'; prompt: string }            // Inject as user message to the model
  | { type: 'clear' }                             // Clear conversation
  | { type: 'exit'; reason: string }              // Exit the REPL
  | { type: 'error'; message: string };           // Error occurred

// ─── Registry ───────────────────────────────────────────

export class CommandRegistry {
  private commands = new Map<string, Command>();

  register(command: Command): void {
    this.commands.set(command.name, command);
    if (command.aliases) {
      for (const alias of command.aliases) {
        this.commands.set(alias, command);
      }
    }
  }

  unregister(name: string): boolean {
    const cmd = this.commands.get(name);
    if (!cmd) return false;
    this.commands.delete(name);
    // Also remove aliases
    if (cmd.aliases) {
      for (const alias of cmd.aliases) {
        this.commands.delete(alias);
      }
    }
    return true;
  }

  get(name: string): Command | undefined {
    return this.commands.get(name);
  }

  getAll(): Command[] {
    // Deduplicate (aliases map to same command)
    const seen = new Set<string>();
    const result: Command[] = [];
    for (const cmd of this.commands.values()) {
      if (!seen.has(cmd.name)) {
        seen.add(cmd.name);
        result.push(cmd);
      }
    }
    return result;
  }

  /**
   * Parse and dispatch a slash command.
   * Returns null if the input is not a command.
   */
  async dispatch(input: string, ctx: CommandContext): Promise<CommandResult | null> {
    if (!input.startsWith('/')) return null;

    const spaceIdx = input.indexOf(' ');
    const name = spaceIdx === -1 ? input.slice(1) : input.slice(1, spaceIdx);
    const args = spaceIdx === -1 ? '' : input.slice(spaceIdx + 1).trim();

    const command = this.get(name);
    if (!command) {
      return { type: 'error', message: `Unknown command: /${name}. Type /help for available commands.` };
    }

    return command.execute(args, ctx);
  }
}
