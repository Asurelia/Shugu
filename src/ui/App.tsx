/**
 * Layer 11 — UI: Full Ink application
 *
 * Replaces all console.log rendering. Everything goes through Ink.
 *
 * Layout (like Claude Code):
 *   <Box flexDirection="column" height="100%">
 *     <ScrollArea flexGrow={1}>     ← messages, thinking, tools, brew timer
 *       {outputLines}
 *     </ScrollArea>
 *     <BottomArea flexShrink={0}>   ← fixed: bars + input + mode + status
 *       ─── separator ───
 *       > [input]
 *       ─── separator ───
 *       ⏵⏵ mode
 *       status line
 *     </BottomArea>
 *   </Box>
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { render, Box, Text, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';

// ─── Types ──────────────────────────────────────────────

export interface AppState {
  /** Lines of output (messages, thinking, tools, brew timer) */
  outputLines: string[];
  /** Current mode */
  mode: string;
  /** Status bar text */
  statusText: string;
  /** Whether the model is currently responding */
  isStreaming: boolean;
  /** Whether to show the input (false during streaming) */
  showInput: boolean;
}

interface AppProps {
  initialState: AppState;
  onSubmit: (text: string) => void;
  onModeChange: (mode: string) => void;
  stateRef: React.MutableRefObject<AppState>;
}

const MODES = ['default', 'plan', 'acceptEdits', 'fullAuto', 'bypass'] as const;

// ─── Main App Component ─────────────────────────────────

function App({ initialState, onSubmit, onModeChange, stateRef }: AppProps) {
  const [state, setState] = useState<AppState>(initialState);
  const [inputValue, setInputValue] = useState('');
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const cols = stdout?.columns ?? 120;
  const bar = '─'.repeat(cols);

  // Sync external state updates
  useEffect(() => {
    const interval = setInterval(() => {
      const ext = stateRef.current;
      setState(prev => {
        if (prev.outputLines !== ext.outputLines ||
            prev.mode !== ext.mode ||
            prev.statusText !== ext.statusText ||
            prev.isStreaming !== ext.isStreaming ||
            prev.showInput !== ext.showInput) {
          return { ...ext };
        }
        return prev;
      });
    }, 50); // 50ms refresh for streaming
    return () => clearInterval(interval);
  }, [stateRef]);

  const modeColor = state.mode === 'bypass' ? 'red' : state.mode === 'fullAuto' ? 'yellow' : 'green';

  // Shift+Tab to cycle modes
  useInput((_input, key) => {
    if (key.tab && key.shift) {
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

  // Calculate scroll area height
  const bottomHeight = 5; // separator + input + separator + mode + status
  const scrollHeight = Math.max(1, rows - bottomHeight);

  // Get visible output lines (last N lines that fit)
  const visibleLines = state.outputLines.slice(-scrollHeight);

  return (
    <Box flexDirection="column" height={rows}>
      {/* ═══ Scrollable output area ═══ */}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {visibleLines.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
        {/* Fill remaining space */}
        <Box flexGrow={1} />
      </Box>

      {/* ═══ Fixed bottom area ═══ */}
      <Box flexDirection="column" flexShrink={0}>
        <Text dimColor>{bar}</Text>
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
          <Text dimColor>  {state.isStreaming ? '⏳ Processing...' : ''}</Text>
        )}
        <Text dimColor>{bar}</Text>
        <Text>
          {'  '}
          <Text dimColor>⏵⏵ </Text>
          <Text color={modeColor}>{state.mode}</Text>
          <Text dimColor> permissions on (shift+tab to cycle)</Text>
        </Text>
        <Text>{state.statusText}</Text>
      </Box>
    </Box>
  );
}

// ─── App Handle (bridge between Ink and the engine) ─────

export interface AppHandle {
  /** Add a line to the output */
  addLine: (line: string) => void;
  /** Add multiple lines */
  addLines: (lines: string[]) => void;
  /** Wait for user input (resolves when they submit) */
  waitForInput: () => Promise<string>;
  /** Update the mode */
  setMode: (mode: string) => void;
  /** Update the status text */
  setStatus: (text: string) => void;
  /** Set streaming state (hides input during streaming) */
  setStreaming: (streaming: boolean) => void;
  /** Unmount the app */
  unmount: () => void;
}

/**
 * Launch the full Ink app. Returns a handle for the engine to interact with.
 */
export function launchApp(
  initialMode: string,
  initialStatus: string,
  onModeChange: (mode: string) => void,
): AppHandle {
  const stateRef: React.MutableRefObject<AppState> = { current: {
    outputLines: [],
    mode: initialMode,
    statusText: initialStatus,
    isStreaming: false,
    showInput: true,
  }};

  let resolveInput: ((text: string) => void) | null = null;

  const ink = render(
    <App
      initialState={stateRef.current}
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

  return {
    addLine(line: string) {
      stateRef.current = {
        ...stateRef.current,
        outputLines: [...stateRef.current.outputLines, line],
      };
    },
    addLines(lines: string[]) {
      stateRef.current = {
        ...stateRef.current,
        outputLines: [...stateRef.current.outputLines, ...lines],
      };
    },
    waitForInput(): Promise<string> {
      stateRef.current = { ...stateRef.current, showInput: true, isStreaming: false };
      return new Promise((resolve) => {
        resolveInput = resolve;
      });
    },
    setMode(mode: string) {
      stateRef.current = { ...stateRef.current, mode };
    },
    setStatus(text: string) {
      stateRef.current = { ...stateRef.current, statusText: text };
    },
    setStreaming(streaming: boolean) {
      stateRef.current = { ...stateRef.current, isStreaming: streaming, showInput: !streaming };
    },
    unmount() {
      ink.unmount();
    },
  };
}
