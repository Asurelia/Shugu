/**
 * Layer 9 — Automation: Obsidian Maintenance Agent
 *
 * A scheduled background agent that maintains the Obsidian vault:
 * 1. Archives stale notes (untouched > 30 days)
 * 2. Generates a .schema.md convention file on first run
 * 3. Creates weekly digests summarizing recent notes
 *
 * Runs as a ScheduledJob — can be started via /schedule or at boot.
 */

import { ObsidianVault } from '../context/memory/obsidian.js';
import { logger } from '../utils/logger.js';

// ─── Schema Template ──────────────────────────────────

const SCHEMA_TEMPLATE = `---
type: schema
maintained_by: shugu
---

# Vault Conventions (.schema.md)

This file documents the conventions used by Shugu to organize this vault.
It is auto-generated and can be customized.

## Folder Structure
- \`Agent/\` — Notes created by the AI agent
- \`Agent/archive/\` — Archived notes (auto-moved after 30 days of inactivity)
- \`Agent/digests/\` — Weekly digests summarizing recent activity
- \`Projects/\` — Organized by initiative
- \`Meetings/\` — Dated entries

## Frontmatter Schema
All agent-created notes include:
\`\`\`yaml
---
type: <note-type>          # memory, decision, reference, auto-memory, digest
tags: [<tag1>, <tag2>]     # searchable tags
created: <ISO-date>        # creation timestamp
source: shugu              # always "shugu" for agent notes
project: <project-name>    # optional project association
---
\`\`\`

## Note Types
- **memory**: Decisions, preferences, corrections extracted from conversations
- **decision**: Architectural or design decisions with rationale
- **reference**: Pointers to external resources (URLs, docs, APIs)
- **auto-memory**: Automatically extracted knowledge hints
- **digest**: Weekly summary of vault activity

## Naming Convention
- Filenames are slugified from the note title
- Max 80 characters
- Format: \`lowercase-with-dashes.md\`

## Linking
- Use \`[[wikilinks]]\` for internal references
- Tags use \`#tag-name\` format (lowercase, dashes)
`;

// ─── Maintenance Functions ────────────────────────────

/**
 * Ensure .schema.md exists in the vault root.
 * Creates it only if missing (does not overwrite user edits).
 */
export async function ensureSchema(vault: ObsidianVault): Promise<boolean> {
  try {
    const existing = await vault.readNote('.schema.md');
    if (existing) return false; // Already exists
  } catch {
    // Note doesn't exist — create it
  }

  try {
    // createNote(folder, title, body, frontmatter) — put in vault root
    await vault.createNote('.', '.schema', SCHEMA_TEMPLATE, { type: 'schema', maintained_by: 'shugu' });
    logger.debug('created .schema.md in vault');
    return true;
  } catch (err) {
    logger.warn('failed to create .schema.md', err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * Archive notes in Agent/ that haven't been modified in over `staleDays` days.
 * Returns the number of notes archived.
 */
export async function archiveStaleNotes(
  vault: ObsidianVault,
  staleDays: number = 30,
): Promise<number> {
  let archived = 0;
  try {
    const staleNotes = await vault.getStaleNotes(staleDays);
    for (const note of staleNotes) {
      try {
        await vault.archiveNote(note.path);
        archived++;
      } catch (err) {
        logger.debug(`failed to archive ${note.path}`, err instanceof Error ? err.message : String(err));
      }
    }
    if (archived > 0) {
      logger.debug(`archived ${archived} stale notes (>${staleDays} days)`);
    }
  } catch (err) {
    logger.warn('stale note scan failed', err instanceof Error ? err.message : String(err));
  }
  return archived;
}

/**
 * Generate a digest note summarizing recent vault activity.
 * Creates a note in Agent/digests/ with stats and highlights.
 */
export async function generateDigest(
  vault: ObsidianVault,
  dayRange: number = 7,
): Promise<string | null> {
  try {
    const recentNotes = await vault.getRecentNotes(dayRange);
    if (recentNotes.length === 0) return null;

    const now = new Date();
    const weekStart = new Date(now.getTime() - dayRange * 86_400_000);
    const dateRange = `${weekStart.toISOString().split('T')[0]} → ${now.toISOString().split('T')[0]}`;

    // Count by type (frontmatter already parsed in ObsidianNote)
    const typeCounts = new Map<string, number>();
    for (const note of recentNotes) {
      const type = (note.frontmatter['type'] as string) ?? 'unknown';
      typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    }

    const typeLines = Array.from(typeCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => `- **${type}**: ${count} note(s)`)
      .join('\n');

    const noteList = recentNotes.slice(0, 20)
      .map(n => `- [[${n.path.replace(/\.md$/, '')}]]`)
      .join('\n');

    const digestBody = `# Weekly Digest: ${dateRange}

## Stats
- **Total notes modified**: ${recentNotes.length}
${typeLines}

## Recent Notes
${noteList}
${recentNotes.length > 20 ? `\n...and ${recentNotes.length - 20} more` : ''}
`;

    const digestTitle = `digest-${now.toISOString().split('T')[0]}`;
    const digestPath = await vault.createNote('Agent/digests', digestTitle, digestBody, {
      type: 'digest',
      tags: ['digest', 'weekly'],
      source: 'shugu',
    });
    logger.debug(`created digest: ${digestPath}`);
    return digestPath;
  } catch (err) {
    logger.warn('digest generation failed', err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ─── Combined Maintenance Run ─────────────────────────

export interface MaintenanceResult {
  schemaCreated: boolean;
  notesArchived: number;
  digestPath: string | null;
}

/**
 * Run all maintenance tasks. Safe to call frequently — idempotent operations.
 */
export async function runVaultMaintenance(
  vault: ObsidianVault,
  options: { staleDays?: number; digestDays?: number } = {},
): Promise<MaintenanceResult> {
  const { staleDays = 30, digestDays = 7 } = options;

  const [schemaCreated, notesArchived, digestPath] = await Promise.all([
    ensureSchema(vault),
    archiveStaleNotes(vault, staleDays),
    generateDigest(vault, digestDays),
  ]);

  return { schemaCreated, notesArchived, digestPath };
}
