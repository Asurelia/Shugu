#!/usr/bin/env node
/**
 * Plugin Child Process Entry Point — Brokered Isolation V1
 *
 * Runs in an isolated Node.js process. Communication with the host
 * is via JSON-RPC over stdio (NDJSON).
 *
 * V1 scope: tools + PreToolUse/PostToolUse hooks only.
 * Commands and skills are NOT supported in brokered mode.
 */

import { createInterface } from 'node:readline';
import type { Tool, ToolCall, ToolResult, ToolContext } from '../protocol/tools.js';
import type {
  HookType, PreToolUseHandler, PostToolUseHandler,
  PreToolUsePayload, PostToolUsePayload,
  CommandHandler, MessageHandler, LifecycleHandler,
  CommandPayload, MessagePayload,
} from './hooks.js';
import type { Command, CommandContext, CommandResult } from '../commands/registry.js';
import type { Skill, SkillContext, SkillResult, SkillTrigger, SkillCategory } from '../skills/loader.js';
import type {
  JsonRpcRequest, JsonRpcResponse, JsonRpcMessage, JsonRpcError,
  InitParams, InvokeToolParams, InvokeHookParams, InvokeCommandParams, InvokeSkillParams,
  RegisterToolParams, RegisterHookParams, RegisterCommandParams, RegisterSkillParams,
  SerializedSkillTrigger, CallbackRunAgentParams, CallbackToolInvokeParams,
  LogParams, CallbackInfoParams, CallbackErrorParams, CallbackQueryParams,
  CapabilityRequestParams, SerializedToolContext, SerializedCommandContext, SerializedSkillContext,
} from './protocol.js';

// ─── State ────────────────────────────────────────────

const registeredTools = new Map<string, Tool>();
const registeredCommands = new Map<string, Command>();
const registeredSkills = new Map<string, Skill>();
const hookHandlers: Array<{
  type: HookType;
  handler: PreToolUseHandler | PostToolUseHandler | CommandHandler | MessageHandler | LifecycleHandler;
  priority: number;
}> = [];

let nextId = 1;
const pendingRequests = new Map<number, {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}>();

// ─── IO ───────────────────────────────────────────────

function send(msg: JsonRpcMessage): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendResponse(id: number, result?: unknown, error?: JsonRpcError): void {
  const msg: JsonRpcResponse = { jsonrpc: '2.0', id };
  if (error) msg.error = error;
  else msg.result = result ?? null;
  send(msg);
}

function sendNotification(method: string, params?: unknown): void {
  send({ jsonrpc: '2.0', method, params } as JsonRpcMessage);
}

/** Send a request to the host and await the response (for capability requests). */
function sendRequest(method: string, params?: unknown): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params } as JsonRpcRequest);
  });
}

// ─── PluginAPI Proxy ──────────────────────────────────

function createChildPluginAPI(dataDir: string) {
  return {
    registerTool(tool: Tool): void {
      registeredTools.set(tool.definition.name, tool);
      sendNotification('register_tool', {
        definition: tool.definition,
      } satisfies RegisterToolParams);
    },

    registerHook(type: HookType, handler: (...args: unknown[]) => Promise<unknown>, priority = 50): void {
      hookHandlers.push({
        type,
        handler: handler as PreToolUseHandler | PostToolUseHandler | CommandHandler | MessageHandler | LifecycleHandler,
        priority,
      });
      sendNotification('register_hook', {
        hookType: type,
        priority,
      } satisfies RegisterHookParams);
    },

    registerCommand(command: Command): void {
      registeredCommands.set(command.name, command);
      sendNotification('register_command', {
        name: command.name,
        aliases: command.aliases,
        description: command.description,
        usage: command.usage,
      } satisfies RegisterCommandParams);
    },

    registerSkill(skill: Skill): void {
      registeredSkills.set(skill.name, skill);
      // Serialize triggers — RegExp needs special handling
      const serializedTriggers: SerializedSkillTrigger[] = skill.triggers.map(t => {
        if (t.type === 'pattern') {
          return { type: 'pattern', pattern: t.regex.source, flags: t.regex.flags };
        }
        return t as SerializedSkillTrigger;
      });
      sendNotification('register_skill', {
        name: skill.name,
        description: skill.description,
        category: skill.category,
        triggers: serializedTriggers,
        requiredTools: skill.requiredTools,
        background: skill.background,
      } satisfies RegisterSkillParams);
    },

    getDataDir(): string {
      return dataDir;
    },

    log(message: string): void {
      sendNotification('log', { message } satisfies LogParams);
    },

    /** Brokered capability client — routes fs/network requests through the host broker. */
    capabilities: {
      async readFile(path: string): Promise<string> {
        const result = await sendRequest('capability_request', { capability: 'fs.read', operation: 'read', args: { path } });
        return (result as { content: string }).content;
      },
      async writeFile(path: string, content: string): Promise<void> {
        await sendRequest('capability_request', { capability: 'fs.write', operation: 'write', args: { path, content } });
      },
      async listDir(path: string): Promise<string[]> {
        const result = await sendRequest('capability_request', { capability: 'fs.list', operation: 'list', args: { path } });
        return (result as { entries: string[] }).entries;
      },
      async httpFetch(url: string, options?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: Record<string, string>; body: string }> {
        const result = await sendRequest('capability_request', { capability: 'http.fetch', operation: 'fetch', args: { url, ...options } });
        return result as { status: number; headers: Record<string, string>; body: string };
      },
    },
  };
}

// ─── Build Minimal ToolContext ─────────────────────────

function buildToolContext(serialized: SerializedToolContext): ToolContext {
  return {
    cwd: serialized.cwd,
    abortSignal: new AbortController().signal,
    permissionMode: serialized.permissionMode as ToolContext['permissionMode'],
    // Security: deny by default in isolated plugin context.
    // Plugins must use only their declared capabilities, not arbitrary tool calls.
    // The host validates plugin capabilities at registration time, not at runtime.
    askPermission: async () => serialized.permissionMode === 'bypass',
  };
}

// ─── Message Handler ──────────────────────────────────

async function handleMessage(msg: JsonRpcMessage): Promise<void> {
  // Handle responses to our outgoing requests (capability results)
  if ('id' in msg && ('result' in msg || 'error' in msg)) {
    const response = msg as JsonRpcResponse;
    const pending = pendingRequests.get(response.id);
    if (pending) {
      pendingRequests.delete(response.id);
      if (response.error) {
        pending.reject(new Error(response.error.message));
      } else {
        pending.resolve(response.result);
      }
    }
    return;
  }

  // Handle requests from host
  const request = msg as JsonRpcRequest;
  if (!request.id || !request.method) return;

  try {
    switch (request.method) {
      case 'init': {
        const params = request.params as InitParams;
        const dataDir = params.dataDir;
        const entryPath = params.entryFile;

        // On Windows, import() needs file:// URLs, not raw paths like C:\...
        const { pathToFileURL } = await import('node:url');
        const entryUrl = pathToFileURL(entryPath).href;
        const mod = await import(entryUrl);
        const init = mod.default ?? mod.init;
        if (typeof init !== 'function') {
          throw new Error('Plugin entry does not export a default function or init()');
        }

        const api = createChildPluginAPI(dataDir);
        await init(api);
        sendResponse(request.id, { status: 'ok' });
        break;
      }

      case 'invoke_tool': {
        const params = request.params as InvokeToolParams;
        const tool = registeredTools.get(params.toolName);
        if (!tool) {
          sendResponse(request.id, undefined, { code: -32601, message: `Unknown tool: ${params.toolName}` });
          return;
        }

        const context = buildToolContext(params.context);

        // Run validateInput inside the child (V1 compromise)
        if (tool.validateInput) {
          const error = tool.validateInput(params.call.input);
          if (error) {
            sendResponse(request.id, {
              tool_use_id: params.call.id,
              content: `Validation error: ${error}`,
              is_error: true,
            } satisfies ToolResult);
            return;
          }
        }

        const result = await tool.execute(params.call, context);
        sendResponse(request.id, result);
        break;
      }

      case 'invoke_hook': {
        const params = request.params as InvokeHookParams;
        const handlers = hookHandlers
          .filter(h => h.type === params.hookType)
          .sort((a, b) => a.priority - b.priority);

        if (params.hookType === 'PreToolUse') {
          let currentPayload = params.payload as PreToolUsePayload;
          for (const h of handlers) {
            const result = await (h.handler as PreToolUseHandler)(currentPayload);
            if (!result.proceed) {
              sendResponse(request.id, result);
              return;
            }
            if (result.modifiedCall) {
              currentPayload = { ...currentPayload, call: result.modifiedCall };
            }
          }
          sendResponse(request.id, { proceed: true, modifiedCall: currentPayload.call });
        } else if (params.hookType === 'PostToolUse') {
          let currentPayload = params.payload as PostToolUsePayload;
          let modifiedResult = currentPayload.result;
          for (const h of handlers) {
            const result = await (h.handler as PostToolUseHandler)({ ...currentPayload, result: modifiedResult });
            if (result.modifiedResult) {
              modifiedResult = result.modifiedResult;
            }
          }
          sendResponse(request.id, { modifiedResult });
        } else if (params.hookType === 'PreCommand' || params.hookType === 'PostCommand') {
          // Fire-and-forget: run all handlers, no return value
          const payload = params.payload as CommandPayload;
          for (const h of handlers) {
            await (h.handler as CommandHandler)(payload);
          }
          sendResponse(request.id, { status: 'ok' });
        } else if (params.hookType === 'OnMessage') {
          const payload = params.payload as MessagePayload;
          for (const h of handlers) {
            await (h.handler as MessageHandler)(payload);
          }
          sendResponse(request.id, { status: 'ok' });
        } else if (params.hookType === 'OnStart' || params.hookType === 'OnExit') {
          // Lifecycle: no payload, just run handlers
          for (const h of handlers) {
            await (h.handler as LifecycleHandler)();
          }
          sendResponse(request.id, { status: 'ok' });
        } else {
          sendResponse(request.id, undefined, { code: -32601, message: `Unknown hook type: ${params.hookType}` });
        }
        break;
      }

      case 'invoke_command': {
        const params = request.params as InvokeCommandParams;
        const cmd = registeredCommands.get(params.commandName);
        if (!cmd) {
          sendResponse(request.id, undefined, { code: -32601, message: `Unknown command: ${params.commandName}` });
          return;
        }

        // Build CommandContext with callback proxies to the host
        const cmdCtx: CommandContext = {
          cwd: params.context.cwd,
          messages: params.context.messages,
          info: (msg: string) => {
            sendNotification('callback/info', { message: msg } satisfies CallbackInfoParams);
          },
          error: (msg: string) => {
            sendNotification('callback/error', { message: msg } satisfies CallbackErrorParams);
          },
          ...(params.context.hasQuery ? {
            query: async (prompt: string): Promise<string> => {
              const result = await sendRequest('callback/query', { prompt } satisfies CallbackQueryParams);
              return (result as { result: string }).result;
            },
          } : {}),
          // client is NOT available in brokered mode
        };

        const result = await cmd.execute(params.args, cmdCtx);
        sendResponse(request.id, result);
        break;
      }

      case 'invoke_skill': {
        const params = request.params as InvokeSkillParams;
        const skill = registeredSkills.get(params.skillName);
        if (!skill) {
          sendResponse(request.id, undefined, { code: -32601, message: `Unknown skill: ${params.skillName}` });
          return;
        }

        // Build SkillContext with proxy callbacks and tool Map
        const proxyTools = new Map<string, Tool>();
        for (const toolName of params.context.availableToolNames) {
          proxyTools.set(toolName, {
            definition: { name: toolName, description: '', inputSchema: { type: 'object', properties: {} } },
            async execute(call, _ctx) {
              const result = await sendRequest('callback/tool_invoke', {
                toolName: call.name,
                call,
              } satisfies CallbackToolInvokeParams);
              return result as ToolResult;
            },
          });
        }

        const skillCtx: SkillContext = {
          input: params.input,
          args: params.args,
          cwd: params.context.cwd,
          messages: params.context.messages,
          toolContext: {
            cwd: params.context.cwd,
            abortSignal: new AbortController().signal,
            permissionMode: params.context.permissionMode as ToolContext['permissionMode'],
            askPermission: async () => true,
          },
          tools: proxyTools,
          info: (msg: string) => {
            sendNotification('callback/info', { message: msg } satisfies CallbackInfoParams);
          },
          error: (msg: string) => {
            sendNotification('callback/error', { message: msg } satisfies CallbackErrorParams);
          },
          query: async (prompt: string): Promise<string> => {
            const result = await sendRequest('callback/query', { prompt } satisfies CallbackQueryParams);
            return (result as { result: string }).result;
          },
          runAgent: async (prompt: string): Promise<string> => {
            const result = await sendRequest('callback/runAgent', { prompt } satisfies CallbackRunAgentParams);
            return (result as { result: string }).result;
          },
        };

        const result = await skill.execute(skillCtx);
        sendResponse(request.id, result);
        break;
      }

      case 'shutdown': {
        sendResponse(request.id, { status: 'ok' });
        setTimeout(() => process.exit(0), 50);
        break;
      }

      default:
        sendResponse(request.id, undefined, { code: -32601, message: `Unknown method: ${request.method}` });
    }
  } catch (err) {
    sendResponse(request.id, undefined, {
      code: -32603,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── Main ─────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line) as JsonRpcMessage;
    handleMessage(msg).catch((err) => {
      process.stderr.write(`[plugin-child] Unhandled: ${err instanceof Error ? err.message : String(err)}\n`);
    });
  } catch {
    process.stderr.write(`[plugin-child] Invalid JSON on stdin\n`);
  }
});

process.on('uncaughtException', (err) => {
  process.stderr.write(`[plugin-child] Uncaught exception: ${err.message}\n`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[plugin-child] Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}\n`);
  process.exit(1);
});
