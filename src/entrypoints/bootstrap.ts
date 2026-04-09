/**
 * Entrypoint — Bootstrap
 *
 * CLI argument parsing, help text, and service construction.
 * Builds a RuntimeServices container from CLI args.
 */

import type { PermissionMode, ToolContext } from '../protocol/tools.js';
import type { Message } from '../protocol/messages.js';
import { isTextBlock } from '../protocol/messages.js';
import { MiniMaxClient } from '../transport/client.js';
import { TerminalRenderer } from '../ui/renderer.js';
import { createDefaultRegistry } from '../tools/index.js';
import { PermissionResolver } from '../policy/permissions.js';
import { MODE_DESCRIPTIONS } from '../policy/modes.js';
import { SessionManager } from '../context/session/persistence.js';
import { MemoryAgent } from '../context/memory/agent.js';
import { ObsidianVault, discoverVault } from '../context/memory/obsidian.js';
import { CredentialVault } from '../credentials/vault.js';
import { CredentialProvider } from '../credentials/provider.js';
import { WrongPasswordError } from '../credentials/errors.js';
import { promptPassword } from '../credentials/prompt.js';
import { createDefaultSkillRegistry } from '../skills/index.js';
import { PluginRegistry } from '../plugins/registry.js';
import { BackgroundManager } from '../automation/background.js';
import { Scheduler } from '../automation/scheduler.js';
import { createBgCommand, createProactiveCommand } from '../commands/automation.js';
import { createTeamCommand } from '../commands/team.js';
import { createVaultCommand } from '../commands/vault.js';
import { createDefaultCommands } from '../commands/index.js';
import { loadMarkdownCommands } from '../commands/markdown-loader.js';
import { loadMarkdownAgents } from '../agents/markdown-loader.js';
import { FileRevertStack, TurnChangeAccumulator } from '../context/session/file-revert.js';
import { registerFileTrackingHook } from '../plugins/builtin/file-tracking-hook.js';
import { createFileRevertCommand } from '../commands/session.js';
import { ToolRouter } from '../tools/router.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createReviewCommand } from '../commands/review.js';
import { createBatchCommand } from '../commands/batch.js';
import { createMetaCommand } from '../meta/cli.js';
import { registerBehaviorHooks } from '../plugins/builtin/behavior-hooks.js';
import { registerVerificationHook } from '../plugins/builtin/verification-hook.js';
import { AgentOrchestrator } from '../agents/orchestrator.js';
import { discoverTools } from '../integrations/discovery.js';
import { runLoop, type LoopConfig } from '../engine/loop.js';
import { renderBanner } from '../ui/banner.js';
import { getCompanion, getCompanionPrompt } from '../ui/companion/index.js';
import { Kairos } from '../automation/kairos.js';
import { logger } from '../utils/logger.js';
import { tracer } from '../utils/tracer.js';
import { buildSystemPrompt } from './prompt-builder.js';
import type { RuntimeServices } from './services.js';
import { formatTimeAgo } from './cli-handlers.js';

// ─── CLI Argument Parsing ───────────────────────────────

export interface CliArgs {
  mode: PermissionMode;
  prompt: string | null;
  continueSession: boolean;
  resumeSession: string | true | false;
  verbose: boolean;
  model: string | null;
}

export function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let mode: PermissionMode = 'default';
  let continueSession = false;
  let resumeSession: string | true | false = false;
  let verbose = false;
  let model: string | null = null;
  const promptParts: string[] = [];

  for (const arg of args) {
    if (arg === '--bypass') {
      mode = 'bypass';
    } else if (arg.startsWith('--model=')) {
      model = arg.slice(8);
    } else if (arg === '--continue' || arg === '-c') {
      continueSession = true;
    } else if (arg === '--resume' || arg === '-r') {
      resumeSession = true;
    } else if (arg.startsWith('--resume=')) {
      resumeSession = arg.slice(9);
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true;
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

  // Resolve model: CLI arg > env var > default
  if (!model) {
    model = process.env['MINIMAX_MODEL'] ?? null;
  }

  return {
    mode,
    prompt: promptParts.length > 0 ? promptParts.join(' ').trim() : null,
    continueSession,
    resumeSession,
    verbose,
    model,
  };
}

export function printHelp(): void {
  console.log(`
  Shugu — coding agent for MiniMax M2.7

  Usage:
    shugu "prompt"              Single-shot query
    shugu                       Interactive REPL
    shugu --continue            Resume last session in current directory
    shugu --resume              Pick a session to resume
    shugu --resume=<id>         Resume specific session
    shugu --mode=<mode>         Set permission mode
    shugu --model=<name>        Set model (overrides MINIMAX_MODEL env)

  Modes:
    plan          ${MODE_DESCRIPTIONS.plan}
    default       ${MODE_DESCRIPTIONS.default}
    accept-edits  ${MODE_DESCRIPTIONS.acceptEdits}
    auto          ${MODE_DESCRIPTIONS.fullAuto}
    bypass        ${MODE_DESCRIPTIONS.bypass}

  Options:
    --continue, -c  Resume most recent session for this project
    --resume, -r    Interactive session picker
    --bypass        Shorthand for --mode=bypass
    --help, -h      Show this help

  Environment:
    MINIMAX_API_KEY          MiniMax API key (required)
    ANTHROPIC_AUTH_TOKEN     Alternative auth token
    MINIMAX_BASE_URL         Custom API base URL
    MINIMAX_MODEL            Default model name (fallback if --model not set)
`);
}

// ─── Permission Prompter ────────────────────────────────

export function createPermissionPrompter(
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

// ─── Bootstrap ──────────────────────────────────────────

export interface BootstrapResult {
  services: RuntimeServices;
  systemPrompt: string;
  needsHatchCeremony: boolean;
  resumedMessages: Message[] | null;
  /** Formatted rehydration block from the resumed session's workContext */
  resumedWorkContext: string | null;
}

export async function bootstrap(cliArgs: CliArgs): Promise<BootstrapResult> {
  const renderer = new TerminalRenderer();
  const client = new MiniMaxClient(cliArgs.model ? { model: cliArgs.model } : {});

  // Configure tracer
  if (cliArgs.verbose) tracer.setVerbose(true);
  tracer.log('session_start', { mode: cliArgs.mode, verbose: cliArgs.verbose, cwd: process.cwd() });

  const cwd = process.cwd();

  // ─── Mandatory Vault ─────────────────────────────────
  const vault = new CredentialVault();
  let credentialProvider: CredentialProvider;

  try {
    if (await vault.exists()) {
      credentialProvider = await unlockExistingVault(vault, renderer);
    } else {
      credentialProvider = await initializeNewVault(vault, renderer);
    }
    renderer.info('  Vault: unlocked');
  } catch (err: unknown) {
    const { isVaultError } = await import('../credentials/errors.js');
    if (isVaultError(err)) {
      renderer.error(`  Vault [${err.code}]: ${err.message}`);
    } else {
      renderer.error(`  Vault: ${err instanceof Error ? err.message : String(err)}`);
    }
    renderer.error('  Cannot proceed without vault. Exiting.');
    process.exit(1);
  }

  const { registry, agentTool, webFetchTool, obsidianTool } = createDefaultRegistry(credentialProvider);
  ToolRouter.validateCategories(registry.getDefinitions());
  const permResolver = new PermissionResolver(cliArgs.mode);
  const skillRegistry = createDefaultSkillRegistry();
  const commands = createDefaultCommands();

  // Load custom markdown commands (.pcc/commands/*.md)
  const builtinCommandNames = new Set(commands.getAll().flatMap(c => [c.name, ...(c.aliases ?? [])]));
  const mdCommands = loadMarkdownCommands(
    [join(homedir(), '.pcc', 'commands'), join(cwd, '.pcc', 'commands')],
    builtinCommandNames,
  );
  for (const cmd of mdCommands) commands.register(cmd);
  if (mdCommands.length > 0) {
    renderer.info(`  Custom commands: ${mdCommands.length} loaded`);
  }

  // Load plugins — local (repo-controlled) plugins require user confirmation
  const pluginRegistry = new PluginRegistry();
  const pluginResult = await pluginRegistry.loadAll(cwd, registry, commands, skillRegistry, {
    onConfirmLocal: cliArgs.mode === 'bypass'
      ? async () => true  // bypass mode trusts everything
      : async (manifest) => {
          // In interactive mode, ask the user
          return renderer.confirm(
            `Project-local plugin "${manifest.name}@${manifest.version}" found. Allow loading? [y/N]`,
          );
        },
  });
  const hookRegistry = pluginRegistry.getHookRegistry();
  if (pluginResult.loaded > 0) {
    renderer.info(`  Plugins: ${pluginResult.loaded} loaded`);
  }

  // Check hatch ceremony BEFORE buildSystemPrompt creates the companion file
  const { isFirstHatch } = await import('../ui/companion/companion.js');
  const needsHatchCeremony = isFirstHatch();

  // Register built-in hooks
  registerBehaviorHooks(hookRegistry);
  registerVerificationHook(hookRegistry);

  // File revert: track file changes for /file-revert
  const revertStack = new FileRevertStack();
  const turnAccumulator = new TurnChangeAccumulator();
  registerFileTrackingHook(hookRegistry, (path, previousContent) => {
    turnAccumulator.recordBefore(path, previousContent);
  });

  // Discover Obsidian vault
  const vaultPath = await discoverVault(cwd);
  let obsidianVault: ObsidianVault | null = null;
  if (vaultPath) {
    obsidianVault = new ObsidianVault(vaultPath);
    obsidianTool.setVault(obsidianVault);
  }

  // Unified Memory Agent
  const memoryAgent = new MemoryAgent(obsidianVault, cwd);
  await memoryAgent.loadIndex();
  memoryAgent.maintenance().catch((err) => {
    logger.debug('memory maintenance failed', err instanceof Error ? err.message : String(err));
  });

  // Automation
  const bgManager = new BackgroundManager();
  const scheduler = new Scheduler();
  const kairos = new Kairos();
  const sessionMgr = new SessionManager();

  const askPermission = createPermissionPrompter(renderer, permResolver);

  const toolContext: ToolContext = {
    cwd,
    abortSignal: new AbortController().signal,
    permissionMode: cliArgs.mode,
    askPermission,
  };

  // Load custom markdown agents (.pcc/agents/*.md)
  const customAgents = await loadMarkdownAgents([
    join(homedir(), '.pcc', 'agents'),
    join(cwd, '.pcc', 'agents'),
  ]);
  const customAgentCount = Object.keys(customAgents).length;
  if (customAgentCount > 0) {
    renderer.info(`  Custom agents: ${customAgentCount} loaded`);
  }

  // Wire agent orchestrator
  const toolMap = new Map(registry.getAll().map(t => [t.definition.name, t]));
  const orchestrator = new AgentOrchestrator(client, toolMap, toolContext, customAgentCount > 0 ? customAgents : undefined);
  agentTool.setOrchestrator(orchestrator);
  agentTool.setEventCallback(() => {});
  commands.register(createTeamCommand(orchestrator));
  commands.register(createReviewCommand(orchestrator, cwd));
  commands.register(createBatchCommand(orchestrator, client, cwd));
  commands.register(createMetaCommand(orchestrator, client, cwd));

  let builtSystemPrompt = '';

  // Register automation commands
  const loopConfigFactory = (effectiveInput?: string): LoopConfig => ({
    client,
    systemPrompt: builtSystemPrompt,
    tools: new Map(registry.getAll().map(t => [t.definition.name, t])),
    toolDefinitions: registry.getDefinitions(),
    toolContext,
    hookRegistry,
    maxTurns: 15,
    toolRouter: new ToolRouter(registry.getDefinitions()),
    effectiveInput: effectiveInput ?? '',
    complexity: 'simple',
  });
  commands.register(createVaultCommand(vault));
  commands.register(createFileRevertCommand(revertStack));
  commands.register(createBgCommand(bgManager, loopConfigFactory));
  commands.register(createProactiveCommand(async (prompt) => {
    const messages: Message[] = [{ role: 'user', content: prompt }];
    let result = '';
    for await (const event of runLoop(messages, loopConfigFactory(prompt))) {
      if (event.type === 'assistant_message') {
        result = event.message.content.filter(isTextBlock).map(b => b.text).join('');
      }
      if (event.type === 'history_sync') {
        messages.length = 0;
        messages.push(...event.messages);
      }
    }
    return result;
  }));

  // Build system prompt
  const adapters = await discoverTools(cwd);
  const promptResult = await buildSystemPrompt(cwd, skillRegistry, adapters, memoryAgent);
  builtSystemPrompt = promptResult.prompt;
  const systemPrompt = builtSystemPrompt;

  // Surface prompt-build warnings to the user
  for (const warning of promptResult.warnings) {
    renderer.error(`  ⚠ ${warning}`);
  }

  // Banner for single-shot mode
  if (cliArgs.prompt) {
    const toolNames = registry.getAll().map(t => t.definition.name);
    const cliNames = adapters.filter(a => a.installed).map(a => a.name);
    const recentSessions = await sessionMgr.listRecent(5);
    const recentActivity = recentSessions.map((s) => {
      const ago = formatTimeAgo(s.updatedAt);
      const proj = s.projectDir.split(/[\\/]/).pop() ?? '';
      return `${ago}: ${proj} (${s.turnCount}t)`;
    });
    renderer.richBanner({
      version: '0.2.0',
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

  // Status bar init
  renderer.statusBar.update({
    model: client.model,
    project: cwd.split(/[\\/]/).pop() ?? 'unknown',
    mode: cliArgs.mode,
  });

  // Handle session resume
  let resumedMessages: Message[] | null = null;
  if (cliArgs.continueSession) {
    const latest = await sessionMgr.loadLatest(cwd);
    if (latest && latest.messages.length > 0) {
      resumedMessages = latest.messages;
      renderer.info(`  Resuming session ${latest.id} (${latest.turnCount} turns, ${formatTimeAgo(latest.updatedAt)})`);
    } else {
      renderer.info('  No previous session found for this directory.');
    }
  } else if (cliArgs.resumeSession) {
    if (typeof cliArgs.resumeSession === 'string') {
      try {
        const session = await sessionMgr.load(cliArgs.resumeSession);
        if (session && session.messages.length > 0) {
          resumedMessages = session.messages;
          renderer.info(`  Resuming session ${session.id} (${session.turnCount} turns)`);
        } else {
          renderer.error(`  Session not found: ${cliArgs.resumeSession}`);
        }
      } catch (err: unknown) {
        const { SessionCorruptedError } = await import('../context/session/persistence.js');
        if (err instanceof SessionCorruptedError) {
          renderer.error(`  Session corrupted: ${cliArgs.resumeSession} — ${(err.cause as Error)?.message ?? 'unknown error'}`);
        } else {
          throw err;
        }
      }
    } else {
      const sessions = await sessionMgr.listRecent(10);
      if (sessions.length > 0) {
        renderer.info('\n  Recent sessions:');
        for (let i = 0; i < sessions.length; i++) {
          const s = sessions[i]!;
          const proj = s.projectDir.split(/[\\/]/).pop() ?? '';
          const ago = formatTimeAgo(s.updatedAt);
          renderer.info(`    ${i + 1}. [${s.id}] ${proj} — ${s.turnCount} turns, ${ago}`);
        }
        renderer.info(`\n  Use: shugu --resume=<id> to resume a specific session\n`);
      } else {
        renderer.info('  No sessions found.');
      }
    }
  }

  const services: RuntimeServices = {
    client,
    registry,
    toolContext,
    permResolver,
    hookRegistry,
    skillRegistry,
    commands,
    sessionMgr,
    bgManager,
    scheduler,
    memoryAgent,
    obsidianVault,
    credentialProvider,
    kairos,
    renderer,
    revertStack,
    turnAccumulator,
    async dispose() {
      scheduler.stop();
      vault.lock();
      await memoryAgent.flushIndex();
    },
  };

  // Extract rehydration context from resumed session's workContext
  let resumedWorkContext: string | null = null;
  if (resumedMessages) {
    // Find the session we resumed from to get its workContext
    const resumedSession = cliArgs.continueSession
      ? await sessionMgr.loadLatest(cwd)
      : typeof cliArgs.resumeSession === 'string'
        ? await sessionMgr.load(cliArgs.resumeSession).catch(() => null)
        : null;
    if (resumedSession?.workContext) {
      const { formatRehydrationBlock } = await import('../context/session/work-context.js');
      resumedWorkContext = formatRehydrationBlock(resumedSession.workContext);
    }
  }

  return { services, systemPrompt, needsHatchCeremony, resumedMessages, resumedWorkContext };
}

// ─── Vault Setup Helpers ────────────────────────────────

async function unlockExistingVault(
  vault: CredentialVault,
  renderer: TerminalRenderer,
): Promise<CredentialProvider> {
  // Priority 1: Environment variable (headless/CI)
  const envPassword = process.env['PCC_VAULT_PASSWORD'];
  if (envPassword) {
    await vault.unlock(envPassword);
    return new CredentialProvider(vault);
  }

  // Priority 2: Interactive prompt (3 attempts)
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const password = await promptPassword({ prompt: '  Vault password: ' });
      await vault.unlock(password);
      return new CredentialProvider(vault);
    } catch (err: unknown) {
      if (err instanceof WrongPasswordError) {
        renderer.error(`  Wrong password (attempt ${attempt}/${MAX_ATTEMPTS})`);
        if (attempt === MAX_ATTEMPTS) {
          throw err;
        }
        continue;
      }
      throw err; // Non-password errors propagate immediately
    }
  }
  throw new WrongPasswordError(); // Unreachable but satisfies TypeScript
}

async function initializeNewVault(
  vault: CredentialVault,
  renderer: TerminalRenderer,
): Promise<CredentialProvider> {
  renderer.info('');
  renderer.info('  ╔══════════════════════════════════════════════╗');
  renderer.info('  ║  First-time setup: Credential Vault           ║');
  renderer.info('  ║  Choose a master password for encrypting       ║');
  renderer.info('  ║  your API keys and tokens (AES-256-GCM).      ║');
  renderer.info('  ╚══════════════════════════════════════════════╝');
  renderer.info('');

  const password = await promptPassword({
    prompt: '  New vault password: ',
    confirm: true,
  });

  await vault.init(password);
  renderer.info(`  Vault created: ${vault.path}`);
  return new CredentialProvider(vault);
}
