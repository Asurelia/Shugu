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

export class AgentTool implements Tool {
  definition = AgentToolDefinition;
  private orchestrator: AgentOrchestrator | null = null;
  private onAgentEvent?: (agentType: string, event: string) => void;

  /**
   * Set the orchestrator. Called during CLI initialization.
   * This late-binding keeps the tool layer decoupled from the agent layer.
   */
  setOrchestrator(orchestrator: AgentOrchestrator): void {
    this.orchestrator = orchestrator;
  }

  /**
   * Set a callback for agent progress events.
   */
  setEventCallback(callback: (agentType: string, event: string) => void): void {
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
        // Forward notable events to the parent
        if (event.type === 'tool_executing') {
          this.onAgentEvent?.(agentType, `Using ${event.call.name}...`);
        }
      },
    };

    try {
      this.onAgentEvent?.(agentType, 'Starting...');
      const result = await this.orchestrator.spawn(prompt, agentType, options);
      this.onAgentEvent?.(agentType, `Done (${result.turns} turns, $${result.costUsd.toFixed(4)})`);

      // Format the response
      const header = `[Agent "${agentType}" — ${result.turns} turns, $${result.costUsd.toFixed(4)}, ${result.endReason}]`;
      const body = result.response || '[No response produced]';

      return {
        tool_use_id: call.id,
        content: `${header}\n\n${body}`,
        is_error: !result.success,
      };
    } catch (error) {
      return {
        tool_use_id: call.id,
        content: `Agent execution failed: ${error instanceof Error ? error.message : String(error)}`,
        is_error: true,
      };
    }
  }
}
