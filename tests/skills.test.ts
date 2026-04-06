/**
 * Tests for Layer 13 — Skills: Registry and matching
 */

import { describe, it, expect } from 'vitest';
import { SkillRegistry, type Skill, type SkillResult } from '../src/skills/loader.js';

function createTestSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: 'test-skill',
    description: 'A test skill',
    category: 'utility',
    triggers: [],
    execute: async () => ({ type: 'handled' } as SkillResult),
    ...overrides,
  };
}

describe('SkillRegistry', () => {
  it('registers and retrieves skills', () => {
    const registry = new SkillRegistry();
    const skill = createTestSkill({ name: 'my-skill' });

    registry.register(skill);
    expect(registry.get('my-skill')).toBe(skill);
    expect(registry.size).toBe(1);
  });

  it('unregisters skills', () => {
    const registry = new SkillRegistry();
    const skill = createTestSkill({ name: 'removable' });

    registry.register(skill);
    expect(registry.size).toBe(1);

    registry.unregister('removable');
    expect(registry.size).toBe(0);
    expect(registry.get('removable')).toBeUndefined();
  });

  it('filters by category', () => {
    const registry = new SkillRegistry();
    registry.register(createTestSkill({ name: 'a', category: 'workflow' }));
    registry.register(createTestSkill({ name: 'b', category: 'analysis' }));
    registry.register(createTestSkill({ name: 'c', category: 'workflow' }));

    expect(registry.getByCategory('workflow')).toHaveLength(2);
    expect(registry.getByCategory('analysis')).toHaveLength(1);
    expect(registry.getByCategory('custom')).toHaveLength(0);
  });
});

describe('SkillRegistry matching', () => {
  it('matches command triggers', () => {
    const registry = new SkillRegistry();
    const skill = createTestSkill({
      name: 'vibe',
      triggers: [{ type: 'command', command: 'vibe' }],
    });

    registry.register(skill);

    const match = registry.match('/vibe MyProject a cool app');
    expect(match).not.toBeNull();
    expect(match!.skill.name).toBe('vibe');
    expect(match!.args).toBe('MyProject a cool app');
  });

  it('matches keyword triggers', () => {
    const registry = new SkillRegistry();
    const skill = createTestSkill({
      name: 'brain',
      triggers: [{ type: 'keyword', keywords: ['second brain', 'obsidian vault'] }],
    });

    registry.register(skill);

    const match = registry.match('search my second brain for TypeScript patterns');
    expect(match).not.toBeNull();
    expect(match!.skill.name).toBe('brain');
  });

  it('matches pattern triggers', () => {
    const registry = new SkillRegistry();
    const skill = createTestSkill({
      name: 'hunt',
      triggers: [{ type: 'pattern', regex: /hunt\s+(?:for\s+)?bugs?\s+in\s+(.+)/i }],
    });

    registry.register(skill);

    const match = registry.match('hunt for bugs in src/auth/');
    expect(match).not.toBeNull();
    expect(match!.skill.name).toBe('hunt');
    expect(match!.args).toBe('src/auth/');
  });

  it('returns null when nothing matches', () => {
    const registry = new SkillRegistry();
    registry.register(createTestSkill({
      name: 'vibe',
      triggers: [{ type: 'command', command: 'vibe' }],
    }));

    expect(registry.match('just a normal message')).toBeNull();
    expect(registry.match('/unknown command')).toBeNull();
  });

  it('command triggers take priority over keywords', () => {
    const registry = new SkillRegistry();

    registry.register(createTestSkill({
      name: 'keyword-skill',
      triggers: [{ type: 'keyword', keywords: ['vibe'] }],
    }));

    registry.register(createTestSkill({
      name: 'command-skill',
      triggers: [{ type: 'command', command: 'vibe' }],
    }));

    // A /vibe command should match the command trigger, not keyword
    const match = registry.match('/vibe test');
    expect(match).not.toBeNull();
    expect(match!.skill.name).toBe('command-skill');
  });

  it('finds always-active skills', () => {
    const registry = new SkillRegistry();
    registry.register(createTestSkill({
      name: 'passive',
      triggers: [{ type: 'always' }],
    }));
    registry.register(createTestSkill({
      name: 'active',
      triggers: [{ type: 'command', command: 'active' }],
    }));

    const alwaysActive = registry.getAlwaysActive();
    expect(alwaysActive).toHaveLength(1);
    expect(alwaysActive[0]!.name).toBe('passive');
  });
});
