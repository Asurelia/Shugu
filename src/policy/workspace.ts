/**
 * Layer 4 — Policy: Workspace boundary enforcement
 *
 * Validates that file paths stay within the workspace directory.
 * Prevents path traversal attacks (../../etc/passwd) and symlink escapes.
 */

import { resolve, relative, dirname, sep } from 'node:path';
import { realpath, stat } from 'node:fs/promises';

export interface WorkspaceValidation {
  valid: boolean;
  resolvedPath: string;
  reason?: string;
}

/**
 * Validate that a file path resolves to within the workspace boundary.
 *
 * - Resolves relative paths against cwd
 * - Uses realpath() to follow symlinks and prevent symlink escape
 * - For new files (Write), validates the parent directory exists within workspace
 * - Returns the resolved absolute path for use by the tool
 */
export async function validateWorkspacePath(
  filePath: string,
  cwd: string,
): Promise<WorkspaceValidation> {
  const absPath = resolve(cwd, filePath);
  const cwdResolved = resolve(cwd);

  // Try realpath to resolve symlinks
  let realPath: string;
  try {
    realPath = await realpath(absPath);
  } catch {
    // File doesn't exist yet (e.g., Write creating new file)
    // Validate the parent directory instead
    const parentDir = dirname(absPath);
    try {
      const realParent = await realpath(parentDir);
      if (!isWithinBoundary(realParent, cwdResolved)) {
        return {
          valid: false,
          resolvedPath: absPath,
          reason: `Parent directory "${parentDir}" resolves outside workspace "${cwdResolved}"`,
        };
      }
      // Parent is within workspace; the new file path is valid
      return { valid: true, resolvedPath: absPath };
    } catch {
      // Parent doesn't exist either — do a pure path-based check
      // (can't use realpath, but resolve() already normalized ../
      if (!isWithinBoundary(absPath, cwdResolved)) {
        return {
          valid: false,
          resolvedPath: absPath,
          reason: `Path "${filePath}" resolves to "${absPath}" which is outside workspace "${cwdResolved}"`,
        };
      }
      return { valid: true, resolvedPath: absPath };
    }
  }

  if (!isWithinBoundary(realPath, cwdResolved)) {
    return {
      valid: false,
      resolvedPath: realPath,
      reason: `Path "${filePath}" resolves to "${realPath}" which is outside workspace "${cwdResolved}"`,
    };
  }

  return { valid: true, resolvedPath: realPath };
}

/**
 * Check if a path is within a boundary directory.
 * Handles both Unix and Windows path separators.
 */
function isWithinBoundary(targetPath: string, boundary: string): boolean {
  // Normalize both paths for comparison
  const normalizedTarget = targetPath.replace(/\\/g, '/').toLowerCase();
  const normalizedBoundary = boundary.replace(/\\/g, '/').toLowerCase();

  // Path must be the boundary itself or start with boundary + separator
  return normalizedTarget === normalizedBoundary
    || normalizedTarget.startsWith(normalizedBoundary + '/');
}
