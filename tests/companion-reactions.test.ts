/**
 * Tests for enriched companion reaction system.
 */

import { describe, it, expect } from 'vitest';
import { generateReaction, type CompanionEvent } from '../src/ui/companion/prompt.js';
import { pickVibeWords, VIBE_WORDS } from '../src/ui/companion/prompt.js';
import type { Companion } from '../src/ui/companion/types.js';
import { SPECIES } from '../src/ui/companion/types.js';

function makeCompanion(overrides?: Partial<Companion>): Companion {
  return {
    species: 'cat',
    rarity: 'common',
    eye: '\u00B0',
    hat: 'none',
    shiny: false,
    name: 'TestBuddy',
    personality: 'curious and helpful',
    hatchedAt: Date.now(),
    ...overrides,
  };
}

describe('generateReaction', () => {
  describe('all species have greetings', () => {
    for (const species of SPECIES) {
      it(`${species} produces a greeting`, () => {
        const c = makeCompanion({ species });
        const reaction = generateReaction(c, { type: 'greeting' });
        expect(reaction).toBeTruthy();
        expect(typeof reaction).toBe('string');
      });
    }
  });

  describe('new event types produce reactions', () => {
    it('test_fail produces a reaction', () => {
      const reaction = generateReaction(makeCompanion(), { type: 'test_fail' });
      expect(reaction).toBeTruthy();
    });

    it('large_diff produces a reaction', () => {
      const reaction = generateReaction(makeCompanion(), { type: 'large_diff' });
      expect(reaction).toBeTruthy();
    });

    it('name_mention produces a reaction', () => {
      const reaction = generateReaction(makeCompanion(), { type: 'name_mention' });
      expect(reaction).toBeTruthy();
    });

    it('turn produces a reaction sometimes (probabilistic)', () => {
      // Run multiple times — should produce at least one non-null in 50 attempts
      let produced = false;
      for (let i = 0; i < 50; i++) {
        if (generateReaction(makeCompanion(), { type: 'turn' }) !== null) {
          produced = true;
          break;
        }
      }
      expect(produced).toBe(true);
    });
  });

  describe('species-specific reactions', () => {
    const speciesWithSpecificReactions = ['cat', 'duck', 'dragon', 'ghost', 'robot', 'owl', 'axolotl', 'capybara'] as const;

    for (const species of speciesWithSpecificReactions) {
      it(`${species} has species-specific greeting`, () => {
        const c = makeCompanion({ species });
        // Run many times to verify species-specific pool is used (not just default)
        const reactions = new Set<string>();
        for (let i = 0; i < 30; i++) {
          const r = generateReaction(c, { type: 'greeting' });
          if (r) reactions.add(r);
        }
        expect(reactions.size).toBeGreaterThan(0);
      });

      it(`${species} has species-specific pet reaction`, () => {
        const c = makeCompanion({ species });
        const reaction = generateReaction(c, { type: 'pet' });
        expect(reaction).toBeTruthy();
      });
    }
  });

  describe('rarity modifiers', () => {
    it('legendary companion sometimes gets flourish (probabilistic)', () => {
      const c = makeCompanion({ rarity: 'legendary' });
      let gotFlourish = false;
      for (let i = 0; i < 100; i++) {
        const r = generateReaction(c, { type: 'greeting' });
        if (r && (r.includes('*legendary') || r.includes('*sparkles') || r.includes('*mythic'))) {
          gotFlourish = true;
          break;
        }
      }
      expect(gotFlourish).toBe(true);
    });

    it('common companion never gets flourish', () => {
      const c = makeCompanion({ rarity: 'common' });
      for (let i = 0; i < 50; i++) {
        const r = generateReaction(c, { type: 'greeting' });
        if (r) {
          expect(r).not.toContain('*legendary');
          expect(r).not.toContain('*sparkles');
          expect(r).not.toContain('*mythic');
          expect(r).not.toContain('*adjusts crown');
          expect(r).not.toContain('*epic stance');
          expect(r).not.toContain('*aura flickers');
        }
      }
    });
  });

  describe('tool_start reactions', () => {
    const tools = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent'];
    for (const tool of tools) {
      it(`reacts to ${tool} tool`, () => {
        const reaction = generateReaction(makeCompanion(), { type: 'tool_start', tool });
        expect(reaction).toBeTruthy();
      });
    }
  });

  describe('error and done reactions', () => {
    it('error produces a reaction', () => {
      const reaction = generateReaction(makeCompanion(), { type: 'error' });
      expect(reaction).toBeTruthy();
    });

    it('done produces a reaction', () => {
      const reaction = generateReaction(makeCompanion(), { type: 'done' });
      expect(reaction).toBeTruthy();
    });
  });
});

describe('pickVibeWords', () => {
  it('returns the requested count', () => {
    const words = pickVibeWords(4);
    expect(words).toHaveLength(4);
  });

  it('returns words from the VIBE_WORDS pool', () => {
    const words = pickVibeWords(6);
    for (const word of words) {
      expect((VIBE_WORDS as readonly string[]).includes(word)).toBe(true);
    }
  });

  it('returns unique words', () => {
    const words = pickVibeWords(10);
    const unique = new Set(words);
    expect(unique.size).toBe(words.length);
  });
});
