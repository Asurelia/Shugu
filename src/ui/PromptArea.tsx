/**
 * Layer 11 — UI: Ink-based prompt area
 *
 * Fixed bottom layout using Ink's flexbox:
 *
 *   ─────────────────── (top separator)
 *   > [user input]      (text input)
 *   ─────────────────── (bottom separator)
 *   ⏵⏵ mode permissions (mode line)
 *   M2.7-hs | ...       (status bar)
 *
 * This is the ONLY React/Ink component in the project.
 * Everything else uses plain console.log.
 */

import React, { useState, useCallback } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import TextInput from 'ink-text-input';

// ─── Props ──────────────────────────────────────────────

interface PromptAreaProps {
  mode: string;
  statusLine: string;
  onSubmit: (text: string) => void;
  onModeChange: (newMode: string) => void;
}

const MODES = ['default', 'plan', 'acceptEdits', 'fullAuto', 'bypass'] as const;

// ─── Component ──────────────────────────────────────────

function PromptArea({ mode, statusLine, onSubmit, onModeChange }: PromptAreaProps) {
  const [value, setValue] = useState('');
  const w = process.stdout.columns ?? 120;
  const bar = '─'.repeat(w);

  const modeColor = mode === 'bypass' ? 'red' : mode === 'fullAuto' ? 'yellow' : 'green';

  // Shift+Tab to cycle modes
  useInput((input, key) => {
    if (key.tab && key.shift) {
      const idx = MODES.indexOf(mode as typeof MODES[number]);
      const next = MODES[(idx + 1) % MODES.length]!;
      onModeChange(next);
    }
  });

  const handleSubmit = useCallback((text: string) => {
    setValue('');
    if (text.trim()) {
      onSubmit(text.trim());
    }
  }, [onSubmit]);

  return (
    <Box flexDirection="column" width="100%">
      <Text dimColor>{bar}</Text>
      <Box>
        <Text bold color="green">{"> "}</Text>
        <TextInput value={value} onChange={setValue} onSubmit={handleSubmit} />
      </Box>
      <Text dimColor>{bar}</Text>
      <Text>
        {"  "}
        <Text dimColor>⏵⏵ </Text>
        <Text color={modeColor}>{mode}</Text>
        <Text dimColor> permissions on (shift+tab to cycle)</Text>
      </Text>
      <Text>{statusLine}</Text>
    </Box>
  );
}

// ─── Launcher ───────────────────────────────────────────

export interface InkPromptHandle {
  waitForInput: () => Promise<string>;
  updateMode: (mode: string) => void;
  updateStatus: (line: string) => void;
  unmount: () => void;
}

/**
 * Launch the Ink prompt area.
 * Returns a handle to interact with it from the non-React world.
 */
export function launchInkPrompt(
  initialMode: string,
  initialStatus: string,
): InkPromptHandle {
  let currentMode = initialMode;
  let currentStatus = initialStatus;
  let resolveInput: ((text: string) => void) | null = null;
  let rerender: ((node: React.ReactElement) => void) | null = null;

  function buildElement() {
    return (
      <PromptArea
        mode={currentMode}
        statusLine={currentStatus}
        onSubmit={(text) => {
          if (resolveInput) {
            resolveInput(text);
            resolveInput = null;
          }
        }}
        onModeChange={(newMode) => {
          currentMode = newMode;
          if (rerender) rerender(buildElement());
        }}
      />
    );
  }

  const ink = render(buildElement());
  rerender = ink.rerender;

  return {
    waitForInput(): Promise<string> {
      return new Promise((resolve) => {
        resolveInput = resolve;
      });
    },
    updateMode(mode: string) {
      currentMode = mode;
      if (rerender) rerender(buildElement());
    },
    updateStatus(line: string) {
      currentStatus = line;
      if (rerender) rerender(buildElement());
    },
    unmount() {
      ink.unmount();
    },
  };
}
