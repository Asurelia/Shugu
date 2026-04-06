/**
 * ThinkingBlock — renders the model's reasoning/thinking.
 */

import React from 'react';
import { Box, Text } from 'ink';

interface Props {
  thinking: string;
}

export function ThinkingBlock({ thinking }: Props) {
  return (
    <Box flexDirection="row">
      <Text dimColor color="magenta">thinking</Text>
      <Text dimColor> → </Text>
      <Text dimColor>{thinking}</Text>
    </Box>
  );
}
