/**
 * Layer 7 — Commands: /dream
 *
 * Manual trigger for DREAM memory consolidation.
 * Reads recent sessions, extracts knowledge, saves to memory.
 */

import type { Command, CommandContext, CommandResult } from './registry.js';
import type { SessionManager } from '../context/session/persistence.js';
import type { MemoryAgent } from '../context/memory/agent.js';
import type { MiniMaxClient } from '../transport/client.js';
import { DreamConsolidationService } from '../automation/dream.js';

// Singleton service instance — persists across invocations to track state
let dreamService: DreamConsolidationService | null = null;

/**
 * Create a /dream command wired to the runtime services.
 */
export function createDreamCommand(
  sessionMgr: SessionManager,
  memoryAgent: MemoryAgent,
  client: MiniMaxClient,
): Command {
  return {
    name: 'dream',
    aliases: ['consolidate'],
    description: 'Consolidate recent sessions into persistent memories (DREAM)',
    usage: '/dream [sessions=5] [minturns=3]',

    async execute(args: string, ctx: CommandContext): Promise<CommandResult> {
      if (!dreamService) {
        dreamService = new DreamConsolidationService();
      }

      // Parse optional args
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const config: Record<string, number> = {};
      for (const part of parts) {
        const [key, val] = part.split('=');
        if (key && val) {
          const num = parseInt(val, 10);
          if (!isNaN(num)) {
            if (key === 'sessions') config['maxSessions'] = num;
            else if (key === 'minturns') config['minTurns'] = num;
          }
        }
      }

      ctx.info('💭 Starting DREAM consolidation...');

      const result = await dreamService.consolidate(
        sessionMgr,
        memoryAgent,
        client,
        config,
      );

      // Report results
      const lines: string[] = [];
      lines.push(`Sessions processed: ${result.sessionsProcessed}`);
      lines.push(`Memories created: ${result.created}`);
      if (result.rejected > 0) lines.push(`Rejected (duplicates/invalid): ${result.rejected}`);
      if (result.errors.length > 0) {
        lines.push(`Errors: ${result.errors.length}`);
        for (const err of result.errors.slice(0, 3)) {
          lines.push(`  - ${err}`);
        }
      }

      if (result.created > 0) {
        ctx.info(`✅ DREAM consolidation complete:\n${lines.join('\n')}`);
      } else if (result.errors.length > 0) {
        ctx.error(`⚠️ DREAM consolidation:\n${lines.join('\n')}`);
      } else {
        ctx.info(`💤 No new memories to consolidate.\n${lines.join('\n')}`);
      }

      return { type: 'handled' };
    },
  };
}
