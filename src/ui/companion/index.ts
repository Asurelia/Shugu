/**
 * Companion module — barrel export
 */

export { CompanionSprite, type CompanionSpriteProps } from './CompanionSprite.js';
export { getCompanion, generateBones, getStoredCompanion, saveCompanion, loadBuddyConfig } from './companion.js';
export { getCompanionPrompt, generateReaction, generatePersonalityPrompt, type CompanionEvent } from './prompt.js';
export { renderSprite, renderFace, spriteFrameCount } from './sprites.js';
export { BuddyObserver } from './observer.js';
export type { Companion, CompanionBones, CompanionSoul, Species, Eye, Hat, Rarity, BuddyConfig } from './types.js';
export { SPECIES, EYES, HATS, RARITIES, RARITY_STARS, DEFAULT_BUDDY_CONFIG } from './types.js';
