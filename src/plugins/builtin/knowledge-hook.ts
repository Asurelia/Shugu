/**
 * Built-in hook: Knowledge auto-save
 *
 * Lightweight hook that detects memory-worthy hints in assistant messages
 * and saves them to the Obsidian vault. Uses the existing detectMemoryHints()
 * function from context/memory/extract.ts.
 *
 * Philosophy: the agent decides what to save. This hook only catches
 * explicit memory patterns ("remember that...", "I'm a...", "the decision is...").
 * For everything else, the agent uses the ObsidianTool directly.
 */

import type { HookRegistry, MessagePayload } from '../hooks.js';
import { ObsidianVault } from '../../context/memory/obsidian.js';
import { detectMemoryHints } from '../../context/memory/extract.js';

/**
 * Register the built-in knowledge extraction hooks on a HookRegistry.
 */
export function registerKnowledgeHooks(
  hookRegistry: HookRegistry,
  vault: ObsidianVault | null,
): void {
  if (!vault) return;

  // OnMessage hook: detect memory-worthy hints in assistant messages
  hookRegistry.register({
    type: 'OnMessage',
    pluginName: 'builtin:knowledge',
    priority: 90, // Low priority — runs after other hooks
    handler: async (payload: MessagePayload) => {
      if (payload.role !== 'assistant') return;

      // Extract text from the message
      const text = typeof payload.message.content === 'string'
        ? payload.message.content
        : (payload.message.content as Array<{ type: string; text?: string }>)
            .filter((b) => b.type === 'text')
            .map((b) => b.text ?? '')
            .join('');

      if (!text || text.length < 20) return;

      // Check for memory hints
      const hints = detectMemoryHints(text);
      if (hints.length === 0) return;

      // Save each hint to the vault (fire-and-forget)
      for (const hint of hints) {
        vault.saveAgentNote(hint.name, hint.content, {
          tags: [hint.type, 'auto-extracted'],
          type: 'auto-memory',
        }).catch(() => {
          // Silent failure — vault writes are best-effort
        });
      }
    },
  });
}
