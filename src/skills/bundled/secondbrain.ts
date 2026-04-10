/**
 * Bundled Skill: Second Brain (Obsidian Integration)
 *
 * Deep integration with Obsidian as the user's knowledge management system.
 * Goes beyond basic search — provides:
 * - Contextual knowledge retrieval during conversations
 * - Automatic note creation from conversations
 * - Graph-aware navigation (follow [[wikilinks]])
 * - Daily notes and journal integration
 * - Zettelkasten-style atomic note creation
 * - Project-specific knowledge extraction
 *
 * This skill connects the agent to the user's accumulated knowledge,
 * making it aware of their notes, references, and thought processes.
 */

import type { Skill, SkillContext, SkillResult } from '../loader.js';
import { ObsidianVault, discoverVault } from '../../context/memory/obsidian.js';
import { slugify } from '../../utils/strings.js';

export const secondBrainSkill: Skill = {
  name: 'brain',
  description: 'Deep Obsidian vault integration — search, create, link, and navigate your second brain',
  category: 'knowledge',
  triggers: [
    { type: 'command', command: 'brain' },
    { type: 'command', command: 'obsidian' },
    { type: 'command', command: 'note' },
    { type: 'keyword', keywords: ['second brain', 'obsidian vault', 'my notes'] },
  ],

  async execute(ctx: SkillContext): Promise<SkillResult> {
    const args = ctx.args.trim();
    const parts = args.split(/\s+/);
    const subcommand = parts[0]?.toLowerCase() ?? '';
    const rest = parts.slice(1).join(' ');

    // Discover vault
    const vaultPath = await discoverVault(ctx.cwd);
    if (!vaultPath) {
      ctx.info('No Obsidian vault found.');
      ctx.info('Set PCC_OBSIDIAN_VAULT environment variable or create .pcc/vault.path');
      ctx.info('Common locations: ~/Obsidian, ~/Documents/Obsidian, .obsidian in project');
      return { type: 'handled' };
    }

    const vault = new ObsidianVault(vaultPath);

    switch (subcommand) {
      case 'search':
      case 's': {
        if (!rest) {
          return { type: 'error', message: 'Usage: /brain search <query>' };
        }
        const results = await vault.searchContent(rest, 8);
        if (results.length === 0) {
          ctx.info(`No notes found for "${rest}"`);
          return { type: 'handled' };
        }
        ctx.info(`\n📚 Found ${results.length} notes for "${rest}":\n`);
        for (const note of results) {
          const preview = note.body.slice(0, 150).replace(/\n/g, ' ').trim();
          const tags = note.tags.length > 0 ? ` [${note.tags.join(', ')}]` : '';
          ctx.info(`  📄 ${note.title}${tags}`);
          ctx.info(`     ${note.path}`);
          ctx.info(`     ${preview}...\n`);
        }
        return { type: 'handled' };
      }

      case 'read':
      case 'r': {
        if (!rest) {
          return { type: 'error', message: 'Usage: /brain read <note-path-or-title>' };
        }
        // Search for the note and read the best match
        return {
          type: 'prompt',
          prompt: `Read the Obsidian note matching "${rest}" from vault at ${vaultPath}.
Use Glob to find the file, then Read to show its contents.
If the note contains [[wikilinks]], list them at the end.`,
        };
      }

      case 'create':
      case 'new': {
        if (!rest) {
          return { type: 'error', message: 'Usage: /brain create <title>' };
        }
        return {
          type: 'prompt',
          prompt: `Create a new Obsidian note titled "${rest}" in the vault at ${vaultPath}/Agent/.

Based on our conversation so far, write:
1. YAML frontmatter: title, created (ISO date), type: agent-note, relevant tags
2. A summary of the key information from our conversation about this topic
3. Any relevant [[wikilinks]] to concepts that might exist in the vault
4. A "Related" section at the bottom with links to potentially related notes

Save to: ${vaultPath}/Agent/${slugify(rest)}.md
Use Write to create the file.`,
        };
      }

      case 'daily':
      case 'd': {
        const today = new Date().toISOString().split('T')[0]!;
        return {
          type: 'prompt',
          prompt: `Check for today's daily note in the Obsidian vault at ${vaultPath}.
Look in: Daily Notes/, Journal/, daily/, or the root.
File pattern: ${today}.md or ${today.replace(/-/g, '')}.md

If it exists, read and summarize it.
If it doesn't exist, create one at ${vaultPath}/Daily Notes/${today}.md with:
- YAML frontmatter (date, type: daily)
- Summary of today's work (from our conversation)
- Tasks completed/pending
- Links to related notes`,
        };
      }

      case 'link':
      case 'l': {
        if (!rest) {
          return { type: 'error', message: 'Usage: /brain link <note-path>' };
        }
        return {
          type: 'prompt',
          prompt: `Read the Obsidian note at or matching "${rest}" in vault ${vaultPath}.
Extract all [[wikilinks]] from the note.
For each linked note, search and read it.
Create a knowledge graph summary showing how this note connects to others.
Present the connections visually using a tree or indented list.`,
        };
      }

      case 'context':
      case 'ctx': {
        // Pull relevant knowledge for the current conversation
        return {
          type: 'prompt',
          prompt: `Search the Obsidian vault at ${vaultPath} for notes relevant to our current conversation.

Strategy:
1. Extract key topics/concepts from the conversation history (technical terms, project names, patterns discussed)
2. For each topic, search the vault using Glob for file names and Grep for content — try synonyms and related terms
3. Also check MemoryAgent context (already in system prompt) for related project_fact or decision entries
4. Follow [[wikilinks]] in found notes to discover connected knowledge (1 level deep)
5. Check the Agent/ folder for previous session notes that may have relevant context

Present findings as a structured summary:
- **Topic** → relevant vault notes (with paths) → key insights extracted
- **Connections** → how vault knowledge relates to the current task
- **Gaps** → topics discussed that have NO vault coverage (suggest creating notes)

If the vault has daily notes, check recent ones for task context.
If no relevant notes found, say so clearly — don't fabricate connections.`,
        };
      }

      case 'zettel':
      case 'z': {
        if (!rest) {
          return { type: 'error', message: 'Usage: /brain zettel <concept>' };
        }
        const zettelId = Date.now().toString(36);
        return {
          type: 'prompt',
          prompt: `Create a Zettelkasten-style atomic note about "${rest}" in ${vaultPath}/Zettelkasten/.

Requirements:
1. One concept per note (atomic)
2. Written in your own words (not copied)
3. YAML frontmatter: id: ${zettelId}, title, created, type: zettel, tags
4. The note body: 2-5 sentences capturing the core idea
5. "References" section: where this idea came from
6. "Connections" section: [[wikilinks]] to related concepts
7. "Questions" section: open questions this raises

Save to: ${vaultPath}/Zettelkasten/${zettelId}-${slugify(rest)}.md`,
        };
      }

      case 'tags':
      case 't': {
        if (!rest) {
          // List all tags
          const notes = await vault.searchContent('', 100);
          const tagCounts = new Map<string, number>();
          for (const note of notes) {
            for (const tag of note.tags) {
              tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
            }
          }
          const sorted = Array.from(tagCounts.entries()).sort((a, b) => b[1] - a[1]);
          ctx.info(`\n🏷️ Tags in vault (${sorted.length}):\n`);
          for (const [tag, count] of sorted.slice(0, 30)) {
            ctx.info(`  #${tag} (${count})`);
          }
          return { type: 'handled' };
        }

        // Search by specific tag
        const tagged = await vault.searchByTag(rest);
        if (tagged.length === 0) {
          ctx.info(`No notes with #${rest}`);
        } else {
          ctx.info(`\n🏷️ Notes with #${rest} (${tagged.length}):\n`);
          for (const note of tagged) {
            ctx.info(`  📄 ${note.title} — ${note.path}`);
          }
        }
        return { type: 'handled' };
      }

      case 'recent': {
        const days = parseInt(rest) || 7;
        const recent = await vault.getRecentNotes(days, 15);
        if (recent.length === 0) {
          ctx.info(`No notes modified in the last ${days} days`);
        } else {
          ctx.info(`\n📅 Recent notes (last ${days} days):\n`);
          for (const note of recent) {
            const tags = note.tags.length > 0 ? ` [${note.tags.join(', ')}]` : '';
            ctx.info(`  📄 ${note.title}${tags}`);
            ctx.info(`     ${note.path}`);
          }
        }
        return { type: 'handled' };
      }

      default: {
        ctx.info(`\n🧠 Second Brain — Obsidian vault: ${vaultPath}\n`);
        ctx.info('Commands:');
        ctx.info('  /brain search <query>     — search notes');
        ctx.info('  /brain read <title>       — read a note');
        ctx.info('  /brain create <title>     — create a new note from conversation');
        ctx.info('  /brain daily              — daily note (read or create)');
        ctx.info('  /brain link <note>        — explore wikilink connections');
        ctx.info('  /brain context            — find vault knowledge relevant to conversation');
        ctx.info('  /brain zettel <concept>   — create an atomic Zettelkasten note');
        ctx.info('  /brain tags [tag]         — list tags or filter by tag');
        ctx.info('  /brain recent [days]      — recently modified notes');

        // Show vault summary
        const summary = await vault.getContextSummary();
        if (summary) {
          ctx.info(`\n${summary}`);
        }

        return { type: 'handled' };
      }
    }
  },
};

// ─── Helpers ───────────────────────────────────────────
