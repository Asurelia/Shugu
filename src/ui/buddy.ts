import { pick } from '../utils/random.js';
import type { Companion } from './companion/types.js';
import { renderSprite, renderFace } from './companion/sprites.js';
import { generateReaction, type CompanionEvent } from './companion/prompt.js';

/**
 * Layer 11 — UI: Buddy companion
 *
 * ASCII character with speech bubbles that reacts to events.
 * Positioned in the right margin of the terminal.
 * Now integrates with the companion system for real species rendering.
 *
 * States: idle, thinking, working, happy, error, sleeping
 */

const R = '\x1b[0m';
const D = '\x1b[2m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const MAGENTA = '\x1b[35m';
const GRAY = '\x1b[90m';

// ─── Buddy States ───────────────────────────────────────

export type BuddyState = 'idle' | 'thinking' | 'working' | 'happy' | 'error' | 'sleeping' | 'searching';

const BUDDY_FRAMES: Record<BuddyState, string[]> = {
  idle: [
    `   ${GRAY}(___) ${R}`,
    `   ${GRAY}/\\_/\\ ${R}`,
    `  ${CYAN}( o   o)${R}`,
    `  ${CYAN}(  ${MAGENTA}ω${CYAN}  )${R}`,
    `   ${CYAN}(")_(")${R}`,
    `   ${D}Shugu${R}`,
  ],
  thinking: [
    `  ${YELLOW}💭...${R}`,
    `   ${GRAY}/\\_/\\ ${R}`,
    `  ${YELLOW}( •   •)${R}`,
    `  ${YELLOW}(  ${MAGENTA}~${YELLOW}  )${R}`,
    `   ${YELLOW}(")_(")${R}`,
    `   ${D}hmm..${R}`,
  ],
  working: [
    `  ${GREEN}⚡${R}`,
    `   ${GRAY}/\\_/\\ ${R}`,
    `  ${GREEN}( >   <)${R}`,
    `  ${GREEN}(  ${MAGENTA}w${GREEN}  )${R}`,
    `   ${GREEN}(")_(")${R}`,
    `   ${D}busy!${R}`,
  ],
  happy: [
    `  ${GREEN}✨${R}`,
    `   ${GRAY}/\\_/\\ ${R}`,
    `  ${GREEN}( ^   ^)${R}`,
    `  ${GREEN}(  ${MAGENTA}ω${GREEN}  )${R}`,
    `   ${GREEN}(")_(")${R}`,
    `   ${D}yay! ${R}`,
  ],
  error: [
    `  ${RED}⚠${R}`,
    `   ${GRAY}/\\_/\\ ${R}`,
    `  ${RED}( x   x)${R}`,
    `  ${RED}(  ${MAGENTA}△${RED}  )${R}`,
    `   ${RED}(")_(")${R}`,
    `   ${D}oops ${R}`,
  ],
  sleeping: [
    `  ${GRAY}z Z z${R}`,
    `   ${GRAY}/\\_/\\ ${R}`,
    `  ${GRAY}( -   -)${R}`,
    `  ${GRAY}(  ${D}ω${GRAY}  )${R}`,
    `   ${GRAY}(")_(")${R}`,
    `   ${D}zzz..${R}`,
  ],
  searching: [
    `  ${CYAN}🔍${R}`,
    `   ${GRAY}/\\_/\\ ${R}`,
    `  ${CYAN}( ◉   ◉)${R}`,
    `  ${CYAN}(  ${MAGENTA}ω${CYAN}  )${R}`,
    `   ${CYAN}(")_(")${R}`,
    `   ${D}look!${R}`,
  ],
};

// ─── Speech Bubbles ─────────────────────────────────────

const EVENT_MESSAGES: Record<string, string[]> = {
  thinking: [
    'Let me think...',
    'Hmm...',
    'Processing...',
    'Analyzing...',
    'Considering...',
  ],
  tool_Bash: [
    'Running command!',
    'Executing...',
    'Shell time!',
  ],
  tool_Read: [
    'Reading file...',
    'Let me check...',
    'Looking...',
  ],
  tool_Write: [
    'Writing file!',
    'Creating...',
    'Saving...',
  ],
  tool_Edit: [
    'Editing...',
    'Modifying...',
    'Patching...',
  ],
  tool_Glob: [
    'Searching files...',
    'Looking around...',
  ],
  tool_Grep: [
    'Searching code...',
    'Hunting...',
  ],
  tool_Agent: [
    'Spawning agent!',
    'Delegating...',
    'Teamwork!',
  ],
  tool_WebFetch: [
    'Fetching web...',
    'Downloading...',
    'On the web!',
  ],
  tool_REPL: [
    'Evaluating...',
    'Computing...',
    'JS go brrr!',
  ],
  done: [
    'Done!',
    'All good!',
    'Finished!',
    'There you go!',
  ],
  error: [
    'Oops!',
    'That broke...',
    'Error!',
    'Hmm, problem.',
  ],
  idle: [
    '...',
    'Waiting...',
    'Ready!',
    'Type something!',
  ],
};

// ─── Buddy Class ────────────────────────────────────────

export class Buddy {
  private state: BuddyState = 'idle';
  private message = '';
  private enabled: boolean;
  private companion: Companion | null = null;
  private frame: number = 0;

  constructor(enabled: boolean = true, companion?: Companion) {
    this.enabled = enabled;
    this.companion = companion ?? null;
  }

  /** Attach a real companion for species-accurate rendering. */
  setCompanion(companion: Companion): void {
    this.companion = companion;
  }

  /**
   * Set buddy state based on an event.
   * Uses companion reaction system when companion is attached.
   */
  onEvent(eventType: string): void {
    if (!this.enabled) return;

    if (eventType === 'thinking') {
      this.state = 'thinking';
    } else if (eventType.startsWith('tool_')) {
      this.state = eventType.includes('WebFetch') || eventType.includes('WebSearch') || eventType.includes('Grep') || eventType.includes('Glob')
        ? 'searching'
        : 'working';
    } else if (eventType === 'done') {
      this.state = 'happy';
    } else if (eventType === 'error') {
      this.state = 'error';
    } else if (eventType === 'idle') {
      this.state = 'idle';
    } else if (eventType === 'sleeping') {
      this.state = 'sleeping';
    }

    // Use companion reaction system if available, else fallback to static messages
    if (this.companion) {
      let eventMap: CompanionEvent['type'] | null = null;
      if (eventType === 'thinking') eventMap = 'thinking';
      else if (eventType.startsWith('tool_')) eventMap = 'tool_start';
      else if (eventType === 'done') eventMap = 'done';
      else if (eventType === 'error') eventMap = 'error';
      else if (eventType === 'idle') eventMap = 'idle';

      if (eventMap) {
        const toolName = eventType.startsWith('tool_') ? eventType.slice(5) : undefined;
        const reaction = generateReaction(this.companion, { type: eventMap, tool: toolName });
        this.message = reaction ?? '';
      } else {
        this.message = '';
      }
    } else {
      // Fallback: static event messages
      if (eventType === 'sleeping') {
        this.message = 'zzz...';
      } else {
        this.message = pick(EVENT_MESSAGES[eventType] ?? EVENT_MESSAGES['tool_Bash']!);
      }
    }
  }

  /**
   * Render the buddy + speech bubble as a multi-line string.
   * Uses real companion sprite when available, falls back to ANSI frames.
   */
  render(): string {
    if (!this.enabled) return '';

    let spriteLines: string[];
    if (this.companion) {
      this.frame = (this.frame + 1) % 3;
      spriteLines = renderSprite(this.companion, this.frame);
      // Add name line
      spriteLines.push(`   ${D}${this.companion.name}${R}`);
    } else {
      spriteLines = BUDDY_FRAMES[this.state] ?? BUDDY_FRAMES['idle']!;
    }

    const bubble = this.message ? renderBubble(this.message) : [];
    const lines: string[] = [];
    if (bubble.length > 0) {
      lines.push(...bubble);
    }
    lines.push(...spriteLines);

    return lines.join('\n');
  }

  /**
   * Render the buddy in the right margin at a given row.
   * Uses ANSI cursor positioning.
   */
  renderAtRight(startRow: number): string {
    if (!this.enabled) return '';

    const termWidth = process.stdout.columns ?? 120;
    const frame = BUDDY_FRAMES[this.state] ?? BUDDY_FRAMES['idle']!;
    const bubble = this.message ? renderBubble(this.message) : [];

    const allLines = [...bubble, ...frame];
    const buddyWidth = 14;
    const col = termWidth - buddyWidth;

    const output: string[] = [];
    for (let i = 0; i < allLines.length; i++) {
      output.push(`\x1b[${startRow + i};${col}H${allLines[i]}`);
    }

    return output.join('');
  }

  get currentState(): BuddyState {
    return this.state;
  }
}

// ─── Speech Bubble (renders ABOVE sprite in ANSI mode) ──
// In ANSI single-shot mode the bubble stays above since we can't
// do side-by-side easily with cursor positioning. The Ink component
// handles the horizontal (left-of-sprite) layout for REPL mode.

function renderBubble(text: string): string[] {
  const maxWidth = 22;
  const wrapped = text.length > maxWidth ? text.slice(0, maxWidth - 2) + '..' : text;
  const padded = wrapped.padEnd(maxWidth);

  return [
    `${D} ╭${'─'.repeat(maxWidth + 2)}╮${R}`,
    `${D} │${R} ${padded} ${D}│${R}`,
    `${D} ╰${'─'.repeat(maxWidth + 2)}╯${R}`,
    `${D}    ╲${R}`,
  ];
}

