/**
 * Layer 10 — Remote: Session gateway
 *
 * Share a PCC session over WebSocket.
 * Another terminal can connect and watch/interact with the session.
 *
 * Protocol (our own, not Anthropic's bridge):
 * - Server: PCC instance running with --share flag
 * - Client: connects via ws://host:port or wss://domain via Cloudflare
 * - Messages: JSON-RPC style { type, payload }
 *
 * The gateway runs on the VPS or locally.
 * With Cloudflare tunnel, it's accessible from anywhere.
 */

import { createServer, type Server } from 'node:http';
import type { LoopEvent } from '../engine/loop.js';

// ─── Gateway Protocol ───────────────────────────────────

export type GatewayMessage =
  | { type: 'event'; payload: LoopEvent }
  | { type: 'input'; payload: { text: string } }
  | { type: 'command'; payload: { command: string; args: string } }
  | { type: 'status'; payload: SessionStatus }
  | { type: 'ping' }
  | { type: 'pong' };

export interface SessionStatus {
  sessionId: string;
  model: string;
  turnCount: number;
  connected: number;
  uptime: number;
}

// ─── Gateway Server ─────────────────────────────────────

export interface GatewayConfig {
  port: number;
  host: string;
  /** Optional: password to connect */
  password?: string;
}

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  port: 9377, // PCC on phone keypad
  host: '0.0.0.0',
};

/**
 * Session gateway server.
 *
 * Usage:
 *   const gw = new SessionGateway(config);
 *   await gw.start();
 *   gw.broadcast({ type: 'event', payload: event }); // send to all clients
 *   gw.onInput((text) => { ... }); // receive input from remote clients
 */
export class SessionGateway {
  private config: GatewayConfig;
  private server: Server | null = null;
  private clients = new Set<WebSocketLike>();
  private inputCallbacks: Array<(text: string) => void> = [];
  private commandCallbacks: Array<(cmd: string, args: string) => void> = [];
  private startTime = Date.now();
  private sessionId = '';

  constructor(config: Partial<GatewayConfig> = {}) {
    this.config = { ...DEFAULT_GATEWAY_CONFIG, ...config };
  }

  /**
   * Start the gateway server.
   */
  async start(sessionId: string): Promise<string> {
    this.sessionId = sessionId;

    // Dynamic import of ws (optional dependency)
    let WebSocketServer: any;
    try {
      // @ts-expect-error — ws is an optional runtime dependency
      const ws = await import('ws');
      WebSocketServer = ws.WebSocketServer ?? ws.default?.WebSocketServer;
    } catch {
      throw new Error(
        'WebSocket server requires the "ws" package. Install it: npm install ws',
      );
    }

    return new Promise((resolve, reject) => {
      this.server = createServer();
      const wss = new WebSocketServer({ server: this.server });

      wss.on('connection', (socket: WebSocketLike, req: { url?: string; headers: Record<string, string | string[] | undefined> }) => {
        // Auth check
        if (this.config.password) {
          const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
          const token = url.searchParams.get('token');
          if (token !== this.config.password) {
            socket.close(4001, 'Unauthorized');
            return;
          }
        }

        this.clients.add(socket);

        // Send current status on connect
        this.sendTo(socket, {
          type: 'status',
          payload: this.getStatus(),
        });

        socket.on('message', (data: Buffer | string) => {
          try {
            const msg = JSON.parse(data.toString()) as GatewayMessage;
            this.handleMessage(msg);
          } catch {
            // Ignore malformed messages
          }
        });

        socket.on('close', () => {
          this.clients.delete(socket);
        });
      });

      this.server.listen(this.config.port, this.config.host, () => {
        const addr = `ws://${this.config.host}:${this.config.port}`;
        resolve(addr);
      });

      this.server.on('error', reject);
    });
  }

  /**
   * Broadcast an event to all connected clients.
   */
  broadcast(message: GatewayMessage): void {
    const data = JSON.stringify(message);
    for (const client of this.clients) {
      try {
        client.send(data);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  /**
   * Register callback for text input from remote clients.
   */
  onInput(callback: (text: string) => void): void {
    this.inputCallbacks.push(callback);
  }

  /**
   * Register callback for commands from remote clients.
   */
  onCommand(callback: (cmd: string, args: string) => void): void {
    this.commandCallbacks.push(callback);
  }

  /**
   * Stop the gateway.
   */
  stop(): void {
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
    this.server?.close();
    this.server = null;
  }

  get isRunning(): boolean {
    return this.server !== null;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  // ─── Private ────────────────────────────────────────

  private handleMessage(msg: GatewayMessage): void {
    switch (msg.type) {
      case 'input':
        for (const cb of this.inputCallbacks) {
          cb(msg.payload.text);
        }
        break;
      case 'command':
        for (const cb of this.commandCallbacks) {
          cb(msg.payload.command, msg.payload.args);
        }
        break;
      case 'ping':
        this.broadcast({ type: 'pong' });
        break;
    }
  }

  private sendTo(client: WebSocketLike, message: GatewayMessage): void {
    try {
      client.send(JSON.stringify(message));
    } catch {
      this.clients.delete(client);
    }
  }

  private getStatus(): SessionStatus {
    return {
      sessionId: this.sessionId,
      model: 'MiniMax-M2.7-highspeed',
      turnCount: 0,
      connected: this.clients.size,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
    };
  }
}

// ─── WebSocket-like interface ───────────────────────────

interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: string, handler: (...args: never[]) => void): void;
}
