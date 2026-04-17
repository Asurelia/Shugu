/**
 * Layer 5 — Context: Read tracking
 *
 * Tracks which files have been read during the current session.
 * Used by FileEditTool / FileWriteTool to enforce "read before modify".
 *
 * Invalidation contract:
 * - markRead(path)    — file has been observed
 * - invalidate(path)  — file state changed (after Write/Edit), marker cleared
 * - clear()           — wipe all state (on /clear or session rotate)
 *
 * The tracker answers "has this session observed the current-on-disk state
 * of path?" — it's NOT a proof the file is unchanged on disk (an external
 * process can modify it), but invalidating after our own writes prevents
 * the common case where hasRead() returns true for stale in-memory state.
 */

export class ReadTracker {
  private readFiles = new Set<string>();

  /** Mark a file as having been read */
  markRead(absPath: string): void {
    this.readFiles.add(absPath);
  }

  /** Check if a file has been read in this session */
  hasRead(absPath: string): boolean {
    return this.readFiles.has(absPath);
  }

  /**
   * Forget that a file was read. Call after Write/Edit mutates the file so
   * subsequent writes in interactive modes re-require a Read.
   */
  invalidate(absPath: string): void {
    this.readFiles.delete(absPath);
  }

  /** Wipe all tracked files (for /clear, session rotate). */
  clear(): void {
    this.readFiles.clear();
  }

  /** Number of tracked files (observability / /trace debugging). */
  size(): number {
    return this.readFiles.size;
  }

  /** Get all read file paths (for debugging) */
  getReadFiles(): ReadonlySet<string> {
    return this.readFiles;
  }
}
