/**
 * Layer 3 — Tools: REPLTool
 *
 * Execute JavaScript/TypeScript in a Node.js context.
 * Was ant-only in the original — now fully unlocked.
 *
 * Uses node -e for stateless execution (simple, reliable).
 */

import { spawn } from 'node:child_process';
import type { Tool, ToolCall, ToolResult, ToolContext, ToolDefinition } from '../../protocol/tools.js';

export const REPLToolDefinition: ToolDefinition = {
  name: 'REPL',
  description: `Execute JavaScript code in a Node.js REPL. Returns the output. Use for: quick calculations, data transformations, testing code snippets, JSON manipulation.`,
  inputSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'JavaScript code to execute. The last expression is printed.',
      },
    },
    required: ['code'],
  },
  concurrencySafe: true,
};

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 50_000;

export class REPLTool implements Tool {
  definition = REPLToolDefinition;

  validateInput(input: Record<string, unknown>): string | null {
    if (typeof input['code'] !== 'string' || !input['code']) {
      return 'code must be a non-empty string';
    }
    return null;
  }

  async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const code = call.input['code'] as string;

    // Wrap code to print the last expression
    const wrappedCode = `
try {
  const __result = (async () => { ${code} })();
  const __val = await __result;
  if (__val !== undefined) console.log(typeof __val === 'object' ? JSON.stringify(__val, null, 2) : __val);
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
`;

    try {
      const result = await runNode(wrappedCode, context.cwd, TIMEOUT_MS);
      return {
        tool_use_id: call.id,
        content: result.output || '(No output)',
        is_error: result.exitCode !== 0,
      };
    } catch (error) {
      return {
        tool_use_id: call.id,
        content: `REPL error: ${error instanceof Error ? error.message : String(error)}`,
        is_error: true,
      };
    }
  }
}

interface NodeResult {
  output: string;
  exitCode: number;
}

function runNode(code: string, cwd: string, timeoutMs: number): Promise<NodeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--input-type=module', '-e', code], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > MAX_OUTPUT) stdout = stdout.slice(0, MAX_OUTPUT);
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > MAX_OUTPUT) stderr = stderr.slice(0, MAX_OUTPUT);
    });

    child.on('error', reject);
    child.on('close', (code) => {
      const output = stdout.trim() + (stderr ? `\nstderr: ${stderr.trim()}` : '');
      resolve({ output, exitCode: code ?? 1 });
    });
  });
}
