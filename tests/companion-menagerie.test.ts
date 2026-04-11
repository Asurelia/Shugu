/**
 * Tests for companion menagerie and buddy config persistence.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// We test the pure functions by importing from companion module
// Note: actual persistence tests need to mock the config dir
import { generateBones, generateStats } from '../src/ui/companion/companion.js';
import { DEFAULT_BUDDY_CONFIG } from '../src/ui/companion/types.js';
import type { BuddyConfig, MenagerieSlot, Menagerie } from '../src/ui/companion/types.js';

describe('generateBones', () => {
  it('produces deterministic results from same seed', () => {
    const a = generateBones('test-seed-123');
    const b = generateBones('test-seed-123');
    expect(a).toEqual(b);
  });

  it('produces different results from different seeds', () => {
    const a = generateBones('seed-alpha');
    const b = generateBones('seed-beta');
    // At least one field should differ (extremely unlikely to match all)
    const same = a.species === b.species && a.rarity === b.rarity && a.eye === b.eye;
    expect(same).toBe(false);
  });

  it('always produces valid species', () => {
    const validSpecies = ['duck', 'goose', 'blob', 'cat', 'dragon', 'octopus', 'owl',
      'penguin', 'turtle', 'snail', 'ghost', 'axolotl', 'capybara', 'cactus', 'robot',
      'rabbit', 'mushroom', 'chonk'];
    for (let i = 0; i < 50; i++) {
      const bones = generateBones(`test-${i}`);
      expect(validSpecies).toContain(bones.species);
    }
  });

  it('always produces valid rarity', () => {
    const validRarities = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
    for (let i = 0; i < 50; i++) {
      const bones = generateBones(`rarity-test-${i}`);
      expect(validRarities).toContain(bones.rarity);
    }
  });

  it('shiny is always a boolean', () => {
    for (let i = 0; i < 50; i++) {
      const bones = generateBones(`shiny-test-${i}`);
      expect(typeof bones.shiny).toBe('boolean');
    }
  });

  it('common companions have no hat', () => {
    // Generate many and check commons
    for (let i = 0; i < 100; i++) {
      const bones = generateBones(`hat-test-${i}`);
      if (bones.rarity === 'common') {
        expect(bones.hat).toBe('none');
      }
    }
  });
});

describe('generateStats', () => {
  it('produces 5 stats', () => {
    const bones = generateBones('stats-test');
    const stats = generateStats(bones);
    expect(Object.keys(stats)).toHaveLength(5);
    expect(stats).toHaveProperty('DEBUGGING');
    expect(stats).toHaveProperty('PATIENCE');
    expect(stats).toHaveProperty('CHAOS');
    expect(stats).toHaveProperty('WISDOM');
    expect(stats).toHaveProperty('SNARK');
  });

  it('produces deterministic stats from same bones', () => {
    const bones = generateBones('det-stats');
    const a = generateStats(bones);
    const b = generateStats(bones);
    expect(a).toEqual(b);
  });

  it('stats are between 1-100', () => {
    for (let i = 0; i < 50; i++) {
      const bones = generateBones(`range-test-${i}`);
      const stats = generateStats(bones);
      for (const val of Object.values(stats)) {
        expect(val).toBeGreaterThanOrEqual(1);
        expect(val).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe('BuddyConfig', () => {
  it('DEFAULT_BUDDY_CONFIG has correct defaults', () => {
    expect(DEFAULT_BUDDY_CONFIG.cooldownSeconds).toBe(30);
    expect(DEFAULT_BUDDY_CONFIG.style).toBe('classic');
    expect(DEFAULT_BUDDY_CONFIG.position).toBe('top');
    expect(DEFAULT_BUDDY_CONFIG.showRarity).toBe(true);
    expect(DEFAULT_BUDDY_CONFIG.observationsEnabled).toBe(false);
    expect(DEFAULT_BUDDY_CONFIG.observationCooldownSeconds).toBe(45);
  });

  it('config is complete (all fields present)', () => {
    const keys = Object.keys(DEFAULT_BUDDY_CONFIG);
    expect(keys).toContain('cooldownSeconds');
    expect(keys).toContain('style');
    expect(keys).toContain('position');
    expect(keys).toContain('showRarity');
    expect(keys).toContain('observationsEnabled');
    expect(keys).toContain('observationCooldownSeconds');
  });
});

describe('Menagerie types', () => {
  it('MenagerieSlot has expected shape', () => {
    const slot: MenagerieSlot = {
      name: 'TestBuddy',
      seed: 'shugu-test',
      personality: 'curious',
      hatchedAt: Date.now(),
    };
    expect(slot.name).toBe('TestBuddy');
    expect(slot.seed).toBe('shugu-test');
  });

  it('MenagerieSlot supports optional vibeWords', () => {
    const slot: MenagerieSlot = {
      name: 'TestBuddy',
      seed: 'shugu-test',
      personality: 'curious',
      hatchedAt: Date.now(),
      vibeWords: ['thunder', 'moss', 'velvet', 'ember'],
    };
    expect(slot.vibeWords).toHaveLength(4);
  });

  it('Menagerie structure is valid', () => {
    const menagerie: Menagerie = {
      activeSlot: 'default',
      slots: {
        default: {
          name: 'Buddy',
          seed: 'test-seed',
          personality: 'helpful',
          hatchedAt: Date.now(),
        },
        secondary: {
          name: 'Ember',
          seed: 'test-seed-2',
          personality: 'fierce',
          hatchedAt: Date.now(),
        },
      },
    };
    expect(Object.keys(menagerie.slots)).toHaveLength(2);
    expect(menagerie.activeSlot).toBe('default');
    expect(menagerie.slots['secondary']!.name).toBe('Ember');
  });
});
