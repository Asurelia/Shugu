/**
 * Entrypoint — REPL Commands
 *
 * Inline slash command handlers that need direct access to REPL state.
 * These are commands that can't go through the generic CommandRegistry
 * because they manipulate live REPL state (companion, budget, tokens, mode, etc.).
 */

import type { AppHandle } from '../ui/FullApp.js';
import type { BudgetTracker } from '../engine/budget.js';
import type { TokenBudgetTracker } from '../context/tokenBudget.js';
import type { TerminalRenderer } from '../ui/renderer.js';
import type { PermissionResolver } from '../policy/permissions.js';
import type { PermissionMode } from '../protocol/tools.js';
import type { Message } from '../protocol/messages.js';
import type { SessionData, SessionManager } from '../context/session/persistence.js';
import { MODE_DESCRIPTIONS } from '../policy/modes.js';
import { compactConversation } from '../context/compactor.js';
import type { MiniMaxClient } from '../transport/client.js';
import { getCompanionInstance, setCompanionMuted } from './cli-handlers.js';
import { formatTimeAgo } from './cli-handlers.js';

export interface ReplState {
  app: AppHandle;
  budget: BudgetTracker;
  tokenTracker: TokenBudgetTracker;
  renderer: TerminalRenderer;
  permResolver: PermissionResolver;
  session: SessionData;
  conversationMessages: Message[];
  client: MiniMaxClient;
  thinkingExpanded: boolean;
  /** Index of the last real human message in conversationMessages (-1 = none) */
  lastHumanInputIdx: number;
}

/**
 * Handle inline REPL commands that need direct state access.
 * Returns true if the command was handled (caller should `continue`).
 * Returns false if input is not a recognized inline command.
 */
export async function handleInlineCommand(
  input: string,
  state: ReplState,
): Promise<{ handled: boolean; thinkingExpanded?: boolean; retry?: boolean }> {
  const { app, budget, tokenTracker, renderer, permResolver, session, conversationMessages, client } = state;

  // ── Companion commands ──
  if (input === '/buddy' || input === '/pet') {
    const { renderBuddyCompact } = await import('../ui/companion/companion.js');
    const c = getCompanionInstance();
    if (c) {
      for (const line of renderBuddyCompact(c)) {
        app.pushMessage({ type: 'info', text: line });
      }
    }
    return { handled: true };
  }

  if (input === '/buddy card' || input === '/buddy info' || input === '/buddy stats') {
    const { renderBuddyCard } = await import('../ui/companion/companion.js');
    const c = getCompanionInstance();
    if (c) {
      for (const line of renderBuddyCard(c)) {
        app.pushMessage({ type: 'info', text: line });
      }
    }
    return { handled: true };
  }

  if (input === '/buddy pet') {
    const { generateReaction } = await import('../ui/companion/prompt.js');
    const c = getCompanionInstance();
    if (c) {
      app.pushMessage({ type: 'info', text: `  ♥ ♥ ♥  ${c.name} purrs happily!  ♥ ♥ ♥` });
      app.setCompanionPetted(true);
      const r = generateReaction(c, { type: 'pet' });
      if (r) app.setCompanionReaction(r);
    }
    return { handled: true };
  }

  if (input === '/buddy mute') {
    setCompanionMuted(true);
    app.pushMessage({ type: 'info', text: '  Companion muted. Use /buddy unmute to restore.' });
    return { handled: true };
  }

  if (input === '/buddy unmute') {
    setCompanionMuted(false);
    app.pushMessage({ type: 'info', text: '  Companion unmuted.' });
    return { handled: true };
  }

  if (input === '/buddy off') {
    setCompanionMuted(true);
    app.pushMessage({ type: 'info', text: '  Companion hidden. Use /buddy to show again.' });
    return { handled: true };
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
    return { handled: true };
  }

  // ── Info commands ──
  if (input === '/cost') {
    renderer.usage(budget.getSummary());
    return { handled: true };
  }

  if (input === '/expand' || input === '/transcript') {
    app.dumpTranscript();
    return { handled: true };
  }

  if (input === '/thinking' || input === '/think') {
    const newState = !state.thinkingExpanded;
    app.setExpandThinking(newState);
    app.pushMessage({
      type: 'info',
      text: newState
        ? '  ∴ Thinking: EXPANDED — full reasoning visible'
        : '  ∴ Thinking: COLLAPSED — single line preview',
    });
    return { handled: true, thinkingExpanded: newState };
  }

  if (input === '/context') {
    const status = tokenTracker.getStatus();
    renderer.info(`Context: ${status.usedTokens.toLocaleString()} / ${status.totalTokens.toLocaleString()} tokens (${status.percentUsed}%)`);
    renderer.info(`Available: ${status.availableTokens.toLocaleString()} tokens`);
    renderer.info(`Compaction needed: ${status.shouldCompact ? 'YES' : 'no'}`);
    renderer.info(`Session: ${session.id} | Turns: ${budget.getTurnCount()}`);
    return { handled: true };
  }

  // ── Session commands ──
  if (input === '/resume' || input === '/continue' || input.startsWith('/resume ')) {
    const targetId = input.startsWith('/resume ') ? input.slice(8).trim() : null;
    const resMgr = new (await import('../context/session/persistence.js')).SessionManager();
    if (targetId) {
      try {
        const s = await resMgr.load(targetId);
        if (s && s.messages.length > 0) {
          conversationMessages.length = 0;
          conversationMessages.push(...s.messages);
          tokenTracker.reset();
          state.lastHumanInputIdx = -1; // Reset: resumed history has no tracked human input
          app.pushMessage({ type: 'info', text: `  Resumed session ${s.id} (${s.turnCount} turns)` });
        } else {
          app.pushMessage({ type: 'error', text: `Session not found: ${targetId}` });
        }
      } catch (err: unknown) {
        const { SessionCorruptedError } = await import('../context/session/persistence.js');
        if (err instanceof SessionCorruptedError) {
          app.pushMessage({ type: 'error', text: `Session corrupted: ${targetId} — ${(err.cause as Error)?.message ?? 'unknown error'}` });
        } else {
          throw err;
        }
      }
    } else {
      const sessions = await resMgr.listRecent(10);
      if (sessions.length > 0) {
        app.pushMessage({ type: 'info', text: '  Recent sessions:' });
        for (const s of sessions) {
          const proj = s.projectDir.split(/[\\/]/).pop() ?? '';
          const ago = formatTimeAgo(s.updatedAt);
          app.pushMessage({ type: 'info', text: `    [${s.id}] ${proj} — ${s.turnCount}t, ${ago}` });
        }
        app.pushMessage({ type: 'info', text: '  Use /resume <id> to load a session' });
      } else {
        app.pushMessage({ type: 'info', text: '  No sessions found.' });
      }
    }
    return { handled: true };
  }

  // ── Retry last turn ──
  if (input === '/retry') {
    const { lastHumanInputIdx } = state;

    if (lastHumanInputIdx < 0 || lastHumanInputIdx >= conversationMessages.length) {
      app.pushMessage({ type: 'error', text: 'Nothing to retry.' });
      return { handled: true };
    }

    if (lastHumanInputIdx === conversationMessages.length - 1) {
      app.pushMessage({ type: 'error', text: 'No assistant response to retry.' });
      return { handled: true };
    }

    // Pop everything after the last human input (assistant responses, tool_results, synthetic messages)
    const popped = conversationMessages.length - lastHumanInputIdx - 1;
    conversationMessages.splice(lastHumanInputIdx + 1);

    app.pushMessage({ type: 'info', text: `  Retrying (removed ${popped} message(s))...` });
    return { handled: false, retry: true };
  }

  // ── Mode switching ──
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
    return { handled: true };
  }

  // ── Compaction ──
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
    return { handled: true };
  }

  return { handled: false };
}
