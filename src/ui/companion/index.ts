/**
 * Companion module — barrel export
 */

export { CompanionSprite, type CompanionSpriteProps } from './CompanionSprite.js';
export { getCompanion, generateBones, getStoredCompanion, saveCompanion } from './companion.js';
export { getCompanionPrompt, generateReaction, type CompanionEvent } from './prompt.js';
export { renderSprite, renderFace, spriteFrameCount } from './sprites.js';
export type { Companion, CompanionBones, CompanionSoul, Species, Eye, Hat, Rarity } from './types.js';
export { SPECIES, EYES, HATS, RARITIES, RARITY_STARS } from './types.js';
