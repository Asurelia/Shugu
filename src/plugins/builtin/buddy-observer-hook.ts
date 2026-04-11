/**
 * Buddy Observer Hook — PostToolUse
 *
 * Feeds tool results to the BuddyObserver for real-time analysis.
 * Priority 95 (last) — purely observational, never modifies results.
 */

import type { HookRegistry, PostToolUsePayload } from '../hooks.js';
import type { BuddyObserver } from '../../ui/companion/observer.js';

export function registerBuddyObserverHook(
  hookRegistry: HookRegistry,
  observer: BuddyObserver,
): void {
  hookRegistry.register({
    type: 'PostToolUse',
    pluginName: 'builtin:buddy-observer',
    priority: 95,
    handler: async (payload: PostToolUsePayload) => {
      observer.observe(payload.tool, payload.call, payload.result, payload.durationMs);
      return {};
    },
  });
}
