/**
 * TrackerPanel — Real-time execution flow visualization
 *
 * Shows a compact panel in the Ink live area with:
 * - Current pipeline stage (idle → strategy → model → tool_exec → done)
 * - Active agents with type + elapsed time
 * - Recent trace events (last 6)
 *
 * Toggled via Ctrl+T. Only rendered when terminal height >= 30.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { TrackerStage } from '../utils/tracer.js';

export interface TrackerEvent {
  time: string;
  type: string;
  detail: string;
}

export interface TrackerAgent {
  id: string;
  type: string;
  elapsed: string;
}

interface TrackerPanelProps {
  stage: TrackerStage;
  agents: TrackerAgent[];
  events: TrackerEvent[];
  isStreaming: boolean;
}

const STAGE_ICONS: Record<string, string> = {
  idle: '○',
  input: '⊙',
  strategy: '◈',
  model: '●',
  tool_exec: '◆',
  tool_result: '◇',
  reflection: '◎',
  intelligence: '◌',
  done: '✓',
};

const STAGE_COLORS: Record<string, string> = {
  idle: 'gray',
  input: 'green',
  strategy: 'cyan',
  model: 'yellow',
  tool_exec: 'magenta',
  tool_result: 'blue',
  reflection: 'cyan',
  intelligence: 'gray',
  done: 'green',
};

const TYPE_COLORS: Record<string, string> = {
  model_call: 'yellow',
  model_response: 'green',
  tool_call: 'magenta',
  tool_result: 'blue',
  agent_spawn: 'cyan',
  agent_done: 'cyan',
  thinking: 'gray',
  strategy: 'cyan',
  error: 'red',
  user_input: 'green',
  stage_change: 'gray',
  decision: 'yellow',
  memory_save: 'gray',
};

export function TrackerPanel({ stage, agents, events, isStreaming }: TrackerPanelProps) {
  const icon = STAGE_ICONS[stage] ?? '?';
  const color = STAGE_COLORS[stage] ?? 'white';

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text bold color="cyan">{'⚡ Tracker'}</Text>
        <Text dimColor>{' ─ '}</Text>
        <Text color={color}>{icon} {stage}</Text>
        {isStreaming && <Text dimColor>{' (streaming)'}</Text>}
      </Box>

      {/* Active agents */}
      {agents.length > 0 && (
        <Box flexDirection="column">
          {agents.map((a, i) => (
            <Text key={i} color="blue">{'  ▸ '}{a.type}<Text dimColor>{' ('}{a.elapsed}{')'}</Text></Text>
          ))}
        </Box>
      )}

      {/* Recent events */}
      {events.length > 0 && (
        <Box flexDirection="column">
          {events.slice(-6).map((e, i) => (
            <Text key={i}>
              <Text dimColor>{e.time}</Text>
              {' '}
              <Text color={TYPE_COLORS[e.type] ?? 'white'}>{e.type.padEnd(14)}</Text>
              {' '}
              <Text dimColor>{e.detail.slice(0, 60)}</Text>
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
