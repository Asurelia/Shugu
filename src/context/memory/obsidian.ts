/**
 * Layer 5 — Context: Obsidian vault integration
 *
 * Provides structured access to an Obsidian vault as a local knowledge graph.
 * No MCP, no plugin API — just direct filesystem access to Markdown files.
 *
 * An Obsidian vault is a folder of .md files with:
 * - YAML frontmatter (tags, project, status, date, etc.)
 * - Wikilinks [[note-name]] for graph relationships
 * - Atomic notes (1 concept per file)
 *
 * Vault structure follows the AI Second Brain pattern:
 *   vault/
 *     Projects/     ← organized by initiative
 *     Meetings/     ← dated entries
 *     Research/     ← by topic
 *     Ideas/        ← tagged concepts
 *     Agent/        ← PCC agent memories (auto-created)
 *     Templates/    ← reusable structures
 */

import { readFile, writeFile, mkdir, readdir, stat, access } from 'node:fs/promises';
import { join, relative, basename, dirname } from 'node:path';
import { homedir } from 'node:os';

// ─── Types ──────────────────────────────────────────────

export interface ObsidianNote {
  /** Relative path from vault root (e.g., "Agent/feedback-cli-first.md") */
  path: string;
  /** Note title (from filename or frontmatter) */
  title: string;
  /** YAML frontmatter parsed */
  frontmatter: Record<string, unknown>;
  /** Markdown body (without frontmatter) */
  body: string;
  /** Wikilinks found in the note */
  links: string[];
  /** Tags from frontmatter or inline #tags */
  tags: string[];
}

export interface VaultConfig {
  /** Absolute path to the vault root */
  path: string;
  /** Subfolder where PCC stores its agent memories */
  agentFolder: string;
}

// ─── Obsidian Vault ─────────────────────────────────────

export class ObsidianVault {
  private config: VaultConfig;

  constructor(vaultPath: string) {
    this.config = {
      path: vaultPath,
      agentFolder: 'Agent',
    };
  }

  /**
   * Check if the vault exists and is accessible.
   */
  async isValid(): Promise<boolean> {
    try {
      const s = await stat(this.config.path);
      return s.isDirectory();
    } catch {
      return false;
    }
  }

  // ─── Reading ────────────────────────────────────────

  /**
   * Read a single note by path (relative to vault root).
   */
  async readNote(notePath: string): Promise<ObsidianNote | null> {
    const absPath = join(this.config.path, notePath);
    try {
      const content = await readFile(absPath, 'utf-8');
      return parseNote(notePath, content);
    } catch {
      return null;
    }
  }

  /**
   * Search notes by content (grep-like).
   */
  async searchContent(query: string, limit: number = 10): Promise<ObsidianNote[]> {
    const allNotes = await this.listNotes();
    const results: Array<{ note: ObsidianNote; score: number }> = [];
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 2);

    for (const notePath of allNotes) {
      const note = await this.readNote(notePath);
      if (!note) continue;

      const text = `${note.title} ${note.body} ${note.tags.join(' ')}`.toLowerCase();
      let score = 0;
      for (const word of queryWords) {
        if (text.includes(word)) score++;
      }
      // Boost exact phrase match
      if (text.includes(queryLower)) score += 3;

      if (score > 0) results.push({ note, score });
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((r) => r.note);
  }

  /**
   * Search notes by tag.
   */
  async searchByTag(tag: string): Promise<ObsidianNote[]> {
    const normalizedTag = tag.startsWith('#') ? tag.slice(1) : tag;
    const allNotes = await this.listNotes();
    const results: ObsidianNote[] = [];

    for (const notePath of allNotes) {
      const note = await this.readNote(notePath);
      if (!note) continue;
      if (note.tags.some((t) => t === normalizedTag)) {
        results.push(note);
      }
    }

    return results;
  }

  /**
   * Resolve a wikilink [[name]] to a note path.
   */
  async resolveLink(linkName: string): Promise<string | null> {
    const allNotes = await this.listNotes();
    const normalized = linkName.toLowerCase().replace(/\s+/g, '-');

    for (const notePath of allNotes) {
      const noteBasename = basename(notePath, '.md').toLowerCase().replace(/\s+/g, '-');
      if (noteBasename === normalized) return notePath;
    }

    return null;
  }

  /**
   * Get all notes linked from a given note (outgoing links).
   */
  async getLinkedNotes(notePath: string): Promise<ObsidianNote[]> {
    const note = await this.readNote(notePath);
    if (!note) return [];

    const linked: ObsidianNote[] = [];
    for (const link of note.links) {
      const resolved = await this.resolveLink(link);
      if (resolved) {
        const linkedNote = await this.readNote(resolved);
        if (linkedNote) linked.push(linkedNote);
      }
    }

    return linked;
  }

  // ─── Writing ────────────────────────────────────────

  /**
   * Create or update a note in the agent memory folder.
   */
  async saveAgentNote(
    title: string,
    body: string,
    metadata: {
      tags?: string[];
      type?: string;
      project?: string;
      links?: string[];
    } = {},
  ): Promise<string> {
    const folder = join(this.config.path, this.config.agentFolder);
    await mkdir(folder, { recursive: true });

    const filename = slugify(title) + '.md';
    const filePath = join(folder, filename);
    const relativePath = join(this.config.agentFolder, filename);

    const frontmatter: Record<string, unknown> = {
      title,
      created: new Date().toISOString(),
      type: metadata.type ?? 'agent-memory',
      ...(metadata.tags && { tags: metadata.tags }),
      ...(metadata.project && { project: metadata.project }),
    };

    // Build links section
    let linksSection = '';
    if (metadata.links && metadata.links.length > 0) {
      linksSection = '\n\n## Related\n' + metadata.links.map((l) => `- [[${l}]]`).join('\n');
    }

    const content = formatNote(frontmatter, body + linksSection);
    await writeFile(filePath, content, 'utf-8');

    return relativePath;
  }

  /**
   * Create a note in a specific folder.
   */
  async createNote(
    folder: string,
    title: string,
    body: string,
    frontmatter: Record<string, unknown> = {},
  ): Promise<string> {
    const folderPath = join(this.config.path, folder);
    await mkdir(folderPath, { recursive: true });

    const filename = slugify(title) + '.md';
    const filePath = join(folderPath, filename);
    const relativePath = join(folder, filename);

    const fm = {
      title,
      created: new Date().toISOString(),
      ...frontmatter,
    };

    await writeFile(filePath, formatNote(fm, body), 'utf-8');
    return relativePath;
  }

  // ─── Listing ────────────────────────────────────────

  /**
   * List all .md files in the vault.
   */
  async listNotes(subfolder?: string): Promise<string[]> {
    const base = subfolder ? join(this.config.path, subfolder) : this.config.path;
    const notes: string[] = [];

    async function walk(dir: string): Promise<void> {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          // Skip hidden folders and .obsidian config
          if (entry.name.startsWith('.')) continue;
          if (entry.name === 'node_modules') continue;

          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(fullPath);
          } else if (entry.name.endsWith('.md')) {
            notes.push(relative(base === dir ? base : dir.split(subfolder ?? '')[0]!, fullPath).replace(/\\/g, '/'));
          }
        }
      } catch {
        // Skip unreadable dirs
      }
    }

    await walk(base);
    // Fix: paths should be relative to vault root
    return notes.map((n) => {
      if (n.startsWith(this.config.path)) {
        return relative(this.config.path, n).replace(/\\/g, '/');
      }
      return n.replace(/\\/g, '/');
    });
  }

  /**
   * Get recent notes (modified in last N days).
   */
  async getRecentNotes(days: number = 7, limit: number = 20): Promise<ObsidianNote[]> {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const allNotes = await this.listNotes();
    const recent: Array<{ note: ObsidianNote; mtime: number }> = [];

    for (const notePath of allNotes) {
      try {
        const absPath = join(this.config.path, notePath);
        const s = await stat(absPath);
        if (s.mtimeMs > cutoff) {
          const note = await this.readNote(notePath);
          if (note) recent.push({ note, mtime: s.mtimeMs });
        }
      } catch {
        // Skip
      }
    }

    return recent
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit)
      .map((r) => r.note);
  }

  // ─── Summary for prompt injection ───────────────────

  /**
   * Generate a compact summary of relevant vault content for the system prompt.
   */
  async getContextSummary(query?: string): Promise<string> {
    const parts: string[] = [];

    // Recent agent memories
    const agentNotes = await this.listNotes(this.config.agentFolder);
    if (agentNotes.length > 0) {
      parts.push(`\n# Obsidian vault (${this.config.path})`);
      parts.push(`Agent memories: ${agentNotes.length} notes`);

      // Show last 5 agent notes
      const recentAgent = agentNotes.slice(-5);
      for (const path of recentAgent) {
        const note = await this.readNote(path);
        if (note) {
          const preview = note.body.slice(0, 100).replace(/\n/g, ' ');
          parts.push(`  - ${note.title}: ${preview}...`);
        }
      }
    }

    // If a query is provided, search for relevant notes
    if (query) {
      const relevant = await this.searchContent(query, 3);
      if (relevant.length > 0) {
        parts.push('\nRelevant vault notes:');
        for (const note of relevant) {
          const preview = note.body.slice(0, 150).replace(/\n/g, ' ');
          parts.push(`  - [[${note.title}]] (${note.tags.join(', ')}): ${preview}`);
        }
      }
    }

    return parts.join('\n');
  }

  get vaultPath(): string {
    return this.config.path;
  }
}

// ─── Note Parsing ───────────────────────────────────────

function parseNote(path: string, content: string): ObsidianNote {
  const { frontmatter, body } = parseFrontmatter(content);
  const title = (frontmatter['title'] as string) ?? basename(path, '.md').replace(/-/g, ' ');
  const links = extractWikilinks(body);
  const tags = extractTags(frontmatter, body);

  return { path, title, frontmatter, body, links, tags };
}

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const fmText = match[1]!;
  const body = match[2]!;

  // Simple YAML-like parsing (key: value per line)
  const frontmatter: Record<string, unknown> = {};
  for (const line of fmText.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value: unknown = line.slice(colonIdx + 1).trim();

    // Parse arrays: [a, b, c] or - a
    if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map((s) => s.trim());
    }

    frontmatter[key] = value;
  }

  return { frontmatter, body };
}

function extractWikilinks(content: string): string[] {
  const matches = content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g);
  return Array.from(matches, (m) => m[1]!);
}

function extractTags(frontmatter: Record<string, unknown>, body: string): string[] {
  const tags = new Set<string>();

  // From frontmatter
  const fmTags = frontmatter['tags'];
  if (Array.isArray(fmTags)) {
    for (const t of fmTags) tags.add(String(t));
  } else if (typeof fmTags === 'string') {
    for (const t of fmTags.split(',')) tags.add(t.trim());
  }

  // From inline #tags
  const inlineTags = body.matchAll(/#([a-zA-Z][\w-]*)/g);
  for (const match of inlineTags) {
    tags.add(match[1]!);
  }

  return Array.from(tags);
}

// ─── Note Formatting ────────────────────────────────────

function formatNote(frontmatter: Record<string, unknown>, body: string): string {
  const fmLines: string[] = [];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      fmLines.push(`${key}: [${value.join(', ')}]`);
    } else {
      fmLines.push(`${key}: ${value}`);
    }
  }

  return `---\n${fmLines.join('\n')}\n---\n\n${body}\n`;
}

// ─── Vault Discovery ────────────────────────────────────

/**
 * Try to find an Obsidian vault.
 * Priority: PCC_VAULT env var > .pcc/vault.path file > common locations
 */
export async function discoverVault(cwd: string): Promise<string | null> {
  // 1. Environment variable
  const envVault = process.env['PCC_OBSIDIAN_VAULT'];
  if (envVault) {
    try {
      await access(envVault);
      return envVault;
    } catch {
      // Invalid path
    }
  }

  // 2. Project-level config
  for (const configPath of [join(cwd, '.pcc', 'vault.path'), join(cwd, 'pcc-vault.path')]) {
    try {
      const vaultPath = (await readFile(configPath, 'utf-8')).trim();
      await access(vaultPath);
      return vaultPath;
    } catch {
      // Not found
    }
  }

  // 3. Check if cwd IS a vault (has .obsidian folder)
  try {
    await access(join(cwd, '.obsidian'));
    return cwd;
  } catch {
    // Not a vault
  }

  // 4. Common locations
  const home = homedir();
  const commonPaths = [
    join(home, 'Obsidian'),
    join(home, 'Documents', 'Obsidian'),
    join(home, 'Documents', 'Obsidian Vault'),
    join(home, 'obsidian-vault'),
    join(home, 'vault'),
  ];

  for (const path of commonPaths) {
    try {
      await access(join(path, '.obsidian'));
      return path;
    } catch {
      // Not found
    }
  }

  return null;
}

// ─── Helpers ────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}
