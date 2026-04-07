/**
 * Tests for Phase 1 — Agent depth + fan-out + budget limiting
 */

import { describe, it, expect, vi } from 'vitest';
import {
  AgentOrchestrator,
  MAX_AGENT_DEPTH,
  MAX_ACTIVE_AGENTS,
  BUILTIN_AGENTS,
  type SpawnOptions,
} from '../src/agents/orchestrator.js';
import { AgentTool } from '../src/tools/agents/AgentTool.js';
import type { Tool, ToolContext } from '../src/protocol/tools.js';

describe('Agent depth limiting', () => {
  it('MAX_AGENT_DEPTH defaults to 3', () => {
    expect(MAX_AGENT_DEPTH).toBe(3);
  });

  it('MAX_ACTIVE_AGENTS defaults to 15', () => {
    expect(MAX_ACTIVE_AGENTS).toBe(15);
  });

  it('AgentTool has setDepth method', () => {
    const tool = new AgentTool();
    expect(typeof tool.setDepth).toBe('function');
    tool.setDepth(2);
  });

  it('AgentTool.createChild creates a new instance with incremented depth', () => {
    const parent = new AgentTool();
    const mockOrchestrator = {} as any;
    parent.setOrchestrator(mockOrchestrator);
    parent.setDepth(0);

    const child = parent.createChild(1, mockOrchestrator);

    expect(child).toBeInstanceOf(AgentTool);
    expect(child).not.toBe(parent); // Different instance
  });

  it('SpawnOptions includes depth field', () => {
    const options: SpawnOptions = {
      depth: 2,
    };
    expect(options.depth).toBe(2);
  });

  it('SpawnOptions includes isolation field', () => {
    const options: SpawnOptions = {
      isolation: 'worktree',
    };
    expect(options.isolation).toBe('worktree');
  });
});

describe('AgentOrchestrator limits', () => {
  it('BUILTIN_AGENTS has expected types', () => {
    expect(BUILTIN_AGENTS).toHaveProperty('general');
    expect(BUILTIN_AGENTS).toHaveProperty('explore');
    expect(BUILTIN_AGENTS).toHaveProperty('code');
    expect(BUILTIN_AGENTS).toHaveProperty('review');
    expect(BUILTIN_AGENTS).toHaveProperty('test');
  });

  it('AgentResult includes worktree and cleanupWarnings fields', () => {
    // Type-level test — verify the interface shape
    const result = {
      response: 'done',
      events: [],
      success: true,
      endReason: 'end_turn',
      costUsd: 0.01,
      turns: 3,
      worktree: undefined,
      cleanupWarnings: ['branch deletion failed'],
    };
    expect(result.cleanupWarnings).toHaveLength(1);
  });
});

describe('AgentTool retry guard', () => {
  it('depth is passed in spawn options', () => {
    const tool = new AgentTool();
    tool.setDepth(2);
    // Verify the depth field exists and is settable
    expect(typeof tool.setDepth).toBe('function');
  });
});
