/**
 * ToolCallBlock — renders a tool call with box-drawing frame.
 */

import React from 'react';
import { Box, Text } from 'ink';

interface ToolCallProps {
  name: string;
  id: string;
}

interface ToolResultProps {
  content: string;
  isError: boolean;
}

export function ToolCallHeader({ name, id }: ToolCallProps) {
  const shortId = id.length > 12 ? id.slice(-8) : id;
  return (
    <Box flexDirection="column">
      <Text color="yellow">{'┌──────────────────────────────────────────'}</Text>
      <Box>
        <Text color="yellow">│ </Text>
        <Text bold>{name}</Text>
        <Text dimColor> {shortId}</Text>
      </Box>
    </Box>
  );
}

export function ToolResultBlock({ content, isError }: ToolResultProps) {
  const truncated = content.length > 1000
    ? content.slice(0, 1000) + `\n... (${content.length} chars)`
    : content;
  const lines = truncated.split('\n');
  const icon = isError ? '✗' : '✓';
  const iconColor = isError ? 'red' : 'green';

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Box key={i}>
          <Text color="yellow">│ </Text>
          <Text>{line}</Text>
        </Box>
      ))}
      <Box>
        <Text color="yellow">└</Text>
        <Text color={iconColor}>{icon}</Text>
        <Text color="yellow">{'─────────────────────────────────────────'}</Text>
      </Box>
    </Box>
  );
}
