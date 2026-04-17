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
import type { UIMessage } from './types.js';
import { CompanionSprite } from './companion/CompanionSprite.js';
import type { Companion } from './companion/types.js';
import { createPasteHandler } from './paste.js';
import { colorizeCode, detectLanguage } from './highlight.js';
import { renderMarkdown, renderInline } from './markdown.js';
import { parseReadOutput, parseGrepOutput, parseWebFetchOutput, parseGlobOutput } from './parsers.js';

// ─── Helpers ──────────────────────────────────────────

function formatDuration(ms: number | undefined): string {
  if (ms == null) return '';
  if (ms < 1000) return ` ${ms}ms`;
  return ` ${(ms / 1000).toFixed(1)}s`;
}

// ─── Message Rendering (for Static items) ──────────────

function StaticMessage({ message, expandThinking = false }: { message: UIMessage; expandThinking?: boolean }) {
  switch (message.type) {
    case 'user': {
      const termWidth = process.stdout.columns ?? 120;
      const lines = message.text.split('\n');

      // Short message (5 lines or fewer): compact with inline formatting
      if (lines.length <= 5) {
        return (
          <Box marginTop={1} flexDirection="column">
            {lines.map((line, i) => (
              <Box key={i}>
                <Text bold color="green" backgroundColor="gray">{i === 0 ? '> ' : '  '}</Text>
                <Text bold backgroundColor="gray">{renderInline(line)}</Text>
              </Box>
            ))}
          </Box>
        );
      }

      // Long paste (> 5 lines): formatted block with code highlighting
      const firstLine = lines[0] ?? '';
      let inCodeBlock = false;
      let codeLang = '';
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text bold color="green" backgroundColor="gray">{'> '}</Text>
            <Text bold backgroundColor="gray">{renderInline(firstLine)}{' '.repeat(Math.max(0, termWidth - firstLine.length - 2))}</Text>
          </Box>
          <Box flexDirection="column" paddingLeft={2}>
            {lines.slice(1, 40).map((line, i) => {
              if (line.startsWith('```')) {
                inCodeBlock = !inCodeBlock;
                if (inCodeBlock) {
                  codeLang = detectLanguage(line.slice(3).trim());
                  return <Text key={i} dimColor>{'┌─ '}{line.slice(3).trim() || 'code'}{' ────────'}</Text>;
                }
                return <Text key={i} dimColor>{'└──────────────────────────────'}</Text>;
              }
              if (inCodeBlock) {
                return <Text key={i}><Text dimColor>{'│ '}</Text>{colorizeCode(line, codeLang)}</Text>;
              }
              return <Box key={i}>{renderInline(line)}</Box>;
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

    case 'assistant_text':
      return renderMarkdown(message.text);

    case 'thinking': {
      if (expandThinking) {
        const lines = message.text.split('\n');
        let inCodeBlock = false;
        return (
          <Box flexDirection="column" paddingLeft={2}>
            <Text dimColor italic>{'∴ [THINKING — '}{lines.length}{' lines]'}</Text>
            {lines.map((line, i) => {
              if (line.startsWith('```')) {
                inCodeBlock = !inCodeBlock;
                return <Text key={i} dimColor italic>{'  '}{line}</Text>;
              }
              if (inCodeBlock || /^\s{4,}\S/.test(line)) {
                return <Text key={i} dimColor>{'  '}{colorizeCode(line, 'generic')}</Text>;
              }
              return <Text key={i} dimColor italic>{'  '}{line}</Text>;
            })}
          </Box>
        );
      }
      const preview = message.text.replace(/\n/g, ' ').slice(0, 120);
      return (
        <Box paddingLeft={2}>
          <Text dimColor italic>{'∴ '}{preview}{message.text.length > 120 ? '… (ctrl+r to expand)' : ''}</Text>
        </Box>
      );
    }

    case 'tool_call': {
      const detail = message.detail || '';
      const tn = message.name;
      let detailEl: React.ReactElement | null = null;
      if (detail) {
        if (tn === 'Bash') {
          detailEl = <Text>{' '}{colorizeCode(detail, 'shell')}</Text>;
        } else if (tn === 'Read' || tn === 'Write' || tn === 'Edit') {
          detailEl = <Text color="cyan">{' '}{detail}</Text>;
        } else if (tn === 'Grep' || tn === 'Glob') {
          detailEl = <Text color="yellow">{' '}{detail}</Text>;
        } else {
          detailEl = <Text dimColor>{' '}{detail}</Text>;
        }
      }
      return (
        <Box>
          <Text color="yellow">{'╭── '}</Text>
          <Text bold color="yellow">{message.name}</Text>
          {detailEl}
        </Box>
      );
    }

    case 'tool_result': {
      const icon = message.isError ? '✗' : '✓';
      const iconColor = message.isError ? 'red' : 'green';
      const totalLines = message.content.split('\n').length;
      const sizeInfo = totalLines > 1 ? ` (${totalLines} lines)` : '';
      const toolName = message.toolName ?? '';
      const detail = (message as { detail?: string }).detail ?? '';

      // ── Read: line numbers + language-aware highlighting ──
      if (toolName === 'Read' && !message.isError) {
        const parsed = parseReadOutput(message.content);
        const lang = detectLanguage(undefined, detail);
        const displayLines = parsed.lines.slice(0, 30);
        return (
          <Box flexDirection="column">
            <Box><Text color="yellow">{'╰'}</Text><Text color={iconColor}>{icon}</Text><Text color="yellow">{'─ '}</Text><Text dimColor>Read{sizeInfo}{formatDuration(message.durationMs)}</Text></Box>
            <Box flexDirection="column" paddingLeft={2}>
              {displayLines.map((l, i) => (
                <Text key={i}>
                  <Text color="yellow">{String(l.lineNum).padStart(4)}</Text>
                  <Text dimColor>{'\t'}</Text>
                  {colorizeCode(l.code, lang)}
                </Text>
              ))}
              {parsed.lines.length > 30 && <Text dimColor>{'  ... '}{parsed.lines.length - 30}{' more lines'}</Text>}
              {parsed.footer && <Text dimColor>{parsed.footer}</Text>}
            </Box>
          </Box>
        );
      }

      // ── Grep: file:line:content with per-file language ──
      if (toolName === 'Grep' && !message.isError) {
        const grepLines = parseGrepOutput(message.content);
        const displayLines = grepLines.slice(0, 30);
        return (
          <Box flexDirection="column">
            <Box><Text color="yellow">{'╰'}</Text><Text color={iconColor}>{icon}</Text><Text color="yellow">{'─ '}</Text><Text dimColor>Grep{sizeInfo}{formatDuration(message.durationMs)}</Text></Box>
            <Box flexDirection="column" paddingLeft={2}>
              {displayLines.map((gl, i) => {
                if (gl.type === 'separator') return <Text key={i} dimColor>{'--'}</Text>;
                if (gl.type === 'plain') return <Text key={i}>{gl.text}</Text>;
                const lineLang = detectLanguage(undefined, gl.file);
                return (
                  <Text key={i} dimColor={gl.type === 'context'}>
                    <Text color="cyan">{gl.file}</Text><Text dimColor>{':'}</Text>
                    <Text color="yellow">{gl.lineNum}</Text><Text dimColor>{':'}</Text>
                    {colorizeCode(gl.content, lineLang)}
                  </Text>
                );
              })}
              {grepLines.length > 30 && <Text dimColor>{'  ... '}{grepLines.length - 30}{' more'}</Text>}
            </Box>
          </Box>
        );
      }

      // ── Glob: colored file paths ──
      if (toolName === 'Glob' && !message.isError) {
        const entries = parseGlobOutput(message.content);
        const displayEntries = entries.slice(0, 30);
        const EC: Record<string, string> = {
          '.ts': 'green', '.tsx': 'green', '.js': 'green', '.jsx': 'green',
          '.json': 'yellow', '.yaml': 'yellow', '.yml': 'yellow',
          '.py': 'blue', '.md': 'cyan', '.sh': 'magenta',
        };
        return (
          <Box flexDirection="column">
            <Box><Text color="yellow">{'╰'}</Text><Text color={iconColor}>{icon}</Text><Text color="yellow">{'─ '}</Text><Text dimColor>Glob{sizeInfo}{formatDuration(message.durationMs)}</Text></Box>
            <Box flexDirection="column" paddingLeft={2}>
              {displayEntries.map((e, i) => (
                <Text key={i} color={e.ext === '' ? 'blue' : (EC[e.ext] ?? 'white')}>{e.path}</Text>
              ))}
              {entries.length > 30 && <Text dimColor>{'  ... '}{entries.length - 30}{' more'}</Text>}
            </Box>
          </Box>
        );
      }

      // ── Bash: PASS/FAIL + JSON detection + shell highlighting ──
      if (toolName === 'Bash' && !message.isError) {
        const bLines = message.content.split('\n').slice(0, 20);
        const firstNonEmpty = bLines.find(l => l.trim().length > 0) ?? '';
        const bashLang = (firstNonEmpty.startsWith('{') || firstNonEmpty.startsWith('[')) ? 'json' : 'shell';
        return (
          <Box flexDirection="column">
            <Box><Text color="yellow">{'╰'}</Text><Text color={iconColor}>{icon}</Text><Text color="yellow">{'─ '}</Text><Text dimColor>Bash{sizeInfo}{formatDuration(message.durationMs)}</Text></Box>
            <Box flexDirection="column" paddingLeft={2}>
              {bLines.map((line, i) => {
                if (/^(PASS|PASSED|OK|✓|✔|success)/i.test(line)) return <Text key={i} color="green">{line}</Text>;
                if (/^(FAIL|FAILED|ERROR|✗|✘)/i.test(line)) return <Text key={i} color="red">{line}</Text>;
                if (/^(WARN|WARNING)/i.test(line)) return <Text key={i} color="yellow">{line}</Text>;
                if (line.startsWith('$') || line.startsWith('>')) return <Text key={i} bold>{line}</Text>;
                return <Text key={i}>{colorizeCode(line, bashLang)}</Text>;
              })}
              {totalLines > 20 && <Text dimColor>{'  ... '}{totalLines - 20}{' more lines'}</Text>}
            </Box>
          </Box>
        );
      }

      // ── WebFetch: parse envelope, detect content type ──
      if (toolName === 'WebFetch' && !message.isError) {
        const parsed = parseWebFetchOutput(message.content);
        const fetchLang = detectLanguage(undefined, undefined, parsed.body ? [parsed.body.split('\n')[0] ?? ''] : undefined);
        const bodyLines = parsed.body.split('\n').slice(0, 20);
        return (
          <Box flexDirection="column">
            <Box><Text color="yellow">{'╰'}</Text><Text color={iconColor}>{icon}</Text><Text color="yellow">{'─ '}</Text><Text dimColor>WebFetch{sizeInfo}{formatDuration(message.durationMs)}</Text></Box>
            <Box flexDirection="column" paddingLeft={2}>
              <Text dimColor>{parsed.status}</Text>
              {bodyLines.map((line, i) => (
                <Text key={i}>{colorizeCode(line, fetchLang)}</Text>
              ))}
              {parsed.body.split('\n').length > 20 && <Text dimColor>{'  ... more'}</Text>}
            </Box>
          </Box>
        );
      }

      // ── Write/Edit: success message with colored file path ──
      if ((toolName === 'Write' || toolName === 'Edit') && !message.isError) {
        const pathMatch = /:\s*(.+?)\s*\(/.exec(message.content);
        const filePath = pathMatch?.[1] ?? '';
        return (
          <Box>
            <Text color="yellow">{'╰'}</Text><Text color={iconColor}>{icon}</Text><Text color="yellow">{'─ '}</Text>
            <Text dimColor>{toolName}{' '}</Text>
            {filePath ? <Text color="cyan">{filePath}</Text> : <Text dimColor>{message.content}</Text>}
            <Text dimColor>{formatDuration(message.durationMs)}</Text>
          </Box>
        );
      }

      // ── Default: collapsed single-line summary ──
      const firstLine = message.content.split('\n').find(l => l.trim().length > 0) ?? '';
      const summary = firstLine.length > 100 ? firstLine.slice(0, 97) + '...' : firstLine;
      return (
        <Box>
          <Text color="yellow">{'╰'}</Text><Text color={iconColor}>{icon}</Text><Text color="yellow">{'─ '}</Text>
          <Text dimColor>{toolName ? `${toolName} ` : ''}{summary}{sizeInfo}{formatDuration(message.durationMs)}</Text>
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

    case 'session_end': {
      const tokensStr = message.totalTokens >= 1000
        ? `${(message.totalTokens / 1000).toFixed(1)}k`
        : String(message.totalTokens);
      const costStr = message.totalCost < 0.01
        ? `$${message.totalCost.toFixed(4)}`
        : `$${message.totalCost.toFixed(3)}`;
      return (
        <Box marginTop={1}>
          <Text dimColor>{'═ Session ended '}</Text>
          <Text dimColor>{'('}{message.reason}{')'}</Text>
          <Text dimColor>{' — '}</Text>
          <Text color="cyan">{tokensStr}{' tokens'}</Text>
          <Text dimColor>{' · '}</Text>
          <Text color="cyan">{costStr}</Text>
        </Box>
      );
    }
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
  companion?: Companion;
  companionReaction?: string;
  companionPetted?: boolean;
  /** When true, thinking blocks render fully expanded */
  expandThinking?: boolean;
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

  // Expand thinking state from ExternalState (toggled via /thinking command)
  const expandThinking = stateRef.current.expandThinking ?? false;

  useInput((input, key) => {
    // Shift+Tab: cycle permission modes
    if (key.tab && key.shift && liveState.showInput) {
      const idx = MODES.indexOf(liveState.mode as typeof MODES[number]);
      const next = MODES[(idx + 1) % MODES.length]!;
      onModeChange(next);
    }

    // Ctrl+R: toggle expanded thinking display
    if (key.ctrl && input === 'r') {
      const current = stateRef.current.expandThinking ?? false;
      stateRef.current = { ...stateRef.current, expandThinking: !current };
    }

    // Escape: clear current input while typing
    if (key.escape && liveState.showInput) {
      setInputValue('');
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
            <StaticMessage message={item.msg} expandThinking={expandThinking} />
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

          {/* Mode indicator */}
          <Text>
            {'  '}
            <Text color={modeColor}>● </Text>
            <Text color={modeColor} bold>{liveState.mode}</Text>
            <Text dimColor> (shift+tab)</Text>
          </Text>
        </Box>

        {/* Right column: companion sprite (persistent, animated) */}
        {liveState.companion && cols >= 100 && (
          <Box flexShrink={0} alignSelf="flex-end">
            <CompanionSprite
              companion={liveState.companion}
              reaction={liveState.companionReaction}
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
  setExpandThinking: (expand: boolean) => void;
  dumpTranscript: () => void;
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
      // Force immediate re-render for streaming (don't wait for 80ms poll)
      const flush = (stateRef.current as ExternalState & { _flush?: () => void })._flush;
      if (flush) flush();
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
    setExpandThinking(expand: boolean) {
      updateState({ expandThinking: expand });
    },
    dumpTranscript() {
      const allMsgs = stateRef.current.messages;
      const lines: string[] = ['', '═══ Full Transcript (expanded) ═══', ''];
      for (const msg of allMsgs) {
        switch (msg.type) {
          case 'user': lines.push(`> ${msg.text}`, ''); break;
          case 'assistant_header': lines.push('assistant →'); break;
          case 'assistant_text': lines.push(msg.text, ''); break;
          case 'thinking': lines.push(`  ∴ [THINKING] ${msg.text}`, ''); break;
          case 'tool_call': lines.push(`  ╭── ${msg.name}${msg.detail ? ' ' + msg.detail : ''}`); break;
          case 'tool_result': lines.push(`  ╰${msg.isError ? '✗' : '✓'}─ ${msg.content}`, ''); break;
          case 'error': lines.push(`  ERROR: ${msg.text}`); break;
          case 'info': lines.push(msg.text); break;
          case 'session_end': lines.push(`═ Session ended (${msg.reason}) — ${msg.totalTokens} tokens · $${msg.totalCost.toFixed(3)}`); break;
        }
      }
      lines.push('', '═══ End Transcript ═══', '');
      for (const line of lines) {
        stateRef.current.messages.push({ type: 'info', text: line });
      }
      const flush = (stateRef.current as ExternalState & { _flush?: () => void })._flush;
      if (flush) flush();
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
