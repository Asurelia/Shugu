/**
 * Layer 11 — UI: Ink-based prompt area
 *
 * Mount/unmount pattern:
 * 1. Mount Ink → show prompt with bars + mode + status
 * 2. User types, submits → unmount Ink
 * 3. console.log response (normal flow)
 * 4. Back to step 1
 */

import React, { useState, useCallback } from 'react';
import { render, Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';

// ─── Component ──────────────────────────────────────────

interface Props {
  mode: string;
  statusLine: string;
  onSubmit: (text: string) => void;
  onModeChange: (mode: string) => void;
}

const MODES = ['default', 'plan', 'acceptEdits', 'fullAuto', 'bypass'] as const;

function PromptArea({ mode, statusLine, onSubmit, onModeChange }: Props) {
  const [value, setValue] = useState('');
  const w = process.stdout.columns ?? 120;
  const bar = '─'.repeat(w);
  const modeColor = mode === 'bypass' ? 'red' : mode === 'fullAuto' ? 'yellow' : 'green';

  useInput((_input, key) => {
    if (key.tab && key.shift) {
      const idx = MODES.indexOf(mode as typeof MODES[number]);
      const next = MODES[(idx + 1) % MODES.length]!;
      onModeChange(next);
    }
  });

  const handleSubmit = useCallback((text: string) => {
    setValue('');
    onSubmit(text.trim());
  }, [onSubmit]);

  return (
    <Box flexDirection="column" width="100%">
      <Text dimColor>{bar}</Text>
      <Box>
        <Text bold color="green">{'> '}</Text>
        <TextInput value={value} onChange={setValue} onSubmit={handleSubmit} />
      </Box>
      <Text dimColor>{bar}</Text>
      <Text>
        {'  '}
        <Text dimColor>⏵⏵ </Text>
        <Text color={modeColor}>{mode}</Text>
        <Text dimColor> permissions on (shift+tab to cycle)</Text>
      </Text>
      <Text>{statusLine}</Text>
    </Box>
  );
}

// ─── Mount/Unmount API ──────────────────────────────────

/**
 * Show the Ink prompt, wait for input, then unmount.
 * Returns the submitted text.
 * This is called once per turn — mount, get input, unmount.
 */
export async function promptWithInk(
  mode: string,
  statusLine: string,
  onModeChange: (mode: string) => void,
): Promise<string> {
  return new Promise<string>((resolve) => {
    let currentMode = mode;

    function buildEl() {
      return (
        <PromptArea
          mode={currentMode}
          statusLine={statusLine}
          onSubmit={(text) => {
            // Unmount Ink immediately so console.log works
            ink.unmount();
            resolve(text);
          }}
          onModeChange={(newMode) => {
            currentMode = newMode;
            onModeChange(newMode);
            ink.rerender(buildEl());
          }}
        />
      );
    }

    const ink = render(buildEl());
  });
}
