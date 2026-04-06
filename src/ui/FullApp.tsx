/**
 * Layer 11 — UI: Full Ink Application (like Claude Code's REPL.tsx)
 *
 * Layout:
 *   <Box height="100%" flexDirection="column">
 *     <ScrollBox flexGrow={1}>        ← messages scroll here
 *       <Messages />
 *     </ScrollBox>
 *     <Box flexShrink={0}>            ← fixed bottom
 *       ─── separator ───
 *       > [TextInput]
 *       ─── separator ───
 *       ⏵⏵ mode
 *       status line
 *     </Box>
 *   </Box>
 *
 * Uses alternate screen buffer for clean rendering.
 * Messages are React state, not text lines.
 * Streaming updates via state → re-render.
 */

import React, { useState, useCallback, useEffect } from 'react';
import { render, Box, Text, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { Messages, type UIMessage } from './components/Messages.js';

// ─── Props & State ──────────────────────────────────────

interface AppProps {
  initialMode: string;
  initialStatus: string;
  stateRef: React.MutableRefObject<ExternalState>;
  onSubmit: (text: string) => void;
  onModeChange: (mode: string) => void;
}

export interface ExternalState {
  messages: UIMessage[];
  mode: string;
  statusText: string;
  isStreaming: boolean;
  showInput: boolean;
  streamStartTime?: number;
  streamTokens?: number;
}

const MODES = ['default', 'plan', 'acceptEdits', 'fullAuto', 'bypass'] as const;

// ─── Main App ───────────────────────────────────────────

function FullApp({ initialMode, initialStatus, stateRef, onSubmit, onModeChange }: AppProps) {
  const [state, setState] = useState<ExternalState>({
    messages: [],
    mode: initialMode,
    statusText: initialStatus,
    isStreaming: false,
    showInput: true,
  });
  const [inputValue, setInputValue] = useState('');
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 120;
  const rows = stdout?.rows ?? 24;
  const bar = '─'.repeat(cols);

  // Poll external state changes (from engine)
  useEffect(() => {
    const interval = setInterval(() => {
      const ext = stateRef.current;
      setState(prev => {
        // Only update if something changed
        if (prev.messages.length !== ext.messages.length ||
            prev.mode !== ext.mode ||
            prev.statusText !== ext.statusText ||
            prev.isStreaming !== ext.isStreaming ||
            prev.showInput !== ext.showInput ||
            prev.streamStartTime !== ext.streamStartTime ||
            prev.streamTokens !== ext.streamTokens) {
          return { ...ext };
        }
        return prev;
      });
    }, 50); // 50ms for smooth streaming
    return () => clearInterval(interval);
  }, [stateRef]);

  const modeColor = state.mode === 'bypass' ? 'red' : state.mode === 'fullAuto' ? 'yellow' : 'green';

  // Shift+Tab to cycle modes
  useInput((_input, key) => {
    if (key.tab && key.shift && state.showInput) {
      const idx = MODES.indexOf(state.mode as typeof MODES[number]);
      const next = MODES[(idx + 1) % MODES.length]!;
      onModeChange(next);
    }
  });

  const handleSubmit = useCallback((text: string) => {
    if (!text.trim()) return;
    setInputValue('');
    onSubmit(text.trim());
  }, [onSubmit]);

  // Calculate space: bottom area is 5 lines (sep + input + sep + mode + status)
  const bottomH = 5;

  return (
    <Box flexDirection="column" height={rows}>
      {/* ═══ Scrollable messages area ═══ */}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        <Messages
          messages={state.messages}
          isStreaming={state.isStreaming}
          streamStartTime={state.streamStartTime}
          streamTokens={state.streamTokens}
        />
      </Box>

      {/* ═══ Fixed bottom area ═══ */}
      <Box flexDirection="column" flexShrink={0}>
        {/* Top separator */}
        <Text dimColor>{bar}</Text>

        {/* Input or streaming indicator */}
        {state.showInput ? (
          <Box>
            <Text bold color="green">{'> '}</Text>
            <TextInput
              value={inputValue}
              onChange={setInputValue}
              onSubmit={handleSubmit}
            />
          </Box>
        ) : (
          <Text dimColor>  </Text>
        )}

        {/* Bottom separator */}
        <Text dimColor>{bar}</Text>

        {/* Mode indicator */}
        <Text>
          {'  '}
          <Text dimColor>⏵⏵ </Text>
          <Text color={modeColor}>{state.mode}</Text>
          <Text dimColor> permissions on (shift+tab to cycle)</Text>
        </Text>

        {/* Status bar */}
        <Text>{state.statusText}</Text>
      </Box>
    </Box>
  );
}

// ─── App Handle (bridge from engine to React) ───────────

export interface AppHandle {
  /** Add a UI message to the conversation */
  pushMessage: (msg: UIMessage) => void;
  /** Update the last assistant_text message (for streaming) */
  updateLastText: (text: string) => void;
  /** Wait for user input */
  waitForInput: () => Promise<string>;
  /** Set mode */
  setMode: (mode: string) => void;
  /** Set status text */
  setStatus: (text: string) => void;
  /** Start streaming */
  startStreaming: () => void;
  /** Stop streaming */
  stopStreaming: () => void;
  /** Unmount */
  unmount: () => void;
}

export function launchFullApp(
  initialMode: string,
  initialStatus: string,
  onModeChange: (mode: string) => void,
): AppHandle {
  const stateRef: React.MutableRefObject<ExternalState> = {
    current: {
      messages: [],
      mode: initialMode,
      statusText: initialStatus,
      isStreaming: false,
      showInput: true,
    },
  };

  let resolveInput: ((text: string) => void) | null = null;

  const ink = render(
    <FullApp
      initialMode={initialMode}
      initialStatus={initialStatus}
      stateRef={stateRef}
      onSubmit={(text) => {
        if (resolveInput) {
          const r = resolveInput;
          resolveInput = null;
          r(text);
        }
      }}
      onModeChange={onModeChange}
    />,
  );

  function updateState(partial: Partial<ExternalState>) {
    stateRef.current = { ...stateRef.current, ...partial };
  }

  return {
    pushMessage(msg: UIMessage) {
      updateState({ messages: [...stateRef.current.messages, msg] });
    },
    updateLastText(text: string) {
      const msgs = [...stateRef.current.messages];
      // Find last assistant_text and update it, or create new
      const lastIdx = msgs.findLastIndex(m => m.type === 'assistant_text');
      if (lastIdx >= 0) {
        msgs[lastIdx] = { type: 'assistant_text', text };
      } else {
        msgs.push({ type: 'assistant_text', text });
      }
      updateState({ messages: msgs });
    },
    waitForInput(): Promise<string> {
      updateState({ showInput: true, isStreaming: false });
      return new Promise((resolve) => {
        resolveInput = resolve;
      });
    },
    setMode(mode: string) {
      updateState({ mode });
    },
    setStatus(text: string) {
      updateState({ statusText: text });
    },
    startStreaming() {
      updateState({
        isStreaming: true,
        showInput: false,
        streamStartTime: Date.now(),
        streamTokens: 0,
      });
    },
    stopStreaming() {
      updateState({ isStreaming: false, showInput: true });
    },
    unmount() {
      ink.unmount();
    },
  };
}
