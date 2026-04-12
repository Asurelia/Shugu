/**
 * Plugin Host — manages a single brokered plugin child process.
 *
 * Spawns a child Node.js process, communicates via JSON-RPC over stdio,
 * and creates proxy Tool/HookHandler objects that forward calls through IPC.
 */

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { validateRegexSafety } from '../utils/security.js';
import type { Tool, ToolCall, ToolResult, ToolContext, ToolDefinition } from '../protocol/tools.js';
import type { HookHandler, HookType } from './hooks.js';
import type { Command, CommandContext, CommandResult } from '../commands/registry.js';
import type { Skill, SkillContext, SkillResult, SkillTrigger, SkillCategory } from '../skills/loader.js';
import type { PluginManifest } from './loader.js';
import type { CapabilityBroker } from './broker.js';
import type {
  JsonRpcMessage, JsonRpcRequest, JsonRpcResponse, JsonRpcNotification, JsonRpcError,
  InitParams, InvokeToolParams, InvokeHookParams, InvokeCommandParams, InvokeSkillParams,
  RegisterToolParams, RegisterHookParams, RegisterCommandParams, RegisterSkillParams,
  SerializedSkillTrigger, CallbackRunAgentParams, CallbackToolInvokeParams,
  LogParams, CapabilityRequestParams,
  CallbackInfoParams, CallbackErrorParams, CallbackQueryParams,
  SerializedCommandContext, SerializedSkillContext,
} from './protocol.js';
import { logger } from '../utils/logger.js';

// ─── Built-in Tool Names (shadowing prevention) ──────

/**
 * SECURITY: Plugins must NOT register tools with these names.
 * A malicious plugin could shadow a builtin tool to intercept all calls
 * (e.g., shadow "Read" to exfiltrate file contents, shadow "WebFetch"
 * to steal auto-injected credential headers).
 */
const BUILTIN_TOOL_NAMES = new Set([
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'Bash', 'Agent', 'WebFetch', 'WebSearch',
  'Sleep', 'REPL', 'Tasks', 'Obsidian',
  'Plan', 'EnterPlanMode', 'ExitPlanMode',
]);

// ─── Options ──────────────────────────────────────────

export interface PluginHostOptions {
  manifest: PluginManifest;
  pluginDir: string;
  capabilities: string[];
  broker: CapabilityBroker;
  timeoutMs?: number;
  maxAgentTurns?: number;   // Max runAgent() calls per invocation (default: 10)
  childEntryPath?: string;  // Override for testing
  disableOsSandbox?: boolean;  // For testing or when permission model isn't available
}

// ─── Docker Sandbox Detection ─────────────────────────

let _dockerAvailable: boolean | null = null;

/**
 * Check if Docker is available for sandbox mode.
 * Cached after first call.
 */
export function isDockerAvailable(): boolean {
  if (_dockerAvailable !== null) return _dockerAvailable;
  try {
    const result = execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'pipe', timeout: 5000 });
    _dockerAvailable = result.toString().trim().length > 0;
  } catch {
    _dockerAvailable = false;
  }
  return _dockerAvailable;
}

/**
 * Build Docker run arguments for sandboxed plugin execution.
 * Returns the full spawn command and args for docker run.
 */
export function buildDockerArgs(
  childEntryPath: string,
  pluginDir: string,
  pluginDataDir: string,
): { cmd: string; args: string[] } {
  // Convert Windows paths to Docker-compatible format
  const toDockerPath = (p: string): string => p.replace(/\\/g, '/');

  return {
    cmd: 'docker',
    args: [
      'run', '--rm', '-i',
      '--net=none',          // No network access
      '--read-only',         // Read-only root filesystem
      '--cap-drop=ALL',      // Drop all Linux capabilities
      '--security-opt=no-new-privileges',
      // Mount child entry (read-only)
      '-v', `${toDockerPath(childEntryPath)}:/app/child-entry.mjs:ro`,
      // Mount plugin dir (read-only)
      '-v', `${toDockerPath(pluginDir)}:/plugin:ro`,
      // Mount plugin data dir (read-write) — the only writable path
      '-v', `${toDockerPath(pluginDataDir)}:/plugin/.data:rw`,
      // Writable /tmp for Node internals
      '--tmpfs', '/tmp',
      // Use slim Node image
      'node:20-slim',
      'node', '/app/child-entry.mjs',
    ],
  };
}

// ─── Permission Flag Helpers ───────────────────────────

/**
 * Parse the Node.js major version from process.version (e.g. 'v24.4.1' → 24).
 */
export function getNodeMajorVersion(): number {
  const match = process.version.match(/^v(\d+)/);
  return match ? parseInt(match[1]!, 10) : 0;
}

/**
 * Build Node.js --permission flags for brokered plugin child processes.
 * Returns an empty array when permission model is unavailable or not applicable.
 *
 * @param nodeVersion - Node.js major version number
 * @param entryPath   - The resolved child entry path
 * @param pluginDir   - The plugin's directory (read access granted here)
 * @param projectDir  - The host project's cwd (read access granted here)
 */
export function buildPermissionFlags(
  nodeVersion: number,
  entryPath: string,
  pluginDir: string,
  projectDir: string,
): string[] {
  // Only stable in Node >= 22; tsx mode (.ts) doesn't support --permission
  if (nodeVersion < 22 || entryPath.endsWith('.ts')) {
    return [];
  }
  const pluginDataDir = join(pluginDir, '.data');

  // fs reads: on Windows, Node converts paths to UNC (\\?\) internally, which
  // breaks --allow-fs-read path matching. Use * on Windows.
  // On Linux/macOS, we can restrict to specific paths.
  let readFlag: string;
  if (process.platform === 'win32') {
    readFlag = '--allow-fs-read=*';
  } else {
    const nodeDir = dirname(process.execPath);
    readFlag = `--allow-fs-read=${pluginDir},${projectDir},${nodeDir}`;
  }

  return [
    '--permission',
    readFlag,
    `--allow-fs-write=${pluginDataDir}`,
    // No --allow-child-process: child cannot spawn subprocesses
    // No --allow-worker: child cannot create workers
  ];
}

// ─── Plugin Host ──────────────────────────────────────

export class PluginHost extends EventEmitter {
  private child: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private timeoutMs: number;
  private dead = false;
  private maxAgentTurns: number;
  private agentCallsRemaining: number;

  /** Proxy tools created from child registrations. */
  readonly tools: Tool[] = [];
  /** Proxy hooks created from child registrations. */
  readonly hooks: HookHandler[] = [];
  /** Proxy commands created from child registrations. */
  readonly commands: Command[] = [];
  /** Proxy skills created from child registrations. */
  readonly skills: Skill[] = [];

  readonly pluginName: string;

  /** Active callback context for command/skill invocations (bidirectional RPC). */
  private activeCallbackCtx: {
    info?: (msg: string) => void;
    error?: (msg: string) => void;
    query?: (prompt: string) => Promise<string>;
    runAgent?: (prompt: string) => Promise<string>;
    toolInvoke?: (toolName: string, call: ToolCall) => Promise<ToolResult>;
  } | null = null;

  constructor(private options: PluginHostOptions) {
    super();
    this.pluginName = options.manifest.name;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxAgentTurns = options.maxAgentTurns ?? 10;
    this.agentCallsRemaining = this.maxAgentTurns;
  }

  // ─── Lifecycle ────────────────────────────────────────

  /**
   * Spawn the child process, send init, collect registrations, return when ready.
   */
  async start(): Promise<void> {
    const entryPath = this.resolveChildEntry();
    const dataDir = join(this.options.pluginDir, '.data');

    // Sanitized env: only PATH + SYSTEMROOT (Windows), no secrets
    const safeEnv: Record<string, string> = {
      NODE_OPTIONS: '--no-warnings',
    };
    if (process.env['PATH']) safeEnv['PATH'] = process.env['PATH'];
    if (process.env['SYSTEMROOT']) safeEnv['SYSTEMROOT'] = process.env['SYSTEMROOT'];
    if (process.env['HOME']) safeEnv['HOME'] = process.env['HOME'];
    if (process.env['USERPROFILE']) safeEnv['USERPROFILE'] = process.env['USERPROFILE'];

    // Determine spawn strategy: Docker sandbox > --permission > bare process
    let spawnCmd: string;
    let spawnArgs: string[];
    let spawnOptions: Parameters<typeof spawn>[2];

    const useDocker = !this.options.disableOsSandbox
      && !entryPath.endsWith('.ts')  // Docker mode only for production .mjs
      && isDockerAvailable();

    if (useDocker) {
      // ─── Docker Sandbox: full isolation (network, filesystem, capabilities) ───
      const docker = buildDockerArgs(entryPath, this.options.pluginDir, dataDir);
      spawnCmd = docker.cmd;
      spawnArgs = docker.args;
      spawnOptions = {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { MSYS_NO_PATHCONV: '1', ...safeEnv }, // Prevent MSYS path mangling on Windows
      };
      // Configure broker path mappings: container paths → host paths
      this.options.broker.setPathMappings([
        { from: '/plugin/.data', to: join(this.options.pluginDir, '.data') },
        { from: '/plugin', to: this.options.pluginDir },
      ]);
      logger.debug(`[plugin:${this.pluginName}] Starting in Docker sandbox`);
    } else if (entryPath.endsWith('.ts')) {
      // ─── Dev mode: tsx for TypeScript ───
      const tsxBin = join(process.cwd(), 'node_modules', '.bin', 'tsx');
      spawnCmd = existsSync(tsxBin) ? tsxBin : 'tsx';
      spawnArgs = [entryPath];
      spawnOptions = {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: this.options.pluginDir,
        env: safeEnv,
        shell: true, // tsx binary needs shell on Windows
      };
      logger.debug(`[plugin:${this.pluginName}] Starting in dev mode (tsx)`);
    } else {
      // ─── Production without Docker: Node --permission flags ───
      spawnCmd = process.execPath;
      spawnArgs = [entryPath];

      if (!this.options.disableOsSandbox) {
        const permissionArgs = buildPermissionFlags(
          getNodeMajorVersion(), entryPath, this.options.pluginDir, process.cwd(),
        );
        if (permissionArgs.length > 0) {
          spawnArgs = [...permissionArgs, ...spawnArgs];
        }
      }

      spawnOptions = {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: this.options.pluginDir,
        env: safeEnv,
      };

      // On Linux, drop to nobody/nogroup if running as root
      if (process.platform === 'linux' && process.getuid?.() === 0) {
        spawnOptions.uid = 65534;
        spawnOptions.gid = 65534;
      }
      logger.debug(`[plugin:${this.pluginName}] Starting with Node --permission flags`);
    }

    this.child = spawn(spawnCmd, spawnArgs, spawnOptions);

    // Forward child stderr to our logger
    this.child.stderr?.on('data', (data: Buffer) => {
      logger.debug(`[plugin:${this.pluginName}] ${data.toString().trimEnd()}`);
    });

    // Handle child exit
    this.child.on('exit', (code, signal) => {
      this.dead = true;
      const error = new Error(`Plugin "${this.pluginName}" child exited: code=${code} signal=${signal}`);
      // Reject all pending requests
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      this.emit('crashed', error);
    });

    this.child.on('error', (err) => {
      this.dead = true;
      logger.debug(`[plugin:${this.pluginName}] spawn error: ${err.message}`);
      this.emit('crashed', err);
    });

    // Read NDJSON from child stdout
    this.readline = createInterface({ input: this.child.stdout!, crlfDelay: Infinity });
    this.readline.on('line', (line) => this.handleLine(line));

    // Send init — paths differ between Docker and native mode
    const initParams: InitParams = useDocker
      ? {
          pluginDir: '/plugin',
          entryFile: `/plugin/${this.options.manifest.entry}`,
          dataDir: '/plugin/.data',
          capabilities: this.options.capabilities,
        }
      : {
          pluginDir: this.options.pluginDir,
          entryFile: join(this.options.pluginDir, this.options.manifest.entry),
          dataDir,
          capabilities: this.options.capabilities,
        };

    await this.request('init', initParams);
  }

  /**
   * Gracefully shut down the child process.
   */
  async shutdown(): Promise<void> {
    if (this.dead || !this.child) return;
    try {
      await this.request('shutdown', undefined);
      this.dead = true;
    } catch {
      // If shutdown request fails, force kill
      this.kill();
    }
  }

  /**
   * Force-kill the child process.
   */
  kill(): void {
    if (this.child && !this.dead) {
      this.child.kill('SIGTERM');
      this.dead = true;
    }
  }

  get isDead(): boolean {
    return this.dead;
  }

  // ─── IPC ──────────────────────────────────────────────

  /**
   * Send a JSON-RPC request and await the response.
   */
  private request(method: string, params?: unknown): Promise<unknown> {
    if (this.dead) {
      return Promise.reject(new Error(`Plugin "${this.pluginName}" is dead`));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Plugin "${this.pluginName}" timed out on ${method} (${this.timeoutMs}ms)`));
      }, this.timeoutMs);
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();

      this.pending.set(id, { resolve, reject, timer });
      this.sendToChild({ jsonrpc: '2.0', id, method, params } as JsonRpcRequest);
    });
  }

  /**
   * Send a JSON line to the child's stdin.
   */
  private sendToChild(msg: JsonRpcMessage): void {
    if (this.child?.stdin?.writable) {
      this.child.stdin.write(JSON.stringify(msg) + '\n');
    }
  }

  /**
   * Handle an incoming line from the child's stdout.
   */
  private handleLine(line: string): void {
    if (!line.trim()) return;

    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.emit('error', new Error(`Malformed JSON from plugin "${this.pluginName}": ${line.slice(0, 100)}`));
      return;
    }

    // Response to a request we sent
    if ('id' in msg && ('result' in msg || 'error' in msg)) {
      const response = msg as JsonRpcResponse;
      const pending = this.pending.get(response.id);
      if (pending) {
        this.pending.delete(response.id);
        clearTimeout(pending.timer);
        if (response.error) {
          pending.reject(new Error(response.error.message));
        } else {
          pending.resolve(response.result);
        }
      }
      return;
    }

    // Request from child (capability_request)
    if ('id' in msg && 'method' in msg) {
      const request = msg as JsonRpcRequest;
      this.handleChildRequest(request).catch((err) => {
        this.sendToChild({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        } as JsonRpcResponse);
      });
      return;
    }

    // Notification from child (registration, log, or callback)
    if ('method' in msg && !('id' in msg)) {
      const notification = msg as JsonRpcNotification;
      // Handle callback notifications (info/error) from bidirectional RPC
      if (notification.method === 'callback/info') {
        const params = notification.params as CallbackInfoParams;
        this.activeCallbackCtx?.info?.(params.message);
        return;
      }
      if (notification.method === 'callback/error') {
        const params = notification.params as CallbackErrorParams;
        this.activeCallbackCtx?.error?.(params.message);
        return;
      }
      this.handleNotification(notification);
    }
  }

  /**
   * Handle a request from the child (capability_request).
   */
  private async handleChildRequest(request: JsonRpcRequest): Promise<void> {
    if (request.method === 'capability_request') {
      const params = request.params as CapabilityRequestParams;
      try {
        const result = await this.options.broker.handle(params);
        this.sendToChild({ jsonrpc: '2.0', id: request.id, result } as JsonRpcResponse);
      } catch (err) {
        this.sendToChild({
          jsonrpc: '2.0', id: request.id,
          error: { code: -32002, message: err instanceof Error ? err.message : String(err) },
        } as JsonRpcResponse);
      }
    } else if (request.method === 'callback/runAgent') {
      const params = request.params as CallbackRunAgentParams;
      if (!this.activeCallbackCtx?.runAgent) {
        this.sendToChild({
          jsonrpc: '2.0', id: request.id,
          error: { code: -32002, message: 'runAgent() not available in this context' },
        } as JsonRpcResponse);
        return;
      }
      // Budget control: limit runAgent calls per invocation
      if (this.agentCallsRemaining <= 0) {
        this.sendToChild({
          jsonrpc: '2.0', id: request.id,
          error: { code: -32002, message: `runAgent budget exhausted (max ${this.maxAgentTurns} calls per invocation)` },
        } as JsonRpcResponse);
        return;
      }
      this.agentCallsRemaining--;
      try {
        const result = await this.activeCallbackCtx.runAgent(params.prompt);
        this.sendToChild({ jsonrpc: '2.0', id: request.id, result: { result } } as JsonRpcResponse);
      } catch (err) {
        this.sendToChild({
          jsonrpc: '2.0', id: request.id,
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        } as JsonRpcResponse);
      }
    } else if (request.method === 'callback/tool_invoke') {
      const params = request.params as CallbackToolInvokeParams;
      if (!this.activeCallbackCtx?.toolInvoke) {
        this.sendToChild({
          jsonrpc: '2.0', id: request.id,
          error: { code: -32002, message: 'tool_invoke not available in this context' },
        } as JsonRpcResponse);
        return;
      }
      try {
        const result = await this.activeCallbackCtx.toolInvoke(params.toolName, params.call);
        this.sendToChild({ jsonrpc: '2.0', id: request.id, result } as JsonRpcResponse);
      } catch (err) {
        this.sendToChild({
          jsonrpc: '2.0', id: request.id,
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        } as JsonRpcResponse);
      }
    } else if (request.method === 'callback/query') {
      // Bidirectional RPC: child asks host to query the model
      const params = request.params as CallbackQueryParams;
      if (!this.activeCallbackCtx?.query) {
        this.sendToChild({
          jsonrpc: '2.0', id: request.id,
          error: { code: -32002, message: 'query() not available in this context' },
        } as JsonRpcResponse);
        return;
      }
      try {
        const result = await this.activeCallbackCtx.query(params.prompt);
        this.sendToChild({ jsonrpc: '2.0', id: request.id, result: { result } } as JsonRpcResponse);
      } catch (err) {
        this.sendToChild({
          jsonrpc: '2.0', id: request.id,
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        } as JsonRpcResponse);
      }
    } else {
      this.sendToChild({
        jsonrpc: '2.0', id: request.id,
        error: { code: -32601, message: `Unknown method from child: ${request.method}` },
      } as JsonRpcResponse);
    }
  }

  /**
   * Handle a notification from the child (registrations + logging).
   */
  /** Check if the plugin's manifest.permissions allows a registration scope. */
  private hasPermission(scope: string): boolean {
    const perms = this.options.manifest.permissions;
    // No permissions declared → allow all (backwards-compatible)
    if (!perms || perms.length === 0) return true;
    return perms.includes(scope);
  }

  private handleNotification(notification: JsonRpcNotification): void {
    switch (notification.method) {
      case 'register_tool': {
        if (!this.hasPermission('tools')) {
          logger.debug(`[plugin:${this.pluginName}] register_tool rejected: missing 'tools' permission`);
          break;
        }
        const params = notification.params as RegisterToolParams;
        // SECURITY: Reject if plugin tries to shadow a builtin tool name
        if (BUILTIN_TOOL_NAMES.has(params.definition.name)) {
          logger.warn(`[plugin:${this.pluginName}] register_tool rejected: "${params.definition.name}" shadows a builtin tool`);
          break;
        }
        this.tools.push(this.createProxyTool(params));
        break;
      }
      case 'register_hook': {
        if (!this.hasPermission('hooks')) {
          logger.debug(`[plugin:${this.pluginName}] register_hook rejected: missing 'hooks' permission`);
          break;
        }
        const params = notification.params as RegisterHookParams;
        this.hooks.push(this.createProxyHook(params));
        break;
      }
      case 'register_skill': {
        if (!this.hasPermission('skills')) {
          logger.debug(`[plugin:${this.pluginName}] register_skill rejected: missing 'skills' permission`);
          break;
        }
        const params = notification.params as RegisterSkillParams;
        this.skills.push(this.createProxySkill(params));
        break;
      }
      case 'register_command': {
        if (!this.hasPermission('commands')) {
          logger.debug(`[plugin:${this.pluginName}] register_command rejected: missing 'commands' permission`);
          break;
        }
        const params = notification.params as RegisterCommandParams;
        this.commands.push(this.createProxyCommand(params));
        break;
      }
      case 'log': {
        const params = notification.params as LogParams;
        logger.debug(`[plugin:${this.pluginName}] ${params.message}`);
        break;
      }
      default:
        logger.debug(`[plugin:${this.pluginName}] Unknown notification: ${notification.method}`);
    }
  }

  // ─── Proxy Creation ───────────────────────────────────

  /**
   * Create a proxy Tool that forwards execute() calls to the child via IPC.
   */
  private createProxyTool(reg: RegisterToolParams): Tool {
    const host = this;
    return {
      definition: reg.definition,
      async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
        const params: InvokeToolParams = {
          toolName: reg.definition.name,
          call,
          context: {
            cwd: context.cwd,
            permissionMode: context.permissionMode,
          },
        };
        const result = await host.request('invoke_tool', params);
        return result as ToolResult;
      },
      // V1: validateInput not exposed on proxy — validation happens in child during execute()
    };
  }

  /**
   * Create a proxy HookHandler that forwards invocations to the child via IPC.
   */
  private createProxyHook(reg: RegisterHookParams): HookHandler {
    const host = this;
    const handler = async (payload: unknown): Promise<unknown> => {
      return host.request('invoke_hook', {
        hookType: reg.hookType,
        payload,
      } as InvokeHookParams);
    };
    return {
      type: reg.hookType as HookType,
      pluginName: this.pluginName,
      priority: reg.priority,
      handler: handler as HookHandler['handler'],
    };
  }

  /**
   * Create a proxy Command that forwards execute() calls to the child via IPC.
   */
  private createProxyCommand(reg: RegisterCommandParams): Command {
    const host = this;
    return {
      name: reg.name,
      aliases: reg.aliases,
      description: reg.description,
      usage: reg.usage,
      async execute(args: string, ctx: CommandContext): Promise<CommandResult> {
        // Reset runAgent budget for this invocation
        host.agentCallsRemaining = host.maxAgentTurns;
        // Set active callback context for bidirectional RPC
        host.activeCallbackCtx = {
          info: ctx.info,
          error: ctx.error,
          query: ctx.query,
        };

        try {
          const params: InvokeCommandParams = {
            commandName: reg.name,
            args,
            context: {
              cwd: ctx.cwd,
              messages: ctx.messages,
              hasQuery: typeof ctx.query === 'function',
            },
          };
          const result = await host.request('invoke_command', params);
          return result as CommandResult;
        } finally {
          host.activeCallbackCtx = null;
        }
      },
    };
  }

  /**
   * Create a proxy Skill that forwards execute() calls to the child via IPC.
   * Reconstructs RegExp triggers from serialized pattern+flags.
   */
  private createProxySkill(reg: RegisterSkillParams): Skill {
    const host = this;

    // Reconstruct triggers — deserialize RegExp from pattern/flags
    const triggers: SkillTrigger[] = reg.triggers.map((t: SerializedSkillTrigger): SkillTrigger => {
      if (t.type === 'pattern') {
        // ReDoS guard: validate pattern safety before compilation
        const validation = validateRegexSafety(t.pattern, 200);
        if (!validation.safe) {
          // Unsafe pattern — fall back to literal string match
          const escaped = t.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          return { type: 'pattern', regex: new RegExp(escaped, t.flags) };
        }
        return { type: 'pattern', regex: new RegExp(t.pattern, t.flags) };
      }
      return t as SkillTrigger;
    });

    return {
      name: reg.name,
      description: reg.description,
      category: reg.category as SkillCategory,
      triggers,
      requiredTools: reg.requiredTools,
      background: reg.background,
      async execute(ctx: SkillContext): Promise<SkillResult> {
        // Reset runAgent budget for this invocation
        host.agentCallsRemaining = host.maxAgentTurns;
        // Set active callback context for bidirectional RPC
        host.activeCallbackCtx = {
          info: ctx.info,
          error: ctx.error,
          query: ctx.query,
          runAgent: ctx.runAgent,
          toolInvoke: async (toolName: string, call: ToolCall): Promise<ToolResult> => {
            // Route tool execution through the host's normal pipeline
            const tool = ctx.tools.get(toolName);
            if (!tool) {
              return { tool_use_id: call.id, content: `Unknown tool: ${toolName}`, is_error: true };
            }
            return tool.execute(call, ctx.toolContext);
          },
        };

        try {
          const params: InvokeSkillParams = {
            skillName: reg.name,
            input: ctx.input,
            args: ctx.args,
            context: {
              cwd: ctx.cwd,
              messages: ctx.messages,
              permissionMode: ctx.toolContext.permissionMode,
              availableToolNames: Array.from(ctx.tools.keys()),
              hasQuery: typeof ctx.query === 'function',
              hasRunAgent: typeof ctx.runAgent === 'function',
            },
          };
          const result = await host.request('invoke_skill', params);
          return result as SkillResult;
        } finally {
          host.activeCallbackCtx = null;
        }
      },
    };
  }

  // ─── Child Entry Resolution ───────────────────────────

  private resolveChildEntry(): string {
    if (this.options.childEntryPath) return this.options.childEntryPath;

    // Try to find dist/plugin-child.mjs relative to the main process entry
    // This works in both production (bundled) and dev (tsx) scenarios
    const candidates = [
      // From main entry's directory
      join(dirname(process.argv[1] ?? ''), '..', 'dist', 'plugin-child.mjs'),
      join(dirname(process.argv[1] ?? ''), 'plugin-child.mjs'),
      // From cwd (fallback)
      join(process.cwd(), 'dist', 'plugin-child.mjs'),
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }

    // Dev fallback: child-entry.ts in src/plugins/ (requires tsx)
    // Resolve relative to this source file's location
    const srcPath = join(process.cwd(), 'src', 'plugins', 'child-entry.ts');
    if (existsSync(srcPath)) return srcPath;

    throw new Error('Cannot find plugin-child.mjs or child-entry.ts');
  }
}
