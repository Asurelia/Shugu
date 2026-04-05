/**
 * Layer 5 — Context: Memory store
 *
 * Persistent memory system using MEMORY.md index + individual memory files.
 * Adapted from OpenClaude src/memdir/memdir.ts and src/memdir/memoryTypes.ts.
 *
 * Memory types: user, feedback, project, reference
 * Storage: ~/.pcc/memory/ (global) or .pcc/memory/ (project-local)
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

// ─── Memory Types ───────────────────────────────────────

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

export interface Memory {
  name: string;
  description: string;
  type: MemoryType;
  content: string;
  filename: string;
}

// ─── Memory Store ───────────────────────────────────────

export class MemoryStore {
  private globalDir: string;
  private projectDir: string | null;

  constructor(projectDir?: string) {
    this.globalDir = join(homedir(), '.pcc', 'memory');
    this.projectDir = projectDir ? join(projectDir, '.pcc', 'memory') : null;
  }

  /**
   * Load all memories (global + project-local).
   */
  async loadAll(): Promise<Memory[]> {
    const memories: Memory[] = [];

    // Load global memories
    memories.push(...await this.loadFromDir(this.globalDir));

    // Load project-local memories
    if (this.projectDir) {
      memories.push(...await this.loadFromDir(this.projectDir));
    }

    return memories;
  }

  /**
   * Save a memory to the appropriate directory.
   */
  async save(memory: Omit<Memory, 'filename'>, scope: 'global' | 'project' = 'project'): Promise<string> {
    const dir = scope === 'global' ? this.globalDir : (this.projectDir ?? this.globalDir);
    await mkdir(dir, { recursive: true });

    const filename = this.slugify(memory.name) + '.md';
    const filePath = join(dir, filename);

    const content = `---
name: ${memory.name}
description: ${memory.description}
type: ${memory.type}
---

${memory.content}
`;

    await writeFile(filePath, content, 'utf-8');

    // Update MEMORY.md index
    await this.updateIndex(dir);

    return filePath;
  }

  /**
   * Load the MEMORY.md index file content.
   */
  async loadIndex(scope: 'global' | 'project' = 'project'): Promise<string> {
    const dir = scope === 'global' ? this.globalDir : (this.projectDir ?? this.globalDir);
    const indexPath = join(dir, 'MEMORY.md');
    try {
      return await readFile(indexPath, 'utf-8');
    } catch {
      return '';
    }
  }

  /**
   * Get memories relevant to a query by scanning descriptions.
   */
  async findRelevant(query: string, limit: number = 5): Promise<Memory[]> {
    const all = await this.loadAll();
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/);

    // Simple relevance scoring: count matching words in name + description
    const scored = all.map((memory) => {
      const text = `${memory.name} ${memory.description} ${memory.content}`.toLowerCase();
      let score = 0;
      for (const word of queryWords) {
        if (word.length > 2 && text.includes(word)) score++;
      }
      return { memory, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.memory);
  }

  // ─── Private ────────────────────────────────────────

  private async loadFromDir(dir: string): Promise<Memory[]> {
    const memories: Memory[] = [];

    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (!file.endsWith('.md') || file === 'MEMORY.md') continue;
        try {
          const content = await readFile(join(dir, file), 'utf-8');
          const memory = this.parseMemoryFile(content, file);
          if (memory) memories.push(memory);
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      // Directory doesn't exist yet
    }

    return memories;
  }

  private parseMemoryFile(content: string, filename: string): Memory | null {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
    if (!frontmatterMatch) return null;

    const frontmatter = frontmatterMatch[1]!;
    const body = frontmatterMatch[2]!;

    const name = this.extractField(frontmatter, 'name') ?? filename;
    const description = this.extractField(frontmatter, 'description') ?? '';
    const type = (this.extractField(frontmatter, 'type') ?? 'reference') as MemoryType;

    return { name, description, type, content: body.trim(), filename };
  }

  private extractField(frontmatter: string, field: string): string | null {
    const match = frontmatter.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
    return match ? match[1]!.trim() : null;
  }

  private async updateIndex(dir: string): Promise<void> {
    const memories = await this.loadFromDir(dir);
    const lines = memories.map(
      (m) => `- [${m.name}](${m.filename}) — ${m.description}`,
    );
    const indexContent = lines.join('\n') + '\n';
    await writeFile(join(dir, 'MEMORY.md'), indexContent, 'utf-8');
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60);
  }
}
