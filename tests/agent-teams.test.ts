/**
 * Tests for Phase 3 — Agent Teams (swarms)
 */

import { describe, it, expect, vi } from 'vitest';
import {
  AgentTeam,
  TEAM_TEMPLATES,
  type TeamMember,
  type TeamConfig,
  type TeamResult,
} from '../src/agents/teams.js';
import { MAX_ACTIVE_AGENTS } from '../src/agents/orchestrator.js';

// ─── TEAM_TEMPLATES structure ──────────────────────────

describe('TEAM_TEMPLATES', () => {
  it('has default template', () => {
    expect(TEAM_TEMPLATES).toHaveProperty('default');
    expect(TEAM_TEMPLATES['default']!.mode).toBe('chain');
    expect(TEAM_TEMPLATES['default']!.members).toHaveLength(3);
  });

  it('default template has explorer, coder, reviewer roles', () => {
    const roles = TEAM_TEMPLATES['default']!.members.map((m) => m.role);
    expect(roles).toContain('explorer');
    expect(roles).toContain('coder');
    expect(roles).toContain('reviewer');
  });

  it('has parallel template', () => {
    expect(TEAM_TEMPLATES).toHaveProperty('parallel');
    expect(TEAM_TEMPLATES['parallel']!.mode).toBe('parallel');
    expect(TEAM_TEMPLATES['parallel']!.members).toHaveLength(3);
  });

  it('parallel template has worker-1, worker-2, worker-3 roles', () => {
    const roles = TEAM_TEMPLATES['parallel']!.members.map((m) => m.role);
    expect(roles).toContain('worker-1');
    expect(roles).toContain('worker-2');
    expect(roles).toContain('worker-3');
  });

  it('has review template', () => {
    expect(TEAM_TEMPLATES).toHaveProperty('review');
    expect(TEAM_TEMPLATES['review']!.mode).toBe('parallel');
    expect(TEAM_TEMPLATES['review']!.members).toHaveLength(3);
  });

  it('review template has security, logic, architecture roles', () => {
    const roles = TEAM_TEMPLATES['review']!.members.map((m) => m.role);
    expect(roles).toContain('security');
    expect(roles).toContain('logic');
    expect(roles).toContain('architecture');
  });

  it('all review members use review agentType', () => {
    for (const member of TEAM_TEMPLATES['review']!.members) {
      expect(member.agentType).toBe('review');
    }
  });

  it('all members have roleContext', () => {
    for (const [, tmpl] of Object.entries(TEAM_TEMPLATES)) {
      for (const member of tmpl.members) {
        expect(member.roleContext).toBeTruthy();
      }
    }
  });
});

// ─── TeamConfig interface ───────────────────────────────

describe('TeamConfig structure', () => {
  it('TeamConfig accepts mode parallel', () => {
    const config: TeamConfig = {
      name: 'Test',
      mode: 'parallel',
      members: [{ role: 'a', agentType: 'general' }],
    };
    expect(config.mode).toBe('parallel');
  });

  it('TeamConfig accepts mode chain', () => {
    const config: TeamConfig = {
      name: 'Test',
      mode: 'chain',
      members: [{ role: 'a', agentType: 'general' }],
    };
    expect(config.mode).toBe('chain');
  });

  it('TeamConfig supports isolation worktree', () => {
    const config: TeamConfig = {
      name: 'Test',
      mode: 'parallel',
      isolation: 'worktree',
      members: [],
    };
    expect(config.isolation).toBe('worktree');
  });

  it('TeamConfig supports maxBudgetUsd', () => {
    const config: TeamConfig = {
      name: 'Test',
      mode: 'parallel',
      maxBudgetUsd: 0.50,
      members: [],
    };
    expect(config.maxBudgetUsd).toBe(0.50);
  });
});

// ─── TeamMember interface ───────────────────────────────

describe('TeamMember structure', () => {
  it('TeamMember requires role and agentType', () => {
    const member: TeamMember = {
      role: 'tester',
      agentType: 'test',
    };
    expect(member.role).toBe('tester');
    expect(member.agentType).toBe('test');
  });

  it('TeamMember accepts optional roleContext', () => {
    const member: TeamMember = {
      role: 'tester',
      agentType: 'test',
      roleContext: 'Focus on integration tests.',
    };
    expect(member.roleContext).toBe('Focus on integration tests.');
  });
});

// ─── AgentTeam constructor ──────────────────────────────

describe('AgentTeam constructor', () => {
  it('exposes name from config', () => {
    const mockOrchestrator = { activeCount: 0 } as any;
    const config: TeamConfig = {
      name: 'My Team',
      mode: 'parallel',
      members: [{ role: 'a', agentType: 'general' }],
    };
    const team = new AgentTeam(mockOrchestrator, config);
    expect(team.name).toBe('My Team');
  });

  it('exposes members from config', () => {
    const mockOrchestrator = { activeCount: 0 } as any;
    const members: TeamMember[] = [
      { role: 'a', agentType: 'general' },
      { role: 'b', agentType: 'review' },
    ];
    const config: TeamConfig = { name: 'Test', members };
    const team = new AgentTeam(mockOrchestrator, config);
    expect(team.members).toHaveLength(2);
    expect(team.members[0]!.role).toBe('a');
    expect(team.members[1]!.role).toBe('b');
  });
});

// ─── Fan-out guard ──────────────────────────────────────

describe('AgentTeam fan-out guard', () => {
  it('rejects dispatch when activeCount + memberCount > MAX_ACTIVE_AGENTS', async () => {
    const mockOrchestrator = { activeCount: MAX_ACTIVE_AGENTS - 1 } as any;
    const members: TeamMember[] = [
      { role: 'a', agentType: 'general' },
      { role: 'b', agentType: 'general' },
    ];
    const config: TeamConfig = { name: 'Test', mode: 'parallel', members };
    const team = new AgentTeam(mockOrchestrator, config);

    const result = await team.dispatch('do something');

    expect(result.allSucceeded).toBe(false);
    expect(result.totalCostUsd).toBe(0);
    expect(result.results.size).toBe(0);
    expect(result.summary).toContain('rejected');
    expect(result.summary).toContain('agent limit');
  });

  it('allows dispatch when activeCount + memberCount <= MAX_ACTIVE_AGENTS', async () => {
    const spawnFn = vi.fn().mockResolvedValue({
      response: 'done',
      events: [],
      success: true,
      endReason: 'end_turn',
      costUsd: 0.001,
      turns: 1,
    });
    const mockOrchestrator = { activeCount: 0, spawn: spawnFn } as any;
    const config: TeamConfig = {
      name: 'Small',
      mode: 'parallel',
      members: [{ role: 'solo', agentType: 'general' }],
    };
    const team = new AgentTeam(mockOrchestrator, config);

    const result = await team.dispatch('small task');

    expect(spawnFn).toHaveBeenCalledOnce();
    expect(result.allSucceeded).toBe(true);
  });
});

// ─── Budget splitting ───────────────────────────────────

describe('AgentTeam budget splitting', () => {
  it('splits maxBudgetUsd evenly across members', async () => {
    const capturedOptions: any[] = [];
    const spawnFn = vi.fn().mockImplementation((_task, _type, opts) => {
      capturedOptions.push(opts);
      return Promise.resolve({
        response: 'ok',
        events: [],
        success: true,
        endReason: 'end_turn',
        costUsd: 0,
        turns: 1,
      });
    });
    const mockOrchestrator = { activeCount: 0, spawn: spawnFn } as any;
    const config: TeamConfig = {
      name: 'Budget Test',
      mode: 'parallel',
      maxBudgetUsd: 0.30,
      members: [
        { role: 'a', agentType: 'general' },
        { role: 'b', agentType: 'general' },
        { role: 'c', agentType: 'general' },
      ],
    };
    const team = new AgentTeam(mockOrchestrator, config);
    await team.dispatch('test budget');

    expect(capturedOptions).toHaveLength(3);
    for (const opts of capturedOptions) {
      expect(opts.maxBudgetUsd).toBeCloseTo(0.10, 5);
    }
  });

  it('passes undefined budget when maxBudgetUsd not set', async () => {
    const capturedOptions: any[] = [];
    const spawnFn = vi.fn().mockImplementation((_task, _type, opts) => {
      capturedOptions.push(opts);
      return Promise.resolve({
        response: 'ok',
        events: [],
        success: true,
        endReason: 'end_turn',
        costUsd: 0,
        turns: 1,
      });
    });
    const mockOrchestrator = { activeCount: 0, spawn: spawnFn } as any;
    const config: TeamConfig = {
      name: 'No Budget',
      mode: 'parallel',
      members: [{ role: 'a', agentType: 'general' }],
    };
    const team = new AgentTeam(mockOrchestrator, config);
    await team.dispatch('test no budget');

    expect(capturedOptions[0].maxBudgetUsd).toBeUndefined();
  });
});

// ─── Mode selection ─────────────────────────────────────

describe('AgentTeam mode selection', () => {
  it('runs delegateParallel when mode is parallel', async () => {
    const spawnFn = vi.fn().mockResolvedValue({
      response: 'ok',
      events: [],
      success: true,
      endReason: 'end_turn',
      costUsd: 0,
      turns: 1,
    });
    const mockOrchestrator = { activeCount: 0, spawn: spawnFn } as any;
    const config: TeamConfig = {
      name: 'Parallel',
      mode: 'parallel',
      members: [
        { role: 'a', agentType: 'general' },
        { role: 'b', agentType: 'general' },
      ],
    };
    const team = new AgentTeam(mockOrchestrator, config);
    const result = await team.dispatch('task');

    // Both spawned concurrently (Promise.all) — order may vary but both called
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(result.results.has('a')).toBe(true);
    expect(result.results.has('b')).toBe(true);
    expect(result.summary).toContain('Parallel execution');
  });

  it('runs delegateChain when mode is chain', async () => {
    const spawnFn = vi.fn().mockResolvedValue({
      response: 'findings from step',
      events: [],
      success: true,
      endReason: 'end_turn',
      costUsd: 0,
      turns: 1,
    });
    const mockOrchestrator = { activeCount: 0, spawn: spawnFn } as any;
    const config: TeamConfig = {
      name: 'Chain',
      mode: 'chain',
      members: [
        { role: 'step1', agentType: 'explore' },
        { role: 'step2', agentType: 'code' },
      ],
    };
    const team = new AgentTeam(mockOrchestrator, config);
    const result = await team.dispatch('task');

    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(result.results.has('step1')).toBe(true);
    expect(result.results.has('step2')).toBe(true);
    expect(result.summary).toContain('Chain execution');
  });

  it('defaults to parallel when mode is not specified', async () => {
    const spawnFn = vi.fn().mockResolvedValue({
      response: 'ok',
      events: [],
      success: true,
      endReason: 'end_turn',
      costUsd: 0,
      turns: 1,
    });
    const mockOrchestrator = { activeCount: 0, spawn: spawnFn } as any;
    const config: TeamConfig = {
      name: 'No Mode',
      members: [{ role: 'x', agentType: 'general' }],
    };
    const team = new AgentTeam(mockOrchestrator, config);
    const result = await team.dispatch('task');

    expect(spawnFn).toHaveBeenCalledOnce();
    expect(result.summary).toContain('Parallel execution');
  });

  it('roleContext is prepended to task prompt', async () => {
    const capturedPrompts: string[] = [];
    const spawnFn = vi.fn().mockImplementation((prompt) => {
      capturedPrompts.push(prompt);
      return Promise.resolve({
        response: 'ok',
        events: [],
        success: true,
        endReason: 'end_turn',
        costUsd: 0,
        turns: 1,
      });
    });
    const mockOrchestrator = { activeCount: 0, spawn: spawnFn } as any;
    const config: TeamConfig = {
      name: 'Context Test',
      mode: 'parallel',
      members: [
        { role: 'a', agentType: 'general', roleContext: 'Be thorough.' },
      ],
    };
    const team = new AgentTeam(mockOrchestrator, config);
    await team.dispatch('fix the bug');

    expect(capturedPrompts[0]).toContain('Be thorough.');
    expect(capturedPrompts[0]).toContain('fix the bug');
  });
});

// ─── TeamResult cleanup warnings ───────────────────────

describe('TeamResult cleanup warnings', () => {
  it('aggregates cleanupWarnings from all results', async () => {
    const spawnFn = vi.fn()
      .mockResolvedValueOnce({
        response: 'ok',
        events: [],
        success: true,
        endReason: 'end_turn',
        costUsd: 0,
        turns: 1,
        cleanupWarnings: ['branch-a deletion failed'],
      })
      .mockResolvedValueOnce({
        response: 'ok',
        events: [],
        success: true,
        endReason: 'end_turn',
        costUsd: 0,
        turns: 1,
        cleanupWarnings: ['branch-b deletion failed'],
      });
    const mockOrchestrator = { activeCount: 0, spawn: spawnFn } as any;
    const config: TeamConfig = {
      name: 'Cleanup Test',
      mode: 'parallel',
      members: [
        { role: 'a', agentType: 'general' },
        { role: 'b', agentType: 'general' },
      ],
    };
    const team = new AgentTeam(mockOrchestrator, config);
    const result = await team.dispatch('task');

    expect(result.cleanupWarnings).toHaveLength(2);
    expect(result.cleanupWarnings).toContain('branch-a deletion failed');
    expect(result.cleanupWarnings).toContain('branch-b deletion failed');
  });

  it('returns empty cleanupWarnings when no warnings', async () => {
    const spawnFn = vi.fn().mockResolvedValue({
      response: 'ok',
      events: [],
      success: true,
      endReason: 'end_turn',
      costUsd: 0,
      turns: 1,
    });
    const mockOrchestrator = { activeCount: 0, spawn: spawnFn } as any;
    const config: TeamConfig = {
      name: 'Clean',
      mode: 'parallel',
      members: [{ role: 'a', agentType: 'general' }],
    };
    const team = new AgentTeam(mockOrchestrator, config);
    const result = await team.dispatch('task');

    expect(result.cleanupWarnings).toHaveLength(0);
  });
});
