/**
 * Layer 3 — Tools: Obsidian Vault Tool
 *
 * First-class tool that the model can call directly to interact
 * with the user's Obsidian vault as a knowledge wiki.
 *
 * Karpathy-style: the wiki is a persistent, compounding artifact.
 * The agent owns the wiki — it writes, updates, lints, and organizes.
 * The human deposits raw sources — the agent ingests them.
 */

import type { Tool, ToolCall, ToolContext, ToolResult, ToolDefinition } from '../../protocol/tools.js';
import { ObsidianVault, discoverVault, type ObsidianNote } from '../../context/memory/obsidian.js';

// ─── Tool Definition ───────────────────────────────────

const definition: ToolDefinition = {
  name: 'Obsidian',
  description: `Read, write, search, update, and manage notes in the user's Obsidian vault (second brain).

Operations:
- search: Search notes by content. Input: { query, limit? }
- read: Read a note by path. Input: { path }
- save: Create or overwrite a note. Input: { title, content, folder?, tags? }
- update: Update an existing note (merge frontmatter, replace or append body). Input: { path, content?, appendContent?, frontmatter? }
- delete: Delete a note. Input: { path }
- archive: Move a note to the archive. Input: { path }
- list: List notes in a folder. Input: { folder? }
- tags: Search notes by tag. Input: { query }
- recent: Get recently modified notes. Input: { days?, limit? }
- ingest: Read a source file and update wiki pages based on its content. Input: { sourcePath }
- lint: Audit the wiki for stale notes, orphan pages, and broken links. Input: { maxAgeDays? }

Use this tool to persist knowledge, decisions, and facts across sessions.`,
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        description: 'The operation to perform',
      },
      query: { type: 'string', description: 'Search query (for search/tags)' },
      path: { type: 'string', description: 'Note path relative to vault root' },
      title: { type: 'string', description: 'Note title (for save)' },
      content: { type: 'string', description: 'Note content/body (for save/update)' },
      appendContent: { type: 'string', description: 'Content to append (for update)' },
      folder: { type: 'string', description: 'Target folder (for save/list)' },
      tags: { type: 'string', description: 'Comma-separated tags (for save)' },
      frontmatter: { type: 'string', description: 'JSON frontmatter to merge (for update)' },
      sourcePath: { type: 'string', description: 'Source file path to ingest' },
      limit: { type: 'number', description: 'Max results (default: 10)' },
      days: { type: 'number', description: 'Number of days for recent/lint (default: 7/30)' },
      maxAgeDays: { type: 'number', description: 'Max age in days for lint stale detection (default: 30)' },
    },
    required: ['operation'],
  },
  categories: ['memory'],
};

// ─── Tool Implementation ───────────────────────────────

export class ObsidianTool implements Tool {
  definition = definition;
  private vault: ObsidianVault | null = null;

  setVault(vault: ObsidianVault): void {
    this.vault = vault;
  }

  async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    // Auto-discover vault if not set
    if (!this.vault) {
      const vaultPath = await discoverVault(context.cwd);
      if (!vaultPath) {
        return { tool_use_id: call.id, content: 'No Obsidian vault found. Set PCC_OBSIDIAN_VAULT environment variable or create .pcc/vault.path file.', is_error: true };
      }
      this.vault = new ObsidianVault(vaultPath);
    }

    const op = call.input['operation'] as string;
    const input = call.input;

    try {
      switch (op) {
        case 'search':
          return await this.opSearch(call.id, input);
        case 'read':
          return await this.opRead(call.id, input);
        case 'save':
          return await this.opSave(call.id, input);
        case 'update':
          return await this.opUpdate(call.id, input);
        case 'delete':
          return await this.opDelete(call.id, input);
        case 'archive':
          return await this.opArchive(call.id, input);
        case 'list':
          return await this.opList(call.id, input);
        case 'tags':
          return await this.opTags(call.id, input);
        case 'recent':
          return await this.opRecent(call.id, input);
        case 'ingest':
          return await this.opIngest(call.id, input);
        case 'lint':
          return await this.opLint(call.id, input);
        default:
          return { tool_use_id: call.id, content: `Unknown operation: "${op}". Valid: search, read, save, update, delete, archive, list, tags, recent, ingest, lint`, is_error: true };
      }
    } catch (error) {
      return { tool_use_id: call.id, content: `Obsidian error: ${error instanceof Error ? error.message : String(error)}`, is_error: true };
    }
  }

  // ─── Operations ────────────────────────────────────

  private async opSearch(id: string, input: Record<string, unknown>): Promise<ToolResult> {
    const query = (input['query'] as string) ?? '';
    const limit = (input['limit'] as number) ?? 10;
    if (!query) return { tool_use_id: id, content: 'Missing "query" for search', is_error: true };

    const results = await this.vault!.searchContent(query, limit);
    if (results.length === 0) return { tool_use_id: id, content: `No notes found for "${query}"` };

    const lines = results.map((n) => {
      const preview = n.body.slice(0, 200).replace(/\n/g, ' ').trim();
      const tags = n.tags.length > 0 ? ` [${n.tags.join(', ')}]` : '';
      return `## ${n.title}${tags}\nPath: ${n.path}\n${preview}...`;
    });
    return { tool_use_id: id, content: `Found ${results.length} notes:\n\n${lines.join('\n\n')}` };
  }

  private async opRead(id: string, input: Record<string, unknown>): Promise<ToolResult> {
    const path = (input['path'] as string) ?? '';
    if (!path) return { tool_use_id: id, content: 'Missing "path" for read', is_error: true };

    const note = await this.vault!.readNote(path);
    if (!note) return { tool_use_id: id, content: `Note not found: ${path}`, is_error: true };

    const fmStr = Object.entries(note.frontmatter).map(([k, v]) => `${k}: ${v}`).join('\n');
    const links = note.links.length > 0 ? `\nLinks: ${note.links.map(l => `[[${l}]]`).join(', ')}` : '';
    return { tool_use_id: id, content: `---\n${fmStr}\n---\n\n${note.body}${links}` };
  }

  private async opSave(id: string, input: Record<string, unknown>): Promise<ToolResult> {
    const title = (input['title'] as string) ?? '';
    const content = (input['content'] as string) ?? '';
    const folder = (input['folder'] as string) ?? 'Agent/Wiki';
    const tagsStr = (input['tags'] as string) ?? '';
    if (!title) return { tool_use_id: id, content: 'Missing "title" for save', is_error: true };

    const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()) : undefined;

    const notePath = await this.vault!.createNote(folder, title, content, {
      tags,
      updated: new Date().toISOString().split('T')[0],
      source: 'conversation',
    });

    return { tool_use_id: id, content: `Saved: ${notePath}` };
  }

  private async opUpdate(id: string, input: Record<string, unknown>): Promise<ToolResult> {
    const path = (input['path'] as string) ?? '';
    if (!path) return { tool_use_id: id, content: 'Missing "path" for update', is_error: true };

    let frontmatter: Record<string, unknown> | undefined;
    const fmStr = input['frontmatter'] as string;
    if (fmStr) {
      try { frontmatter = JSON.parse(fmStr); } catch { frontmatter = undefined; }
    }

    const success = await this.vault!.updateNote(path, {
      body: input['content'] as string | undefined,
      appendBody: input['appendContent'] as string | undefined,
      frontmatter,
    });

    return success
      ? { tool_use_id: id, content: `Updated: ${path}` }
      : { tool_use_id: id, content: `Note not found: ${path}`, is_error: true };
  }

  private async opDelete(id: string, input: Record<string, unknown>): Promise<ToolResult> {
    const path = (input['path'] as string) ?? '';
    if (!path) return { tool_use_id: id, content: 'Missing "path" for delete', is_error: true };

    const success = await this.vault!.deleteNote(path);
    return success
      ? { tool_use_id: id, content: `Deleted: ${path}` }
      : { tool_use_id: id, content: `Note not found: ${path}`, is_error: true };
  }

  private async opArchive(id: string, input: Record<string, unknown>): Promise<ToolResult> {
    const path = (input['path'] as string) ?? '';
    if (!path) return { tool_use_id: id, content: 'Missing "path" for archive', is_error: true };

    const newPath = await this.vault!.archiveNote(path);
    return newPath
      ? { tool_use_id: id, content: `Archived: ${path} → ${newPath}` }
      : { tool_use_id: id, content: `Note not found: ${path}`, is_error: true };
  }

  private async opList(id: string, input: Record<string, unknown>): Promise<ToolResult> {
    const folder = (input['folder'] as string) ?? undefined;
    const notes = await this.vault!.listNotes(folder);

    if (notes.length === 0) {
      return { tool_use_id: id, content: folder ? `No notes in "${folder}"` : 'Vault is empty' };
    }

    return { tool_use_id: id, content: `${notes.length} notes:\n${notes.join('\n')}` };
  }

  private async opTags(id: string, input: Record<string, unknown>): Promise<ToolResult> {
    const query = (input['query'] as string) ?? '';
    if (!query) return { tool_use_id: id, content: 'Missing "query" (tag name) for tags', is_error: true };

    const results = await this.vault!.searchByTag(query);
    if (results.length === 0) return { tool_use_id: id, content: `No notes with tag #${query}` };

    const lines = results.map(n => `- ${n.title} (${n.path})`);
    return { tool_use_id: id, content: `Notes with #${query} (${results.length}):\n${lines.join('\n')}` };
  }

  private async opRecent(id: string, input: Record<string, unknown>): Promise<ToolResult> {
    const days = (input['days'] as number) ?? 7;
    const limit = (input['limit'] as number) ?? 15;

    const notes = await this.vault!.getRecentNotes(days, limit);
    if (notes.length === 0) return { tool_use_id: id, content: `No notes modified in the last ${days} days` };

    const lines = notes.map(n => {
      const tags = n.tags.length > 0 ? ` [${n.tags.join(', ')}]` : '';
      return `- ${n.title}${tags} — ${n.path}`;
    });
    return { tool_use_id: id, content: `Recent notes (last ${days} days):\n${lines.join('\n')}` };
  }

  private async opIngest(id: string, input: Record<string, unknown>): Promise<ToolResult> {
    const sourcePath = (input['sourcePath'] as string) ?? '';
    if (!sourcePath) return { tool_use_id: id, content: 'Missing "sourcePath" for ingest', is_error: true };

    // Read the source file from the vault's Sources/ folder
    const note = await this.vault!.readNote(sourcePath);
    if (!note) {
      return { tool_use_id: id, content: `Source not found: ${sourcePath}. Place source files in Sources/ folder of the vault.`, is_error: true };
    }

    // Return the source content for the model to process
    // The model will then decide which wiki pages to create/update
    return {
      tool_use_id: id,
      content: `Source loaded (${note.body.length} chars). Title: "${note.title}"\nTags: ${note.tags.join(', ')}\n\n--- SOURCE CONTENT ---\n${note.body}\n--- END SOURCE ---\n\nNow analyze this source and create/update wiki pages in Agent/Wiki/. For each topic covered:\n1. Search if a wiki page already exists for that topic\n2. If yes: update it with new information\n3. If no: create a new page\n4. Add [[wikilinks]] between related pages`,
    };
  }

  private async opLint(id: string, input: Record<string, unknown>): Promise<ToolResult> {
    const maxAgeDays = (input['maxAgeDays'] as number) ?? 30;
    const issues: string[] = [];

    // 1. Find stale notes
    const stale = await this.vault!.getStaleNotes(maxAgeDays);
    if (stale.length > 0) {
      issues.push(`\n## Stale notes (not updated in ${maxAgeDays}+ days): ${stale.length}`);
      for (const note of stale.slice(0, 10)) {
        issues.push(`  - ${note.title} (${note.path})`);
      }
    }

    // 2. Find notes with no incoming links (orphans)
    const allNotes = await this.vault!.listNotes('Agent');
    const allLinks = new Set<string>();
    const notesByTitle = new Map<string, string>();

    for (const notePath of allNotes) {
      if (notePath.includes('/archive/')) continue;
      const note = await this.vault!.readNote(notePath);
      if (!note) continue;
      notesByTitle.set(note.title.toLowerCase(), notePath);
      for (const link of note.links) {
        allLinks.add(link.toLowerCase());
      }
    }

    const orphans = allNotes.filter(p => {
      if (p.includes('/archive/') || p.includes('/sessions/')) return false;
      const title = p.split('/').pop()?.replace('.md', '').replace(/-/g, ' ') ?? '';
      return !allLinks.has(title.toLowerCase());
    });

    if (orphans.length > 0) {
      issues.push(`\n## Orphan notes (no incoming links): ${orphans.length}`);
      for (const p of orphans.slice(0, 10)) {
        issues.push(`  - ${p}`);
      }
    }

    // 3. Summary
    if (issues.length === 0) {
      return { tool_use_id: id, content: `Wiki lint: all clean! ${allNotes.length} notes checked.` };
    }

    return { tool_use_id: id, content: `Wiki lint report:\n${issues.join('\n')}` };
  }
}
