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
import { getCompanionInstance, setCompanionMuted, setCompanionInstance } from './cli-handlers.js';
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
  const { app, budget, tokenTracker, permResolver, session, conversationMessages, client } = state;

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

  if (input === '/buddy show') {
    const { renderBuddyCompact } = await import('../ui/companion/companion.js');
    const c = getCompanionInstance();
    if (c) {
      for (const line of renderBuddyCompact(c)) {
        app.pushMessage({ type: 'info', text: line });
      }
    }
    return { handled: true };
  }

  if (input === '/buddy list') {
    const { listSlots } = await import('../ui/companion/companion.js');
    const slots = listSlots();
    if (slots.length === 0) {
      app.pushMessage({ type: 'info', text: '  No companions saved yet.' });
    } else {
      app.pushMessage({ type: 'info', text: '  ╭─── Menagerie ───────────────────╮' });
      for (const s of slots) {
        const marker = s.active ? ' ◆' : '  ';
        app.pushMessage({ type: 'info', text: `  │${marker} ${s.name.padEnd(12)} ${s.species.padEnd(10)} ${s.rarity.padEnd(10)} │` });
      }
      app.pushMessage({ type: 'info', text: '  ╰──────────────────────────────────╯' });
    }
    return { handled: true };
  }

  if (input.startsWith('/buddy save')) {
    const slotName = input.slice(11).trim() || undefined;
    const c = getCompanionInstance();
    if (c) {
      try {
        const { saveSlot } = await import('../ui/companion/companion.js');
        const name = slotName || c.name.toLowerCase();
        saveSlot(name, c);
        app.pushMessage({ type: 'info', text: `  ${c.name} saved to slot "${name}".` });
      } catch (e) {
        app.pushMessage({ type: 'info', text: `  Error: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    return { handled: true };
  }

  if (input.startsWith('/buddy summon')) {
    const slotName = input.slice(12).trim();
    if (!slotName) {
      app.pushMessage({ type: 'info', text: '  Usage: /buddy summon <slot>' });
      return { handled: true };
    }
    try {
      const { summonSlot } = await import('../ui/companion/companion.js');
      const newCompanion = summonSlot(slotName);
      setCompanionInstance(newCompanion);
      app.setCompanion(newCompanion);
      app.pushMessage({ type: 'info', text: `  ${newCompanion.name} the ${newCompanion.species} has appeared!` });
    } catch (e) {
      app.pushMessage({ type: 'info', text: `  Error: ${e instanceof Error ? e.message : String(e)}` });
    }
    return { handled: true };
  }

  if (input.startsWith('/buddy dismiss ')) {
    const slotName = input.slice(15).trim();
    if (!slotName) {
      app.pushMessage({ type: 'info', text: '  Usage: /buddy dismiss <slot>' });
      return { handled: true };
    }
    try {
      const { dismissSlot } = await import('../ui/companion/companion.js');
      const removed = dismissSlot(slotName);
      if (removed) {
        app.pushMessage({ type: 'info', text: `  Slot "${slotName}" dismissed.` });
      } else {
        app.pushMessage({ type: 'info', text: `  Slot "${slotName}" not found.` });
      }
    } catch (e) {
      app.pushMessage({ type: 'info', text: `  Error: ${e instanceof Error ? e.message : String(e)}` });
    }
    return { handled: true };
  }

  if (input.startsWith('/buddy personality ')) {
    const text = input.slice(18).trim();
    const c = getCompanionInstance();
    if (c && text) {
      c.personality = text;
      const { saveCompanion } = await import('../ui/companion/companion.js');
      saveCompanion({ name: c.name, personality: text, hatchedAt: c.hatchedAt });
      app.pushMessage({ type: 'info', text: `  ${c.name}'s personality: "${text}"` });
    }
    return { handled: true };
  }

  if (input.startsWith('/buddy frequency')) {
    const arg = input.slice(15).trim();
    const { loadBuddyConfig, saveBuddyConfig } = await import('../ui/companion/companion.js');
    if (!arg) {
      const cfg = loadBuddyConfig();
      app.pushMessage({ type: 'info', text: `  Reaction cooldown: ${cfg.cooldownSeconds}s | Observation cooldown: ${cfg.observationCooldownSeconds}s` });
    } else {
      const seconds = parseInt(arg, 10);
      if (isNaN(seconds) || seconds < 5 || seconds > 300) {
        app.pushMessage({ type: 'info', text: '  Frequency must be 5-300 seconds.' });
      } else {
        saveBuddyConfig({ cooldownSeconds: seconds });
        app.pushMessage({ type: 'info', text: `  Reaction cooldown set to ${seconds}s.` });
      }
    }
    return { handled: true };
  }

  if (input.startsWith('/buddy style')) {
    const arg = input.slice(12).trim() as 'classic' | 'round';
    if (arg === 'classic' || arg === 'round') {
      const { saveBuddyConfig } = await import('../ui/companion/companion.js');
      saveBuddyConfig({ style: arg });
      app.pushMessage({ type: 'info', text: `  Bubble style: ${arg}` });
    } else {
      app.pushMessage({ type: 'info', text: '  Usage: /buddy style [classic|round]' });
    }
    return { handled: true };
  }

  if (input.startsWith('/buddy observe')) {
    const arg = input.slice(14).trim();
    const { loadBuddyConfig, saveBuddyConfig } = await import('../ui/companion/companion.js');
    if (arg === 'on') {
      saveBuddyConfig({ observationsEnabled: true });
      app.pushMessage({ type: 'info', text: '  Buddy observations: ON — injecting into model context.' });
    } else if (arg === 'off') {
      saveBuddyConfig({ observationsEnabled: false });
      app.pushMessage({ type: 'info', text: '  Buddy observations: OFF.' });
    } else {
      const cfg = loadBuddyConfig();
      app.pushMessage({ type: 'info', text: `  Observations: ${cfg.observationsEnabled ? 'ON' : 'OFF'}. Usage: /buddy observe [on|off]` });
    }
    return { handled: true };
  }

  // ── Info commands ──
  if (input === '/cost') {
    app.pushMessage({ type: 'info', text: budget.getSummary() });
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
    app.pushMessage({ type: 'info', text: `  Context: ${status.usedTokens.toLocaleString()} / ${status.totalTokens.toLocaleString()} tokens (${status.percentUsed}%)` });
    app.pushMessage({ type: 'info', text: `  Available: ${status.availableTokens.toLocaleString()} tokens` });
    app.pushMessage({ type: 'info', text: `  Compaction needed: ${status.shouldCompact ? 'YES' : 'no'}` });
    app.pushMessage({ type: 'info', text: `  Session: ${session.id} | Turns: ${budget.getTurnCount()}` });
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
          // Carry over workContext so it survives quit-before-new-prompt
          if (s.workContext) {
            state.session.workContext = s.workContext;
          }
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
      app.pushMessage({ type: 'info', text: `  Mode changed to: ${modeMap[newMode]} — ${MODE_DESCRIPTIONS[modeMap[newMode]!]}` });
    } else {
      app.pushMessage({ type: 'error', text: `Unknown mode: ${newMode}. Valid: plan, default, accept-edits, auto, bypass` });
    }
    return { handled: true };
  }

  // ── Compaction ──
  if (input === '/compact') {
    app.pushMessage({ type: 'info', text: '  Compacting conversation...' });
    const result = await compactConversation(conversationMessages, client);
    if (result.wasCompacted) {
      conversationMessages.length = 0;
      conversationMessages.push(...result.messages);
      app.pushMessage({ type: 'info', text: `  Compacted: ${result.removedTurns} turns summarized.` });
    } else {
      app.pushMessage({ type: 'info', text: '  Nothing to compact (too few turns).' });
    }
    return { handled: true };
  }

  return { handled: false };
}
