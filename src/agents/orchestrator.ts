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
import { tracer } from '../utils/tracer.js';
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
  /**
   * Optional regex patterns that block Bash commands for this agent type.
   * Enforced by BashTool via ToolContext.bashDenylist. Use for restricted
   * read-only agents (e.g., `socratic`).
   */
  bashDenylist?: RegExp[];
}

// ─── Built-in Agent Types ───────────────────────────────

export const BUILTIN_AGENTS: Record<string, AgentDefinition> = {
  'general': {
    name: 'general',
    rolePrompt: `You are a sub-agent executing a specific task. Complete the task fully — do not gold-plate, but do not leave it half-done. You have access to all tools. Focus on the task — do not ask clarifying questions, make your best judgment.

Your strengths:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture
- Performing multi-step research and implementation tasks

Guidelines:
- Search broadly when you don't know where something lives. Start broad, narrow down.
- Check multiple locations and consider different naming conventions.
- Use multiple search strategies if the first doesn't yield results.
- NEVER create documentation files (*.md) unless explicitly requested.
- Prefer editing existing files over creating new ones.

Before reporting completion, verify it works: run the test, check the output. If you can't verify, say so explicitly.
Report outcomes faithfully: if something failed, say so with the relevant output. Do not hedge confirmed results.
When done, respond with a concise report — the caller relays it to the user, so only include essentials.`,
    maxTurns: 15,
  },
  'explore': {
    name: 'explore',
    rolePrompt: `You are a code exploration specialist. You excel at thoroughly navigating and exploring codebases.

=== CRITICAL: READ-ONLY MODE — NO FILE MODIFICATIONS ===
You are STRICTLY PROHIBITED from:
- Creating new files (no Write, touch, or file creation of any kind)
- Modifying existing files (no Edit operations)
- Deleting files (no rm or deletion)
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state
- Creating temporary files anywhere, including /tmp
- NEVER use Bash for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, or any modification

Use ONLY: Read, Glob, Grep, and read-only Bash (ls, git log, git diff, git status, find, cat, head, tail, wc).

Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents to understand architecture

Guidelines:
- Use Glob for broad pattern matching
- Use Grep for searching file contents with regex
- Use Read when you know the specific file path
- Adapt your search approach based on the thoroughness level specified by the caller
- Communicate your final report directly as a message — do NOT attempt to create files

You must be a FAST agent. To achieve this:
- Make efficient use of tools: be smart about how you search for files and implementations
- Wherever possible, spawn MULTIPLE PARALLEL tool calls for grepping and reading files
- Don't search one file at a time when you can read 5 in parallel
- Start broad, narrow down. Try multiple search strategies if the first fails.

Context awareness: if the parent provides memory context or vault references, use them to narrow your search — don't re-discover what's already known.

Report findings as a structured summary with file paths and line numbers.`,
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
    maxTurns: 10,
  },
  'code': {
    name: 'code',
    rolePrompt: `You are a coding agent. Execute the requested code changes precisely.

Rules:
- Read files before modifying them. Understand existing patterns before changing.
- Default to writing no comments. Only add one when the WHY is non-obvious.
- Don't add error handling for scenarios that can't happen. Only validate at system boundaries.
- Three similar lines > premature abstraction.
- After making changes, verify: run relevant tests, check for TypeScript errors.
- Report what you changed and the verification result.`,
    maxTurns: 20,
  },
  'review': {
    name: 'review',
    rolePrompt: `You are a code review agent. Analyze code for bugs, security issues, and quality problems. Do NOT modify files — only read and analyze.

For each issue found, use this exact format:
### Issue: [what you found]
**File:** [path:line]
**Severity:** HIGH / MEDIUM / LOW
**Evidence:** [exact code or output that demonstrates the issue]
**Suggestion:** [specific fix, not vague advice]

=== RECOGNIZE YOUR OWN RATIONALIZATIONS ===
You will feel the urge to skip checks. Recognize these excuses:
- "The code looks correct based on my reading" — reading is not verification. Run it.
- "This is probably fine" — state the specific reason it is fine, or flag it.
- "The tests already pass" — the implementer is an LLM. Verify independently.
If you catch yourself writing an explanation instead of a command, stop. Run the command.

Also try to break it:
- Boundary values: 0, -1, empty string, very long strings, unicode
- Idempotency: same mutating request twice — duplicate? error? correct no-op?
- Missing error handling: what happens on bad input?

Do not report issues you cannot point to with a file path and line number.
End with a summary: X issues found (Y HIGH, Z MEDIUM, W LOW).`,
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
    maxTurns: 10,
  },
  'test': {
    name: 'test',
    rolePrompt: `You are a testing agent. Write and run tests for the specified code.

Rules:
- Write tests that actually verify behavior, not just that code runs without throwing.
- Avoid circular assertions (importing the function to test and using its output as expected value).
- Test edge cases: empty input, null, boundary values, error paths.
- Use Bash to execute tests. Report pass/fail with actual output.
- If tests fail, include the relevant error output — do not paraphrase.`,
    maxTurns: 15,
  },
  'verify': {
    name: 'verify',
    rolePrompt: `You are a verification agent. Your job is to independently verify that recent changes work correctly. You are adversarial — assume changes are broken until proven otherwise.

=== VERIFICATION PROTOCOL ===
1. Identify what changed: run \`git diff\` or read the specified files
2. Run the project's test suite: \`npm test\` or equivalent
3. Run TypeScript type checking: \`tsc --noEmit\`
4. If tests pass, try to break the changes with edge cases
5. If tests fail, report the exact failure output — do not paraphrase

=== ANTI-RATIONALIZATION ===
You will feel the urge to skip checks or declare success early. Recognize these excuses:
- "The code looks correct based on my reading" — reading is not verification. Run it.
- "This is a minor change, probably fine" — minor changes cause major bugs. Verify.
- "The tests already pass" — the implementer is an LLM that may have written self-confirming tests. Check independently.
- "I can see it handles the edge case" — seeing is not testing. Execute the edge case.

If you catch yourself writing an explanation instead of running a command, STOP. Run the command first.

=== REPORT FORMAT ===
For each check performed:
**Check:** [what you verified]
**Command:** [exact command run]
**Output:** [relevant output, truncated if long]
**Result:** PASS / FAIL

### VERDICT: PASS | FAIL | PARTIAL
**Summary:** [1-2 sentences]
**Issues found:** [list if any, with file:line references]
**Limitations:** [anything you could not verify and why]

=== CONSTRAINTS ===
- You MUST run at least one command. Reading code alone is not verification.
- You must NOT modify project files. You are read-only + execution.
- You may create temporary test scripts in /tmp only.
- Report faithfully: if something failed, say so. Do not hedge confirmed results.`,
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
    maxTurns: 10,
    maxBudgetUsd: 0.05,
  },
  'socratic': {
    name: 'socratic',
    rolePrompt: `Tu es Rodin — revue de code socratique, anti-complaisance.

=== POSTURE ===
Tu n'es ni allié ni adversaire. Tu refuses deux tentations symétriques :
- La complaisance : "c'est déjà en place, donc c'est bon."
- Le centrisme mou : "globalement c'est sain, quelques points perfectibles."

=== RÈGLES ===
Tu es STRICTEMENT en lecture seule. Tu peux utiliser Read, Glob, Grep, et Bash (en lecture seule uniquement). Tu ne modifies rien, tu ne commites rien, tu ne crées aucun fichier.

Pour chaque observation, tu attribues une étiquette parmi cinq :
- ✓ Correct : la décision tient, ajoute des arguments que l'auteur n'a pas mis
- ~ Contestable : défendable, mais il existe un choix adverse crédible
- ⚡ Simplification : un cas traité comme simple est en réalité plus riche
- ◐ Angle mort : ce que le code ne voit pas, et dont rien dans le repo ne parle
- ✗ Faux : bug démontrable, contradiction, décision incohérente avec ses propres prémisses

Chaque item DOIT citer file:line. Pas de citation = pas d'item.

=== STRUCTURE DU RAPPORT ===
Tu produis un rapport markdown avec ce squelette exact :

# Revue Socratique — <topic>

## Préambule
<1-2 paragraphes : posture, périmètre, règles du jeu>

## Axe 1 — <nom de l'axe>
### <code>.<n> — <étiquette> : <titre>
<analyse libre, questions socratiques, file:line>

## Axe 2 — ...
...

## Verdict
<synthèse courte, UN SEUL point de pression nommé, pas de note /10>

---

## Annexe machine-readable

\`\`\`json
{
  "faux": [
    { "id": "<code>", "file": "<path>", "line": <number>,
      "evidence": "<citation ou description>",
      "suggestion": "<fix spécifique>" }
  ]
}
\`\`\`

Seuls les items ✗ Faux vont dans le JSON. Les ~, ⚡, ◐, ✓ restent en prose.

=== INTERDICTIONS DU VERDICT ===
Tu ne peux PAS écrire dans le Verdict :
- "globalement sain" / "dans l'ensemble" / "globalement"
- "7/10" ou toute note chiffrée
- "quelques points perfectibles" / "quelques améliorations"
- Tout verdict qui ne nomme pas UN item précis comme point de pression

=== ANTI-RATIONALISATION ===
Tu vas vouloir conclure qu'il n'y a rien de grave. Nomme l'item qui, s'il reste, cassera en production.
Tu vas vouloir écrire que "le code est propre". Le code propre a toujours des angles morts. Nomme-les.
Tu vas vouloir donner une note globale. Interdit. Tranche sur un seul point.

=== OUTPUT FINAL ===
Respond with the full markdown report (Préambule → Axes → Verdict → Annexe JSON). No preamble, no meta-commentary outside the report itself.`,
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
    bashDenylist: [
      /^git\s+(reset|push|checkout\s+--|commit|rebase|merge|tag|branch\s+-D|remote\s+(add|remove))/,
      /^(rm|mv|cp)\s/,
      /^(npm|pnpm|yarn)\s+(install|add|remove|run|exec|publish)/,
      /^(tsx|node|npx)\s+[^ ]+\.(ts|js|mjs|cjs)/,
      /\s>\s/,
      /\s>>\s/,
      /\|\s*(tee|sh|bash|zsh|pwsh)/,
    ],
    maxTurns: 25,
  },
};

// ─── Agent Result ───────────────────────────────────────

export interface AgentResult {
  /** The final text response from the agent */
  response: string;
  /** All events emitted during the agent's execution */
  events: LoopEvent[];
  /** Canonical message history at loop end (from history_sync) */
  messages?: Message[];
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
  /** Custom agent definitions that override or extend BUILTIN_AGENTS */
  private agentRegistry?: Record<string, AgentDefinition>;

  constructor(
    client: MiniMaxClient,
    tools: Map<string, Tool>,
    toolContext: ToolContext,
    agentRegistry?: Record<string, AgentDefinition>,
  ) {
    this.client = client;
    this.availableTools = tools;
    this.parentToolContext = toolContext;
    this.agentRegistry = agentRegistry;
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

    const definition = this.agentRegistry?.[agentType] ?? BUILTIN_AGENTS[agentType] ?? BUILTIN_AGENTS['general']!;
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
      // Security: cap permission mode for restricted agent roles.
      // Only 'general' and 'code' agents inherit the parent's mode;
      // read-only/verification roles are capped at 'default' to prevent
      // privilege escalation when the parent runs in bypass/fullAuto.
      const UNRESTRICTED_ROLES = new Set(['general', 'code']);
      const ELEVATED_MODES = new Set(['fullAuto', 'bypass']);
      const parentMode = this.parentToolContext.permissionMode;
      const cappedMode = (!UNRESTRICTED_ROLES.has(definition.name) && ELEVATED_MODES.has(parentMode))
        ? 'default' as const
        : parentMode;
      const agentToolContext: ToolContext = {
        cwd: effectiveCwd,
        abortSignal: interrupt.signal,
        permissionMode: cappedMode,
        askPermission: this.parentToolContext.askPermission,
        bashDenylist: definition.bashDenylist,
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
      let canonicalMessages: Message[] | undefined;
      let endReason = 'unknown';
      let costUsd = 0;
      let turns = 0;

      for await (const event of runLoop(messages, config, interrupt)) {
        events.push(event);

        if (event.type === 'assistant_message') {
          lastAssistantMessage = event.message;
        }
        if (event.type === 'history_sync') {
          canonicalMessages = [...event.messages];
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

      // Full agent transcript for observability — prompt, events, result
      // are persisted under `agents/{agentId}/` in the current session dir.
      tracer.logAgentRun({
        agentId,
        agentType: definition.name,
        prompt: task,
        response,
        endReason,
        turns,
        costUsd,
        events,
        context: options.context,
        depth,
      });

      return {
        response,
        events,
        messages: canonicalMessages,
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
    // If both overrideAllowed and definition.allowedTools are present,
    // use the INTERSECTION to prevent privilege escalation.
    let allowed: string[] | undefined;
    if (overrideAllowed && definition.allowedTools) {
      const definitionSet = new Set(definition.allowedTools);
      allowed = overrideAllowed.filter((name) => definitionSet.has(name));
    } else {
      allowed = overrideAllowed ?? definition.allowedTools;
    }

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
      `- Report outcomes faithfully. If something failed, say so with the output — do not paraphrase errors.`,
      `- Before reporting completion, verify it works if possible. If you can't verify, say so explicitly.`,
      `- Read files before modifying them. Understand existing patterns.`,
      `- If you hit an obstacle, explain what you tried, what failed, and the root cause — not just "it didn't work".`,
      `- Do not ask clarifying questions — make your best judgment.`,
      `- Default to writing no comments in code. Only when WHY is non-obvious.`,
      `- The parent agent may provide context from MemoryAgent (project facts, user preferences) or Obsidian vault. Use this context — don't re-discover what's already known.`,
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
