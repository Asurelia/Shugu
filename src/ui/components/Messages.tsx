/**
 * Messages — renders the conversation as React components.
 *
 * Each message is a typed object, not a text line.
 * The component re-renders on state change (streaming).
 */

import React from 'react';
import { Box, Text } from 'ink';
import { ThinkingBlock } from './ThinkingBlock.js';
import { ToolCallHeader, ToolResultBlock } from './ToolCallBlock.js';
import { Spinner, BrewTimer } from './Spinner.js';

// ─── Message Types ──────────────────────────────────────

export type UIMessage =
  | { type: 'user'; text: string }
  | { type: 'assistant_header' }
  | { type: 'assistant_text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; name: string; id: string; detail?: string }
  | { type: 'tool_result'; content: string; isError: boolean; toolName?: string }
  | { type: 'error'; text: string }
  | { type: 'info'; text: string }
  | { type: 'brew'; durationMs: number; tokens?: number };

// ─── Component ──────────────────────────────────────────

interface Props {
  messages: UIMessage[];
  isStreaming: boolean;
  streamStartTime?: number;
  streamTokens?: number;
}

export function Messages({ messages, isStreaming, streamStartTime, streamTokens }: Props) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {messages.map((msg, i) => (
        <MessageRow key={i} message={msg} />
      ))}

      {/* Streaming spinner — shows while model is responding */}
      {isStreaming && streamStartTime && (
        <Box marginTop={1}>
          <Spinner startTime={streamStartTime} tokenCount={streamTokens} />
        </Box>
      )}
    </Box>
  );
}

function MessageRow({ message, isFirst }: { message: UIMessage; isFirst?: boolean }) {
  switch (message.type) {
    case 'user':
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="green">{'> '}<Text bold color="white">{message.text}</Text></Text>
        </Box>
      );

    case 'assistant_header':
      return (
        <Box marginTop={1}>
          <Text bold color="cyan">assistant</Text>
          <Text dimColor> →</Text>
        </Box>
      );

    case 'thinking':
      return (
        <Box marginLeft={2}>
          <ThinkingBlock thinking={message.text} />
        </Box>
      );

    case 'assistant_text':
      return (
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          {message.text.split('\n').map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
        </Box>
      );

    case 'tool_call':
      return (
        <Box marginTop={1}>
          <ToolCallHeader name={message.name} id={message.id} />
        </Box>
      );

    case 'tool_result': {
      // Truncate very long results to prevent terminal flooding
      const maxPreview = 2000;
      const truncatedContent = message.content.length > maxPreview
        ? message.content.slice(0, maxPreview) + `\n... [${(message.content.length - maxPreview).toLocaleString()} chars truncated]`
        : message.content;
      return <ToolResultBlock content={truncatedContent} isError={message.isError} />;
    }

    case 'error':
      return (
        <Box marginTop={1}>
          <Text color="red" bold>error</Text>
          <Text color="red"> → {message.text}</Text>
        </Box>
      );

    case 'info':
      return <Text>{message.text}</Text>;

    case 'brew':
      return <BrewTimer durationMs={message.durationMs} tokenCount={message.tokens} />;
  }
}
