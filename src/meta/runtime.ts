/**
 * Meta-Harness: Non-Interactive Runtime Factory
 *
 * bootstrapMeta() replicates the full pipeline of bootstrap()
 * (src/entrypoints/bootstrap.ts:186) without interactive components:
 * - No TTY vault password prompt (uses PCC_VAULT_PASSWORD env var)
 * - No terminal renderer, REPL, or banner
 * - No session resume picker
 * - fullAuto permission mode (no askPermission prompts)
 * - Auto-accept for local plugins
 *
 * This produces a complete RuntimeServices + LoopConfig,
 * NOT just a raw runLoop() wrapper.
 */

import type { ToolContext } from '../protocol/tools.js';
import { MiniMaxClient } from '../transport/client.js';
import { createDefaultRegistry } from '../tools/index.js';
import { PermissionResolver } from '../policy/permissions.js';
import { CredentialVault } from '../credentials/vault.js';
import { CredentialProvider } from '../credentials/provider.js';
import { PluginRegistry } from '../plugins/registry.js';
import { registerBehaviorHooks } from '../plugins/builtin/behavior-hooks.js';
import { registerVerificationHook } from '../plugins/builtin/verification-hook.js';
import { AgentOrchestrator } from '../agents/orchestrator.js';
import { buildSystemPrompt } from '../entrypoints/prompt-builder.js';
import type { LoopConfig } from '../engine/loop.js';
import type { MetaRuntimeConfig, HarnessRuntime } from './types.js';
import type { AgentDefinition } from '../agents/orchestrator.js';
import { tracer } from '../utils/tracer.js';

// ─── Meta Runtime ─────────────────────────────────────

export interface MetaRuntime {
  loopConfig: LoopConfig;
  orchestrator: AgentOrchestrator;
  systemPrompt: string;
  dispose(): Promise<void>;
}

/**
 * Bootstrap a non-interactive Shugu runtime for Meta-Harness evaluation.
 *
 * This mirrors the service construction in bootstrap() but strips away
 * all interactive components. The result is a fully wired runtime that
 * can execute tasks headlessly via runStructuredQuery().
 */
export async function bootstrapMeta(config: MetaRuntimeConfig): Promise<MetaRuntime> {
  const { harnessConfig, cwd, archivePath } = config;
  const permissionMode = config.permissionMode ?? 'fullAuto';

  tracer.log('session_start', { mode: 'meta', cwd, archivePath });

  // ── 1. Client ──────────────────────────────────────
  const clientConfig: Record<string, unknown> = {};
  if (harnessConfig.model?.temperature !== undefined) {
    clientConfig.temperature = harnessConfig.model.temperature;
  }
  if (harnessConfig.model?.maxTokens !== undefined) {
    clientConfig.maxTokens = harnessConfig.model.maxTokens;
  }
  const client = new MiniMaxClient(clientConfig);

  // ── 2. Credentials ─────────────────────────────────
  // In meta mode, vault unlocks via env var only (no TTY prompt)
  const vault = new CredentialVault();
  let credentialProvider: CredentialProvider;
  const envPassword = process.env['PCC_VAULT_PASSWORD'];
  if (envPassword && await vault.exists()) {
    await vault.unlock(envPassword);
    credentialProvider = new CredentialProvider(vault);
  } else {
    // If no vault or no password, create a provider without vault access
    // This is acceptable for evaluation — most tasks don't need credentials
    credentialProvider = new CredentialProvider(null as unknown as CredentialVault);
  }

  // ── 3. Tool Registry ───────────────────────────────
  const { registry, agentTool } = createDefaultRegistry(credentialProvider);

  // ── 4. Permissions ─────────────────────────────────
  const permResolver = new PermissionResolver(permissionMode);
  const askPermission = async (_tool: string, _action: string): Promise<boolean> => true;

  // ── 5. Plugins & Hooks ─────────────────────────────
  const pluginRegistry = new PluginRegistry();
  await pluginRegistry.loadAll(cwd, registry, /* no commands */ undefined as never, /* no skills */ undefined as never, {
    onConfirmLocal: async () => true, // auto-accept in meta mode
  }).catch(() => { /* plugin loading is non-critical */ });

  const hookRegistry = pluginRegistry.getHookRegistry();
  registerBehaviorHooks(hookRegistry);
  registerVerificationHook(hookRegistry);

  // ── 6. Tool Context ────────────────────────────────
  const toolContext: ToolContext = {
    cwd,
    abortSignal: new AbortController().signal,
    permissionMode,
    askPermission,
  };

  // ── 7. Agent Orchestrator ──────────────────────────
  const toolMap = new Map(registry.getAll().map(t => [t.definition.name, t]));

  // Merge harness agent profiles with builtins
  let agentRegistry: Record<string, AgentDefinition> | undefined;
  if (harnessConfig.agents) {
    // Import BUILTIN_AGENTS to merge with
    const { BUILTIN_AGENTS } = await import('../agents/orchestrator.js');
    agentRegistry = { ...BUILTIN_AGENTS };
    for (const [name, partial] of Object.entries(harnessConfig.agents)) {
      const base = agentRegistry[name] ?? BUILTIN_AGENTS['general']!;
      agentRegistry[name] = { ...base, ...partial, name } as AgentDefinition;
    }
  }

  const orchestrator = new AgentOrchestrator(client, toolMap, toolContext, agentRegistry);
  agentTool.setOrchestrator(orchestrator);
  agentTool.setEventCallback(() => {});

  // ── 8. System Prompt ───────────────────────────────
  const promptResult = await buildSystemPrompt(
    cwd,
    undefined, // no skills in meta mode
    undefined, // no adapters
    undefined, // no memory agent
    harnessConfig,
  );
  const systemPrompt = promptResult.prompt;

  // ── 9. Build LoopConfig ────────────────────────────
  const harnessRuntime: HarnessRuntime = {};
  if (harnessConfig.limits?.toolTimeoutMs !== undefined) {
    harnessRuntime.toolTimeoutMs = harnessConfig.limits.toolTimeoutMs;
  }
  if (harnessConfig.reflection?.forceInterval !== undefined) {
    harnessRuntime.reflectionInterval = harnessConfig.reflection.forceInterval;
  }
  if (harnessConfig.reflection?.promptTemplate) {
    harnessRuntime.reflectionTemplate = harnessConfig.reflection.promptTemplate;
  }

  const loopConfig: LoopConfig = {
    client,
    systemPrompt,
    tools: new Map(registry.getAll().map(t => [t.definition.name, t])),
    toolDefinitions: registry.getDefinitions(),
    toolContext,
    hookRegistry,
    maxTurns: harnessConfig.limits?.maxTurns ?? 25,
    maxBudgetUsd: harnessConfig.limits?.maxBudgetUsd,
    harnessRuntime: Object.keys(harnessRuntime).length > 0 ? harnessRuntime : undefined,
  };

  return {
    loopConfig,
    orchestrator,
    systemPrompt,
    async dispose() {
      vault.lock();
    },
  };
}
