/**
 * Entrypoint — Interactive REPL
 *
 * The main interactive loop. Receives RuntimeServices, manages conversation state,
 * delegates to REPL commands and the agentic loop.
 */

import type { Message } from '../protocol/messages.js';
import { isTextBlock } from '../protocol/messages.js';
import { runLoop, type LoopConfig } from '../engine/loop.js';
import { InterruptController } from '../engine/interrupts.js';
import { BudgetTracker } from '../engine/budget.js';
import { TokenBudgetTracker, estimateTokens } from '../context/tokenBudget.js';
import { compactConversation } from '../context/compactor.js';
import type { ToolContext } from '../protocol/tools.js';
import type { CommandContext } from '../commands/index.js';
import type { SkillContext } from '../skills/index.js';
import { getGitContext } from '../context/workspace/git.js';
import { renderBanner } from '../ui/banner.js';
import { MINIMAX_MODELS } from '../transport/client.js';
import { analyzeTask } from '../engine/strategy.js';
import { runPostTurnIntelligence, type IntelligenceResult } from '../engine/intelligence.js';
import { logger } from '../utils/logger.js';
import { tracer } from '../utils/tracer.js';
import { expandFileTags } from '../context/file-tags.js';
import { extractWorkContext } from '../context/session/work-context.js';
import { ToolRouter } from '../tools/router.js';
import { createCloneCommand, createSnapshotCommand } from '../commands/session.js';
import type { SessionData } from '../context/session/persistence.js';
import type { RuntimeServices } from './services.js';
import { handleEventForApp, formatTimeAgo, getCompanionInstance, isCompanionMuted } from './cli-handlers.js';
import { handleInlineCommand, type ReplState } from './repl-commands.js';
import { buildVolatilePromptParts } from './prompt-builder.js';

export async function runREPL(
  services: RuntimeServices,
  systemPrompt: string,
  needsHatchCeremony: boolean,
  resumedMessages: Message[] | null,
  resumedWorkContext: string | null = null,
): Promise<void> {
  const {
    client, registry, toolContext, permResolver, hookRegistry,
    skillRegistry, commands, sessionMgr, bgManager, scheduler,
    obsidianVault: obsidianVaultInstance, memoryAgent, kairos, renderer,
  } = services;

  const conversationMessages: Message[] = resumedMessages ? [...resumedMessages] : [];
  const budget = new BudgetTracker(client.model);
  const tokenTracker = new TokenBudgetTracker({ model: client.model });

  // Seed token tracker from resumed session so context bar shows accurate usage
  if (resumedMessages && resumedMessages.length > 0) {
    const estimated = estimateTokens(resumedMessages);
    tokenTracker.updateFromUsage({ input_tokens: estimated, output_tokens: 0 });
  }
  let session = sessionMgr.createSession(toolContext.cwd, client.model);
  let correctionCount = 0;
  let turnCount = 0;
  let lastHumanInputIdx = -1;
  let lastRawUserInput = '';
  let pendingRehydration: string | null = resumedWorkContext;

  // Register session-aware commands (need live session reference).
  // The getter syncs session.messages from the live conversationMessages array
  // so that /clone and /snapshot always capture the current REPL state,
  // even after /resume or /snapshot load rewrites conversationMessages.
  const getLiveSession = (): SessionData => {
    session.messages = conversationMessages;
    return session;
  };
  commands.register(createCloneCommand(
    sessionMgr,
    getLiveSession,
    (cloned) => { session = cloned; },
  ));
  commands.register(createSnapshotCommand(sessionMgr, getLiveSession));
  let thinkingExpanded = false;

  // Vault refresh tracking
  let lastVaultRefresh = Date.now();
  let dynamicVaultContext = '';
  let latestVolatileParts: string[] = [];

  // Skill execution helpers
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
      systemPrompt: [
        { type: 'text' as const, text: systemPrompt as string, cache_control: { type: 'ephemeral' as const } },
        ...(latestVolatileParts.length > 0
          ? [{ type: 'text' as const, text: latestVolatileParts.join('\n\n') }]
          : []),
      ],
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

  // Launch Ink app
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

  // Wire rich agent event rendering
  const { AgentTool: AgentToolClass } = await import('../tools/agents/AgentTool.js');
  const agentToolInstance = registry.getAll().find(t => t.definition.name === 'Agent');
  if (agentToolInstance && agentToolInstance instanceof AgentToolClass) {
    const AGENT_COLORS: Record<string, string> = {
      general: 'blue', explore: 'cyan', code: 'green', review: 'yellow', test: 'magenta',
    };
    agentToolInstance.setEventCallback((evt) => {
      const color = AGENT_COLORS[evt.agentType] ?? 'blue';
      const prefix = `  [${evt.agentType}]`;
      switch (evt.event) {
        case 'start':
          app.pushMessage({ type: 'info', text: `\x1b[1m\x1b[34m${prefix}\x1b[0m \x1b[2mStarting: ${evt.message ?? ''}\x1b[0m` });
          break;
        case 'tool':
          app.pushMessage({ type: 'info', text: `\x1b[36m${prefix}\x1b[0m \x1b[33m${evt.toolName}\x1b[0m${evt.toolDetail ? ` \x1b[2m${evt.toolDetail}\x1b[0m` : ''}` });
          break;
        case 'text':
          app.pushMessage({ type: 'info', text: `\x1b[36m${prefix}\x1b[0m \x1b[2m${evt.message ?? ''}\x1b[0m` });
          break;
        case 'done':
          app.pushMessage({ type: 'info', text: `\x1b[32m${prefix}\x1b[0m \x1b[2mDone (${evt.turns} turns, $${evt.cost?.toFixed(4)})\x1b[0m` });
          break;
        case 'error':
          app.pushMessage({ type: 'info', text: `\x1b[31m${prefix}\x1b[0m \x1b[31m${evt.message ?? 'Error'}\x1b[0m` });
          break;
      }
    });
  }

  // Push banner into scrollable area
  const bannerSessions = await sessionMgr.listRecent(5);
  const bannerActivity = bannerSessions.map((s) => {
    const ago = formatTimeAgo(s.updatedAt);
    const proj = s.projectDir.split(/[\\/]/).pop() ?? '';
    return `${ago}: ${proj} (${s.turnCount}t)`;
  });
  const bannerText = renderBanner({
    version: '0.2.0',
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

  // Set session title
  try {
    const gitCtx = await getGitContext(toolContext.cwd);
    const projectName = toolContext.cwd.split(/[\\/]/).pop() ?? '';
    const branch = gitCtx.branch && gitCtx.branch !== 'unknown' ? gitCtx.branch : '';
    const title = branch ? `${projectName} ─ ${branch}` : projectName;
    app.setSessionTitle(title);
  } catch {
    app.setSessionTitle(toolContext.cwd.split(/[\\/]/).pop() ?? 'shugu');
  }

  // Hatch ceremony
  const { renderHatchCeremony } = await import('../ui/companion/companion.js');
  const { generateReaction } = await import('../ui/companion/prompt.js');
  if (needsHatchCeremony) {
    const c = getCompanionInstance();
    if (c) {
      for (const line of renderHatchCeremony(c)) {
        app.pushMessage({ type: 'info', text: line });
      }
    }
  }

  // Set companion on live UI
  const companionInstance = getCompanionInstance();
  if (companionInstance) {
    app.setCompanion(companionInstance);
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
    // Only recompute workContext if we have a tracked human input;
    // after /resume (lastHumanInputIdx = -1), preserve existing workContext
    if (lastHumanInputIdx >= 0) {
      session.workContext = extractWorkContext(conversationMessages, lastHumanInputIdx, lastRawUserInput);
    }
    await sessionMgr.save(session).catch((err) => {
      logger.debug('session save failed', err instanceof Error ? err.message : String(err));
    });
  };

  process.on('SIGINT', async () => {
    app.unmount();
    await saveSession();
    await services.dispose();
    process.exit(0);
  });

  // Command context for registry-based commands
  const cmdCtx: CommandContext = {
    cwd: toolContext.cwd,
    messages: conversationMessages,
    info: (msg) => renderer.info(msg),
    error: (msg) => renderer.error(msg),
    client,
  };

  // Repl state for inline command handlers
  const replState: ReplState = {
    app,
    budget,
    tokenTracker,
    renderer,
    permResolver,
    session,
    conversationMessages,
    client,
    thinkingExpanded,
    lastHumanInputIdx,
  };

  // ─── Main REPL Loop ──────────────────────────────────

  while (true) {
    const input = await askQuestion();
    if (!input) {
      renderer.statusBar.redraw();
      continue;
    }

    // ── Inline REPL commands (need direct state access) ──
    // Sync state bidirectionally: write before call, read back after
    replState.thinkingExpanded = thinkingExpanded;
    replState.lastHumanInputIdx = lastHumanInputIdx;
    const inlineResult = await handleInlineCommand(input, replState);
    lastHumanInputIdx = replState.lastHumanInputIdx; // read back (may be reset by /resume)
    if (inlineResult.handled) {
      if (inlineResult.thinkingExpanded !== undefined) {
        thinkingExpanded = inlineResult.thinkingExpanded;
      }
      continue;
    }
    const isRetry = inlineResult.retry === true;

    // For retry: recover the original human input for strategy/memory analysis
    let effectiveInput = input;
    if (isRetry && lastHumanInputIdx >= 0 && lastHumanInputIdx < conversationMessages.length) {
      const preserved = conversationMessages[lastHumanInputIdx]!;
      effectiveInput = typeof preserved.content === 'string'
        ? preserved.content
        : (preserved.content as Array<{ type: string; text?: string }>)
            .filter((b) => b.type === 'text')
            .map((b) => b.text ?? '')
            .join('\n');
    }

    if (!isRetry) {
      // Trace
      tracer.startTrace();
      tracer.log('user_input', { input: input.slice(0, 200), length: input.length });

      // Correction detection
      const correctionPatterns = /^(non|no|pas ça|not that|c'est faux|wrong|incorrect|ce n'est pas|that's not|arrête|stop|undo)/i;
      if (correctionPatterns.test(input.trim())) {
        correctionCount++;
      }
      turnCount++;

      // KAIROS
      const kairosNotif = kairos.onUserInput();
      if (kairosNotif) {
        if (kairosNotif.type === 'away_summary') {
          app.pushMessage({ type: 'info', text: `  💤 ${kairosNotif.message}` });
        } else if (kairosNotif.type === 'break_suggestion') {
          app.pushMessage({ type: 'info', text: `  ☕ ${kairosNotif.message}` });
        }
      }

      // Show user message immediately (before processing)
      if (!input.startsWith('/') || input.startsWith('/vibe') || input.startsWith('/dream') || input.startsWith('/hunt') || input.startsWith('/brain') || input.startsWith('/proactive')) {
        app.pushMessage({ type: 'user', text: input });
      }

      // ── Skill matching ──
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
            lastHumanInputIdx = conversationMessages.length - 1;
          }
        }
      }
      if (skillHandled) continue;

    // ── Command registry dispatch ──
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
            app.pushMessage({ type: 'info', text: kairos.getSessionSummary(conversationMessages) });
            if (turnCount > 3 && correctionCount > 0) {
              const ratio = Math.round((correctionCount / turnCount) * 100);
              app.pushMessage({ type: 'info', text: `  Corrections: ${correctionCount}/${turnCount} turns (${ratio}%)` });
              if (ratio > 30 && memoryAgent) {
                memoryAgent.save({
                  title: 'High correction rate',
                  content: `Session had ${ratio}% correction rate (${correctionCount}/${turnCount}). Consider more explicit prompts or breaking tasks into smaller steps.`,
                  type: 'preference',
                  confidence: 0.6,
                  source: 'hint',
                  tags: ['feedback', 'auto-evaluation'],
                  timestamp: new Date().toISOString(),
                });
              }
            }
            tracer.log('session_end', { turns: turnCount, corrections: correctionCount, cost: budget.getTotalCostUsd() });
            renderer.loopEnd(cmdResult.reason, budget.getTotalCostUsd());
            await services.dispose();
            return;
          case 'error':
            renderer.error(cmdResult.message);
            continue;
          case 'prompt':
            app.pushMessage({ type: 'user', text: input });
            conversationMessages.push({ role: 'user', content: cmdResult.prompt });
            lastHumanInputIdx = conversationMessages.length - 1;
            break;
        }
      }
      if (cmdResult?.type !== 'prompt') continue;
    } else {
      // Capture raw input before file expansion (for workContext.currentGoal)
      lastRawUserInput = input;
      // Expand @file tags in user input
      const { expandedContent, taggedFiles, truncated } = await expandFileTags(input, toolContext.cwd);
      if (taggedFiles.length > 0) {
        const existing = taggedFiles.filter(f => f.exists);
        const missing = taggedFiles.filter(f => !f.exists);
        if (existing.length > 0) {
          app.pushMessage({ type: 'info', text: `  Tagged: ${existing.map(f => f.raw).join(', ')}${truncated ? ' (some content truncated)' : ''}` });
        }
        if (missing.length > 0) {
          app.pushMessage({ type: 'info', text: `  Not found: ${missing.map(f => f.raw).join(', ')}` });
        }
      }
      conversationMessages.push({ role: 'user', content: expandedContent });
      lastHumanInputIdx = conversationMessages.length - 1;
    }
    } // end if (!isRetry)

    // ── Strategy analysis ──
    const strategy = await analyzeTask(effectiveInput, conversationMessages, client);
    if (strategy.complexity !== 'trivial' && strategy.strategyPrompt) {
      tracer.log('strategy', { complexity: strategy.complexity, classifiedBy: strategy.classifiedBy, reflectionInterval: strategy.reflectionInterval });
      app.pushMessage({ type: 'info', text: `  ⚡ Strategy: ${strategy.complexity} (${strategy.classifiedBy})` });
    }

    // ── Mid-conversation vault refresh (throttled 60s) ──
    if (obsidianVaultInstance && (Date.now() - lastVaultRefresh) > 60_000) {
      try {
        dynamicVaultContext = await obsidianVaultInstance.refreshContext();
        lastVaultRefresh = Date.now();
      } catch { /* non-critical */ }
    }

    // ── Build volatile prompt parts ──
    let memoryContext: string | undefined;
    if (memoryAgent && effectiveInput.length > 10) {
      memoryContext = await memoryAgent.getRelevantContext(effectiveInput, 5) ?? undefined;
    }

    const volatileParts = buildVolatilePromptParts({
      mode: permResolver.getMode(),
      dynamicVaultContext,
      strategyPrompt: strategy.strategyPrompt ?? undefined,
      kairosContext: kairos.shouldInjectTimeContext() ? kairos.getTimeContext() : undefined,
      memoryContext,
    });
    // Inject rehydration context on the first turn after resume (once only)
    if (pendingRehydration) {
      volatileParts.unshift(pendingRehydration);
      pendingRehydration = null;
    }
    latestVolatileParts = volatileParts;

    // ── Auto-compaction ──
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

    // ── Execute agentic loop ──
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

    const currentSystemPrompt: import('../protocol/messages.js').SystemPromptBlock[] = [
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
      ...(volatileParts.length > 0
        ? [{ type: 'text' as const, text: volatileParts.join('\n\n') }]
        : []),
    ];

    const config: LoopConfig = {
      client,
      systemPrompt: currentSystemPrompt,
      tools: new Map(registry.getAll().map(t => [t.definition.name, t])),
      toolDefinitions: registry.getDefinitions(),
      toolContext: turnToolContext,
      hookRegistry,
      maxTurns: 25,
      reflectionInterval: strategy.reflectionInterval,
      // M2.7 alignment: dynamic tool routing + per-call memory refresh
      toolRouter: new ToolRouter(registry.getDefinitions()),
      complexity: strategy.complexity,
      effectiveInput,
      refreshContext: async (query: string, _turnIndex: number): Promise<string[] | null> => {
        let refreshedMemory: string | undefined;
        if (memoryAgent && query.length > 10) {
          refreshedMemory = await memoryAgent.getRelevantContext(query, 3) ?? undefined;
        }
        if (obsidianVaultInstance && (Date.now() - lastVaultRefresh) > 60_000) {
          try {
            dynamicVaultContext = await obsidianVaultInstance.refreshContext();
            lastVaultRefresh = Date.now();
          } catch { /* non-critical */ }
        }
        return buildVolatilePromptParts({
          mode: permResolver.getMode(),
          dynamicVaultContext,
          strategyPrompt: strategy.strategyPrompt ?? undefined,
          kairosContext: kairos.shouldInjectTimeContext() ? kairos.getTimeContext() : undefined,
          memoryContext: refreshedMemory,
        });
      },
    };

    let lastOutputTokens = 0;
    const streamStart = Date.now();
    app.startStreaming();

    for await (const event of runLoop(conversationMessages, config, interrupt)) {
      handleEventForApp(event, app, budget);

      // Companion reactions
      if (companionInstance && !isCompanionMuted()) {
        if (event.type === 'tool_executing') {
          const r = generateReaction(companionInstance, { type: 'tool_start', tool: event.call.name });
          if (r) app.setCompanionReaction(r);
        } else if (event.type === 'error') {
          const r = generateReaction(companionInstance, { type: 'error' });
          if (r) app.setCompanionReaction(r);
        }
      }

      if (event.type === 'history_sync') {
        // Replace conversation with canonical loop history
        // This ensures tool_result messages are persisted between REPL turns
        conversationMessages.length = 0;
        conversationMessages.push(...event.messages);
      }
      if (event.type === 'turn_end') {
        tokenTracker.updateFromUsage(event.usage);
        lastOutputTokens = event.usage.output_tokens;
        const status = tokenTracker.getStatus();
        renderer.statusBar.update({
          contextPercent: status.percentUsed,
          contextUsed: status.usedTokens,
          costUsd: budget.getTotalCostUsd(),
        });

      }
    }

    // Flush file changes to revert stack (after all tool calls in this user turn)
    const { revertStack, turnAccumulator } = services;
    const revertEntry = turnAccumulator.flush(turnCount);
    if (revertEntry) {
      revertStack.push(revertEntry);
    }

    // Brew timer
    const brewMs = Date.now() - streamStart;
    app.pushMessage({ type: 'brew', durationMs: brewMs, tokens: lastOutputTokens });
    app.stopStreaming();
    app.setStatus(renderer.statusBar.render());

    // Companion done reaction
    if (companionInstance && !isCompanionMuted()) {
      const r = generateReaction(companionInstance, { type: 'done' });
      if (r) app.setCompanionReaction(r);
    }

    process.removeListener('SIGINT', sigintHandler);

    // Post-turn intelligence (fire-and-forget)
    runPostTurnIntelligence(
      {
        client,
        messages: conversationMessages,
        enableSuggestion: true,
        enableSpeculation: true,
        enableMemoryExtraction: true,
        intelligenceModel: MINIMAX_MODELS.fast,
      },
      (result: IntelligenceResult) => {
        if (result.suggestion) {
          app.pushMessage({ type: 'info', text: `  💡 ${result.suggestion}` });
        }
        if (result.speculation) {
          app.pushMessage({ type: 'info', text: `  ⚡ Pre-analysis: ${result.speculation.analysis.split('\n')[0]?.slice(0, 100) ?? ''}` });
        }
        if (result.memories.length > 0 && memoryAgent) {
          memoryAgent.saveLLMExtracted(result.memories).then((saved) => {
            if (saved > 0) {
              tracer.log('memory_save', { count: saved, source: 'llm_extraction' });
              app.pushMessage({ type: 'info', text: `  📝 ${saved} memory note(s) saved` });
            }
            memoryAgent.flushIndex();
          }).catch((err) => {
            logger.debug('memory save failed', err instanceof Error ? err.message : String(err));
          });
        }
      },
    ).catch((err) => {
      logger.debug('post-turn intelligence failed', err instanceof Error ? err.message : String(err));
    });

    // Save session (single path — includes workContext extraction)
    await saveSession();
  }
}
