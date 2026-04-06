/**
 * Layer 11 — UI: Full Ink Application
 *
 * Architecture (inspired by Claude Code's approach, adapted for Ink):
 *
 * Uses Ink's <Static> for message history — once rendered, messages are
 * "printed" to terminal scrollback and never re-rendered. This gives:
 * - Native terminal scroll (mouse wheel, Page Up/Down)
 * - No re-render overhead for past messages
 * - Proper scrollback buffer
 *
 * The live area (bottom) contains only: spinner, input, mode, status.
 * This is the only part that re-renders.
 *
 * Layout:
 *   <Static>               ← printed to scrollback, scrollable
 *     {rendered messages}
 *   </Static>
 *   <Box>                  ← live area, re-renders
 *     spinner / brew timer
 *     ─── separator ───
 *     > [TextInput]
 *     ─── separator ───
 *     ⏵⏵ mode
 *     status line
 *   </Box>
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { render, Box, Text, Static, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import type { UIMessage } from './components/Messages.js';

// ─── Message Rendering (for Static items) ──────────────

function StaticMessage({ message }: { message: UIMessage }) {
  switch (message.type) {
    case 'user':
      return (
        <Box marginTop={1}>
          <Text bold color="green">{'> '}</Text>
          <Text bold color="white">{message.text}</Text>
        </Box>
      );

    case 'assistant_header':
      return (
        <Box marginTop={1}>
          <Text bold color="cyan">assistant</Text>
          <Text dimColor>{' →'}</Text>
        </Box>
      );

    case 'assistant_text':
      return (
        <Box flexDirection="column" paddingLeft={2}>
          {message.text.split('\n').map((line, i) => {
            // Basic markdown rendering
            if (line.startsWith('### ')) return <Text key={i} bold color="cyan">{'   '}{line.slice(4)}</Text>;
            if (line.startsWith('## ')) return <Text key={i} bold color="cyan">{'  '}{line.slice(3)}</Text>;
            if (line.startsWith('# ')) return <Text key={i} bold color="cyan">{line.slice(2)}</Text>;
            if (line.startsWith('```')) return <Text key={i} dimColor color="gray">{line}</Text>;
            if (line.startsWith('- ') || line.startsWith('* ')) return <Text key={i}>{'  '}{line}</Text>;
            if (/^\d+\.\s/.test(line)) return <Text key={i}>{'  '}{line}</Text>;
            if (line.startsWith('|')) return <Text key={i} dimColor>{line}</Text>;
            if (line.startsWith('---') || line.startsWith('***')) return <Text key={i} dimColor>{'────────────────────────────────────────'}</Text>;
            if (line.startsWith('>')) return <Text key={i} dimColor italic>{'  │ '}{line.slice(1).trim()}</Text>;
            return <Text key={i}>{line}</Text>;
          })}
        </Box>
      );

    case 'thinking': {
      // Thinking block in a dimmed box — shows reasoning
      const thinkPreview = message.text.length > 300 ? message.text.slice(0, 300) + '…' : message.text;
      const thinkLines = thinkPreview.split('\n').slice(0, 6);
      return (
        <Box flexDirection="column" paddingLeft={2} marginTop={1}>
          <Text dimColor italic color="gray">{'╭─ ∴ reasoning ─────────────────────────────'}</Text>
          {thinkLines.map((line, i) => (
            <Text key={i} dimColor italic color="gray">{'│ '}{line}</Text>
          ))}
          {message.text.length > 300 && (
            <Text dimColor italic color="gray">{'│ …'}</Text>
          )}
          <Text dimColor italic color="gray">{'╰────────────────────────────────────────────'}</Text>
        </Box>
      );
    }

    case 'tool_call': {
      // Show tool name + useful detail (path, command, pattern) instead of cryptic ID
      const detail = message.detail || '';
      return (
        <Box marginTop={1}>
          <Text color="yellow">{'╭── '}</Text>
          <Text bold color="yellow">{message.name}</Text>
          {detail ? <Text dimColor>{' '}{detail}</Text> : null}
        </Box>
      );
    }

    case 'tool_result': {
      const maxLen = 1500;
      const preview = message.content.length > maxLen
        ? message.content.slice(0, maxLen) + `\n… [${(message.content.length - maxLen).toLocaleString()} chars truncated]`
        : message.content;
      const lines = preview.split('\n').slice(0, 30); // Max 30 lines displayed
      const icon = message.isError ? '✗' : '✓';
      const iconColor = message.isError ? 'red' : 'green';
      return (
        <Box flexDirection="column">
          {lines.map((line, i) => (
            <Box key={i}>
              <Text color="yellow">{'│ '}</Text>
              <Text>{line}</Text>
            </Box>
          ))}
          <Box>
            <Text color="yellow">{'╰'}</Text>
            <Text color={iconColor}>{icon}</Text>
            <Text color="yellow">{'────────────────────────────────────────'}</Text>
          </Box>
        </Box>
      );
    }

    case 'error':
      return (
        <Box marginTop={1}>
          <Text color="red" bold>{'error'}</Text>
          <Text color="red">{' → '}{message.text}</Text>
        </Box>
      );

    case 'info':
      return <Text>{message.text}</Text>;

    case 'brew':
      return (
        <Text dimColor color="magenta">
          {'✻ Brewed for '}
          {message.durationMs >= 60000
            ? `${Math.floor(message.durationMs / 60000)}m ${Math.floor((message.durationMs % 60000) / 1000)}s`
            : `${Math.floor(message.durationMs / 1000)}s`}
          {message.tokens ? ` · ↓ ${message.tokens} tokens` : ''}
        </Text>
      );
  }
}

// ─── Spinner ───────────────────────────────────────────

function SpinnerInline({ startTime, tokenCount }: { startTime: number; tokenCount?: number }) {
  const VERBS = ['Thinking', 'Hatching', 'Brewing', 'Pondering', 'Cogitating', 'Manifesting'];
  const [frame, setFrame] = React.useState(0);
  const [verb] = React.useState(() => VERBS[Math.floor(Math.random() * VERBS.length)]!);
  React.useEffect(() => {
    const t = setInterval(() => setFrame(f => f + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const elStr = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`;
  const tkStr = tokenCount && tokenCount > 0 ? ` · ↓ ${tokenCount} tokens` : '';
  return <Text color="magenta">{'✻ '}{verb}… ({elStr}{tkStr})</Text>;
}

// ─── Props & State ─────────────────────────────────────

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

// ─── Main App ──────────────────────────────────────────

function FullApp({ initialMode, initialStatus, stateRef, onSubmit, onModeChange }: AppProps) {
  // Track which messages have already been "printed" to Static
  const [renderedCount, setRenderedCount] = useState(0);
  const [liveState, setLiveState] = useState({
    mode: initialMode,
    statusText: initialStatus,
    isStreaming: false,
    showInput: true,
    streamStartTime: undefined as number | undefined,
    streamTokens: undefined as number | undefined,
  });
  const [inputValue, setInputValue] = useState('');
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 120;
  const bar = '─'.repeat(Math.min(cols, 120));

  // Track messages for Static rendering — use a ref to avoid stale closure issues
  const [staticMessages, setStaticMessages] = useState<Array<{ id: string; msg: UIMessage }>>([]);
  const renderedCountRef = useRef(0);
  let globalMsgId = useRef(0);

  // Single function to sync new messages — prevents duplicates
  const syncMessages = useCallback(() => {
    const ext = stateRef.current;
    const currentCount = renderedCountRef.current;
    if (ext.messages.length > currentCount) {
      const newMsgs = ext.messages.slice(currentCount).map((msg) => ({
        id: `msg-${globalMsgId.current++}`,
        msg,
      }));
      renderedCountRef.current = ext.messages.length;
      setRenderedCount(ext.messages.length);
      setStaticMessages(prev => [...prev, ...newMsgs]);
    }
  }, [stateRef]);

  // Poll external state
  useEffect(() => {
    const interval = setInterval(() => {
      syncMessages();

      const ext = stateRef.current;
      setLiveState(prev => {
        if (prev.mode !== ext.mode ||
            prev.statusText !== ext.statusText ||
            prev.isStreaming !== ext.isStreaming ||
            prev.showInput !== ext.showInput ||
            prev.streamStartTime !== ext.streamStartTime ||
            prev.streamTokens !== ext.streamTokens) {
          return {
            mode: ext.mode,
            statusText: ext.statusText,
            isStreaming: ext.isStreaming,
            showInput: ext.showInput,
            streamStartTime: ext.streamStartTime,
            streamTokens: ext.streamTokens,
          };
        }
        return prev;
      });
    }, 80);
    return () => clearInterval(interval);
  }, [stateRef, syncMessages]);

  // Expose flush for immediate pushMessage rendering
  useEffect(() => {
    (stateRef as { current: ExternalState & { _flush?: () => void } }).current._flush = syncMessages;
  }, [stateRef, syncMessages]);

  const modeColor = liveState.mode === 'bypass' ? 'red' : liveState.mode === 'fullAuto' ? 'yellow' : 'green';

  useInput((_input, key) => {
    if (key.tab && key.shift && liveState.showInput) {
      const idx = MODES.indexOf(liveState.mode as typeof MODES[number]);
      const next = MODES[(idx + 1) % MODES.length]!;
      onModeChange(next);
    }
  });

  const handleSubmit = useCallback((text: string) => {
    if (!text.trim()) return;
    setInputValue('');
    onSubmit(text.trim());
  }, [onSubmit]);

  return (
    <>
      {/* ═══ Static area: printed to terminal scrollback, never re-rendered ═══ */}
      <Static items={staticMessages}>
        {(item) => (
          <Box key={item.id} flexDirection="column">
            <StaticMessage message={item.msg} />
          </Box>
        )}
      </Static>

      {/* ═══ Live area: re-renders dynamically ═══ */}
      <Box flexDirection="column">
        {/* Spinner during streaming */}
        {liveState.isStreaming && liveState.streamStartTime && (
          <SpinnerInline startTime={liveState.streamStartTime} tokenCount={liveState.streamTokens} />
        )}

        {/* Top separator */}
        <Text dimColor>{bar}</Text>

        {/* Input */}
        {liveState.showInput ? (
          <Box>
            <Text bold color="green">{'> '}</Text>
            <TextInput
              value={inputValue}
              onChange={setInputValue}
              onSubmit={handleSubmit}
            />
          </Box>
        ) : (
          <Text dimColor>{'  …'}</Text>
        )}

        {/* Bottom separator */}
        <Text dimColor>{bar}</Text>

        {/* Mode */}
        <Text>
          {'  '}
          <Text dimColor>⏵⏵ </Text>
          <Text color={modeColor}>{liveState.mode}</Text>
          <Text dimColor> permissions on (shift+tab to cycle)</Text>
        </Text>

        {/* Status */}
        <Text>{liveState.statusText}</Text>
      </Box>
    </>
  );
}

// ─── App Handle ────────────────────────────────────────

export interface AppHandle {
  pushMessage: (msg: UIMessage) => void;
  updateLastText: (text: string) => void;
  waitForInput: () => Promise<string>;
  setMode: (mode: string) => void;
  setStatus: (text: string) => void;
  startStreaming: () => void;
  stopStreaming: () => void;
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
      const flush = (stateRef.current as ExternalState & { _flush?: () => void })._flush;
      if (flush) flush();
    },
    updateLastText(text: string) {
      const msgs = [...stateRef.current.messages];
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
