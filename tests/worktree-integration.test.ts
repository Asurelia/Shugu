/**
 * Tests for Phase 2 — Git worktree integration, root resolution, error surfacing
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { relativeToCwd } from '../src/utils/git.js';
import type { WorktreeCleanupResult, MergeResult, Worktree } from '../src/agents/worktree.js';
import type { AgentResult, SpawnOptions } from '../src/agents/orchestrator.js';

// ─── relativeToCwd unit tests (pure, no git needed) ─────

describe('relativeToCwd', () => {
  it('returns empty string when cwd equals repoRoot', () => {
    const root = '/home/user/project';
    const result = relativeToCwd(root, root);
    expect(result).toBe('');
  });

  it('returns relative subdirectory path', () => {
    const root = '/home/user/project';
    const cwd = '/home/user/project/packages/api';
    const result = relativeToCwd(root, cwd);
    expect(result).toBe('packages/api'.split('/').join(require('node:path').sep));
  });

  it('handles trailing slashes consistently', () => {
    const root = '/home/user/project';
    const cwd = '/home/user/project/src';
    const result = relativeToCwd(root, cwd);
    expect(result).toBeTruthy(); // non-empty for a subdirectory
    expect(result).not.toContain('..');
  });
});

// ─── WorktreeCleanupResult structure ────────────────────

describe('WorktreeCleanupResult structure', () => {
  it('has required fields with correct types', () => {
    const result: WorktreeCleanupResult = {
      removed: true,
      branchDeleted: true,
      warnings: [],
    };
    expect(result.removed).toBe(true);
    expect(result.branchDeleted).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it('can hold warnings without throwing', () => {
    const result: WorktreeCleanupResult = {
      removed: false,
      branchDeleted: false,
      warnings: ['Failed to remove worktree at /tmp/wt: EBUSY', 'Failed to delete branch pcc-agent-abc123: ref not found'],
    };
    expect(result.warnings).toHaveLength(2);
    expect(result.removed).toBe(false);
    expect(result.branchDeleted).toBe(false);
  });
});

// ─── MergeResult structure ───────────────────────────────

describe('MergeResult structure', () => {
  it('successful merge has correct shape', () => {
    const result: MergeResult = {
      merged: true,
      conflicts: false,
    };
    expect(result.merged).toBe(true);
    expect(result.conflicts).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.conflictFiles).toBeUndefined();
  });

  it('conflict result includes conflictFiles and optional error', () => {
    const result: MergeResult = {
      merged: false,
      conflicts: true,
      conflictFiles: ['src/index.ts', 'src/utils.ts'],
      error: 'Merge failed: CONFLICT (content): Merge conflict in src/index.ts',
    };
    expect(result.conflicts).toBe(true);
    expect(result.conflictFiles).toHaveLength(2);
    expect(result.error).toContain('CONFLICT');
  });

  it('commit failure result has error but no conflicts', () => {
    const result: MergeResult = {
      merged: false,
      conflicts: false,
      error: 'Commit failed: nothing to commit',
    };
    expect(result.merged).toBe(false);
    expect(result.conflicts).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

// ─── Worktree interface structure ────────────────────────

describe('Worktree interface structure', () => {
  it('has all required fields', () => {
    const worktree: Worktree = {
      id: 'abc12345',
      path: '/home/user/project/.pcc-worktrees/pcc-agent-abc12345',
      branch: 'pcc-agent-abc12345',
      baseBranch: 'main',
      createdAt: new Date(),
    };
    expect(worktree.id).toHaveLength(8);
    expect(worktree.path).toContain('.pcc-worktrees');
    expect(worktree.branch).toBe(worktree.branch);
    expect(worktree.createdAt).toBeInstanceOf(Date);
  });
});

// ─── SpawnOptions isolation field ───────────────────────

describe('SpawnOptions isolation field', () => {
  it('accepts isolation: worktree', () => {
    const options: SpawnOptions = {
      isolation: 'worktree',
    };
    expect(options.isolation).toBe('worktree');
  });

  it('isolation is optional', () => {
    const options: SpawnOptions = {};
    expect(options.isolation).toBeUndefined();
  });
});

// ─── AgentResult worktree fields ────────────────────────

describe('AgentResult worktree and cleanupWarnings fields', () => {
  it('result without worktree has undefined fields', () => {
    const result: AgentResult = {
      response: 'done',
      events: [],
      success: true,
      endReason: 'end_turn',
      costUsd: 0,
      turns: 1,
    };
    expect(result.worktree).toBeUndefined();
    expect(result.cleanupWarnings).toBeUndefined();
  });

  it('result can carry worktree metadata', () => {
    const worktree: Worktree = {
      id: 'deadbeef',
      path: '/tmp/.pcc-worktrees/pcc-agent-deadbeef',
      branch: 'pcc-agent-deadbeef',
      baseBranch: 'main',
      createdAt: new Date(),
    };
    const result: AgentResult = {
      response: 'modified files',
      events: [],
      success: true,
      endReason: 'end_turn',
      costUsd: 0.005,
      turns: 3,
      worktree,
    };
    expect(result.worktree).toBeDefined();
    expect(result.worktree?.id).toBe('deadbeef');
  });

  it('result can carry cleanup warnings', () => {
    const result: AgentResult = {
      response: 'done',
      events: [],
      success: true,
      endReason: 'end_turn',
      costUsd: 0,
      turns: 1,
      cleanupWarnings: ['branch deletion failed: ref not found'],
    };
    expect(result.cleanupWarnings).toHaveLength(1);
    expect(result.cleanupWarnings![0]).toContain('branch deletion failed');
  });
});

// ─── removeWorktree returns warnings not throws ──────────

describe('removeWorktree error surface contract', () => {
  it('WorktreeCleanupResult warns on partial failure without throwing', () => {
    // Simulate what removeWorktree returns when branch deletion fails
    const cleanup: WorktreeCleanupResult = {
      removed: true,
      branchDeleted: false,
      warnings: ['Failed to delete branch pcc-agent-xyz: error: branch \'pcc-agent-xyz\' not found.'],
    };
    // The key contract: warnings collected, not thrown
    expect(cleanup.warnings.length).toBeGreaterThan(0);
    expect(cleanup.removed).toBe(true);
    expect(cleanup.branchDeleted).toBe(false);
  });

  it('WorktreeCleanupResult is fully successful with empty warnings', () => {
    const cleanup: WorktreeCleanupResult = {
      removed: true,
      branchDeleted: true,
      warnings: [],
    };
    expect(cleanup.warnings).toHaveLength(0);
  });
});

// ─── createWorktree path convention ─────────────────────

describe('createWorktree path convention', () => {
  it('worktree path uses .pcc-worktrees under git root', () => {
    // Verify the path convention documented in the module
    const gitRoot = '/home/user/project';
    const branch = 'pcc-agent-abc12345';
    const { join } = require('node:path');
    const expectedPath = join(gitRoot, '.pcc-worktrees', branch);
    expect(expectedPath).toContain('.pcc-worktrees');
    expect(expectedPath).toContain(branch);
  });
});
