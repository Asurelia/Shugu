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
  switch (event.type) {
    case 'greeting':
      return pick(GREETINGS[companion.species] ?? GREETINGS['default']!);

    case 'tool_start':
      return pick(TOOL_REACTIONS[event.tool ?? ''] ?? TOOL_REACTIONS['default']!);

    case 'error':
      return pick(ERROR_REACTIONS);

    case 'done':
      return pick(DONE_REACTIONS);

    case 'thinking':
      return Math.random() < 0.3 ? pick(THINKING_REACTIONS) : null; // Only 30% chance

    case 'idle':
      return Math.random() < 0.1 ? pick(IDLE_REACTIONS) : null; // Rare idle comments

    case 'pet':
      return pick(PET_REACTIONS[companion.species] ?? PET_REACTIONS['default']!);

    default:
      return null;
  }
}

// ─── Event Types ───────────────────────────────────────

export interface CompanionEvent {
  type: 'greeting' | 'tool_start' | 'error' | 'done' | 'thinking' | 'idle' | 'pet';
  tool?: string;
}

// ─── Reaction Libraries ────────────────────────────────

const GREETINGS: Record<string, string[]> = {
  cat: ['*purrs*', 'Meow!', '*stretches*', 'Oh, you\'re back!'],
  duck: ['Quack!', '*waddles over*', 'Hello there!'],
  dragon: ['*little puff of smoke*', 'Rawr!', '*flaps tiny wings*'],
  ghost: ['Boo!', '*floats closer*', '...'],
  robot: ['HELLO HUMAN', 'Beep boop!', 'Systems online!'],
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
  default: ['*happy*', 'Thank you!', '*wiggles*', '♥'],
};

