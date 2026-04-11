/**
 * Layer 3 — Tools: AgentTool
 *
 * The tool the model calls to spawn sub-agents.
 * A sub-agent gets its own conversation loop, tool set, and budget.
 *
 * Usage by the model:
 *   Agent({ prompt: "Search for all TODO comments", subagent_type: "explore" })
 *
 * The orchestrator is injected at registration time (not imported directly)
 * to keep Layer 3 decoupled from Layer 8.
 */

import type { Tool, ToolCall, ToolResult, ToolContext, ToolDefinition } from '../../protocol/tools.js';
import type { AgentOrchestrator, SpawnOptions } from '../../agents/orchestrator.js';
import { isTextBlock } from '../../protocol/messages.js';
import { tracer } from '../../utils/tracer.js';

export const AgentToolDefinition: ToolDefinition = {
  name: 'Agent',
  description: `Launch a sub-agent to handle a complex task autonomously. Each agent gets its own conversation loop, tool set, and budget.

Available agent types:
- "general": General-purpose agent with all tools (default). Use for multi-step tasks.
- "explore": Fast read-only code exploration (Glob, Grep, Read, Bash). Use for codebase research.
- "code": Code writing agent (all tools, focused on changes). Use for implementation tasks.
- "review": Code review agent (read-only, adversarial). Use for finding bugs and quality issues.
- "test": Testing agent (write tests, run them). Use for test creation and validation.
- "verify": Verification agent (read-only + execution). Runs tests and produces PASS/FAIL verdict.

## When to use
Use this tool for research tasks, code exploration, parallel work, or isolated modifications. Launch multiple agents concurrently when tasks are independent — use a single message with multiple Agent tool calls.

## Writing the prompt
Brief the agent like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context that the agent can make judgment calls.
- If you need a short response, say so.

**Never delegate understanding.** Don't write "based on your findings, fix the bug." Write prompts that prove you understood: include file paths, line numbers, what specifically to change.

## Result
The sub-agent's result is returned as text. It cannot see your conversation — the prompt must be self-contained. Relay findings to the user since the agent result is not directly visible to them.`,
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'Complete task description for the sub-agent. Include all necessary context — it cannot see your conversation.',
      },
      subagent_type: {
        type: 'string',
        description: 'Agent type: "general", "explore", "code", "review", "test", "verify". Default: "general".',
      },
      context: {
        type: 'string',
        description: 'Optional additional context (e.g., file contents, previous findings).',
      },
      isolation: {
        type: 'string',
        description: 'Isolation mode. "worktree" creates a temporary git worktree so the agent works on an isolated copy of the repo.',
      },
    },
    required: ['prompt'],
  },
  concurrencySafe: true, // Multiple agents can run in parallel
  categories: ['agent'],
};

export interface AgentEvent {
  agentType: string;
  event: 'start' | 'tool' | 'thinking' | 'text' | 'done' | 'error';
  toolName?: string;
  toolDetail?: string;
  message?: string;
  turns?: number;
  cost?: number;
}

export class AgentTool implements Tool {
  definition = AgentToolDefinition;
  private orchestrator: AgentOrchestrator | null = null;
  private onAgentEvent?: (event: AgentEvent) => void;
  private depth = 0;

  setOrchestrator(orchestrator: AgentOrchestrator): void {
    this.orchestrator = orchestrator;
  }

  setEventCallback(callback: (event: AgentEvent) => void): void {
    this.onAgentEvent = callback;
  }

  setDepth(depth: number): void {
    this.depth = depth;
  }

  /**
   * Create a child AgentTool with incremented depth.
   * Used by the orchestrator to propagate depth through nested agent spawns.
   */
  createChild(childDepth: number, orchestrator: AgentOrchestrator): AgentTool {
    const child = new AgentTool();
    child.setOrchestrator(orchestrator);
    child.setDepth(childDepth);
    child.setEventCallback(() => {}); // Sub-agents don't bubble events to parent UI
    return child;
  }

  validateInput(input: Record<string, unknown>): string | null {
    if (typeof input['prompt'] !== 'string' || !input['prompt']) {
      return 'prompt must be a non-empty string describing the task';
    }
    return null;
  }

  async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    if (!this.orchestrator) {
      return {
        tool_use_id: call.id,
        content: 'Error: Agent system not initialized. AgentTool requires an orchestrator.',
        is_error: true,
      };
    }

    const prompt = call.input['prompt'] as string;
    const agentType = (call.input['subagent_type'] as string) ?? 'general';
    const additionalContext = call.input['context'] as string | undefined;
    const isolation = call.input['isolation'] as 'worktree' | undefined;

    const options: SpawnOptions = {
      context: additionalContext,
      depth: this.depth,
      isolation,
      onEvent: (event) => {
        if (event.type === 'tool_executing') {
          // Extract detail from tool input
          const input = event.call.input;
          let detail = '';
          switch (event.call.name) {
            case 'Bash': detail = ((input['command'] as string) ?? '').slice(0, 60); break;
            case 'Read': case 'Write': case 'Edit': {
              const fp = ((input['file_path'] as string) ?? '').replace(/\\/g, '/').split('/');
              detail = fp.length > 2 ? fp.slice(-2).join('/') : fp.join('/'); break;
            }
            case 'Glob': detail = (input['pattern'] as string) ?? ''; break;
            case 'Grep': detail = (input['pattern'] as string) ?? ''; break;
            case 'WebSearch': detail = (input['query'] as string) ?? ''; break;
            case 'WebFetch': { try { detail = new URL((input['url'] as string) ?? '').hostname; } catch { detail = ''; } break; }
          }
          this.onAgentEvent?.({ agentType, event: 'tool', toolName: event.call.name, toolDetail: detail });
        } else if (event.type === 'assistant_message') {
          // Extract first line of text for feedback
          const text = event.message.content
            .filter(isTextBlock)
            .map(b => b.text)
            .join('')
            .split('\n')[0]
            ?.slice(0, 80);
          if (text) {
            this.onAgentEvent?.({ agentType, event: 'text', message: text });
          }
        }
      },
    };

    try {
      this.onAgentEvent?.({ agentType, event: 'start', message: prompt.slice(0, 80) });
      const agentSpanId = tracer.startSpan();
      const agentStartMs = Date.now();
      tracer.log('agent_spawn', { agentType, depth: this.depth, prompt: prompt.slice(0, 150) }, agentSpanId);
      let result = await this.orchestrator.spawn(prompt, agentType, options);

      // Self-repair: retry once if agent failed or produced no response
      // Disabled near max depth to prevent exponential fan-out (depth 0 → retry → 2 agents at depth 1 → 4 at depth 2 → ...)
      const { MAX_AGENT_DEPTH } = await import('../../agents/orchestrator.js');
      if ((!result.success || !result.response) && this.depth < MAX_AGENT_DEPTH - 1) {
        // Sanitize error info: truncate, strip potential secrets/paths
        const rawError = result.response || result.endReason || 'unknown error';
        const errorInfo = rawError.slice(0, 200).replace(/[A-Za-z0-9_\-]{20,}/g, '[REDACTED]');
        this.onAgentEvent?.({ agentType, event: 'error', message: `Retrying: ${errorInfo}` });
        const retryPrompt = `Previous attempt failed: ${errorInfo}\nTry a different approach.\n\nOriginal task: ${prompt}`;
        result = await this.orchestrator.spawn(retryPrompt, agentType, options);
      }

      this.onAgentEvent?.({ agentType, event: 'done', turns: result.turns, cost: result.costUsd });
      tracer.logTimed('agent_done', { agentType, turns: result.turns, cost: result.costUsd, success: result.success, endReason: result.endReason }, agentStartMs, agentSpanId);

      const header = `[Agent "${agentType}" — ${result.turns} turns, $${result.costUsd.toFixed(4)}, ${result.endReason}]`;
      const body = result.response || '[No response produced]';

      return {
        tool_use_id: call.id,
        content: `${header}\n\n${body}`,
        is_error: !result.success,
      };
    } catch (error) {
      this.onAgentEvent?.({ agentType, event: 'error', message: error instanceof Error ? error.message : String(error) });
      return {
        tool_use_id: call.id,
        content: `Agent execution failed: ${error instanceof Error ? error.message : String(error)}`,
        is_error: true,
      };
    }
  }
}
