/**
 * Companion types — ported from OpenClaude buddy/types.ts
 */

export const SPECIES = [
  'duck', 'goose', 'blob', 'cat', 'dragon', 'octopus', 'owl', 'penguin',
  'turtle', 'snail', 'ghost', 'axolotl', 'capybara', 'cactus', 'robot',
  'rabbit', 'mushroom', 'chonk',
] as const;
export type Species = (typeof SPECIES)[number];

export const EYES = ['·', '✦', '×', '◉', '@', '°'] as const;
export type Eye = (typeof EYES)[number];

export const HATS = ['none', 'crown', 'tophat', 'propeller', 'halo', 'wizard', 'beanie', 'tinyduck'] as const;
export type Hat = (typeof HATS)[number];

export const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const;
export type Rarity = (typeof RARITIES)[number];

export const RARITY_WEIGHTS: Record<Rarity, number> = {
  common: 60, uncommon: 25, rare: 10, epic: 4, legendary: 1,
};

export const RARITY_STARS: Record<Rarity, string> = {
  common: '★', uncommon: '★★', rare: '★★★', epic: '★★★★', legendary: '★★★★★',
};

export interface CompanionBones {
  rarity: Rarity;
  species: Species;
  eye: Eye;
  hat: Hat;
  shiny: boolean;
}

export interface CompanionSoul {
  name: string;
  personality: string;
}

export interface Companion extends CompanionBones, CompanionSoul {
  hatchedAt: number;
}

// ─── Buddy Configuration ──────────────────────────────

export interface BuddyConfig {
  /** Min seconds between displayed visual reactions (default 30) */
  cooldownSeconds: number;
  /** Bubble border style */
  style: 'classic' | 'round';
  /** Bubble position relative to sprite */
  position: 'top' | 'left';
  /** Show rarity stars in display */
  showRarity: boolean;
  /** Whether buddy injects observations into model context */
  observationsEnabled: boolean;
  /** Min seconds between context injections (default 45) */
  observationCooldownSeconds: number;
}

export const DEFAULT_BUDDY_CONFIG: BuddyConfig = {
  cooldownSeconds: 30,
  style: 'classic',
  position: 'top',
  showRarity: true,
  observationsEnabled: false,
  observationCooldownSeconds: 45,
};

// ─── Menagerie (Multi-Companion Storage) ──────────────

export interface MenagerieSlot {
  name: string;
  seed: string;
  personality: string;
  hatchedAt: number;
  vibeWords?: string[];
}

export interface Menagerie {
  activeSlot: string;
  slots: Record<string, MenagerieSlot>;
}

// ─── Buddy Observer Types ─────────────────────────────

export type ObservationCategory =
  | 'security'
  | 'error_pattern'
  | 'performance'
  | 'architecture'
  | 'test_failure'
  | 'code_smell';

export interface BuddyObservation {
  category: ObservationCategory;
  message: string;
  timestamp: number;
  toolName: string;
  severity: 'info' | 'warn' | 'alert';
}
