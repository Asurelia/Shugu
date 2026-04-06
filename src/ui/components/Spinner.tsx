/**
 * Spinner — streaming indicator with rotating verbs.
 * Like Claude Code's SpinnerWithVerb.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';

const VERBS = [
  'Thinking', 'Hatching', 'Brewing', 'Pondering', 'Cogitating',
  'Mulling', 'Contemplating', 'Processing', 'Analyzing', 'Crafting',
  'Composing', 'Manifesting', 'Computing', 'Reasoning', 'Synthesizing',
];

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface Props {
  startTime: number;
  tokenCount?: number;
}

export function Spinner({ startTime, tokenCount }: Props) {
  const [frame, setFrame] = useState(0);
  const [verb] = useState(() => VERBS[Math.floor(Math.random() * VERBS.length)]!);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, []);

  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const elapsedStr = elapsed >= 60
    ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
    : `${elapsed}s`;

  const tokenStr = tokenCount !== undefined && tokenCount > 0
    ? ` · ↓ ${tokenCount} tokens`
    : '';

  return (
    <Box>
      <Text color="magenta">✻ {verb}… ({elapsedStr}{tokenStr})</Text>
    </Box>
  );
}

interface BrewTimerProps {
  durationMs: number;
  tokenCount?: number;
}

export function BrewTimer({ durationMs, tokenCount }: BrewTimerProps) {
  const secs = Math.floor(durationMs / 1000);
  const str = secs >= 60
    ? `${Math.floor(secs / 60)}m ${secs % 60}s`
    : `${secs}s`;
  const tokenStr = tokenCount !== undefined && tokenCount > 0
    ? ` · ↓ ${tokenCount} tokens`
    : '';

  return (
    <Box>
      <Text dimColor color="magenta">✻ Brewed for {str}{tokenStr}</Text>
    </Box>
  );
}
