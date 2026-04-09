import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { PermissionResolver } from '../src/policy/permissions.js';
import { WebFetchTool } from '../src/tools/web/WebFetchTool.js';
import type { ToolContext } from '../src/protocol/tools.js';
import { traceCommand } from '../src/commands/trace.js';
import { tracer } from '../src/utils/tracer.js';
import { MemoryAgent } from '../src/context/memory/agent.js';
import { CredentialProvider } from '../src/credentials/provider.js';
import { TriggerServer } from '../src/automation/triggers.js';
import { Scheduler } from '../src/automation/scheduler.js';
import { loadPlugin } from '../src/plugins/loader.js';
import { createReviewCommand } from '../src/commands/review.js';

function makeToolContext(): ToolContext {
  return {
    cwd: process.cwd(),
    abortSignal: new AbortController().signal,
    permissionMode: 'default',
    askPermission: async () => true,
  };
}

describe('security audit gaps', () => {
  afterEach(() => {
    tracer.reset();
    vi.restoreAllMocks();
  });

  it('does not auto-allow environment variable exfiltration in fullAuto mode', () => {
    const resolver = new PermissionResolver('fullAuto');

    const printenv = resolver.resolve({
      id: 'bash_env',
      name: 'Bash',
      input: { command: 'printenv MINIMAX_API_KEY' },
    });

    const nodeEnv = resolver.resolve({
      id: 'bash_node_env',
      name: 'Bash',
      input: { command: 'node -e "console.log(process.env.MINIMAX_API_KEY)"' },
    });

    expect(printenv.decision).not.toBe('allow');
    expect(nodeEnv.decision).not.toBe('allow');
  });

  it('blocks localhost SSRF through WebFetch', async () => {
    let server: Server | null = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ internal: true, secret: 'only-for-local-clients' }));
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const { port } = server.address() as AddressInfo;
    const tool = new WebFetchTool();

    try {
      const result = await tool.execute(
        {
          id: 'webfetch_localhost',
          name: 'WebFetch',
          input: { url: `http://127.0.0.1:${port}/internal` },
        },
        makeToolContext(),
      );

      expect(result.is_error).toBe(true);
      expect(String(result.content)).toMatch(/blocked|localhost|internal|private/i);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server?.close((err) => (err ? reject(err) : resolve()));
      });
      server = null;
    }
  });

  it('redacts secrets when /trace displays recent in-memory events', async () => {
    const secret = 'Authorization: Bearer verysecretvalue12345678901234567890';
    tracer.startTrace();
    await tracer.log('tool_call', { tool: 'WebFetch', input: secret });

    const infos: string[] = [];
    const ctx = {
      cwd: process.cwd(),
      messages: [],
      info: (msg: string) => infos.push(msg),
      error: vi.fn(),
      client: {} as never,
    };

    await traceCommand.execute('', ctx as never);

    const rendered = infos.join('\n');
    expect(rendered).toContain('[REDACTED]');
    expect(rendered).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{20,}/);
  });

  it('redacts secrets loaded from persisted memory before prompt injection', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'audit-project-'));

    try {
      const memoryDir = join(projectDir, '.pcc', 'memory');
      await mkdir(memoryDir, { recursive: true });
      await writeFile(
        join(memoryDir, 'prod-token.md'),
        `---
name: Production Token
description: Deployment credential note
type: reference
---

Authorization: Bearer supersecretvalue12345678901234567890
`,
        'utf-8',
      );

      const agent = new MemoryAgent(null, projectDir);
      await agent.loadIndex();

      const context = await agent.getRelevantContext('deployment token authorization', 5);

      expect(context).toContain('[REDACTED]');
      expect(context).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{20,}/);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('degrades cleanly when credential-aware code runs without an unlocked vault', () => {
    const provider = new CredentialProvider(null as unknown as never);

    expect(() => provider.getAuthHeaders('https://example.com')).not.toThrow();
    expect(provider.getAuthHeaders('https://example.com')).toEqual({});
  });

  it('rejects malformed JSON trigger requests instead of executing them with empty input', async () => {
    let portProbe: Server | null = createServer();
    portProbe.listen(0, '127.0.0.1');
    await once(portProbe, 'listening');
    const { port } = portProbe.address() as AddressInfo;
    await new Promise<void>((resolve, reject) => {
      portProbe?.close((err) => (err ? reject(err) : resolve()));
    });
    portProbe = null;

    const executor = vi.fn().mockResolvedValue('ok');
    const server = new TriggerServer(port);
    server.setExecutor(executor);

    const trigger = server.addTrigger({
      name: 'deploy',
      promptTemplate: 'deploy now',
      enabled: true,
    });

    await server.start();

    try {
      const response = await fetch(`http://127.0.0.1:${port}/trigger/${trigger.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not-valid-json',
      });

      await Promise.resolve();

      expect(response.status).toBe(400);
      expect(executor).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it('cancels scheduled jobs when their timeout elapses', async () => {
    const scheduler = new Scheduler();
    let sideEffectRan = false;

    scheduler.setExecutor(async (_job, signal?) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (signal?.aborted) return 'aborted';
      sideEffectRan = true;
      return 'completed too late';
    });

    const job = scheduler.addJob({
      name: 'slow-job',
      prompt: 'do work',
      schedule: { type: 'interval', ms: 60_000 },
      timeoutMs: 10,
      enabled: true,
    });

    await expect(scheduler.runNow(job.id)).rejects.toThrow(/timed out/i);
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(sideEffectRan).toBe(false);
  });

  it('does not let plugin code escape its declared permissions during load', async () => {
    const pluginDir = await mkdtemp(join(tmpdir(), 'audit-plugin-'));

    try {
      const markerPath = join(pluginDir, 'side-effect.txt');
      await writeFile(
        join(pluginDir, 'plugin.json'),
        JSON.stringify({
          name: 'audit-plugin',
          version: '1.0.0',
          description: 'test plugin',
          entry: 'index.mjs',
          permissions: [],
        }),
        'utf-8',
      );
      await writeFile(
        join(pluginDir, 'index.mjs'),
        `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(markerPath)}, 'plugin-side-effect', 'utf-8');
export default function init() {}`,
        'utf-8',
      );

      await loadPlugin(pluginDir, 'global');

      await expect(access(markerPath)).rejects.toThrow();
    } finally {
      await rm(pluginDir, { recursive: true, force: true });
    }
  });

  it('surfaces git access failures in /review instead of pretending there are no changes', async () => {
    const cmd = createReviewCommand({ spawn: vi.fn() } as never, process.cwd());
    const result = await cmd.execute('', {
      cwd: join(process.cwd(), 'definitely-not-a-git-repo', String(Date.now())),
      messages: [],
      info: vi.fn(),
      error: vi.fn(),
    });

    expect(result.type).toBe('error');
    if (result.type === 'error') {
      expect(result.message).toMatch(/git error|git repository|not a git repository/i);
      expect(result.message).not.toMatch(/no code changes found/i);
    }
  });
});
