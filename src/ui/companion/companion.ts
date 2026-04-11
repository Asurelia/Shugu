/**
 * Companion generation — deterministic from a seed string.
 * Ported from OpenClaude buddy/companion.ts
 */

import type { CompanionBones, Companion, Rarity, Species, Eye, Hat, BuddyConfig, Menagerie, MenagerieSlot } from './types.js';
import { SPECIES, EYES, HATS, RARITIES, RARITY_WEIGHTS, RARITY_STARS, DEFAULT_BUDDY_CONFIG } from './types.js';
import { renderSprite, renderFace } from './sprites.js';
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

// ─── Stats Generation ──────────────────────────────────

const STAT_NAMES = ['DEBUGGING', 'PATIENCE', 'CHAOS', 'WISDOM', 'SNARK'] as const;

const RARITY_STAT_FLOOR: Record<Rarity, number> = {
  common: 5, uncommon: 15, rare: 25, epic: 35, legendary: 50,
};

export function generateStats(bones: CompanionBones): Record<string, number> {
  const rng = new SeededRandom(simpleHash(`stats-${bones.species}-${bones.eye}-${bones.rarity}`));
  const floor = RARITY_STAT_FLOOR[bones.rarity];
  const stats: Record<string, number> = {};

  // Pick a peak stat and a dump stat
  const peakIdx = Math.floor(rng.next() * STAT_NAMES.length);
  const dumpIdx = (peakIdx + 2) % STAT_NAMES.length;

  for (let i = 0; i < STAT_NAMES.length; i++) {
    let val = floor + Math.floor(rng.next() * (100 - floor));
    if (i === peakIdx) val = Math.min(100, val + 20);
    if (i === dumpIdx) val = Math.max(floor, val - 25);
    stats[STAT_NAMES[i]!] = val;
  }

  return stats;
}

// ─── Display Functions ─────────────────────────────────

function statBar(value: number): string {
  const filled = Math.round(value / 100 * 14);
  return '█'.repeat(filled) + '░'.repeat(14 - filled);
}

/**
 * Render the full /buddy card as text lines.
 */
export function renderBuddyCard(companion: Companion): string[] {
  const stars = RARITY_STARS[companion.rarity];
  const stats = generateStats(companion);
  const sprite = renderSprite(companion, 0);
  const face = renderFace(companion);

  const lines: string[] = [];
  lines.push('╭───────────────────────────────────────╮');
  lines.push(`│  ${face}  ${companion.name}  ${stars}${companion.shiny ? ' ✨' : ''}`.padEnd(40) + '│');
  lines.push(`│  ${companion.rarity} ${companion.species}`.padEnd(40) + '│');
  lines.push('│' + '─'.repeat(39) + '│');

  // Sprite
  for (const spriteLine of sprite) {
    lines.push('│  ' + spriteLine.padEnd(37) + '│');
  }

  lines.push('│' + '─'.repeat(39) + '│');

  // Stats
  for (const [name, value] of Object.entries(stats)) {
    const bar = statBar(value);
    lines.push(`│  ${name.padEnd(10)} ${bar} ${String(value).padStart(3)}  │`);
  }

  lines.push('│' + '─'.repeat(39) + '│');
  lines.push(`│  Personality: ${companion.personality}`.slice(0, 39).padEnd(40) + '│');
  lines.push('╰───────────────────────────────────────╯');

  return lines;
}

/**
 * Render the compact /buddy view (sprite + name).
 */
export function renderBuddyCompact(companion: Companion): string[] {
  const stars = RARITY_STARS[companion.rarity];
  const sprite = renderSprite(companion, 0);
  const lines: string[] = [];
  for (const line of sprite) {
    lines.push(`  ${line}`);
  }
  lines.push(`  ${companion.name} — ${companion.rarity} ${companion.species} ${stars}${companion.shiny ? ' ✨' : ''}`);
  return lines;
}

/**
 * Render the hatch ceremony for a new companion.
 */
export function renderHatchCeremony(companion: Companion): string[] {
  const stars = RARITY_STARS[companion.rarity];
  const sprite = renderSprite(companion, 0);
  const stats = generateStats(companion);

  const lines: string[] = [];
  lines.push('');
  lines.push('  ✦ ✦ ✦  A wild companion appeared!  ✦ ✦ ✦');
  lines.push('');
  for (const line of sprite) {
    lines.push(`      ${line}`);
  }
  lines.push('');
  lines.push(`  Name: ${companion.name}`);
  lines.push(`  Species: ${companion.species} ${stars}${companion.shiny ? ' ✨ SHINY!' : ''}`);
  lines.push(`  Rarity: ${companion.rarity}`);
  lines.push(`  Personality: ${companion.personality}`);
  lines.push('');
  for (const [name, value] of Object.entries(stats)) {
    lines.push(`  ${name.padEnd(10)} ${statBar(value)} ${value}`);
  }
  lines.push('');
  lines.push(`  ${companion.name} will sit beside your input and observe your work.`);
  lines.push('  Use /buddy to see them, /buddy card for stats, /buddy pet for ♥');
  lines.push('');
  return lines;
}

/**
 * Check if this is the first time the companion is seen (for hatch ceremony).
 */
export function isFirstHatch(): boolean {
  return !existsSync(COMPANION_FILE);
}

// ─── Menagerie (Multi-Companion Storage) ──────────────

const MENAGERIE_FILE = join(CONFIG_DIR, 'menagerie.json');
const BUDDY_CONFIG_FILE = join(CONFIG_DIR, 'buddy-config.json');

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 14) || 'buddy';
}

/**
 * Load the menagerie. If none exists, auto-migrate from companion.json.
 */
export function loadMenagerie(): Menagerie {
  try {
    const data = readFileSync(MENAGERIE_FILE, 'utf-8');
    return JSON.parse(data) as Menagerie;
  } catch {
    // Auto-migrate from companion.json if it exists
    const stored = getStoredCompanion();
    const defaultSlot: MenagerieSlot = {
      name: stored?.name ?? 'Buddy',
      seed: `shugu-${homedir()}`,
      personality: stored?.personality ?? 'curious and helpful',
      hatchedAt: stored?.hatchedAt ?? Date.now(),
    };
    const menagerie: Menagerie = {
      activeSlot: 'default',
      slots: { default: defaultSlot },
    };
    saveMenagerie(menagerie);
    return menagerie;
  }
}

/**
 * Persist the menagerie to disk.
 */
export function saveMenagerie(menagerie: Menagerie): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(MENAGERIE_FILE, JSON.stringify(menagerie, null, 2));
}

/**
 * Save current companion to a named slot.
 * Throws if slot already exists (use saveCompanion for active slot updates).
 */
export function saveSlot(slotName: string, companion: Companion): void {
  const menagerie = loadMenagerie();
  const slug = slugify(slotName);
  if (menagerie.slots[slug]) {
    throw new Error(`Slot "${slug}" already exists. Use a different name.`);
  }
  menagerie.slots[slug] = {
    name: companion.name,
    seed: `shugu-${homedir()}-${slug}`,
    personality: companion.personality,
    hatchedAt: companion.hatchedAt,
    vibeWords: (companion as Companion & { vibeWords?: string[] }).vibeWords,
  };
  saveMenagerie(menagerie);
}

/**
 * Summon a companion from a named slot.
 * If the slot doesn't exist, generates a new companion deterministically from the slot name.
 */
export function summonSlot(slotName: string): Companion {
  const menagerie = loadMenagerie();
  const slug = slugify(slotName);
  const slot = menagerie.slots[slug];

  if (slot) {
    menagerie.activeSlot = slug;
    saveMenagerie(menagerie);
    const bones = generateBones(slot.seed);
    return { ...bones, name: slot.name, personality: slot.personality, hatchedAt: slot.hatchedAt };
  }

  // Generate new companion from slot name as seed
  const seed = `shugu-${homedir()}-${slug}`;
  const bones = generateBones(seed);
  const defaultNames: Record<Species, string> = {
    duck: 'Quacko', goose: 'Honkers', blob: 'Gloopy', cat: 'Shugu',
    dragon: 'Ember', octopus: 'Inky', owl: 'Hoot', penguin: 'Waddles',
    turtle: 'Shell', snail: 'Slick', ghost: 'Boo', axolotl: 'Axie',
    capybara: 'Cappy', cactus: 'Spike', robot: 'Beep', rabbit: 'Bun',
    mushroom: 'Spore', chonk: 'Chonky',
  };
  const newSlot: MenagerieSlot = {
    name: defaultNames[bones.species] ?? 'Buddy',
    seed,
    personality: 'curious and helpful',
    hatchedAt: Date.now(),
  };
  menagerie.slots[slug] = newSlot;
  menagerie.activeSlot = slug;
  saveMenagerie(menagerie);
  saveCompanion({ name: newSlot.name, personality: newSlot.personality, hatchedAt: newSlot.hatchedAt });

  return { ...bones, ...newSlot };
}

/**
 * List all saved companion slots.
 */
export function listSlots(): Array<{ slot: string; name: string; species: Species; rarity: Rarity; active: boolean }> {
  const menagerie = loadMenagerie();
  return Object.entries(menagerie.slots).map(([slug, slot]) => {
    const bones = generateBones(slot.seed);
    return {
      slot: slug,
      name: slot.name,
      species: bones.species,
      rarity: bones.rarity,
      active: slug === menagerie.activeSlot,
    };
  });
}

/**
 * Dismiss (remove) a saved companion slot.
 * Cannot dismiss the currently active slot.
 */
export function dismissSlot(slotName: string): boolean {
  const menagerie = loadMenagerie();
  const slug = slugify(slotName);
  if (!menagerie.slots[slug]) return false;
  if (slug === menagerie.activeSlot) {
    throw new Error(`Cannot dismiss active companion "${slug}". Summon another first.`);
  }
  delete menagerie.slots[slug];
  saveMenagerie(menagerie);
  return true;
}

// ─── Buddy Configuration ──────────────────────────────

/**
 * Load buddy config with defaults for any missing fields.
 */
export function loadBuddyConfig(): BuddyConfig {
  try {
    const data = readFileSync(BUDDY_CONFIG_FILE, 'utf-8');
    const stored = JSON.parse(data) as Partial<BuddyConfig>;
    return { ...DEFAULT_BUDDY_CONFIG, ...stored };
  } catch {
    return { ...DEFAULT_BUDDY_CONFIG };
  }
}

/**
 * Merge partial config updates and persist.
 */
export function saveBuddyConfig(config: Partial<BuddyConfig>): void {
  const current = loadBuddyConfig();
  const merged = { ...current, ...config };
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(BUDDY_CONFIG_FILE, JSON.stringify(merged, null, 2));
}
