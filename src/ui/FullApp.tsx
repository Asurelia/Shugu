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
import { CompanionSprite } from './companion/CompanionSprite.js';
import type { Companion } from './companion/types.js';
import { createPasteHandler } from './paste.js';

// ─── Syntax Coloring (lightweight, no deps) ─────────────

const KW_REGEX = /\b(const|let|var|function|class|import|export|from|return|if|else|for|while|switch|case|break|default|new|this|type|interface|async|await|try|catch|throw|extends|implements|typeof|instanceof|in|of|as|is|void|null|undefined|true|false)\b/g;
const STRING_REGEX = /('[^']*'|"[^"]*"|`[^`]*`)/g;
const COMMENT_REGEX = /(\/\/.*$|\/\*[\s\S]*?\*\/)/gm;
const NUMBER_REGEX = /\b(\d+\.?\d*)\b/g;
const DECORATOR_REGEX = /(@\w+)/g;

function colorizeCode(line: string): React.ReactElement {
  // Simple approach: split line into colored segments
  // Priority: comments > strings > keywords > numbers > decorators
  if (line.match(/^\s*\/\//)) {
    return <Text color="gray" italic>{line}</Text>;
  }
  if (line.match(/^\s*#/)) {
    return <Text color="gray" italic>{line}</Text>;
  }

  // Build segments by replacing patterns with markers, then rendering
  // For simplicity, just colorize the whole line based on dominant pattern
  const parts: React.ReactElement[] = [];
  let remaining = line;
  let idx = 0;

  // Tokenize: find strings first (they shouldn't be keyword-highlighted)
  const tokens: Array<{ start: number; end: number; type: 'string' | 'keyword' | 'number' | 'decorator' | 'comment' }> = [];

  // Strings
  for (const m of line.matchAll(STRING_REGEX)) {
    if (m.index !== undefined) tokens.push({ start: m.index, end: m.index + m[0].length, type: 'string' });
  }
  // Inline comments
  for (const m of line.matchAll(COMMENT_REGEX)) {
    if (m.index !== undefined) tokens.push({ start: m.index, end: m.index + m[0].length, type: 'comment' });
  }
  // Keywords (only if not inside a string/comment)
  for (const m of line.matchAll(KW_REGEX)) {
    if (m.index !== undefined) {
      const inOther = tokens.some(t => m.index! >= t.start && m.index! < t.end);
      if (!inOther) tokens.push({ start: m.index, end: m.index + m[0].length, type: 'keyword' });
    }
  }
  // Numbers
  for (const m of line.matchAll(NUMBER_REGEX)) {
    if (m.index !== undefined) {
      const inOther = tokens.some(t => m.index! >= t.start && m.index! < t.end);
      if (!inOther) tokens.push({ start: m.index, end: m.index + m[0].length, type: 'number' });
    }
  }
  // Decorators
  for (const m of line.matchAll(DECORATOR_REGEX)) {
    if (m.index !== undefined) {
      const inOther = tokens.some(t => m.index! >= t.start && m.index! < t.end);
      if (!inOther) tokens.push({ start: m.index, end: m.index + m[0].length, type: 'decorator' });
    }
  }

  // Sort by position
  tokens.sort((a, b) => a.start - b.start);

  // Render segments
  let pos = 0;
  for (const token of tokens) {
    if (token.start > pos) {
      parts.push(<Text key={idx++} color="white">{line.slice(pos, token.start)}</Text>);
    }
    const text = line.slice(token.start, token.end);
    switch (token.type) {
      case 'keyword': parts.push(<Text key={idx++} color="magenta">{text}</Text>); break;
      case 'string': parts.push(<Text key={idx++} color="green">{text}</Text>); break;
      case 'number': parts.push(<Text key={idx++} color="yellow">{text}</Text>); break;
      case 'comment': parts.push(<Text key={idx++} color="gray" italic>{text}</Text>); break;
      case 'decorator': parts.push(<Text key={idx++} color="yellow">{text}</Text>); break;
    }
    pos = token.end;
  }
  if (pos < line.length) {
    parts.push(<Text key={idx++} color="white">{line.slice(pos)}</Text>);
  }

  return parts.length > 0 ? <>{parts}</> : <Text color="white">{line}</Text>;
}

// ─── Message Rendering (for Static items) ──────────────

function StaticMessage({ message }: { message: UIMessage }) {
  switch (message.type) {
    case 'user': {
      const termWidth = process.stdout.columns ?? 120;
      const lines = message.text.split('\n');

      // Short message (< 5 lines): single line with gray background
      if (lines.length <= 5) {
        const content = `> ${message.text}`;
        const pad = Math.max(0, termWidth - content.length);
        return (
          <Box marginTop={1}>
            <Text bold color="green" backgroundColor="gray">{'> '}</Text>
            <Text bold color="white" backgroundColor="gray">{message.text}{' '.repeat(pad)}</Text>
          </Box>
        );
      }

      // Long paste (> 5 lines): formatted block with markdown rendering
      const firstLine = lines[0] ?? '';
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text bold color="green" backgroundColor="gray">{'> '}</Text>
            <Text bold color="white" backgroundColor="gray">{firstLine}{' '.repeat(Math.max(0, termWidth - firstLine.length - 2))}</Text>
          </Box>
          <Box flexDirection="column" paddingLeft={2}>
            {lines.slice(1, 40).map((line, i) => {
              // Basic markdown coloring for pasted content
              if (line.startsWith('```')) {
                const lang = line.slice(3).trim();
                return <Text key={i} dimColor>{'┌─ '}{lang || 'code'}{' ────────'}</Text>;
              }
              if (line.startsWith('# ') || line.startsWith('## ') || line.startsWith('### ')) {
                return <Text key={i} bold color="cyan">{line.replace(/^#+\s/, '')}</Text>;
              }
              if (line.startsWith('- ') || line.startsWith('* ')) {
                return <Text key={i}>{line}</Text>;
              }
              if (line.startsWith('| ')) {
                return <Text key={i} dimColor>{line}</Text>;
              }
              if (line.startsWith('---') || line.startsWith('***')) {
                return <Text key={i} dimColor>{'────────────────────────────────'}</Text>;
              }
              return <Text key={i} color="white">{line}</Text>;
            })}
            {lines.length > 40 && <Text dimColor>{'  ... +'}{lines.length - 40}{' more lines'}</Text>}
          </Box>
          <Text dimColor>{'  📋 Pasted '}{lines.length}{' lines'}</Text>
        </Box>
      );
    }

    case 'assistant_header':
      return (
        <Box marginTop={1}>
          <Text bold color="cyan">assistant</Text>
          <Text dimColor>{' →'}</Text>
        </Box>
      );

    case 'assistant_text': {
      const lines = message.text.split('\n');
      let inCodeBlock = false;
      return (
        <Box flexDirection="column" paddingLeft={2}>
          {lines.map((line, i) => {
            // Toggle code block state
            if (line.startsWith('```')) {
              inCodeBlock = !inCodeBlock;
              const lang = line.slice(3).trim();
              return inCodeBlock
                ? <Text key={i} dimColor>{'┌─ '}{lang || 'code'}{' ────────────────────────'}</Text>
                : <Text key={i} dimColor>{'└──────────────────────────────'}</Text>;
            }
            // Inside code block — syntax-colored with border
            if (inCodeBlock) {
              return <Text key={i}>
                <Text dimColor>{'│ '}</Text>
                {colorizeCode(line)}
              </Text>;
            }
            // Markdown formatting
            if (line.startsWith('### ')) return <Text key={i} bold color="cyan">{line.slice(4)}</Text>;
            if (line.startsWith('## ')) return <Text key={i} bold color="cyan">{line.slice(3)}</Text>;
            if (line.startsWith('# ')) return <Text key={i} bold color="cyan">{line.slice(2)}</Text>;
            if (line.startsWith('- ') || line.startsWith('* ')) return <Text key={i}>{'  '}{line}</Text>;
            if (/^\d+\.\s/.test(line)) return <Text key={i}>{'  '}{line}</Text>;
            if (line.startsWith('| ') && line.endsWith(' |')) return <Text key={i} dimColor>{line}</Text>;
            if (/^[|\-:]+$/.test(line.replace(/\s/g, ''))) return <Text key={i} dimColor>{line}</Text>; // table separator
            if (line.startsWith('---') || line.startsWith('***')) return <Text key={i} dimColor>{'────────────────────────────────────────'}</Text>;
            if (line.startsWith('>')) return <Text key={i} dimColor italic>{'  │ '}{line.slice(1).trim()}</Text>;
            // Bold: **text** → render with bold
            if (line.includes('**')) {
              // Simple bold rendering — just strip the ** markers
              return <Text key={i}>{line.replace(/\*\*([^*]+)\*\*/g, '$1')}</Text>;
            }
            return <Text key={i}>{line}</Text>;
          })}
        </Box>
      );
    }

    case 'thinking': {
      // Collapsed by default — single line like Claude Code
      const preview = message.text.replace(/\n/g, ' ').slice(0, 120);
      return (
        <Box paddingLeft={2}>
          <Text dimColor italic>{'∴ '}{preview}{message.text.length > 120 ? '…' : ''}</Text>
        </Box>
      );
    }

    case 'tool_call': {
      // Compact: tool name + detail on one line
      const detail = message.detail || '';
      return (
        <Box>
          <Text color="yellow">{'╭── '}</Text>
          <Text bold color="yellow">{message.name}</Text>
          {detail ? <Text dimColor>{' '}{detail}</Text> : null}
        </Box>
      );
    }

    case 'tool_result': {
      const icon = message.isError ? '✗' : '✓';
      const iconColor = message.isError ? 'red' : 'green';
      const totalLines = message.content.split('\n').length;
      const sizeInfo = totalLines > 1 ? ` (${totalLines} lines)` : '';
      const isFileOp = message.toolName === 'Write' || message.toolName === 'Edit';
      const isBash = message.toolName === 'Bash';
      const termWidth = process.stdout.columns ?? 120;

      // For file operations: show diff-style colored output
      if (isFileOp && !message.isError) {
        const lines = message.content.split('\n').slice(0, 30);
        return (
          <Box flexDirection="column">
            <Box>
              <Text color="yellow">{'╰'}</Text>
              <Text color={iconColor}>{icon}</Text>
              <Text color="yellow">{'─ '}</Text>
              <Text dimColor>{message.toolName}{sizeInfo}</Text>
            </Box>
            <Box flexDirection="column" paddingLeft={2}>
              {lines.map((line, i) => {
                if (line.startsWith('+') || line.startsWith('> ')) {
                  return <Text key={i} backgroundColor="green" color="white">{line}{' '.repeat(Math.max(0, termWidth - line.length - 2))}</Text>;
                }
                if (line.startsWith('-') || line.startsWith('< ')) {
                  return <Text key={i} backgroundColor="red" color="white">{line}{' '.repeat(Math.max(0, termWidth - line.length - 2))}</Text>;
                }
                if (line.startsWith('@@') || line.match(/^[0-9]+[,:]/) || line.startsWith('---') || line.startsWith('+++')) {
                  return <Text key={i} color="cyan">{line}</Text>;
                }
                return <Text key={i}>{colorizeCode(line)}</Text>;
              })}
              {totalLines > 30 && <Text dimColor>{'  ... '}{totalLines - 30}{' more lines'}</Text>}
            </Box>
          </Box>
        );
      }

      // For bash: colorize output
      if (isBash && !message.isError) {
        const lines = message.content.split('\n').slice(0, 20);
        return (
          <Box flexDirection="column">
            <Box>
              <Text color="yellow">{'╰'}</Text>
              <Text color={iconColor}>{icon}</Text>
              <Text color="yellow">{'─ '}</Text>
              <Text dimColor>Bash{sizeInfo}</Text>
            </Box>
            <Box flexDirection="column" paddingLeft={2}>
              {lines.map((line, i) => {
                if (line.match(/^(PASS|PASSED|OK|✓|✔|success)/i)) return <Text key={i} color="green">{line}</Text>;
                if (line.match(/^(FAIL|FAILED|ERROR|✗|✘)/i)) return <Text key={i} color="red">{line}</Text>;
                if (line.match(/^(WARN|WARNING)/i)) return <Text key={i} color="yellow">{line}</Text>;
                if (line.startsWith('$') || line.startsWith('>')) return <Text key={i} bold>{line}</Text>;
                return <Text key={i}>{colorizeCode(line)}</Text>;
              })}
              {totalLines > 20 && <Text dimColor>{'  ... '}{totalLines - 20}{' more lines'}</Text>}
            </Box>
          </Box>
        );
      }

      // Default: collapsed single-line summary
      const firstLine = message.content.split('\n').find(l => l.trim().length > 0) ?? '';
      const summary = firstLine.length > 100 ? firstLine.slice(0, 97) + '...' : firstLine;
      return (
        <Box>
          <Text color="yellow">{'╰'}</Text>
          <Text color={iconColor}>{icon}</Text>
          <Text color="yellow">{'─ '}</Text>
          <Text dimColor>{summary}{sizeInfo}</Text>
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
  sessionTitle?: string;
  /** Companion instance for persistent sprite display */
  companion?: Companion;
  /** Current companion reaction text (speech bubble) */
  companionReaction?: string;
  /** Whether companion was just petted */
  companionPetted?: boolean;
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
    sessionTitle: undefined as string | undefined,
    companion: undefined as Companion | undefined,
    companionReaction: undefined as string | undefined,
    companionPetted: false,
  });
  const [inputValue, setInputValue] = useState('');
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 120;
  const bar = '─'.repeat(cols);

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
            prev.streamTokens !== ext.streamTokens ||
            prev.sessionTitle !== ext.sessionTitle ||
            prev.companion !== ext.companion ||
            prev.companionReaction !== ext.companionReaction ||
            prev.companionPetted !== ext.companionPetted) {
          return {
            mode: ext.mode,
            statusText: ext.statusText,
            isStreaming: ext.isStreaming,
            showInput: ext.showInput,
            streamStartTime: ext.streamStartTime,
            streamTokens: ext.streamTokens,
            sessionTitle: ext.sessionTitle,
            companion: ext.companion,
            companionReaction: ext.companionReaction,
            companionPetted: ext.companionPetted ?? false,
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

  // Handle pasted text from bracketed paste mode (set via ExternalState)
  const lastPasteRef = useRef('');
  const pastedContentRef = useRef<string | null>(null); // Store full paste for submit
  const pasteCounter = useRef(0);
  useEffect(() => {
    const ext = stateRef.current as ExternalState & { _pastedText?: string };
    if (ext._pastedText && ext._pastedText !== lastPasteRef.current) {
      lastPasteRef.current = ext._pastedText;
      const raw = ext._pastedText;
      const lineCount = raw.split('\n').length;
      ext._pastedText = '';

      if (lineCount > 3) {
        // Large paste: show placeholder, store full content
        pasteCounter.current++;
        pastedContentRef.current = raw;
        setInputValue(prev => prev + `[Pasted text #${pasteCounter.current} — ${lineCount} lines]`);
      } else {
        // Small paste: inline directly
        const cleaned = raw.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
        setInputValue(prev => prev + cleaned);
      }
    }
  });

  const handleSubmit = useCallback((text: string) => {
    if (!text.trim()) return;
    // Expand paste placeholder with full content
    let finalText = text;
    if (pastedContentRef.current && text.includes('[Pasted text #')) {
      finalText = text.replace(/\[Pasted text #\d+ — \d+ lines\]/, pastedContentRef.current);
      pastedContentRef.current = null;
    }
    // Sanitize residual paste markers ([200~, [201~, etc.)
    finalText = finalText.replace(/\[200~/g, '').replace(/\[201~/g, '').replace(/200~/g, '').replace(/201~/g, '');
    setInputValue('');
    onSubmit(finalText.trim());
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

      {/* ═══ Live area: horizontal layout — left (bars/input/status) + right (companion) ═══ */}
      <Box>
        {/* Left column: everything except companion */}
        <Box flexDirection="column" flexGrow={1}>
          {/* Spinner during streaming */}
          {liveState.isStreaming && liveState.streamStartTime && (
            <SpinnerInline startTime={liveState.streamStartTime} tokenCount={liveState.streamTokens} />
          )}

          {/* Top separator with session title */}
          {(() => {
            const title = liveState.sessionTitle;
            const barWidth = liveState.companion && cols >= 100 ? cols - 20 : cols;
            if (title) {
              const label = ` ${title} `;
              const leftLen = Math.max(1, barWidth - label.length - 4);
              return <Text dimColor>{'─'.repeat(leftLen)}{label}{'─'.repeat(4)}</Text>;
            }
            return <Text dimColor>{'─'.repeat(barWidth)}</Text>;
          })()}

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
          {(() => {
            const barWidth = liveState.companion && cols >= 100 ? cols - 20 : cols;
            return <Text dimColor>{'─'.repeat(barWidth)}</Text>;
          })()}

          {/* Status */}
          <Text>{liveState.statusText}</Text>

          {/* Mode */}
          <Text>
            {'  '}
            <Text dimColor>⏵⏵ </Text>
            <Text color={modeColor}>{liveState.mode}</Text>
            <Text dimColor> permissions on (shift+tab to cycle)</Text>
          </Text>
        </Box>

        {/* Right column: companion sprite (persistent, animated) */}
        {liveState.companion && cols >= 100 && (
          <Box flexShrink={0} alignSelf="flex-end">
            <CompanionSprite
              companion={liveState.companion}
              petted={liveState.companionPetted}
              termWidth={cols}
            />
          </Box>
        )}
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
  setSessionTitle: (title: string) => void;
  setCompanion: (companion: Companion) => void;
  setCompanionReaction: (text: string) => void;
  setCompanionPetted: (petted: boolean) => void;
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

  // Enable bracketed paste mode for proper paste handling
  const pasteHandler = createPasteHandler();
  pasteHandler.enable();
  pasteHandler.onPaste((text) => {
    // Inject pasted text into the app state for the component to pick up
    (stateRef.current as ExternalState & { _pastedText?: string })._pastedText = text;
  });

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
    setSessionTitle(title: string) {
      updateState({ sessionTitle: title });
    },
    setCompanion(companion: Companion) {
      updateState({ companion });
    },
    setCompanionReaction(text: string) {
      updateState({ companionReaction: text });
      // Auto-clear reaction after 10s
      setTimeout(() => {
        if (stateRef.current.companionReaction === text) {
          updateState({ companionReaction: undefined });
        }
      }, 10_000);
    },
    setCompanionPetted(petted: boolean) {
      updateState({ companionPetted: petted });
      if (petted) {
        setTimeout(() => updateState({ companionPetted: false }), 3000);
      }
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
      pasteHandler.disable();
      ink.unmount();
    },
  };
}
