/**
 * Layer 5 — Context: Read tracking
 *
 * Tracks which files have been read during the current session.
 * Used by FileEditTool to enforce "read before edit" at runtime.
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

  /** Get all read file paths (for debugging) */
  getReadFiles(): ReadonlySet<string> {
    return this.readFiles;
  }
}
