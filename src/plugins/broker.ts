/**
 * Capability broker for brokered plugin isolation.
 *
 * Gates plugin access to fs, network, and other system capabilities.
 * Each request is validated against the plugin's allowed capabilities
 * and workspace boundaries before execution.
 */

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { realpath } from 'node:fs/promises';
import { isBlockedUrl } from '../utils/network.js';
import { logger } from '../utils/logger.js';

// ─── Capability Names ─────────────────────────────────

export type CapabilityName = 'fs.read' | 'fs.write' | 'fs.list' | 'http.fetch';

// ─── Capability Request ───────────────────────────────

export interface CapabilityRequest {
  capability: string;
  operation: string;
  args: unknown;
}

// ─── Broker ───────────────────────────────────────────

export class CapabilityBroker {
  private allowed: Set<string>;
  private pathMappings: Array<{ from: string; to: string }> = [];

  constructor(
    allowedCapabilities: CapabilityName[],
    private pluginDir: string,
    private projectDir: string,
  ) {
    this.allowed = new Set(allowedCapabilities);
  }

  /**
   * Add path mappings for Docker sandbox mode.
   * Maps container paths (e.g., /plugin) to host paths (e.g., C:\Users\...\my-plugin).
   */
  setPathMappings(mappings: Array<{ from: string; to: string }>): void {
    this.pathMappings = mappings;
  }

  /**
   * Translate a path from container space to host space using path mappings.
   */
  private translatePath(containerPath: string): string {
    for (const mapping of this.pathMappings) {
      if (containerPath.startsWith(mapping.from)) {
        return containerPath.replace(mapping.from, mapping.to);
      }
    }
    return containerPath;
  }

  /**
   * Handle a capability request. Returns the result or throws on denial/error.
   */
  async handle(req: CapabilityRequest): Promise<unknown> {
    if (!this.allowed.has(req.capability)) {
      throw new Error(`Capability denied: ${req.capability} (not in plugin's allowed list)`);
    }

    switch (req.capability) {
      case 'fs.read':
        return this.handleFsRead(req.args as { path: string });
      case 'fs.write':
        return this.handleFsWrite(req.args as { path: string; content: string });
      case 'fs.list':
        return this.handleFsList(req.args as { path: string });
      case 'http.fetch':
        return this.handleHttpFetch(req.args as { url: string; method?: string; headers?: Record<string, string>; body?: string });
      default:
        throw new Error(`Unknown capability: ${req.capability}`);
    }
  }

  // ─── FS Capabilities ──────────────────────────────────

  private async validatePath(filePath: string): Promise<string> {
    // Translate Docker container paths to host paths before validation
    const translated = this.translatePath(filePath);
    const resolved = isAbsolute(translated) ? translated : resolve(this.pluginDir, translated);

    // Resolve symlinks to prevent traversal
    let real: string;
    try {
      real = await realpath(resolved);
    } catch {
      // File may not exist yet (for writes) — use the resolved path
      real = resolved;
    }

    // Must be inside pluginDir/.data/ or projectDir
    const pluginDataDir = resolve(this.pluginDir, '.data');
    const relToPluginData = relative(pluginDataDir, real);
    const relToProject = relative(this.projectDir, real);

    const insidePluginData = !relToPluginData.startsWith('..') && !isAbsolute(relToPluginData);
    const insideProject = !relToProject.startsWith('..') && !isAbsolute(relToProject);

    if (!insidePluginData && !insideProject) {
      throw new Error(`Path denied: ${filePath} is outside workspace and plugin data directory`);
    }

    return real;
  }

  private async handleFsRead(args: { path: string }): Promise<{ content: string }> {
    const safePath = await this.validatePath(args.path);
    const content = await readFile(safePath, 'utf-8');
    return { content };
  }

  private async handleFsWrite(args: { path: string; content: string }): Promise<{ written: boolean }> {
    const safePath = await this.validatePath(args.path);
    // Ensure parent directory exists
    const { dirname } = await import('node:path');
    await mkdir(dirname(safePath), { recursive: true });
    await writeFile(safePath, args.content, { encoding: 'utf-8', mode: 0o600 });
    return { written: true };
  }

  private async handleFsList(args: { path: string }): Promise<{ entries: string[] }> {
    const safePath = await this.validatePath(args.path);
    const entries = await readdir(safePath);
    return { entries };
  }

  // ─── Network Capability ───────────────────────────────

  private async handleHttpFetch(args: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    // SSRF protection — shared with WebFetchTool
    const blocked = isBlockedUrl(args.url);
    if (blocked) {
      throw new Error(`SSRF blocked: ${blocked}`);
    }

    const response = await fetch(args.url, {
      method: args.method ?? 'GET',
      headers: args.headers,
      body: args.body,
    });

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    const body = await response.text();
    // Cap response size to prevent memory issues
    const cappedBody = body.length > 100_000 ? body.slice(0, 100_000) + '\n[truncated]' : body;

    return {
      status: response.status,
      headers: responseHeaders,
      body: cappedBody,
    };
  }
}
