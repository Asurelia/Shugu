/**
 * Entrypoint — CLI
 *
 * The main entry point for `pcc` command.
 * Phase 4: tools + permissions + context/compaction + session persistence.
 *
 * Usage:
 *   pcc "prompt"              Single-shot with default mode
 *   pcc --mode=auto "prompt"  Single-shot with fullAuto mode
 *   pcc --mode=plan           Interactive REPL in plan mode
 *   pcc --bypass              Interactive REPL, no permission prompts
 */

import * as readline from 'node:readline';
import { MiniMaxClient } from '../transport/client.js';
import { runLoop, type LoopEvent, type LoopConfig } from '../engine/loop.js';
import { InterruptController } from '../engine/interrupts.js';
import { BudgetTracker } from '../engine/budget.js';
import { TerminalRenderer } from '../ui/renderer.js';
import { createDefaultRegistry } from '../tools/index.js';
import { PermissionResolver } from '../policy/permissions.js';
import { MODE_DESCRIPTIONS } from '../policy/modes.js';
import type { PermissionMode, ToolContext, ToolCall } from '../protocol/tools.js';
import type { Message, ContentBlock } from '../protocol/messages.js';
import { isTextBlock, isThinkingBlock, isToolUseBlock } from '../protocol/messages.js';
import { getGitContext, formatGitContext } from '../context/workspace/git.js';
import { getProjectContext, formatProjectContext } from '../context/workspace/project.js';
import { TokenBudgetTracker } from '../context/tokenBudget.js';
import { compactConversation } from '../context/compactor.js';
import { SessionManager, type SessionData } from '../context/session/persistence.js';
import { MemoryStore } from '../context/memory/store.js';
import { formatMemoriesForPrompt } from '../context/memory/extract.js';
import { discoverTools, getDiscoverySummary } from '../integrations/discovery.js';
import { generateHints } from '../integrations/adapter.js';
import { createDefaultCommands, type CommandContext } from '../commands/index.js';
import { ObsidianVault, discoverVault } from '../context/memory/obsidian.js';
import { AgentOrchestrator } from '../agents/orchestrator.js';
import type { ToolRegistryImpl } from '../tools/registry.js';
import { CredentialVault } from '../credentials/vault.js';
import { CredentialProvider } from '../credentials/provider.js';
// renderStatusLine now handled by StatusBar component

// ─── System Prompt ──────────────────────────────────────

const BASE_SYSTEM_PROMPT = `You are an AI coding assistant powered by MiniMax M2.7. You help users with software engineering tasks by reading, writing, and editing code, running commands, and searching files.

You have access to these tools:
- Bash: Execute shell commands
- Read: Read files (with line numbers)
- Write: Create or overwrite files
- Edit: Perform exact string replacements in files
- Glob: Find files by pattern (e.g., "**/*.ts")
- Grep: Search file contents with regex

Guidelines:
- Read files before modifying them. Understand before changing.
- Use Edit for modifying existing files, Write only for new files or full rewrites.
- Use Glob/Grep to find files instead of Bash with find/grep.
- Test changes after making them when possible.
- Be concise. Lead with the action, not the reasoning.
- When a tool call fails, diagnose the error before retrying.`;

async function buildSystemPrompt(cwd: string): Promise<string> {
  const parts = [BASE_SYSTEM_PROMPT];

  // Workspace context
  parts.push('\n\n# Environment');
  parts.push(`  - Working directory: ${cwd}`);
  parts.push(`  - Platform: ${process.platform}`);
  parts.push(`  - Date: ${new Date().toISOString().split('T')[0]}`);

  // Git context
  const git = await getGitContext(cwd);
  parts.push(formatGitContext(git));

  // Project context
  const project = await getProjectContext(cwd);
  parts.push(formatProjectContext(project));

  // Custom instructions from CLAUDE.md/PCC.md
  if (project.customInstructions) {
    parts.push('\n\n# Project Instructions');
    parts.push(project.customInstructions);
  }

  // CLI tool discovery (CLI-first, not MCP)
  try {
    const adapters = await discoverTools(cwd);
    const hints = generateHints(adapters);
    if (hints) {
      parts.push(hints);
    }
  } catch {
    // Discovery failed — not critical
  }

  // Obsidian vault context
  try {
    const vaultPath = await discoverVault(cwd);
    if (vaultPath) {
      const vault = new ObsidianVault(vaultPath);
      const vaultSummary = await vault.getContextSummary();
      if (vaultSummary) {
        parts.push(vaultSummary);
      }
    }
  } catch {
    // Vault loading failed — not critical
  }

  // File-based memories (fallback if no Obsidian vault)
  try {
    const memStore = new MemoryStore(cwd);
    const memories = await memStore.loadAll();
    if (memories.length > 0) {
      parts.push(formatMemoriesForPrompt(memories));
    }
  } catch {
    // Memory loading failed — not critical
  }

  return parts.join('\n');
}

// ─── CLI Argument Parsing ───────────────────────────────

interface CliArgs {
  mode: PermissionMode;
  prompt: string | null;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let mode: PermissionMode = 'default';
  const promptParts: string[] = [];

  for (const arg of args) {
    if (arg === '--bypass') {
      mode = 'bypass';
    } else if (arg.startsWith('--mode=')) {
      const modeArg = arg.slice(7);
      if (modeArg === 'plan' || modeArg === 'auto' || modeArg === 'bypass' || modeArg === 'accept-edits') {
        mode = modeArg === 'auto' ? 'fullAuto'
          : modeArg === 'accept-edits' ? 'acceptEdits'
          : modeArg;
      } else {
        console.error(`Unknown mode: ${modeArg}. Valid: plan, default, accept-edits, auto, bypass`);
        process.exit(1);
      }
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      promptParts.push(arg);
    }
  }

  return {
    mode,
    prompt: promptParts.length > 0 ? promptParts.join(' ').trim() : null,
  };
}

function printHelp(): void {
  console.log(`
  Project CC — Claude Code for MiniMax M2.7

  Usage:
    pcc "prompt"                Single-shot query
    pcc                         Interactive REPL
    pcc --mode=<mode> "prompt"  Set permission mode

  Modes:
    plan          ${MODE_DESCRIPTIONS.plan}
    default       ${MODE_DESCRIPTIONS.default}
    accept-edits  ${MODE_DESCRIPTIONS.acceptEdits}
    auto          ${MODE_DESCRIPTIONS.fullAuto}
    bypass        ${MODE_DESCRIPTIONS.bypass}

  Options:
    --bypass      Shorthand for --mode=bypass
    --help, -h    Show this help

  Environment:
    MINIMAX_API_KEY          MiniMax API key (required)
    ANTHROPIC_AUTH_TOKEN     Alternative auth token
    MINIMAX_BASE_URL         Custom API base URL
`);
}

// ─── Main ───────────────────────────────────────────────

async function main(): Promise<void> {
  const renderer = new TerminalRenderer();
  const cliArgs = parseArgs();

  try {
    const client = new MiniMaxClient();
    // Rich banner rendered after all info is collected (below)

    const cwd = process.cwd();

    // Initialize credential vault (optional — if exists and master password provided)
    const vault = new CredentialVault();
    let credentialProvider: CredentialProvider | undefined;
    if (await vault.exists()) {
      // In a real REPL we'd prompt for the master password here
      // For now, try env var PCC_VAULT_PASSWORD
      const vaultPassword = process.env['PCC_VAULT_PASSWORD'];
      if (vaultPassword) {
        const unlocked = await vault.unlock(vaultPassword);
        if (unlocked) {
          credentialProvider = new CredentialProvider(vault);
          renderer.info('  Vault: unlocked');
        } else {
          renderer.info('  Vault: wrong password, running without credentials');
        }
      } else {
        renderer.info('  Vault: locked (set PCC_VAULT_PASSWORD to unlock)');
      }
    }

    const { registry, agentTool, webFetchTool } = createDefaultRegistry(credentialProvider);
    const permResolver = new PermissionResolver(cliArgs.mode);

    // Discover CLI tools before building system prompt
    const adapters = await discoverTools(cwd);
    const systemPrompt = await buildSystemPrompt(cwd);

    // Render the rich banner with all info collected
    const toolNames = registry.getAll().map(t => t.definition.name);
    const cliNames = adapters.filter(a => a.installed).map(a => a.name);
    // Load real recent sessions for the banner
    const tempSessionMgr = new SessionManager();
    const recentSessions = await tempSessionMgr.listRecent(5);
    const recentActivity = recentSessions.map((s) => {
      const ago = formatTimeAgo(s.updatedAt);
      const proj = s.projectDir.split(/[\\/]/).pop() ?? '';
      return `${ago}: ${proj} (${s.turnCount}t)`;
    });

    renderer.richBanner({
      version: '1.0.0',
      provider: 'MiniMax',
      model: client.model,
      endpoint: client.baseUrl,
      tools: toolNames,
      clis: cliNames,
      mode: `${cliArgs.mode}`,
      projectName: cwd.split(/[\\/]/).pop() ?? 'unknown',
      vaultStatus: credentialProvider?.isAvailable ? 'unlocked' : 'locked',
      cwd,
      tips: [],
      recentActivity,
    });

    // Initialize status bar
    renderer.statusBar.update({
      model: client.model,
      project: process.cwd().split(/[\\/]/).pop() ?? 'unknown',
      mode: cliArgs.mode,
    });

    const askPermission = createPermissionPrompter(renderer, permResolver);

    const toolContext: ToolContext = {
      cwd,
      abortSignal: new AbortController().signal,
      permissionMode: cliArgs.mode,
      askPermission,
    };

    // Wire up the agent orchestrator
    const toolMap = new Map(registry.getAll().map(t => [t.definition.name, t]));
    const orchestrator = new AgentOrchestrator(client, toolMap, toolContext);
    agentTool.setOrchestrator(orchestrator);
    agentTool.setEventCallback((type, msg) => renderer.info(`  [agent:${type}] ${msg}`));

    if (cliArgs.prompt) {
      await runSingleQuery(client, cliArgs.prompt, renderer, registry, toolContext, systemPrompt);
    } else {
      await runREPL(client, renderer, registry, toolContext, permResolver, systemPrompt);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('No API key')) {
      renderer.error(error.message);
      renderer.info('\nSet one of: MINIMAX_API_KEY, ANTHROPIC_AUTH_TOKEN, or ANTHROPIC_API_KEY');
      process.exit(1);
    }
    renderer.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// ─── Permission Prompter ───────────────────────────────���

function createPermissionPrompter(
  renderer: TerminalRenderer,
  permResolver: PermissionResolver,
): (tool: string, action: string) => Promise<boolean> {
  return async (tool: string, action: string): Promise<boolean> => {
    const result = permResolver.resolve({
      id: 'pending',
      name: tool,
      input: parseActionForResolver(tool, action),
    });

    if (result.decision === 'allow') return true;
    if (result.decision === 'deny') {
      renderer.permissionDenied(tool, action, result.reason);
      return false;
    }

    // Ask the user
    return renderer.permissionPrompt(tool, action, result.reason);
  };
}

function parseActionForResolver(tool: string, action: string): Record<string, unknown> {
  if (tool === 'Bash') return { command: action };
  if (tool === 'Write' || tool === 'Edit' || tool === 'Read') return { file_path: action };
  return {};
}

// ─── Single Query ───────────────────────────────────────

async function runSingleQuery(
  client: MiniMaxClient,
  prompt: string,
  renderer: TerminalRenderer,
  registry: ToolRegistryImpl,
  toolContext: ToolContext,
  systemPrompt: string,
): Promise<void> {
  const messages: Message[] = [{ role: 'user', content: prompt }];
  const interrupt = new InterruptController();

  process.on('SIGINT', () => {
    interrupt.abort('User interrupted');
  });

  const config: LoopConfig = {
    client,
    systemPrompt,
    tools: new Map(registry.getAll().map(t => [t.definition.name, t])),
    toolDefinitions: registry.getDefinitions(),
    toolContext,
    maxTurns: 25,
  };

  let lastUsage = { input_tokens: 0, output_tokens: 0 };
  let totalCost = 0;
  for await (const event of runLoop(messages, config, interrupt)) {
    handleEvent(event, renderer);
    if (event.type === 'turn_end') lastUsage = event.usage;
    if (event.type === 'loop_end') totalCost = event.totalCost;
  }

  renderer.endStream(lastUsage.output_tokens);

  // Status bar after single-shot
  renderer.printStatusBar({
    model: client.model,
    project: toolContext.cwd.split(/[\\/]/).pop() ?? '',
    contextPercent: Math.round((lastUsage.input_tokens / 204800) * 100),
    contextUsed: lastUsage.input_tokens,
    contextTotal: 204800,
    costSession: totalCost,
    costTotal: totalCost,
    mode: toolContext.permissionMode,
  });
}

// ─── Interactive REPL ────────────────────────────────���──

async function runREPL(
  client: MiniMaxClient,
  renderer: TerminalRenderer,
  registry: ToolRegistryImpl,
  toolContext: ToolContext,
  permResolver: PermissionResolver,
  systemPrompt: string,
): Promise<void> {
  // Enable keypress events on stdin (needed for bottom block redraw)
  if (!process.stdin.listenerCount('keypress')) {
    readline.emitKeypressEvents(process.stdin);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '',
  });

  const conversationMessages: Message[] = [];
  const budget = new BudgetTracker(client.model);
  const tokenTracker = new TokenBudgetTracker({ model: client.model });
  const sessionMgr = new SessionManager();
  const session = sessionMgr.createSession(toolContext.cwd, client.model);
  const commands = createDefaultCommands();

  // ── Status bar: autonomous component ──
  renderer.statusBar.update({
    model: client.model,
    project: toolContext.cwd.split(/[\\/]/).pop() ?? '',
    contextTotal: tokenTracker.getStatus().totalTokens,
    sessionStartTime: Date.now(),
    mode: permResolver.getMode(),
  });
  renderer.statusBar.start();

  // Draw the bottom 2 lines (bar + mode) below the prompt using save/restore
  function drawPromptBottom(): void {
    const w = process.stdout.columns ?? 120;
    const mode = permResolver.getMode();
    const mc = mode === 'bypass' ? '\x1b[31m' : mode === 'fullAuto' ? '\x1b[33m' : '\x1b[32m';

    process.stdout.write('\x1b7');  // save cursor
    process.stdout.write('\n');     // move down to bottom bar line
    process.stdout.write(`\x1b[2K\x1b[90m${'─'.repeat(w)}\x1b[0m`);
    process.stdout.write('\n');     // move to mode line
    process.stdout.write(`\x1b[2K  \x1b[2m⏵⏵ ${mc}${mode}\x1b[0m \x1b[2mpermissions on (shift+tab to cycle)\x1b[0m`);
    process.stdout.write('\x1b8');  // restore cursor back to prompt
  }

  const askQuestion = (): Promise<string> => {
    return new Promise((resolve) => {
      // Top separator
      renderer.printTopSeparator();
      // Prompt >
      renderer.promptIndicator();
      // Bottom bar + mode (always visible)
      drawPromptBottom();

      const onKeypress = (_ch: string, key: { name?: string; shift?: boolean } | undefined) => {
        // Shift+Tab = cycle permission mode
        if (key?.name === 'tab' && key?.shift) {
          const modes: Array<import('../protocol/tools.js').PermissionMode> = ['default', 'plan', 'acceptEdits', 'fullAuto', 'bypass'];
          const currentIdx = modes.indexOf(permResolver.getMode());
          const nextIdx = (currentIdx + 1) % modes.length;
          permResolver.setMode(modes[nextIdx]!);
          renderer.statusBar.update({ mode: modes[nextIdx]! });
          // Redraw bottom bar with new mode
          drawPromptBottom();
          return;
        }
        // Redraw on destructive keys
        if (key?.name === 'backspace' || key?.name === 'delete') {
          drawPromptBottom();
          renderer.statusBar.redraw();
        }
      };
      process.stdin.on('keypress', onKeypress);

      rl.once('line', (line) => {
        process.stdin.removeListener('keypress', onKeypress);
        // Move past the bottom bar + mode lines (2 lines down)
        process.stdout.write('\n\n');
        resolve(line.trim());
      });
    });
  };

  const saveSession = async () => {
    session.messages = conversationMessages;
    session.turnCount = budget.getTurnCount();
    session.totalUsage = budget.getTotalUsage();
    await sessionMgr.save(session).catch(() => {});
  };

  rl.on('close', async () => {
    renderer.statusBar.stop();
    await saveSession();
    renderer.loopEnd('user_exit', budget.getTotalCostUsd());
    process.exit(0);
  });

  // Command context for slash commands
  const cmdCtx: CommandContext = {
    cwd: toolContext.cwd,
    messages: conversationMessages,
    info: (msg) => renderer.info(msg),
    error: (msg) => renderer.error(msg),
  };

  while (true) {
    const input = await askQuestion();
    if (!input) {
      renderer.statusBar.redraw();
      continue;
    }

    // ── Local-state commands (need direct access to REPL state) ──
    if (input === '/cost') { renderer.usage(budget.getSummary()); continue; }
    if (input === '/context') {
      const status = tokenTracker.getStatus();
      renderer.info(`Context: ${status.usedTokens.toLocaleString()} / ${status.totalTokens.toLocaleString()} tokens (${status.percentUsed}%)`);
      renderer.info(`Available: ${status.availableTokens.toLocaleString()} tokens`);
      renderer.info(`Compaction needed: ${status.shouldCompact ? 'YES' : 'no'}`);
      renderer.info(`Session: ${session.id} | Turns: ${budget.getTurnCount()}`);
      continue;
    }
    if (input.startsWith('/mode ')) {
      const newMode = input.slice(6).trim();
      const modeMap: Record<string, PermissionMode> = {
        plan: 'plan', default: 'default', 'accept-edits': 'acceptEdits',
        auto: 'fullAuto', bypass: 'bypass',
      };
      if (modeMap[newMode]) {
        permResolver.setMode(modeMap[newMode]!);
        renderer.info(`Mode changed to: ${modeMap[newMode]} — ${MODE_DESCRIPTIONS[modeMap[newMode]!]}`);
      } else {
        renderer.error(`Unknown mode: ${newMode}. Valid: plan, default, accept-edits, auto, bypass`);
      }
      continue;
    }
    if (input === '/compact') {
      renderer.info('Compacting conversation...');
      const result = await compactConversation(conversationMessages, client);
      if (result.wasCompacted) {
        conversationMessages.length = 0;
        conversationMessages.push(...result.messages);
        renderer.info(`Compacted: ${result.removedTurns} turns summarized.`);
      } else {
        renderer.info('Nothing to compact (too few turns).');
      }
      continue;
    }

    // ── Slash command dispatch via registry ──────────────
    if (input.startsWith('/')) {
      const cmdResult = await commands.dispatch(input, cmdCtx);
      if (cmdResult) {
        switch (cmdResult.type) {
          case 'handled':
            continue;
          case 'clear':
            conversationMessages.length = 0;
            continue;
          case 'exit':
            renderer.statusBar.stop();
            await saveSession();
            renderer.loopEnd(cmdResult.reason, budget.getTotalCostUsd());
            rl.close();
            return;
          case 'error':
            renderer.error(cmdResult.message);
            continue;
          case 'prompt':
            // Inject the command's prompt as a user message — fall through to the loop
            conversationMessages.push({ role: 'user', content: cmdResult.prompt });
            break; // Fall through to the agentic loop below
        }
      }
      if (cmdResult?.type !== 'prompt') continue;
    } else {
      // Regular user message
      conversationMessages.push({ role: 'user', content: input });
    }

    // ── Auto-compaction check ─────────────────────────
    if (tokenTracker.shouldCompact()) {
      renderer.info('Context window filling up — auto-compacting...');
      const result = await compactConversation(conversationMessages, client);
      if (result.wasCompacted) {
        conversationMessages.length = 0;
        conversationMessages.push(...result.messages);
        renderer.info(`Auto-compacted: ${result.removedTurns} turns summarized.`);
      }
    }

    const interrupt = new InterruptController();
    const sigintHandler = () => { interrupt.abort('User interrupted'); };
    process.on('SIGINT', sigintHandler);

    const turnAbort = new AbortController();
    interrupt.signal.addEventListener('abort', () => turnAbort.abort(), { once: true });
    const turnToolContext: ToolContext = {
      ...toolContext,
      abortSignal: turnAbort.signal,
      permissionMode: permResolver.getMode(),
    };

    const config: LoopConfig = {
      client,
      systemPrompt,
      tools: new Map(registry.getAll().map(t => [t.definition.name, t])),
      toolDefinitions: registry.getDefinitions(),
      toolContext: turnToolContext,
      maxTurns: 25,
    };

    let lastOutputTokens = 0;
    for await (const event of runLoop(conversationMessages, config, interrupt)) {
      handleEvent(event, renderer, budget);
      if (event.type === 'assistant_message') {
        conversationMessages.push(event.message);
      }
      if (event.type === 'turn_end') {
        tokenTracker.updateFromUsage(event.usage);
        lastOutputTokens = event.usage.output_tokens;
        // Update status bar
        const status = tokenTracker.getStatus();
        renderer.statusBar.update({
          contextPercent: status.percentUsed,
          contextUsed: status.usedTokens,
          costUsd: budget.getTotalCostUsd(),
        });
      }
    }

    renderer.endStream(lastOutputTokens);
    // Status bar will be shown by askQuestion() before next prompt

    process.removeListener('SIGINT', sigintHandler);

    // Save session periodically
    session.messages = conversationMessages;
    session.turnCount = budget.getTurnCount();
    session.totalUsage = budget.getTotalUsage();
    await sessionMgr.save(session).catch(() => {});
  }

  rl.close();
}

// ─── Event Handler ─────────────────���────────────────────

function handleEvent(
  event: LoopEvent,
  renderer: TerminalRenderer,
  budget?: BudgetTracker,
): void {
  switch (event.type) {
    case 'turn_start':
      break;

    case 'assistant_message':
      renderer.startStream();
      for (const block of event.message.content) {
        renderContentBlock(block, renderer);
      }
      break;

    case 'tool_executing':
      renderer.endStream();
      renderer.toolCall(event.call.name, event.call.id);
      break;

    case 'tool_result': {
      const content = typeof event.result.content === 'string'
        ? event.result.content
        : JSON.stringify(event.result.content);
      renderer.toolResult(event.result.tool_use_id, content, event.result.is_error ?? false);
      break;
    }

    case 'turn_end':
      budget?.addTurnUsage(event.usage);
      break;

    case 'loop_end':
      renderer.endStream();
      // Status info now shown in the footer status bar, not inline
      break;

    case 'error':
      renderer.error(event.error.message);
      break;
  }
}

function renderContentBlock(block: ContentBlock, renderer: TerminalRenderer): void {
  if (isThinkingBlock(block)) {
    renderer.thinkingHeader();
    renderer.streamThinking(block.thinking);
    console.log('');
  } else if (isTextBlock(block)) {
    renderer.streamText(block.text);
  } else if (isToolUseBlock(block)) {
    // Handled via tool_executing event
  }
}

// ─── Helpers ────────────────────────────────────────────

function formatTimeAgo(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ─── Entry ──────────────────────────────────────────────

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
