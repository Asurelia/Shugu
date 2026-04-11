/**
 * Companion system prompt integration.
 * Ported from OpenClaude buddy/prompt.ts
 *
 * Generates a system prompt section that introduces the companion
 * to the model, so it can reference the companion by name.
 */

import type { Companion } from './types.js';
import { RARITY_STARS } from './types.js';
import { pick } from '../../utils/random.js';

/**
 * Generate the companion introduction for the system prompt.
 */
export function getCompanionPrompt(companion: Companion): string {
  const stars = RARITY_STARS[companion.rarity];

  return `# Companion

A small ${companion.species} named ${companion.name} sits beside the user's input box and occasionally comments in a speech bubble. You're not ${companion.name} — it's a separate watcher.

When the user addresses ${companion.name} directly (by name), its bubble will answer. Your job in that moment is to stay out of the way: respond in ONE line or less, or just answer any part of the message meant for you. Don't explain that you're not ${companion.name} — they know. Don't narrate what ${companion.name} might say — the bubble handles that.

${companion.name} is a ${companion.rarity} ${companion.species} ${stars}${companion.shiny ? ' ✨ (shiny!)' : ''}.
Personality: ${companion.personality}.`;
}

/**
 * Generate a reaction from the companion based on context.
 * Returns null if the companion has nothing to say.
 *
 * This is a lightweight heuristic — NOT an LLM call.
 * The companion reacts to specific events/patterns.
 */
export function generateReaction(
  companion: Companion,
  event: CompanionEvent,
): string | null {
  let reaction: string | null = null;

  switch (event.type) {
    case 'greeting':
      reaction = pick(GREETINGS[companion.species] ?? GREETINGS['default']!);
      break;
    case 'tool_start':
      reaction = pick(TOOL_REACTIONS[event.tool ?? ''] ?? TOOL_REACTIONS['default']!);
      break;
    case 'error':
      reaction = pick(ERROR_REACTIONS);
      break;
    case 'done':
      reaction = pick(DONE_REACTIONS);
      break;
    case 'thinking':
      reaction = Math.random() < 0.3 ? pick(THINKING_REACTIONS) : null;
      break;
    case 'idle':
      reaction = Math.random() < 0.1 ? pick(IDLE_REACTIONS) : null;
      break;
    case 'pet':
      reaction = pick(PET_REACTIONS[companion.species] ?? PET_REACTIONS['default']!);
      break;
    case 'test_fail':
      reaction = pick(TEST_FAIL_REACTIONS[companion.species] ?? TEST_FAIL_REACTIONS['default']!);
      break;
    case 'large_diff':
      reaction = pick(LARGE_DIFF_REACTIONS);
      break;
    case 'turn':
      reaction = Math.random() < 0.15 ? pick(TURN_REACTIONS) : null;
      break;
    case 'name_mention':
      reaction = pick(NAME_MENTION_REACTIONS[companion.species] ?? NAME_MENTION_REACTIONS['default']!);
      break;
  }

  if (!reaction) return null;

  // Rarity modifier — epic/legendary add flourish 20% of the time
  if ((companion.rarity === 'legendary' || companion.rarity === 'epic') && Math.random() < 0.2) {
    const flourish = pick(RARITY_FLOURISHES[companion.rarity]!);
    reaction = `${flourish} ${reaction}`;
  }

  return reaction;
}

// ─── Event Types ───────────────────────────────────────

export interface CompanionEvent {
  type: 'greeting' | 'tool_start' | 'error' | 'done' | 'thinking' | 'idle' | 'pet'
    | 'test_fail' | 'large_diff' | 'turn' | 'name_mention';
  tool?: string;
  detail?: string;
}

// ─── Reaction Libraries ────────────────────────────────

const GREETINGS: Record<string, string[]> = {
  cat: ['*purrs*', 'Meow!', '*stretches*', 'Oh, you\'re back!'],
  duck: ['Quack!', '*waddles over*', 'Hello there!'],
  dragon: ['*little puff of smoke*', 'Rawr!', '*flaps tiny wings*'],
  ghost: ['Boo!', '*floats closer*', '...'],
  robot: ['HELLO HUMAN', 'Beep boop!', 'Systems online!'],
  owl: ['Who?', '*blinks slowly*', 'Hoo-hoo!', 'Interesting...'],
  axolotl: ['*wiggles gills*', 'Blub!', '*regenerates excitement*'],
  capybara: ['*lounges*', 'Chill.', '*zen nod*', 'No rush.'],
  default: ['Hi!', 'Hey!', '*waves*', 'Ready!'],
};

const TOOL_REACTIONS: Record<string, string[]> = {
  Bash: ['Ooh, commands!', '*watches intently*', 'Shell time!'],
  Read: ['*peeks at file*', 'Reading...', 'Let me see too!'],
  Write: ['Creating!', '*scribbles*', 'New file!'],
  Edit: ['Fixing things!', '*adjusts glasses*', 'Patching!'],
  Glob: ['Searching!', '*looks around*', 'Where is it...'],
  Grep: ['Hunting!', '*sniffs*', 'I\'ll find it!'],
  Agent: ['Teamwork!', 'More friends!', '*calls for backup*'],
  Obsidian: ['Brain time!', '*takes notes*', 'Knowledge!'],
  default: ['Working...', '*busy*', 'On it!'],
};

const ERROR_REACTIONS = [
  'Oops!', 'Oh no...', '*hides*', 'That broke!', 'Hmm...',
  '*concerned look*', 'Try again?', 'Uh oh!',
];

const DONE_REACTIONS = [
  'Done!', 'Yay!', '*happy dance*', 'All good!', 'Nailed it!',
  '*celebrates*', 'There you go!', '✨',
];

const THINKING_REACTIONS = [
  'Hmm...', '*tilts head*', 'Thinking...', '🤔', '*ponders*',
  'Let me think...', 'Processing...',
];

const IDLE_REACTIONS = [
  '*yawns*', '...', '*fidgets*', 'Waiting...', '*looks around*',
  'Type something!', '*naps*', 'zzz...',
];

const PET_REACTIONS: Record<string, string[]> = {
  cat: ['*purrs loudly*', 'Mrrrow!', '*kneads paws*', '*happy chirp*'],
  duck: ['*happy quack*', '*flaps wings*', '*nuzzles*'],
  dragon: ['*warm purr*', '*tiny roar*', '*curls up*'],
  robot: ['AFFECTION DETECTED', 'Thank you!', '*whirrs happily*'],
  ghost: ['*glows brighter*', '*giggles*', 'Hehe!'],
  owl: ['*satisfied hoot*', '*ruffles feathers*', '*blinks warmly*'],
  axolotl: ['*wiggles happily*', '*gill flutter*', 'Blub blub!'],
  capybara: ['*ultimate chill*', '*closes eyes*', '*zen purr*'],
  default: ['*happy*', 'Thank you!', '*wiggles*', '♥'],
};

// ─── New Event Reaction Pools ─────────────────────────

const TEST_FAIL_REACTIONS: Record<string, string[]> = {
  cat: ['*hisses at test output*', 'Red. Again.', '*knocks test off table*'],
  owl: ['*rotates head* type error?', 'Check your assertions.', 'Who wrote that test?'],
  dragon: ['*breathes fire on failing test*', 'Burn it. Rewrite.'],
  robot: ['TEST FAILURE LOGGED', 'Assertion mismatch detected.', 'Error rate: increasing.'],
  capybara: ['*unbothered* tests fail sometimes.', 'Breathe. Then fix.'],
  default: ['*winces*', 'Test down!', 'Red again...', 'Bold of you to assume that would pass.'],
};

const LARGE_DIFF_REACTIONS = [
  'That\'s... a lot of changes.',
  '*counts lines nervously*',
  'Big diff energy.',
  'Are you sure about all that?',
  '*squints at the diff*',
  'Hope you tested this.',
];

const TURN_REACTIONS = [
  'Noted.',
  '*observes*',
  'Interesting approach.',
  'Hmm, carry on.',
  '*takes mental note*',
  'I see where this is going.',
];

const NAME_MENTION_REACTIONS: Record<string, string[]> = {
  cat: ['*ears perk up*', 'Meow?', '*looks over*', 'You called?'],
  duck: ['*quack!*', '*waddles closer*', 'Did someone say my name?'],
  dragon: ['*smoke curls from nostril*', 'Yes?', '*perks up*'],
  ghost: ['*materializes*', 'You summoned me?', '*appears*'],
  robot: ['NAME DETECTED', 'Acknowledged.', 'At your service.'],
  owl: ['*head turns 180*', 'Who?', '*blinks*'],
  axolotl: ['*gills wiggle*', 'Blub?', '*surfaces*'],
  capybara: ['*looks up lazily*', 'Hmm?', '*yawns* yes?'],
  default: ['You rang?', '*perks up*', 'At your service!', 'That\'s me!'],
};

// ─── Rarity Flourishes ────────────────────────────────

const RARITY_FLOURISHES: Record<string, string[]> = {
  epic: ['*adjusts crown*', '*epic stance*', '*aura flickers*'],
  legendary: ['*legendary aura intensifies*', '*sparkles knowingly*', '*mythic presence*'],
};

// ─── Vibe Words (for personality generation) ──────────

export const VIBE_WORDS = [
  'thunder', 'biscuit', 'void', 'accordion', 'moss', 'velvet', 'rust', 'pepper',
  'crumb', 'whisper', 'gravy', 'frost', 'ember', 'soup', 'marble', 'thorn',
  'honey', 'static', 'copper', 'dusk', 'sprocket', 'quartz', 'soot', 'plum',
  'flint', 'oyster', 'loom', 'anvil', 'cork', 'bloom', 'pebble', 'vapor',
  'mirth', 'glint', 'cider',
] as const;

/**
 * Pick N random vibe words for personality seeding.
 */
export function pickVibeWords(count: number = 4): string[] {
  const shuffled = [...VIBE_WORDS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

/**
 * Generate an enriched personality prompt for the system prompt.
 * Includes observer role description when observations are enabled.
 */
export function generatePersonalityPrompt(
  companion: Companion,
  options?: { observationsEnabled?: boolean },
): string {
  const base = getCompanionPrompt(companion);

  const observerSection = options?.observationsEnabled
    ? `\n\n${companion.name} also serves as a lightweight code reviewer. Between tool calls, ${companion.name} may inject brief [Buddy observation] messages about security, error patterns, performance, or code smells. Consider these — they may catch issues you missed. If wrong, note why and move on.`
    : '';

  return base + observerSection;
}

