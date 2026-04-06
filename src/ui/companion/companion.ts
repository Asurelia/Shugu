/**
 * Companion generation — deterministic from a seed string.
 * Ported from OpenClaude buddy/companion.ts
 */

import type { CompanionBones, Companion, Rarity, Species, Eye, Hat } from './types.js';
import { SPECIES, EYES, HATS, RARITIES, RARITY_WEIGHTS } from './types.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

// ─── Hash Function ─────────────────────────────────────

function simpleHash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

// ─── Seeded Random ─────────────────────────────────────

class SeededRandom {
  private seed: number;
  constructor(seed: number) { this.seed = seed; }
  next(): number {
    this.seed = (this.seed * 1664525 + 1013904223) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)]!;
  }
  weightedPick<T extends string>(weights: Record<T, number>): T {
    const entries = Object.entries(weights) as [T, number][];
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [key, weight] of entries) {
      r -= weight;
      if (r <= 0) return key;
    }
    return entries[entries.length - 1]![0];
  }
}

// ─── Generate Companion Bones ──────────────────────────

export function generateBones(seed: string): CompanionBones {
  const rng = new SeededRandom(simpleHash(seed));

  const rarity = rng.weightedPick(RARITY_WEIGHTS);
  const species = rng.pick(SPECIES);
  const eye = rng.pick(EYES);
  const hat = rarity === 'common' ? 'none' as Hat : rng.pick(HATS);
  const shiny = rng.next() < 0.01;

  return { rarity, species, eye, hat, shiny };
}

// ─── Stored Companion ──────────────────────────────────

const CONFIG_DIR = join(homedir(), '.pcc');
const COMPANION_FILE = join(CONFIG_DIR, 'companion.json');

interface StoredCompanion {
  name: string;
  personality: string;
  hatchedAt: number;
}

export function getStoredCompanion(): StoredCompanion | null {
  try {
    const data = readFileSync(COMPANION_FILE, 'utf-8');
    return JSON.parse(data) as StoredCompanion;
  } catch {
    return null;
  }
}

export function saveCompanion(soul: StoredCompanion): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(COMPANION_FILE, JSON.stringify(soul, null, 2));
}

/**
 * Get the full companion (bones + soul).
 * If no soul is stored, generates a default one.
 */
export function getCompanion(seed?: string): Companion {
  const actualSeed = seed ?? `shugu-${homedir()}`;
  const bones = generateBones(actualSeed);

  let stored = getStoredCompanion();
  if (!stored) {
    // Default soul — user can rename via /buddy name
    const defaultNames: Record<Species, string> = {
      duck: 'Quacko', goose: 'Honkers', blob: 'Gloopy', cat: 'Shugu',
      dragon: 'Ember', octopus: 'Inky', owl: 'Hoot', penguin: 'Waddles',
      turtle: 'Shell', snail: 'Slick', ghost: 'Boo', axolotl: 'Axie',
      capybara: 'Cappy', cactus: 'Spike', robot: 'Beep', rabbit: 'Bun',
      mushroom: 'Spore', chonk: 'Chonky',
    };
    stored = {
      name: defaultNames[bones.species] ?? 'Buddy',
      personality: 'curious and helpful',
      hatchedAt: Date.now(),
    };
    saveCompanion(stored);
  }

  return { ...bones, ...stored };
}
