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
import { renderBanner } from '../ui/banner.js';
import { createDefaultSkillRegistry, generateSkillsPrompt, type SkillContext, type SkillResult, type SkillRegistry } from '../skills/index.js';
import { PluginRegistry } from '../plugins/registry.js';
import type { HookRegistry } from '../plugins/hooks.js';
import { BackgroundManager } from '../automation/background.js';
import { Scheduler } from '../automation/scheduler.js';
import { createBgCommand, createProactiveCommand } from '../commands/automation.js';
import { registerKnowledgeHooks } from '../plugins/builtin/knowledge-hook.js';
import { registerBehaviorHooks } from '../plugins/builtin/behavior-hooks.js';
import { getCompanion, getCompanionPrompt } from '../ui/companion/index.js';

// ─── System Prompt ──────────────────────────────────────

const BASE_SYSTEM_PROMPT = `You are an AI coding assistant powered by MiniMax M2.7. You help users with software engineering tasks by reading, writing, and editing code, running commands, and searching files.

You have access to these tools:
- Bash: Execute shell commands
- Read: Read files (with line numbers)
- Write: Create or overwrite files
- Edit: Perform exact string replacements in files
- Glob: Find files by pattern (e.g., "**/*.ts")
- Grep: Search file contents with regex
- Obsidian: Read, write, search, update, and manage the user's Obsidian vault (second brain). Use this to persist knowledge, decisions, and facts across sessions. The wiki in Agent/Wiki/ is yours to maintain — write, update, lint, and organize it.

Guidelines:
- Read files before modifying them. Understand before changing.
- Use Edit for modifying existing files, Write only for new files or full rewrites.
- Use Glob/Grep to find files instead of Bash with find/grep.
- Test changes after making them when possible.
- Be concise. Lead with the action, not the reasoning.
- When a tool call fails, diagnose the error before retrying.`;

async function buildSystemPrompt(
  cwd: string,
  skillRegistry?: SkillRegistry,
  precomputedAdapters?: Awaited<ReturnType<typeof discoverTools>>,
): Promise<string> {
  const parts = [BASE_SYSTEM_PROMPT];

  // Workspace context (sync — instant)
  parts.push('\n\n# Environment');
  parts.push(`  - Working directory: ${cwd}`);
  parts.push(`  - Platform: ${process.platform}`);
  parts.push(`  - Date: ${new Date().toISOString().split('T')[0]}`);

  // ── Run ALL independent async operations in PARALLEL ──
  const [gitResult, projectResult, vaultResult, memoryResult] = await Promise.all([
    // 1. Git context (2 spawns instead of 3)
    getGitContext(cwd).catch(() => null),
    // 2. Project context (file checks)
    getProjectContext(cwd).catch(() => null),
    // 3. Obsidian vault context
    (async () => {
      const vaultPath = await discoverVault(cwd);
      if (!vaultPath) return null;
      const vault = new ObsidianVault(vaultPath);
      return vault.getContextSummary();
    })().catch(() => null),
    // 4. File-based memories
    (async () => {
      const memStore = new MemoryStore(cwd);
      const memories = await memStore.loadAll();
      return memories.length > 0 ? formatMemoriesForPrompt(memories) : null;
    })().catch(() => null),
  ]);

  // Assemble results (order matters for prompt quality)
  if (gitResult) parts.push(formatGitContext(gitResult));
  if (projectResult) {
    parts.push(formatProjectContext(projectResult));
    if (projectResult.customInstructions) {
      parts.push('\n\n# Project Instructions');
      parts.push(projectResult.customInstructions);
    }
  }

  // CLI tool hints (use pre-computed adapters — NO redundant discoverTools call)
  if (precomputedAdapters) {
    try {
      const hints = generateHints(precomputedAdapters);
      if (hints) parts.push(hints);
    } catch { /* non-critical */ }
  }

  if (vaultResult) parts.push(vaultResult);
  if (memoryResult) parts.push(memoryResult);

  // Skill descriptions (sync — instant)
  if (skillRegistry) {
    const skillsPrompt = generateSkillsPrompt(skillRegistry);
    if (skillsPrompt) parts.push(skillsPrompt);
  }

  // Companion introduction (sync after first call — cached in module)
  try {
    const companion = getCompanion();
    parts.push('\n' + getCompanionPrompt(companion));
  } catch { /* non-critical */ }

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

    const { registry, agentTool, webFetchTool, obsidianTool } = createDefaultRegistry(credentialProvider);
    const permResolver = new PermissionResolver(cliArgs.mode);

    // Create skill registry with bundled skills
    const skillRegistry = createDefaultSkillRegistry();

    // Create command registry (before plugins so they can add commands)
    const commands = createDefaultCommands();

    // Load plugins (adds tools, commands, skills, hooks)
    const pluginRegistry = new PluginRegistry();
    const pluginResult = await pluginRegistry.loadAll(cwd, registry, commands, skillRegistry);
    const hookRegistry = pluginRegistry.getHookRegistry();
    if (pluginResult.loaded > 0) {
      renderer.info(`  Plugins: ${pluginResult.loaded} loaded`);
    }

    // Check if this is the first hatch BEFORE buildSystemPrompt creates the companion file
    const { isFirstHatch } = await import('../ui/companion/companion.js');
    const needsHatchCeremony = isFirstHatch();

    // Register built-in behavior hooks (security, anti-lazy, path safety)
    registerBehaviorHooks(hookRegistry);

    // Discover Obsidian vault and wire knowledge hooks
    const vaultPath = await discoverVault(cwd);
    let obsidianVaultInstance: ObsidianVault | null = null;
    if (vaultPath) {
      obsidianVaultInstance = new ObsidianVault(vaultPath);
      obsidianTool.setVault(obsidianVaultInstance);
      registerKnowledgeHooks(hookRegistry, obsidianVaultInstance);
    }

    // Create automation instances
    const bgManager = new BackgroundManager();
    const scheduler = new Scheduler();

    // Register automation commands (closures over bgManager/scheduler)
    const loopConfigFactory = (): LoopConfig => ({
      client,
      systemPrompt: '', // Will be set properly after systemPrompt is built
      tools: new Map(registry.getAll().map(t => [t.definition.name, t])),
      toolDefinitions: registry.getDefinitions(),
      toolContext,
      hookRegistry,
      maxTurns: 15,
    });
    commands.register(createBgCommand(bgManager, loopConfigFactory));
    commands.register(createProactiveCommand(async (prompt) => {
      // Simple agent execution for proactive mode
      const messages: Message[] = [{ role: 'user', content: prompt }];
      let result = '';
      for await (const event of runLoop(messages, loopConfigFactory())) {
        if (event.type === 'assistant_message') {
          result = event.message.content.filter(isTextBlock).map(b => b.text).join('');
        }
      }
      return result;
    }));

    // Discover CLI tools before building system prompt
    const adapters = await discoverTools(cwd);
    const systemPrompt = await buildSystemPrompt(cwd, skillRegistry, adapters);

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

    // Banner will be pushed into Ink app's scrollable area in REPL mode
    // For single-shot mode, still render with console.log
    if (!cliArgs.prompt) {
      // Banner rendered inside Ink app (see runREPL)
    } else {
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
    }

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
      await runSingleQuery(client, cliArgs.prompt, renderer, registry, toolContext, systemPrompt, hookRegistry);
    } else {
      await runREPL(client, renderer, registry, toolContext, permResolver, systemPrompt, hookRegistry, skillRegistry, commands, bgManager, scheduler, obsidianVaultInstance, needsHatchCeremony);
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
  hookRegistry?: HookRegistry,
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
    hookRegistry,
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
  hookRegistry?: HookRegistry,
  skillRegistry?: SkillRegistry,
  commands?: import('../commands/registry.js').CommandRegistry,
  bgManager?: BackgroundManager,
  scheduler?: Scheduler,
  obsidianVaultInstance?: ObsidianVault | null,
  needsHatchCeremony?: boolean,
): Promise<void> {
  const conversationMessages: Message[] = [];
  const budget = new BudgetTracker(client.model);
  const tokenTracker = new TokenBudgetTracker({ model: client.model });
  const sessionMgr = new SessionManager();
  const session = sessionMgr.createSession(toolContext.cwd, client.model);
  if (!commands) commands = createDefaultCommands();

  // Vault refresh tracking (for mid-conversation context updates)
  let lastVaultRefresh = Date.now();
  let dynamicVaultContext = '';

  // ── Skill execution helpers ──
  const queryModel = async (prompt: string): Promise<string> => {
    const result = await client.complete([{ role: 'user', content: prompt }], { systemPrompt });
    return result.message.content
      .filter(isTextBlock)
      .map((b) => b.text)
      .join('');
  };

  const runAgentLoop = async (prompt: string): Promise<string> => {
    const messages: Message[] = [{ role: 'user', content: prompt }];
    const agentConfig: LoopConfig = {
      client,
      systemPrompt,
      tools: new Map(registry.getAll().map(t => [t.definition.name, t])),
      toolDefinitions: registry.getDefinitions(),
      toolContext,
      hookRegistry,
      maxTurns: 20,
    };
    let lastText = '';
    for await (const event of runLoop(messages, agentConfig)) {
      if (event.type === 'assistant_message') {
        lastText = event.message.content
          .filter(isTextBlock)
          .map((b) => b.text)
          .join('');
      }
    }
    return lastText;
  };

  renderer.statusBar.update({
    model: client.model,
    project: toolContext.cwd.split(/[\\/]/).pop() ?? '',
    contextTotal: tokenTracker.getStatus().totalTokens,
    sessionStartTime: Date.now(),
    mode: permResolver.getMode(),
  });

  // ── Full Ink app ──
  const { launchFullApp } = await import('../ui/FullApp.js');
  const app = launchFullApp(
    permResolver.getMode(),
    renderer.statusBar.render(),
    (newMode) => {
      permResolver.setMode(newMode as import('../protocol/tools.js').PermissionMode);
      renderer.statusBar.update({ mode: newMode });
      app.setMode(newMode);
      app.setStatus(renderer.statusBar.render());
    },
  );

  // Push the full banner into the scrollable area
  // Load recent sessions
  const bannerSessionMgr = new SessionManager();
  const bannerSessions = await bannerSessionMgr.listRecent(5);
  const bannerActivity = bannerSessions.map((s) => {
    const ago = formatTimeAgo(s.updatedAt);
    const proj = s.projectDir.split(/[\\/]/).pop() ?? '';
    return `${ago}: ${proj} (${s.turnCount}t)`;
  });
  const bannerText = renderBanner({
    version: '1.0.0',
    provider: 'MiniMax',
    model: client.model,
    endpoint: client.baseUrl,
    tools: registry.getAll().map(t => t.definition.name),
    clis: [],
    mode: permResolver.getMode(),
    projectName: toolContext.cwd.split(/[\\/]/).pop() ?? '',
    vaultStatus: 'locked',
    cwd: toolContext.cwd,
    tips: [],
    recentActivity: bannerActivity,
  });
  for (const line of bannerText.split('\n')) {
    app.pushMessage({ type: 'info', text: line });
  }

  // Set session title in top bar (like Claude Code: ──── branch-name ─)
  try {
    const gitCtx = await getGitContext(toolContext.cwd);
    const projectName = toolContext.cwd.split(/[\\/]/).pop() ?? '';
    const branch = gitCtx.branch && gitCtx.branch !== 'unknown' ? gitCtx.branch : '';
    const title = branch ? `${projectName} ─ ${branch}` : projectName;
    app.setSessionTitle(title);
  } catch {
    app.setSessionTitle(toolContext.cwd.split(/[\\/]/).pop() ?? 'shugu');
  }

  // Hatch ceremony on first launch (flag set in main() BEFORE companion file was created)
  const { renderHatchCeremony, renderBuddyCompact, renderBuddyCard } = await import('../ui/companion/companion.js');
  if (needsHatchCeremony) {
    const c = getCompanionInstance();
    if (c) {
      for (const line of renderHatchCeremony(c)) {
        app.pushMessage({ type: 'info', text: line });
      }
    }
  }

  const askQuestion = async (): Promise<string> => {
    app.setStatus(renderer.statusBar.render());
    app.setMode(permResolver.getMode());
    app.stopStreaming();
    return app.waitForInput();
  };

  const saveSession = async () => {
    session.messages = conversationMessages;
    session.turnCount = budget.getTurnCount();
    session.totalUsage = budget.getTotalUsage();
    await sessionMgr.save(session).catch(() => {});
  };

  process.on('SIGINT', async () => {
    app.unmount();
    await saveSession();
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
    if (input === '/buddy' || input === '/pet') {
      const c = getCompanionInstance();
      if (c) {
        for (const line of renderBuddyCompact(c)) {
          app.pushMessage({ type: 'info', text: line });
        }
      }
      continue;
    }
    if (input === '/buddy card' || input === '/buddy info' || input === '/buddy stats') {
      const c = getCompanionInstance();
      if (c) {
        for (const line of renderBuddyCard(c)) {
          app.pushMessage({ type: 'info', text: line });
        }
      }
      continue;
    }
    if (input === '/buddy pet') {
      const c = getCompanionInstance();
      if (c) {
        app.pushMessage({ type: 'info', text: `  ♥ ♥ ♥  ${c.name} purrs happily!  ♥ ♥ ♥` });
      }
      continue;
    }
    if (input === '/buddy mute') {
      _companionMuted = true;
      app.pushMessage({ type: 'info', text: '  Companion muted. Use /buddy unmute to restore.' });
      continue;
    }
    if (input === '/buddy unmute') {
      _companionMuted = false;
      app.pushMessage({ type: 'info', text: '  Companion unmuted.' });
      continue;
    }
    if (input === '/buddy off') {
      _companionMuted = true;
      app.pushMessage({ type: 'info', text: '  Companion hidden. Use /buddy to show again.' });
      continue;
    }
    if (input.startsWith('/buddy name ')) {
      const newName = input.slice(12).trim();
      const c = getCompanionInstance();
      if (c && newName) {
        const oldName = c.name;
        c.name = newName;
        const { saveCompanion } = await import('../ui/companion/companion.js');
        saveCompanion({ name: newName, personality: c.personality, hatchedAt: c.hatchedAt });
        app.pushMessage({ type: 'info', text: `  ${oldName} is now ${newName}!` });
      }
      continue;
    }
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

    // ── Show user message IMMEDIATELY (before any processing) ──
    if (!input.startsWith('/') || input.startsWith('/vibe') || input.startsWith('/dream') || input.startsWith('/hunt') || input.startsWith('/brain') || input.startsWith('/proactive')) {
      app.pushMessage({ type: 'user', text: input });
    }

    // ── Skill matching (before command dispatch) ──────────
    let skillHandled = false;
    if (skillRegistry && input.startsWith('/')) {
      const skillMatch = skillRegistry.match(input);
      if (skillMatch) {
        const skillCtx: SkillContext = {
          input,
          args: skillMatch.args,
          cwd: toolContext.cwd,
          messages: conversationMessages,
          toolContext,
          tools: new Map(registry.getAll().map(t => [t.definition.name, t])),
          info: (msg) => app.pushMessage({ type: 'info', text: msg }),
          error: (msg) => app.pushMessage({ type: 'error', text: msg }),
          query: queryModel,
          runAgent: runAgentLoop,
        };
        const skillResult = await skillMatch.skill.execute(skillCtx);
        if (skillResult.type === 'handled') { skillHandled = true; }
        else if (skillResult.type === 'error') {
          app.pushMessage({ type: 'error', text: skillResult.message });
          skillHandled = true;
        } else if (skillResult.type === 'prompt') {
          conversationMessages.push({ role: 'user', content: skillResult.prompt });
        }
      }
    }
    if (skillHandled) continue;

    // ── Slash command dispatch via registry ──────────────
    if (input.startsWith('/')) {
      const cmdResult = await commands!.dispatch(input, cmdCtx);
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
            return;
          case 'error':
            renderer.error(cmdResult.message);
            continue;
          case 'prompt':
            app.pushMessage({ type: 'user', text: input });
            conversationMessages.push({ role: 'user', content: cmdResult.prompt });
            break;
        }
      }
      if (cmdResult?.type !== 'prompt') continue;
    } else {
      // Regular user message (already displayed above)
      conversationMessages.push({ role: 'user', content: input });
    }

    // ── Mid-conversation vault refresh (throttled to 60s) ──
    if (obsidianVaultInstance && (Date.now() - lastVaultRefresh) > 60_000) {
      try {
        dynamicVaultContext = await obsidianVaultInstance.refreshContext();
        lastVaultRefresh = Date.now();
      } catch {
        // Vault refresh failure is non-critical
      }
    }
    const currentSystemPrompt = dynamicVaultContext
      ? systemPrompt + '\n\n# Updated vault context\n' + dynamicVaultContext
      : systemPrompt;

    // ── Reactive auto-compaction (OpenClaude pattern: buffer-based + circuit breaker) ──
    if (tokenTracker.shouldAutoCompact()) {
      const status = tokenTracker.getStatus();
      app.pushMessage({ type: 'info', text: `⚡ Context at ${status.percentUsed}% — auto-compacting...` });
      try {
        const result = await compactConversation(conversationMessages, client);
        if (result.wasCompacted) {
          conversationMessages.length = 0;
          conversationMessages.push(...result.messages);
          tokenTracker.recordCompactSuccess();
          app.pushMessage({ type: 'info', text: `Compacted: ${result.removedTurns} turns → summary.` });
        }
      } catch {
        tokenTracker.recordCompactFailure();
        if (tokenTracker.compactCircuitBroken) {
          app.pushMessage({ type: 'error', text: 'Auto-compaction failed 3 times — circuit breaker tripped. Use /compact manually.' });
        }
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
      systemPrompt: currentSystemPrompt,
      tools: new Map(registry.getAll().map(t => [t.definition.name, t])),
      toolDefinitions: registry.getDefinitions(),
      toolContext: turnToolContext,
      hookRegistry,
      maxTurns: 25,
    };

    let lastOutputTokens = 0;
    const streamStart = Date.now();
    app.startStreaming();

    for await (const event of runLoop(conversationMessages, config, interrupt)) {
      // Push events as typed UIMessages into the Ink app
      handleEventForApp(event, app, budget);
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

    // Brew timer
    const brewMs = Date.now() - streamStart;
    app.pushMessage({ type: 'brew', durationMs: brewMs, tokens: lastOutputTokens });
    app.stopStreaming();
    app.setStatus(renderer.statusBar.render());

    process.removeListener('SIGINT', sigintHandler);

    // Save session periodically
    session.messages = conversationMessages;
    session.turnCount = budget.getTurnCount();
    session.totalUsage = budget.getTotalUsage();
    await sessionMgr.save(session).catch(() => {});
  }

  // Ink already unmounted after each submit
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

// ─── Ink Event Handler (pushes UIMessages to FullApp) ───

// Companion instance — created once, reused across events
let _companion: import('../ui/companion/index.js').Companion | null = null;
let _companionMuted = false;
function getCompanionInstance(): import('../ui/companion/index.js').Companion | null {
  if (_companion === undefined) return null;
  if (!_companion) {
    try { _companion = getCompanion(); } catch { _companion = null; }
  }
  return _companion;
}

function handleEventForApp(
  event: LoopEvent,
  app: import('../ui/FullApp.js').AppHandle,
  budget?: BudgetTracker,
): void {
  switch (event.type) {
    case 'turn_start':
      break;

    case 'assistant_message': {
      app.pushMessage({ type: 'assistant_header' });
      for (const block of event.message.content) {
        if (isThinkingBlock(block)) {
          app.pushMessage({ type: 'thinking', text: block.thinking });
        } else if (isTextBlock(block)) {
          app.pushMessage({ type: 'assistant_text', text: block.text });
        }
      }
      break;
    }

    case 'tool_executing': {
      // Extract human-readable detail from tool input
      const detail = extractToolDetail(event.call.name, event.call.input);
      app.pushMessage({ type: 'tool_call', name: event.call.name, id: event.call.id, detail });
      break;
    }

    case 'tool_result': {
      const content = typeof event.result.content === 'string'
        ? event.result.content
        : JSON.stringify(event.result.content);
      app.pushMessage({ type: 'tool_result', content, isError: event.result.is_error ?? false });
      break;
    }

    case 'turn_end':
      budget?.addTurnUsage(event.usage);
      break;

    case 'loop_end':
      break;

    case 'error':
      app.pushMessage({ type: 'error', text: event.error.message });
      break;
  }
}

// ─── Helpers ────────────────────────────────────────────

/**
 * Extract a human-readable detail from tool input.
 * Shows the path, command, or pattern instead of the cryptic tool_use ID.
 */
function extractToolDetail(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash': {
      const cmd = (input['command'] as string) ?? '';
      return cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd;
    }
    case 'Read':
    case 'Write':
    case 'Edit': {
      const fp = (input['file_path'] as string) ?? '';
      // Show just filename or last 2 path segments
      const parts = fp.replace(/\\/g, '/').split('/');
      return parts.length > 2 ? parts.slice(-2).join('/') : fp;
    }
    case 'Glob': {
      return (input['pattern'] as string) ?? '';
    }
    case 'Grep': {
      const pat = (input['pattern'] as string) ?? '';
      const path = (input['path'] as string) ?? '';
      const shortPath = path.replace(/\\/g, '/').split('/').pop() ?? '';
      return pat + (shortPath ? ` in ${shortPath}` : '');
    }
    case 'WebFetch': {
      const url = (input['url'] as string) ?? '';
      try { return new URL(url).hostname; } catch { return url.slice(0, 60); }
    }
    case 'WebSearch': {
      return (input['query'] as string) ?? '';
    }
    case 'Agent': {
      return ((input['description'] as string) ?? '').slice(0, 60);
    }
    case 'Obsidian': {
      const op = (input['operation'] as string) ?? '';
      const q = (input['query'] as string) ?? (input['path'] as string) ?? (input['title'] as string) ?? '';
      return `${op}${q ? ': ' + q.slice(0, 50) : ''}`;
    }
    default:
      return '';
  }
}

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
