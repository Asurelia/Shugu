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
import { createWorktree, removeWorktree, worktreeHasChanges, type Worktree, type WorktreeCleanupResult } from './worktree.js';
import { resolveGitRoot, relativeToCwd } from '../utils/git.js';
import { join } from 'node:path';

// ─── Agent Limits ──────────────────────────────────────

/** Maximum recursion depth for nested agent spawning */
export const MAX_AGENT_DEPTH = 3;

/** Maximum concurrent active agents across all depths */
export const MAX_ACTIVE_AGENTS = 15;

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
  /** If isolation='worktree' was used and changes were made, the worktree metadata */
  worktree?: import('./worktree.js').Worktree;
  /** Warnings from worktree cleanup (e.g., branch deletion failed) */
  cleanupWarnings?: string[];
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
    const depth = options.depth ?? 0;

    // Fan-out guard: prevent runaway agent proliferation
    if (this.activeAgents.size >= MAX_ACTIVE_AGENTS) {
      return {
        response: `Agent spawn rejected: ${this.activeAgents.size} agents already active (max ${MAX_ACTIVE_AGENTS}). Wait for existing agents to complete.`,
        events: [],
        success: false,
        endReason: 'fan_out_limit',
        costUsd: 0,
        turns: 0,
      };
    }

    const definition = BUILTIN_AGENTS[agentType] ?? BUILTIN_AGENTS['general']!;
    const agentId = `agent-${++this.agentCounter}`;
    const interrupt = new InterruptController();
    this.activeAgents.set(agentId, interrupt);

    let worktree: Worktree | null = null;
    let effectiveCwd = options.cwd ?? this.parentToolContext.cwd;
    let cleanupWarnings: string[] = [];

    try {
      // Worktree isolation: create a git worktree for this agent
      if (options.isolation === 'worktree') {
        const gitRoot = await resolveGitRoot(this.parentToolContext.cwd);
        const relCwd = relativeToCwd(gitRoot, effectiveCwd);
        worktree = await createWorktree(gitRoot);
        effectiveCwd = relCwd ? join(worktree.path, relCwd) : worktree.path;
      }

      // Build restricted tool set (depth-aware: keeps Agent tool if depth < MAX)
      const agentTools = this.buildToolSet(definition, options.allowedTools, depth);
      const agentToolDefs = Array.from(agentTools.values()).map((t) => t.definition);

      // Build system prompt with role
      const systemPrompt = this.buildAgentPrompt(definition, options.context, depth, effectiveCwd);

      // Create tool context for sub-agent (worktree-aware cwd, fresh abort)
      const agentToolContext: ToolContext = {
        cwd: effectiveCwd,
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

      // Worktree cleanup: only auto-remove if no changes remain
      let resultWorktree: Worktree | undefined;
      if (worktree) {
        const hasChanges = await worktreeHasChanges(worktree);
        if (!hasChanges) {
          const gitRoot = await resolveGitRoot(this.parentToolContext.cwd);
          const cleanup: WorktreeCleanupResult = await removeWorktree(gitRoot, worktree);
          cleanupWarnings = cleanup.warnings;
        } else {
          // Keep worktree in result so caller can merge/inspect
          resultWorktree = worktree;
        }
        worktree = null; // Handled — don't re-run in finally
      }

      return {
        response,
        events,
        success: endReason === 'end_turn',
        endReason,
        costUsd,
        turns,
        worktree: resultWorktree,
        cleanupWarnings: cleanupWarnings.length > 0 ? cleanupWarnings : undefined,
      };
    } finally {
      this.activeAgents.delete(agentId);
      // If worktree was not cleaned up in the try block (e.g. exception path), attempt cleanup
      if (worktree) {
        try {
          const gitRoot = await resolveGitRoot(this.parentToolContext.cwd);
          const cleanup = await removeWorktree(gitRoot, worktree);
          cleanupWarnings.push(...cleanup.warnings);
        } catch {
          // Best effort in finally — don't mask the original error
        }
      }
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
    depth: number = 0,
  ): Map<string, Tool> {
    const allowed = overrideAllowed ?? definition.allowedTools;

    let tools: Map<string, Tool>;
    if (!allowed) {
      tools = new Map(this.availableTools);
    } else {
      tools = new Map<string, Tool>();
      for (const name of allowed) {
        const tool = this.availableTools.get(name);
        if (tool) tools.set(name, tool);
      }
    }

    // Depth-aware Agent tool handling:
    // - At max depth: remove Agent tool entirely (prevent further nesting)
    // - Below max depth: keep Agent tool but mark depth for propagation
    if (depth >= MAX_AGENT_DEPTH) {
      tools.delete('Agent');
    } else if (tools.has('Agent')) {
      // Clone the parent AgentTool with incremented depth
      // We use the createChildAgentTool factory which avoids circular imports
      const parentAgent = tools.get('Agent')! as import('../tools/agents/AgentTool.js').AgentTool;
      const childAgent = parentAgent.createChild(depth + 1, this);
      tools.set('Agent', childAgent);
    }

    return tools;
  }

  private buildAgentPrompt(definition: AgentDefinition, additionalContext?: string, depth: number = 0, effectiveCwd?: string): string {
    const cwd = effectiveCwd ?? this.parentToolContext.cwd;
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
      `Working directory: ${cwd}`,
      `Platform: ${process.platform}`,
      `Max turns: ${definition.maxTurns}`,
      `Agent depth: ${depth}/${MAX_AGENT_DEPTH}`,
      `Active agents: ${this.activeAgents.size}/${MAX_ACTIVE_AGENTS}`,
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
  /** Current recursion depth (0 = top-level). Orchestrator increments on spawn. */
  depth?: number;
  /** Isolation mode. 'worktree' creates a git worktree for the agent. */
  isolation?: 'worktree';
}
