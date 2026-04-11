/**
 * CompanionSprite — React/Ink component
 *
 * Ported from OpenClaude buddy/CompanionSprite.tsx.
 * Renders the companion sprite with animation, speech bubbles, and reactions.
 *
 * Features:
 * - Idle animation (fidget sequence, 500ms ticks)
 * - Speech bubble with rounded border (reaction text)
 * - Fade-out effect (last 3s of bubble dims)
 * - Pet hearts animation
 * - Narrow mode (compact face for terminals <100 cols)
 */

import React, { useState, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import type { Companion } from './types.js';
import { renderSprite, renderFace, spriteFrameCount } from './sprites.js';

// ─── Constants ─────────────────────────────────────────

const TICK_MS = 500;
const BUBBLE_SHOW_TICKS = 20;       // ~10 seconds
const FADE_WINDOW_TICKS = 6;        // last ~3 seconds dim
const PET_FRAMES = 5;               // heart animation frames

// Idle sequence: mostly rest (0), occasional fidget (1-2), rare blink (-1)
const IDLE_SEQUENCE = [0, 0, 0, 0, 1, 0, 0, 0, -1, 0, 0, 2, 0, 0, 0];

const PET_HEARTS = [
  '   ♥    ♥   ',
  '  ♥  ♥   ♥  ',
  ' ♥   ♥  ♥   ',
  '♥  ♥      ♥ ',
  '·    ·   ·  ',
];

// ─── Speech Bubble Component (renders LEFT of sprite) ──

const BUBBLE_MAX_WIDTH = 24;

function SpeechBubble({ text, fading }: { text: string; fading: boolean }): React.ReactElement {
  const lines = wordWrap(text, BUBBLE_MAX_WIDTH);
  const color = fading ? 'gray' : 'cyan';

  return (
    <Box flexDirection="row" alignItems="center">
      {/* Bubble box */}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={color}
        paddingX={1}
      >
        {lines.map((line, i) => (
          <Text key={i} italic dimColor={fading} color={fading ? 'gray' : undefined}>{line}</Text>
        ))}
      </Box>
      {/* Connector pointing right toward the sprite */}
      <Text color={color}>{'─╮'}</Text>
    </Box>
  );
}

// ─── Main Sprite Component ─────────────────────────────

export interface CompanionSpriteProps {
  companion: Companion;
  /** Current reaction text (speech bubble) */
  reaction?: string;
  /** Whether the companion was just petted */
  petted?: boolean;
  /** Terminal width (for narrow mode) */
  termWidth?: number;
}

export function CompanionSprite({
  companion,
  reaction,
  petted,
  termWidth = 120,
}: CompanionSpriteProps): React.ReactElement {
  const [tick, setTick] = useState(0);
  const [bubbleTick, setBubbleTick] = useState(0);
  const [currentReaction, setCurrentReaction] = useState<string | undefined>(reaction);
  const [petFrame, setPetFrame] = useState(-1);
  const prevReaction = useRef(reaction);

  // Animation tick
  useEffect(() => {
    const timer = setInterval(() => {
      setTick((t) => t + 1);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, []);

  // Reaction bubble lifecycle
  useEffect(() => {
    if (reaction && reaction !== prevReaction.current) {
      setCurrentReaction(reaction);
      setBubbleTick(0);
      prevReaction.current = reaction;
    }
  }, [reaction]);

  // Bubble countdown
  useEffect(() => {
    if (!currentReaction) return;
    if (bubbleTick >= BUBBLE_SHOW_TICKS) {
      setCurrentReaction(undefined);
      return;
    }
    const timer = setTimeout(() => setBubbleTick((t) => t + 1), TICK_MS);
    return () => clearTimeout(timer);
  }, [bubbleTick, currentReaction]);

  // Pet animation
  useEffect(() => {
    if (petted) {
      setPetFrame(0);
    }
  }, [petted]);

  useEffect(() => {
    if (petFrame >= 0 && petFrame < PET_FRAMES) {
      const timer = setTimeout(() => setPetFrame((f) => f + 1), TICK_MS);
      return () => clearTimeout(timer);
    }
    if (petFrame >= PET_FRAMES) {
      setPetFrame(-1);
    }
  }, [petFrame]);

  // Narrow mode: compact face
  if (termWidth < 100) {
    const face = renderFace(companion);
    return (
      <Box>
        <Text color="cyan">{face}</Text>
        {currentReaction && (
          <Text dimColor> {currentReaction.slice(0, 20)}</Text>
        )}
      </Box>
    );
  }

  // Full sprite mode
  const isReacting = !!currentReaction;
  const fading = isReacting && bubbleTick >= (BUBBLE_SHOW_TICKS - FADE_WINDOW_TICKS);
  const frameCount = spriteFrameCount(companion.species);

  let frameIndex: number;
  if (isReacting) {
    // Cycle all frames fast when reacting
    frameIndex = tick % frameCount;
  } else {
    // Idle sequence
    const seqIdx = tick % IDLE_SEQUENCE.length;
    const seqVal = IDLE_SEQUENCE[seqIdx]!;
    frameIndex = seqVal === -1 ? 0 : seqVal; // -1 = blink (handled by eye replacement)
  }

  const spriteLines = renderSprite(companion, frameIndex);

  // Apply blink effect (-1 in idle sequence)
  const seqIdx = tick % IDLE_SEQUENCE.length;
  const isBlinking = IDLE_SEQUENCE[seqIdx] === -1;

  const renderedLines = spriteLines.map((line) => {
    if (isBlinking) {
      return line.replace(companion.eye, '-').replace(companion.eye, '-');
    }
    return line;
  });

  // Sprite + name as a vertical column
  const spriteColumn = (
    <Box flexDirection="column" alignItems="flex-end" flexShrink={0}>
      {/* Pet hearts above sprite */}
      {petFrame >= 0 && petFrame < PET_FRAMES && (
        <Text color="red">{PET_HEARTS[petFrame]}</Text>
      )}
      {/* Sprite lines */}
      {renderedLines.map((line, i) => (
        <Text key={i} color={companion.shiny ? 'yellow' : 'cyan'}>{line}</Text>
      ))}
      {/* Name */}
      <Text dimColor>  {companion.name}</Text>
    </Box>
  );

  return (
    <Box flexDirection="row" alignItems="center">
      {/* Speech bubble on the LEFT of sprite */}
      {currentReaction && (
        <SpeechBubble text={currentReaction} fading={fading} />
      )}
      {/* Sprite on the RIGHT */}
      {spriteColumn}
    </Box>
  );
}

// ─── Helpers ───────────────────────────────────────────

function wordWrap(text: string, width: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length + word.length + 1 > width && current) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}
