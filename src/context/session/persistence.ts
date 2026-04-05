/**
 * Layer 5 — Context: Session persistence
 *
 * Save and load conversation sessions to disk.
 * Storage: ~/.pcc/sessions/{sessionId}.json
 */

import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Message, Usage } from '../../protocol/messages.js';

// ─── Session Data ───────────────────────────────────────

export interface SessionData {
  id: string;
  projectDir: string;
  messages: Message[];
  model: string;
  totalUsage: Usage;
  turnCount: number;
  createdAt: string;
  updatedAt: string;
}

// ─── Session Manager ────────────────────────────────────

export class SessionManager {
  private sessionsDir: string;

  constructor() {
    this.sessionsDir = join(homedir(), '.pcc', 'sessions');
  }

  /**
   * Create a new session.
   */
  createSession(projectDir: string, model: string): SessionData {
    return {
      id: randomUUID().slice(0, 8),
      projectDir,
      messages: [],
      model,
      totalUsage: { input_tokens: 0, output_tokens: 0 },
      turnCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Save a session to disk.
   */
  async save(session: SessionData): Promise<string> {
    await mkdir(this.sessionsDir, { recursive: true });
    const filePath = join(this.sessionsDir, `${session.id}.json`);
    session.updatedAt = new Date().toISOString();
    await writeFile(filePath, JSON.stringify(session, null, 2), 'utf-8');
    return filePath;
  }

  /**
   * Load a session by ID.
   */
  async load(sessionId: string): Promise<SessionData | null> {
    try {
      const filePath = join(this.sessionsDir, `${sessionId}.json`);
      const content = await readFile(filePath, 'utf-8');
      return JSON.parse(content) as SessionData;
    } catch {
      return null;
    }
  }

  /**
   * Load the most recent session for a project directory.
   */
  async loadLatest(projectDir: string): Promise<SessionData | null> {
    try {
      const files = await readdir(this.sessionsDir);
      const jsonFiles = files.filter((f) => f.endsWith('.json'));

      let latest: SessionData | null = null;
      let latestTime = 0;

      for (const file of jsonFiles) {
        try {
          const filePath = join(this.sessionsDir, file);
          const fileStat = await stat(filePath);
          const content = await readFile(filePath, 'utf-8');
          const session = JSON.parse(content) as SessionData;

          if (session.projectDir === projectDir && fileStat.mtimeMs > latestTime) {
            latest = session;
            latestTime = fileStat.mtimeMs;
          }
        } catch {
          // Skip corrupted files
        }
      }

      return latest;
    } catch {
      return null;
    }
  }

  /**
   * List recent sessions.
   */
  async listRecent(limit: number = 10): Promise<SessionSummary[]> {
    try {
      const files = await readdir(this.sessionsDir);
      const summaries: SessionSummary[] = [];

      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const content = await readFile(join(this.sessionsDir, file), 'utf-8');
          const session = JSON.parse(content) as SessionData;
          summaries.push({
            id: session.id,
            projectDir: session.projectDir,
            turnCount: session.turnCount,
            updatedAt: session.updatedAt,
            model: session.model,
          });
        } catch {
          // Skip
        }
      }

      return summaries
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limit);
    } catch {
      return [];
    }
  }
}

export interface SessionSummary {
  id: string;
  projectDir: string;
  turnCount: number;
  updatedAt: string;
  model: string;
}
