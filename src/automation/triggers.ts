/**
 * Layer 9 — Automation: Triggers
 *
 * Remote triggers allow external systems (webhooks, CI, scripts)
 * to kick off agent tasks. A lightweight HTTP server listens
 * for trigger requests and dispatches them as background sessions.
 *
 * This is NOT an MCP server — it's a simple REST API for automation.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';

// ─── Trigger Definition ────────────────────────────────

export interface TriggerDefinition {
  /** Unique trigger ID */
  id: string;
  /** Human-readable name */
  name: string;
  /** The prompt template to execute (supports {{variable}} interpolation) */
  promptTemplate: string;
  /** Required variables for the template */
  requiredVars?: string[];
  /** Optional: restrict to specific source IPs */
  allowedIPs?: string[];
  /** Optional: require a bearer token */
  authToken?: string;
  /** Whether this trigger is enabled */
  enabled: boolean;
  /** When this was created */
  createdAt: string;
  /** Number of times this trigger has fired */
  fireCount: number;
  /** Last fire time */
  lastFiredAt?: string;
}

// ─── Trigger Request ───────────────────────────────────

export interface TriggerRequest {
  triggerId: string;
  variables: Record<string, string>;
  source: string;
  timestamp: string;
}

// ─── Trigger Executor Callback ─────────────────────────

export type TriggerExecutor = (prompt: string, triggerName: string) => Promise<string>;

// ─── Trigger Server ────────────────────────────────────

export class TriggerServer extends EventEmitter {
  private server: Server | null = null;
  private triggers = new Map<string, TriggerDefinition>();
  private executor: TriggerExecutor | null = null;
  private port: number;
  private triggerCounter = 0;

  constructor(port: number = 7799) {
    super();
    this.port = port;
  }

  /**
   * Set the executor that runs trigger prompts.
   */
  setExecutor(executor: TriggerExecutor): void {
    this.executor = executor;
  }

  /**
   * Start listening for trigger requests.
   */
  async start(): Promise<void> {
    if (this.server) return;

    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        this.sendJson(res, 500, { error: 'Internal server error' });
      });
    });

    return new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, '127.0.0.1', () => {
        this.emit('listening', this.port);
        resolve();
      });
      this.server!.on('error', reject);
    });
  }

  /**
   * Stop the trigger server.
   */
  async stop(): Promise<void> {
    if (!this.server) return;

    return new Promise<void>((resolve) => {
      this.server!.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  /**
   * Register a new trigger.
   */
  addTrigger(config: Omit<TriggerDefinition, 'id' | 'createdAt' | 'fireCount'>): TriggerDefinition {
    const trigger: TriggerDefinition = {
      ...config,
      id: `trigger-${++this.triggerCounter}`,
      createdAt: new Date().toISOString(),
      fireCount: 0,
    };

    this.triggers.set(trigger.id, trigger);
    return trigger;
  }

  /**
   * Remove a trigger.
   */
  removeTrigger(id: string): boolean {
    return this.triggers.delete(id);
  }

  /**
   * List all triggers.
   */
  listTriggers(): TriggerDefinition[] {
    return Array.from(this.triggers.values());
  }

  /**
   * Get a specific trigger.
   */
  getTrigger(id: string): TriggerDefinition | undefined {
    return this.triggers.get(id);
  }

  /**
   * Whether the server is running.
   */
  get isListening(): boolean {
    return this.server?.listening ?? false;
  }

  // ─── Private ────────────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // CORS headers for webhook sources
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Routes
    if (req.method === 'GET' && url.pathname === '/health') {
      this.sendJson(res, 200, { status: 'ok', triggers: this.triggers.size });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/triggers') {
      this.sendJson(res, 200, {
        triggers: this.listTriggers().map((t) => ({
          id: t.id,
          name: t.name,
          enabled: t.enabled,
          fireCount: t.fireCount,
          lastFiredAt: t.lastFiredAt,
        })),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/trigger/')) {
      const triggerId = url.pathname.slice('/trigger/'.length);
      await this.handleTriggerFire(req, res, triggerId);
      return;
    }

    // Catch-all: fire by name (POST /fire with body { name, variables })
    if (req.method === 'POST' && url.pathname === '/fire') {
      const body = await this.readBody(req);
      const { name, variables } = body as { name?: string; variables?: Record<string, string> };
      if (!name) {
        this.sendJson(res, 400, { error: 'Missing "name" in body' });
        return;
      }

      const trigger = Array.from(this.triggers.values()).find((t) => t.name === name);
      if (!trigger) {
        this.sendJson(res, 404, { error: `Trigger "${name}" not found` });
        return;
      }

      await this.fireTrigger(trigger, variables ?? {}, req, res);
      return;
    }

    this.sendJson(res, 404, { error: 'Not found' });
  }

  private async handleTriggerFire(
    req: IncomingMessage,
    res: ServerResponse,
    triggerId: string,
  ): Promise<void> {
    const trigger = this.triggers.get(triggerId);
    if (!trigger) {
      this.sendJson(res, 404, { error: `Trigger "${triggerId}" not found` });
      return;
    }

    const body = await this.readBody(req);
    const variables = (body as { variables?: Record<string, string> }).variables ?? {};

    await this.fireTrigger(trigger, variables, req, res);
  }

  private async fireTrigger(
    trigger: TriggerDefinition,
    variables: Record<string, string>,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!trigger.enabled) {
      this.sendJson(res, 403, { error: 'Trigger is disabled' });
      return;
    }

    // Auth check
    if (trigger.authToken) {
      const auth = req.headers['authorization'];
      if (auth !== `Bearer ${trigger.authToken}`) {
        this.sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }
    }

    // IP check
    if (trigger.allowedIPs && trigger.allowedIPs.length > 0) {
      const sourceIP = req.socket.remoteAddress ?? '';
      if (!trigger.allowedIPs.includes(sourceIP)) {
        this.sendJson(res, 403, { error: 'IP not allowed' });
        return;
      }
    }

    // Validate required variables
    if (trigger.requiredVars) {
      const missing = trigger.requiredVars.filter((v) => !variables[v]);
      if (missing.length > 0) {
        this.sendJson(res, 400, { error: `Missing required variables: ${missing.join(', ')}` });
        return;
      }
    }

    if (!this.executor) {
      this.sendJson(res, 503, { error: 'No executor configured' });
      return;
    }

    // Interpolate the prompt template
    const prompt = this.interpolate(trigger.promptTemplate, variables);

    // Update trigger stats
    trigger.fireCount++;
    trigger.lastFiredAt = new Date().toISOString();

    const triggerReq: TriggerRequest = {
      triggerId: trigger.id,
      variables,
      source: req.socket.remoteAddress ?? 'unknown',
      timestamp: new Date().toISOString(),
    };

    this.emit('trigger:fire', trigger, triggerReq);

    // Execute asynchronously — respond immediately with accepted
    this.sendJson(res, 202, {
      status: 'accepted',
      triggerId: trigger.id,
      prompt,
    });

    // Fire and forget
    this.executor(prompt, trigger.name).then(
      (result) => {
        this.emit('trigger:complete', trigger, result);
      },
      (error) => {
        this.emit('trigger:error', trigger, error);
      },
    );
  }

  private interpolate(template: string, vars: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
      return vars[key] ?? `{{${key}}}`;
    });
  }

  private async readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch {
          resolve({});
        }
      });
      req.on('error', reject);
    });
  }

  private sendJson(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
}
