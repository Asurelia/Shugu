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
import { createDefaultSkillRegistry } from '../skills/index.js';
import { PluginRegistry } from '../plugins/registry.js';
import { BackgroundManager } from '../automation/background.js';
import { Scheduler } from '../automation/scheduler.js';
import { createBgCommand, createProactiveCommand } from '../commands/automation.js';
import { createDefaultCommands } from '../commands/index.js';
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
}

export function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let mode: PermissionMode = 'default';
  let continueSession = false;
  let resumeSession: string | true | false = false;
  let verbose = false;
  const promptParts: string[] = [];

  for (const arg of args) {
    if (arg === '--bypass') {
      mode = 'bypass';
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

  return {
    mode,
    prompt: promptParts.length > 0 ? promptParts.join(' ').trim() : null,
    continueSession,
    resumeSession,
    verbose,
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
}

export async function bootstrap(cliArgs: CliArgs): Promise<BootstrapResult> {
  const renderer = new TerminalRenderer();
  const client = new MiniMaxClient();

  // Configure tracer
  if (cliArgs.verbose) tracer.setVerbose(true);
  tracer.log('session_start', { mode: cliArgs.mode, verbose: cliArgs.verbose, cwd: process.cwd() });

  const cwd = process.cwd();

  // Initialize credential vault (optional)
  const vault = new CredentialVault();
  let credentialProvider: CredentialProvider | undefined;
  if (await vault.exists()) {
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
  const skillRegistry = createDefaultSkillRegistry();
  const commands = createDefaultCommands();

  // Load plugins
  const pluginRegistry = new PluginRegistry();
  const pluginResult = await pluginRegistry.loadAll(cwd, registry, commands, skillRegistry);
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

  // Wire agent orchestrator
  const toolMap = new Map(registry.getAll().map(t => [t.definition.name, t]));
  const orchestrator = new AgentOrchestrator(client, toolMap, toolContext);
  agentTool.setOrchestrator(orchestrator);
  agentTool.setEventCallback(() => {});

  // Register automation commands
  const loopConfigFactory = (): LoopConfig => ({
    client,
    systemPrompt: '',
    tools: new Map(registry.getAll().map(t => [t.definition.name, t])),
    toolDefinitions: registry.getDefinitions(),
    toolContext,
    hookRegistry,
    maxTurns: 15,
  });
  commands.register(createBgCommand(bgManager, loopConfigFactory));
  commands.register(createProactiveCommand(async (prompt) => {
    const messages: Message[] = [{ role: 'user', content: prompt }];
    let result = '';
    for await (const event of runLoop(messages, loopConfigFactory())) {
      if (event.type === 'assistant_message') {
        result = event.message.content.filter(isTextBlock).map(b => b.text).join('');
      }
    }
    return result;
  }));

  // Build system prompt
  const adapters = await discoverTools(cwd);
  const systemPrompt = await buildSystemPrompt(cwd, skillRegistry, adapters, memoryAgent);

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
      const session = await sessionMgr.load(cliArgs.resumeSession);
      if (session && session.messages.length > 0) {
        resumedMessages = session.messages;
        renderer.info(`  Resuming session ${session.id} (${session.turnCount} turns)`);
      } else {
        renderer.error(`  Session not found: ${cliArgs.resumeSession}`);
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
    async dispose() {
      scheduler.stop();
      vault.lock();
      await memoryAgent.flushIndex();
    },
  };

  return { services, systemPrompt, needsHatchCeremony, resumedMessages };
}
