/**
 * Layer 13 — Skills: barrel export + registration helper
 */

export {
  SkillRegistry,
  loadBundledSkills,
  loadExternalSkills,
  generateSkillsPrompt,
  type Skill,
  type SkillCategory,
  type SkillTrigger,
  type SkillContext,
  type SkillResult,
} from './loader.js';

export {
  generateSkillSource,
  saveGeneratedSkill,
  skillCreatorSkill,
} from './generator.js';

// Bundled skills
export { vibeSkill } from './bundled/vibe.js';
export { dreamSkill } from './bundled/dream.js';
export { hunterSkill } from './bundled/hunter.js';
export { loopSkill } from './bundled/loop.js';
export { scheduleSkill } from './bundled/schedule.js';
export { secondBrainSkill } from './bundled/secondbrain.js';

// ─── Registration Helper ──────────────────────────────

import { SkillRegistry } from './loader.js';
import { vibeSkill } from './bundled/vibe.js';
import { dreamSkill } from './bundled/dream.js';
import { hunterSkill } from './bundled/hunter.js';
import { loopSkill } from './bundled/loop.js';
import { scheduleSkill } from './bundled/schedule.js';
import { secondBrainSkill } from './bundled/secondbrain.js';
import { skillCreatorSkill } from './generator.js';

/**
 * Create a skill registry with all bundled skills registered.
 */
export function createDefaultSkillRegistry(): SkillRegistry {
  const registry = new SkillRegistry();

  // Workflow skills
  registry.register(vibeSkill);

  // Analysis skills
  registry.register(dreamSkill);
  registry.register(hunterSkill);

  // Automation skills
  registry.register(scheduleSkill);

  // Knowledge skills
  registry.register(secondBrainSkill);

  // Utility skills
  registry.register(loopSkill);
  registry.register(skillCreatorSkill);

  return registry;
}
