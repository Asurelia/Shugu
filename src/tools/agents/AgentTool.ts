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

export const AgentToolDefinition: ToolDefinition = {
  name: 'Agent',
  description: `Launch a sub-agent to handle a complex task autonomously. The sub-agent gets its own conversation and can use tools independently. Use for: research tasks, code exploration, parallel work, isolated modifications.

Available agent types:
- "general": General-purpose agent with all tools (default)
- "explore": Read-only code exploration (Glob, Grep, Read, Bash)
- "code": Code writing agent (all tools, focused on changes)
- "review": Code review agent (read-only, analysis focused)
- "test": Testing agent (write tests, run them)

The sub-agent's result is returned as text. It cannot see your conversation — provide complete context in the prompt.`,
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'Complete task description for the sub-agent. Include all necessary context.',
      },
      subagent_type: {
        type: 'string',
        description: 'Agent type: "general", "explore", "code", "review", "test". Default: "general".',
      },
      context: {
        type: 'string',
        description: 'Optional additional context (e.g., file contents, previous findings).',
      },
    },
    required: ['prompt'],
  },
  concurrencySafe: true, // Multiple agents can run in parallel
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

  setOrchestrator(orchestrator: AgentOrchestrator): void {
    this.orchestrator = orchestrator;
  }

  setEventCallback(callback: (event: AgentEvent) => void): void {
    this.onAgentEvent = callback;
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

    const options: SpawnOptions = {
      context: additionalContext,
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
      let result = await this.orchestrator.spawn(prompt, agentType, options);

      // Self-repair: retry once if agent failed or produced no response
      if (!result.success || !result.response) {
        const errorInfo = result.response || result.endReason;
        this.onAgentEvent?.({ agentType, event: 'error', message: `Retrying: ${errorInfo}` });
        const retryPrompt = `Previous attempt failed: ${errorInfo}\nTry a different approach.\n\nOriginal task: ${prompt}`;
        result = await this.orchestrator.spawn(retryPrompt, agentType, options);
      }

      this.onAgentEvent?.({ agentType, event: 'done', turns: result.turns, cost: result.costUsd });

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
