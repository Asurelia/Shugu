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
import { logger } from '../../utils/logger.js';

// ─── Session Errors ────────────────────────────────────

export class SessionCorruptedError extends Error {
  constructor(id: string, cause: unknown) {
    super(`Session corrupted: ${id}`);
    this.name = 'SessionCorruptedError';
    this.cause = cause;
  }
}

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
  /** Work context snapshot for session rehydration (optional for backwards compat) */
  workContext?: import('./work-context.js').WorkContext;
}

// ─── Session Snapshot ──────────────────────────────────

export interface SessionSnapshot {
  id: string;           // snapshot UUID
  sessionId: string;    // parent session
  turnIndex: number;    // number of messages at snapshot time
  messages: Message[];
  label?: string;
  createdAt: string;
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
   * Clone a session: deep-copy messages, generate a new ID, preserve everything else.
   * The cloned session is saved to disk and returned.
   */
  async clone(session: SessionData): Promise<SessionData> {
    const cloned: SessionData = {
      ...session,
      id: randomUUID().slice(0, 8),
      messages: structuredClone(session.messages),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.save(cloned);
    return cloned;
  }

  /**
   * Load a session by ID.
   * Returns null if the session file does not exist.
   * Throws SessionCorruptedError if the file exists but cannot be parsed.
   */
  async load(sessionId: string): Promise<SessionData | null> {
    const filePath = join(this.sessionsDir, `${sessionId}.json`);
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new SessionCorruptedError(sessionId, err);
    }
    try {
      return JSON.parse(content) as SessionData;
    } catch (err: unknown) {
      throw new SessionCorruptedError(sessionId, err);
    }
  }

  /**
   * Load the most recent session for a project directory.
   * Returns null if no sessions directory exists or no matching session is found.
   * Logs warnings for corrupted session files but continues scanning.
   */
  async loadLatest(projectDir: string): Promise<SessionData | null> {
    let files: string[];
    try {
      files = await readdir(this.sessionsDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }

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
      } catch (err: unknown) {
        const sessionId = file.replace('.json', '');
        logger.warn(`Corrupted session file: ${sessionId}`, err instanceof Error ? err.message : String(err));
      }
    }

    return latest;
  }

  /**
   * List recent sessions.
   * Returns empty array if sessions directory does not exist.
   * Logs warnings for corrupted session files but continues scanning.
   */
  async listRecent(limit: number = 10): Promise<SessionSummary[]> {
    let files: string[];
    try {
      files = await readdir(this.sessionsDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

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
      } catch (err: unknown) {
        const sessionId = file.replace('.json', '');
        logger.warn(`Corrupted session file: ${sessionId}`, err instanceof Error ? err.message : String(err));
      }
    }

    return summaries
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  // ─── Snapshots ─────────────────────────────────────────

  /**
   * Directory for a session's snapshots: ~/.pcc/sessions/snapshots/{sessionId}/
   */
  private snapshotsDir(sessionId: string): string {
    return join(this.sessionsDir, 'snapshots', sessionId);
  }

  /**
   * Create a snapshot of the current session state.
   * Stores a deep copy of the messages at the time of the snapshot.
   */
  async createSnapshot(session: SessionData, label?: string): Promise<SessionSnapshot> {
    const snapshot: SessionSnapshot = {
      id: randomUUID().slice(0, 8),
      sessionId: session.id,
      turnIndex: session.messages.length,
      messages: structuredClone(session.messages),
      ...(label !== undefined ? { label } : {}),
      createdAt: new Date().toISOString(),
    };

    const dir = this.snapshotsDir(session.id);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `${snapshot.id}.json`);
    await writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');

    return snapshot;
  }

  /**
   * List all snapshots for a session, sorted by creation time (newest first).
   * Returns empty array if no snapshots directory exists.
   */
  async listSnapshots(sessionId: string): Promise<SessionSnapshot[]> {
    const dir = this.snapshotsDir(sessionId);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const snapshots: SessionSnapshot[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const content = await readFile(join(dir, file), 'utf-8');
        snapshots.push(JSON.parse(content) as SessionSnapshot);
      } catch (err: unknown) {
        const snapshotId = file.replace('.json', '');
        logger.warn(`Corrupted snapshot file: ${snapshotId}`, err instanceof Error ? err.message : String(err));
      }
    }

    return snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Load a specific snapshot by ID and session ID.
   * Returns null if the snapshot file does not exist.
   */
  async loadSnapshot(snapshotId: string, sessionId: string): Promise<SessionSnapshot | null> {
    const filePath = join(this.snapshotsDir(sessionId), `${snapshotId}.json`);
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    try {
      return JSON.parse(content) as SessionSnapshot;
    } catch (err: unknown) {
      logger.warn(`Corrupted snapshot file: ${snapshotId}`, err instanceof Error ? err.message : String(err));
      return null;
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
