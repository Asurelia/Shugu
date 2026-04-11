/**
 * Layer 6 — Automation: DREAM Consolidation Service
 *
 * Reads recent session files, extracts knowledge-worthy facts,
 * and saves them via MemoryAgent. This is the foundation for
 * autonomous memory consolidation (KAIROS-triggered).
 *
 * DREAM = Distill, Retain, Extract, Augment, Memorize
 */

import type { MiniMaxClient } from '../transport/client.js';
import type { SessionManager, SessionData } from '../context/session/persistence.js';
import type { MemoryAgent, MemoryItem } from '../context/memory/agent.js';
import { logger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────

export interface ConsolidationResult {
  /** Number of new memories created */
  created: number;
  /** Number of existing memories updated */
  updated: number;
  /** Number of items rejected (duplicates, low-value) */
  rejected: number;
  /** Sessions processed */
  sessionsProcessed: number;
  /** Errors encountered (non-fatal) */
  errors: string[];
}

export interface DreamConfig {
  /** Maximum number of recent sessions to consolidate. Default: 5 */
  maxSessions: number;
  /** Minimum turns for a session to be worth consolidating. Default: 3 */
  minTurns: number;
  /** Maximum tokens for the consolidation prompt response. Default: 2048 */
  maxTokens: number;
}

const DEFAULT_CONFIG: DreamConfig = {
  maxSessions: 5,
  minTurns: 3,
  maxTokens: 2048,
};

// ─── Consolidation Prompt ─────────────────────────────

const CONSOLIDATION_PROMPT = `You are a memory consolidation agent. Your job is to extract knowledge-worthy facts from recent coding sessions.

For each session provided, identify:
1. **Decisions** made (architecture choices, tool selections, approach changes)
2. **Preferences** expressed by the user (coding style, workflow preferences, what they like/dislike)
3. **Project facts** discovered (file locations, API patterns, dependencies, constraints)
4. **Error solutions** found (specific errors and their fixes)
5. **References** to external resources (URLs, docs, tools mentioned)

## Output Format

For EACH memory worth saving, output exactly one line in this format:
MEMORY: <type> | <title> | <content>

Where <type> is one of: decision, preference, project_fact, error_solution, reference

## Rules
- Only extract facts that would be useful in FUTURE sessions (not just this one)
- Be specific: include file paths, function names, error messages
- Do NOT extract ephemeral information (what file was edited, what test was run)
- Do NOT duplicate information that's already in the codebase (e.g., what a function does)
- Prefer the user's exact words for preferences
- Keep each memory concise (1-2 sentences)
- If a session has nothing worth remembering, output: NONE

## Sessions to consolidate:

`;

// ─── Service ──────────────────────────────────────────

export class DreamConsolidationService {
  private lastConsolidatedAt: Date | null = null;
  private lastSessionIds: Set<string> = new Set();
  private consolidating = false;

  /**
   * Consolidate recent sessions into persistent memories.
   */
  async consolidate(
    sessionMgr: SessionManager,
    memoryAgent: MemoryAgent,
    client: MiniMaxClient,
    config: Partial<DreamConfig> = {},
  ): Promise<ConsolidationResult> {
    if (this.consolidating) {
      return { created: 0, updated: 0, rejected: 0, sessionsProcessed: 0, errors: ['Consolidation already in progress'] };
    }

    this.consolidating = true;
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const result: ConsolidationResult = { created: 0, updated: 0, rejected: 0, sessionsProcessed: 0, errors: [] };

    try {
      // 1. Get recent sessions
      const summaries = await sessionMgr.listRecent(cfg.maxSessions * 2); // Fetch extra to filter
      const candidates = summaries
        .filter(s => s.turnCount >= cfg.minTurns)
        .filter(s => !this.lastSessionIds.has(s.id))
        .slice(0, cfg.maxSessions);

      if (candidates.length === 0) {
        return { ...result, errors: ['No new sessions to consolidate'] };
      }

      // 2. Load full session data
      const sessions: SessionData[] = [];
      for (const summary of candidates) {
        try {
          const session = await sessionMgr.load(summary.id);
          if (session) sessions.push(session);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`Failed to load session ${summary.id}: ${msg}`);
        }
      }

      if (sessions.length === 0) {
        return { ...result, errors: [...result.errors, 'No sessions could be loaded'] };
      }

      // 3. Build consolidation prompt
      const sessionTexts = sessions.map((s, i) => {
        const messages = s.messages
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => {
            const content = typeof m.content === 'string'
              ? m.content
              : m.content
                  .filter(b => 'text' in b && b.type === 'text')
                  .map(b => (b as { text: string }).text)
                  .join('\n');
            // Truncate long messages
            const truncated = content.length > 1000 ? content.slice(0, 1000) + '...' : content;
            return `[${m.role}]: ${truncated}`;
          })
          .join('\n');

        return `--- Session ${i + 1} (${s.id}, ${s.turnCount} turns, ${s.updatedAt}) ---\n${messages}`;
      }).join('\n\n');

      const fullPrompt = CONSOLIDATION_PROMPT + sessionTexts;

      // 4. Call the model for extraction
      const response = await client.complete(
        [{ role: 'user', content: fullPrompt }],
        { maxTokens: cfg.maxTokens },
      );

      const responseText = response.message.content
        .filter(b => b.type === 'text')
        .map(b => (b as { text: string }).text)
        .join('');

      // 5. Parse MEMORY lines
      const memoryLines = responseText
        .split('\n')
        .filter(line => line.startsWith('MEMORY:'))
        .map(line => line.slice('MEMORY:'.length).trim());

      result.sessionsProcessed = sessions.length;

      for (const line of memoryLines) {
        const parts = line.split('|').map(p => p.trim());
        if (parts.length < 3) {
          result.rejected++;
          continue;
        }

        const [typeStr, title, content] = parts;
        const validTypes = ['decision', 'preference', 'project_fact', 'error_solution', 'reference'] as const;
        const type = validTypes.find(t => t === typeStr);
        if (!type || !title || !content) {
          result.rejected++;
          continue;
        }

        const item: MemoryItem = {
          title,
          content,
          type,
          confidence: 0.7,
          source: 'llm',
          tags: ['dream-consolidation'],
          timestamp: new Date().toISOString(),
        };

        try {
          const saved = await memoryAgent.save(item);
          if (saved) {
            result.created++;
          } else {
            result.rejected++; // Duplicate
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`Failed to save memory "${title}": ${msg}`);
        }
      }

      // 6. Update state
      this.lastConsolidatedAt = new Date();
      for (const session of sessions) {
        this.lastSessionIds.add(session.id);
      }

      // 7. Flush memory index
      await memoryAgent.flushIndex();

      logger.debug(`Dream consolidation complete: ${result.created} created, ${result.rejected} rejected from ${result.sessionsProcessed} sessions`);

      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Consolidation failed: ${msg}`);
      return result;
    } finally {
      this.consolidating = false;
    }
  }

  /** When was the last consolidation? */
  getLastConsolidatedAt(): Date | null {
    return this.lastConsolidatedAt;
  }

  /** Which sessions have already been consolidated? */
  getProcessedSessionIds(): ReadonlySet<string> {
    return this.lastSessionIds;
  }
}
