/**
 * Layer 14 — Plugins: Hook System
 *
 * Hooks allow plugins to intercept tool execution, command dispatch,
 * and lifecycle events. They provide the extensibility backbone
 * for the plugin system.
 *
 * Hook types:
 * - PreToolUse:  runs before a tool executes (can modify input or block)
 * - PostToolUse: runs after a tool executes (can modify output)
 * - PreCommand:  runs before a slash command
 * - PostCommand: runs after a slash command
 * - OnMessage:   runs when a new message is added to the conversation
 * - OnStart:     runs when PCC starts
 * - OnExit:      runs when PCC is about to exit
 */

import { EventEmitter } from 'node:events';
import type { ToolCall, ToolResult } from '../protocol/tools.js';
import type { Message } from '../protocol/messages.js';
import { tracer } from '../utils/tracer.js';
import { logger } from '../utils/logger.js';

// ─── Hook Types ────────────────────────────────────────

export type HookType =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PreCommand'
  | 'PostCommand'
  | 'OnMessage'
  | 'OnStart'
  | 'OnExit';

// ─── Hook Payloads ─────────────────────────────────────

export interface PreToolUsePayload {
  tool: string;
  call: ToolCall;
}

export interface PreToolUseResult {
  /** Whether to proceed with tool execution */
  proceed: boolean;
  /** Modified tool call (if changed) */
  modifiedCall?: ToolCall;
  /** Reason for blocking (if proceed=false) */
  blockReason?: string;
}

export interface PostToolUsePayload {
  tool: string;
  call: ToolCall;
  result: ToolResult;
  durationMs: number;
}

export interface PostToolUseResult {
  /** Modified result (if changed) */
  modifiedResult?: ToolResult;
}

export interface CommandPayload {
  command: string;
  args: string;
}

export interface MessagePayload {
  message: Message;
  role: 'user' | 'assistant';
}

// ─── Hook Handler Types ────────────────────────────────

export type PreToolUseHandler = (payload: PreToolUsePayload) => Promise<PreToolUseResult>;
export type PostToolUseHandler = (payload: PostToolUsePayload) => Promise<PostToolUseResult>;
export type CommandHandler = (payload: CommandPayload) => Promise<void>;
export type MessageHandler = (payload: MessagePayload) => Promise<void>;
export type LifecycleHandler = () => Promise<void>;

export interface HookHandler {
  type: HookType;
  pluginName: string;
  priority: number;  // Lower = runs first (0-100)
  handler: PreToolUseHandler | PostToolUseHandler | CommandHandler | MessageHandler | LifecycleHandler;
}

// ─── Hook Registry ─────────────────────────────────────

export class HookRegistry extends EventEmitter {
  private hooks = new Map<HookType, HookHandler[]>();

  /**
   * Register a hook handler.
   */
  register(hook: HookHandler): void {
    const list = this.hooks.get(hook.type) ?? [];
    list.push(hook);
    // Sort by priority (lower = first)
    list.sort((a, b) => a.priority - b.priority);
    this.hooks.set(hook.type, list);
  }

  /**
   * Unregister all hooks from a specific plugin.
   */
  unregisterPlugin(pluginName: string): void {
    for (const [type, handlers] of this.hooks) {
      this.hooks.set(type, handlers.filter((h) => h.pluginName !== pluginName));
    }
  }

  /**
   * Run PreToolUse hooks. Returns whether to proceed and any modifications.
   */
  async runPreToolUse(payload: PreToolUsePayload): Promise<PreToolUseResult> {
    const handlers = this.hooks.get('PreToolUse') ?? [];
    let currentCall = payload.call;

    for (const hook of handlers) {
      try {
        const result = await (hook.handler as PreToolUseHandler)({
          ...payload,
          call: currentCall,
        });

        if (!result.proceed) {
          tracer.log('tool_call', { hook: hook.pluginName, action: 'blocked', tool: payload.tool, reason: result.blockReason });
          this.emit('hook:blocked', hook.pluginName, 'PreToolUse', result.blockReason);
          return result;
        }

        if (result.modifiedCall) {
          tracer.log('tool_call', { hook: hook.pluginName, action: 'modified_input', tool: payload.tool });
          currentCall = result.modifiedCall;
        }
      } catch (error) {
        logger.warn(`Hook PreToolUse from plugin "${hook.pluginName}" threw: ${(error as Error).message}`);
        tracer.log('error', { hook: hook.pluginName, type: 'PreToolUse', error: (error as Error).message });
        this.emit('hook:error', hook.pluginName, 'PreToolUse', error);

        // Fail secure: high-priority hooks (security-related, priority < 50) block on error.
        // This prevents a crashing security hook from silently allowing dangerous operations.
        if (hook.priority < 50) {
          return { proceed: false, blockReason: `Security hook "${hook.pluginName}" failed — blocking tool call for safety` };
        }
      }
    }

    return { proceed: true, modifiedCall: currentCall };
  }

  /**
   * Run PostToolUse hooks. Returns any modifications to the result.
   */
  async runPostToolUse(payload: PostToolUsePayload): Promise<PostToolUseResult> {
    const handlers = this.hooks.get('PostToolUse') ?? [];
    let currentResult = payload.result;

    for (const hook of handlers) {
      try {
        const result = await (hook.handler as PostToolUseHandler)({
          ...payload,
          result: currentResult,
        });

        if (result.modifiedResult) {
          currentResult = result.modifiedResult;
        }
      } catch (error) {
        logger.warn(`Hook PostToolUse from plugin "${hook.pluginName}" threw: ${(error as Error).message}`);
        this.emit('hook:error', hook.pluginName, 'PostToolUse', error);
      }
    }

    return { modifiedResult: currentResult };
  }

  /**
   * Run command hooks (pre or post).
   */
  async runCommandHook(type: 'PreCommand' | 'PostCommand', payload: CommandPayload): Promise<void> {
    const handlers = this.hooks.get(type) ?? [];
    for (const hook of handlers) {
      try {
        await (hook.handler as CommandHandler)(payload);
      } catch (error) {
        this.emit('hook:error', hook.pluginName, type, error);
      }
    }
  }

  /**
   * Run message hooks.
   */
  async runMessageHook(payload: MessagePayload): Promise<void> {
    const handlers = this.hooks.get('OnMessage') ?? [];
    for (const hook of handlers) {
      try {
        await (hook.handler as MessageHandler)(payload);
      } catch (error) {
        this.emit('hook:error', hook.pluginName, 'OnMessage', error);
      }
    }
  }

  /**
   * Run lifecycle hooks.
   */
  async runLifecycleHook(type: 'OnStart' | 'OnExit'): Promise<void> {
    const handlers = this.hooks.get(type) ?? [];
    for (const hook of handlers) {
      try {
        await (hook.handler as LifecycleHandler)();
      } catch (error) {
        this.emit('hook:error', hook.pluginName, type, error);
      }
    }
  }

  /**
   * Get all hooks of a given type.
   */
  getHooks(type: HookType): HookHandler[] {
    return this.hooks.get(type) ?? [];
  }

  /**
   * Get all registered hooks.
   */
  getAllHooks(): HookHandler[] {
    const all: HookHandler[] = [];
    for (const handlers of this.hooks.values()) {
      all.push(...handlers);
    }
    return all;
  }

  get totalCount(): number {
    let count = 0;
    for (const handlers of this.hooks.values()) {
      count += handlers.length;
    }
    return count;
  }
}
