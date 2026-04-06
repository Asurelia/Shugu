/**
 * Layer 8 — Agents: Orchestrator
 *
 * Spawns and manages sub-agents. A sub-agent is simply another runLoop()
 * with its own conversation, budget, and restricted tool set.
 *
 * No separate process, no React, no IPC — just nested agentic loops.
 * MiniMax M2.7 has native Agent Teams capabilities (stable role identity,
 * adversarial reasoning) that we leverage via role prompts.
 *
 * Reference: OpenClaude src/tools/AgentTool/runAgent.ts
 */

import { runLoop, type LoopConfig, type LoopEvent } from '../engine/loop.js';
import { MiniMaxClient } from '../transport/client.js';
import { InterruptController } from '../engine/interrupts.js';
import type { Message, AssistantMessage } from '../protocol/messages.js';
import type { Tool, ToolContext } from '../protocol/tools.js';
import { isTextBlock } from '../protocol/messages.js';

// ─── Agent Definition ───────────────────────────────────

export interface AgentDefinition {
  /** Unique name for this agent type */
  name: string;
  /** Role description injected as system prompt */
  rolePrompt: string;
  /** Which tools this agent can use (null = all available) */
  allowedTools?: string[];
  /** Max turns before the agent must stop */
  maxTurns: number;
  /** Max budget in USD for this agent */
  maxBudgetUsd?: number;
}

// ─── Built-in Agent Types ───────────────────────────────

export const BUILTIN_AGENTS: Record<string, AgentDefinition> = {
  'general': {
    name: 'general',
    rolePrompt: `You are a sub-agent executing a specific task. Complete the task thoroughly, then report your findings concisely. You have access to all tools. Focus on the task — do not ask clarifying questions, make your best judgment.`,
    maxTurns: 15,
  },
  'explore': {
    name: 'explore',
    rolePrompt: `You are a code exploration agent. Your job is to search, read, and understand code. Do NOT modify any files. Use Glob to find files, Grep to search content, and Read to examine code. Report your findings as a structured summary.`,
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
    maxTurns: 10,
  },
  'code': {
    name: 'code',
    rolePrompt: `You are a coding agent. Execute the requested code changes precisely. Read files before modifying them. Use Edit for modifications, Write for new files. Test your changes when possible. Report what you changed.`,
    maxTurns: 20,
  },
  'review': {
    name: 'review',
    rolePrompt: `You are a code review agent. Analyze code changes for bugs, security issues, and quality problems. Do NOT modify files — only read and analyze. Provide specific, actionable feedback with file paths and line references.`,
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
    maxTurns: 10,
  },
  'test': {
    name: 'test',
    rolePrompt: `You are a testing agent. Write and run tests for the specified code. Use Bash to execute test commands. Report pass/fail status and any issues found.`,
    maxTurns: 15,
  },
};

// ─── Agent Result ───────────────────────────────────────

export interface AgentResult {
  /** The final text response from the agent */
  response: string;
  /** All events emitted during the agent's execution */
  events: LoopEvent[];
  /** Whether the agent completed successfully */
  success: boolean;
  /** Reason for termination */
  endReason: string;
  /** Total cost of this agent's execution */
  costUsd: number;
  /** Number of turns the agent took */
  turns: number;
}

// ─── Orchestrator ───────────────────────────────────────

export class AgentOrchestrator {
  private client: MiniMaxClient;
  private availableTools: Map<string, Tool>;
  private parentToolContext: ToolContext;
  private activeAgents = new Map<string, InterruptController>();
  private agentCounter = 0;

  constructor(
    client: MiniMaxClient,
    tools: Map<string, Tool>,
    toolContext: ToolContext,
  ) {
    this.client = client;
    this.availableTools = tools;
    this.parentToolContext = toolContext;
  }

  /**
   * Spawn a sub-agent to execute a task.
   */
  async spawn(
    task: string,
    agentType: string = 'general',
    options: SpawnOptions = {},
  ): Promise<AgentResult> {
    const definition = BUILTIN_AGENTS[agentType] ?? BUILTIN_AGENTS['general']!;
    const agentId = `agent-${++this.agentCounter}`;
    const interrupt = new InterruptController();
    this.activeAgents.set(agentId, interrupt);

    try {
      // Build restricted tool set
      const agentTools = this.buildToolSet(definition, options.allowedTools);
      const agentToolDefs = Array.from(agentTools.values()).map((t) => t.definition);

      // Build system prompt with role
      const systemPrompt = this.buildAgentPrompt(definition, options.context);

      // Create tool context for sub-agent (same cwd, fresh abort)
      const agentToolContext: ToolContext = {
        cwd: options.cwd ?? this.parentToolContext.cwd,
        abortSignal: interrupt.signal,
        permissionMode: this.parentToolContext.permissionMode,
        askPermission: this.parentToolContext.askPermission,
      };

      // Initial message is the task
      const messages: Message[] = [
        { role: 'user', content: task },
      ];

      // Run the sub-agent loop
      const config: LoopConfig = {
        client: this.client,
        systemPrompt,
        tools: agentTools,
        toolDefinitions: agentToolDefs,
        toolContext: agentToolContext,
        maxTurns: options.maxTurns ?? definition.maxTurns,
        maxBudgetUsd: options.maxBudgetUsd ?? definition.maxBudgetUsd,
      };

      const events: LoopEvent[] = [];
      let lastAssistantMessage: AssistantMessage | null = null;
      let endReason = 'unknown';
      let costUsd = 0;
      let turns = 0;

      for await (const event of runLoop(messages, config, interrupt)) {
        events.push(event);

        if (event.type === 'assistant_message') {
          lastAssistantMessage = event.message;
        }
        if (event.type === 'turn_end') {
          turns++;
        }
        if (event.type === 'loop_end') {
          endReason = event.reason;
          costUsd = event.totalCost;
        }

        // Forward progress to parent if callback provided
        options.onEvent?.(event);
      }

      // Extract text response
      const response = lastAssistantMessage
        ? lastAssistantMessage.content
            .filter(isTextBlock)
            .map((b) => b.text)
            .join('')
        : '[Agent produced no text response]';

      return {
        response,
        events,
        success: endReason === 'end_turn',
        endReason,
        costUsd,
        turns,
      };
    } finally {
      this.activeAgents.delete(agentId);
    }
  }

  /**
   * Abort all active agents.
   */
  abortAll(): void {
    for (const [id, interrupt] of this.activeAgents) {
      interrupt.abort('Parent aborted');
    }
    this.activeAgents.clear();
  }

  get activeCount(): number {
    return this.activeAgents.size;
  }

  // ─── Private ────────────────────────────────────────

  private buildToolSet(
    definition: AgentDefinition,
    overrideAllowed?: string[],
  ): Map<string, Tool> {
    const allowed = overrideAllowed ?? definition.allowedTools;

    if (!allowed) {
      // All tools except Agent (prevent recursive spawning by default)
      const tools = new Map(this.availableTools);
      tools.delete('Agent');
      return tools;
    }

    const tools = new Map<string, Tool>();
    for (const name of allowed) {
      const tool = this.availableTools.get(name);
      if (tool) tools.set(name, tool);
    }
    return tools;
  }

  private buildAgentPrompt(definition: AgentDefinition, additionalContext?: string): string {
    const parts: string[] = [
      // Shared base prompt for all agents
      `You are a Shugu sub-agent. Complete your task thoroughly, then stop.`,
      ``,
      `# Guidelines`,
      `- Be concise and focused on your specific role`,
      `- Read files before modifying them`,
      `- Report findings as structured statements`,
      `- If you hit an obstacle, explain what you tried and what failed`,
      `- Do not ask clarifying questions — make your best judgment`,
      ``,
      `# Your Role`,
      definition.rolePrompt,
      ``,
      `# Environment`,
      `Working directory: ${this.parentToolContext.cwd}`,
      `Platform: ${process.platform}`,
      `Max turns: ${definition.maxTurns}`,
    ];

    if (additionalContext) {
      parts.push(``, `# Context from parent`, additionalContext);
    }

    return parts.join('\n');
  }
}

// ─── Spawn Options ──────────────────────────────────────

export interface SpawnOptions {
  /** Override allowed tools for this agent */
  allowedTools?: string[];
  /** Additional context to inject into the agent's system prompt */
  context?: string;
  /** Override working directory */
  cwd?: string;
  /** Override max turns */
  maxTurns?: number;
  /** Override max budget */
  maxBudgetUsd?: number;
  /** Callback for each event from the sub-agent */
  onEvent?: (event: LoopEvent) => void;
}
