/**
 * CLI Event Handlers
 *
 * Converts LoopEvents into UI actions (both TerminalRenderer and Ink AppHandle).
 */

import type { LoopEvent } from '../engine/loop.js';
import type { TerminalRenderer } from '../ui/renderer.js';
import type { AppHandle } from '../ui/FullApp.js';
import type { ContentBlock } from '../protocol/messages.js';
import { isTextBlock, isThinkingBlock, isToolUseBlock } from '../protocol/messages.js';
import type { BudgetTracker } from '../engine/budget.js';
import { getCompanion } from '../ui/companion/index.js';
import type { Companion } from '../ui/companion/index.js';

// ─── Companion singleton ──────────────────────────────

let _companion: Companion | null = null;
let _companionMuted = false;

export function getCompanionInstance(): Companion | null {
  if (_companion === undefined) return null;
  if (!_companion) {
    try { _companion = getCompanion(); } catch { _companion = null; }
  }
  return _companion;
}

export function setCompanionMuted(muted: boolean): void {
  _companionMuted = muted;
}

export function isCompanionMuted(): boolean {
  return _companionMuted;
}

// ─── Single-shot event handler ────────────────────────

export function handleEvent(
  event: LoopEvent,
  renderer: TerminalRenderer,
  budget?: BudgetTracker,
): void {
  switch (event.type) {
    case 'turn_start':
      break;

    case 'assistant_message':
      renderer.startStream();
      for (const block of event.message.content) {
        renderContentBlock(block, renderer);
      }
      break;

    case 'tool_executing':
      renderer.endStream();
      renderer.toolCall(event.call.name, event.call.id);
      break;

    case 'tool_result': {
      const content = typeof event.result.content === 'string'
        ? event.result.content
        : JSON.stringify(event.result.content);
      renderer.toolResult(event.result.tool_use_id, content, event.result.is_error ?? false);
      break;
    }

    case 'turn_end':
      budget?.addTurnUsage(event.usage);
      break;

    case 'loop_end':
      renderer.endStream();
      break;

    case 'error':
      renderer.error(event.error.message);
      break;
  }
}

function renderContentBlock(block: ContentBlock, renderer: TerminalRenderer): void {
  if (isThinkingBlock(block)) {
    renderer.thinkingHeader();
    renderer.streamThinking(block.thinking);
    console.log('');
  } else if (isTextBlock(block)) {
    renderer.streamText(block.text);
  } else if (isToolUseBlock(block)) {
    // Handled via tool_executing event
  }
}

// ─── Ink event handler (pushes UIMessages to FullApp) ──

/** Track tool_use_id → tool context for result enrichment */
const _toolContextMap = new Map<string, { name: string; detail: string }>();

export function handleEventForApp(
  event: LoopEvent,
  app: AppHandle,
  budget?: BudgetTracker,
): void {
  switch (event.type) {
    case 'turn_start':
      break;

    case 'assistant_message': {
      app.pushMessage({ type: 'assistant_header' });
      for (const block of event.message.content) {
        if (isThinkingBlock(block)) {
          app.pushMessage({ type: 'thinking', text: block.thinking });
        } else if (isTextBlock(block)) {
          app.pushMessage({ type: 'assistant_text', text: block.text });
        }
      }
      break;
    }

    case 'tool_executing': {
      const detail = extractToolDetail(event.call.name, event.call.input);
      _toolContextMap.set(event.call.id, { name: event.call.name, detail });
      app.pushMessage({ type: 'tool_call', name: event.call.name, id: event.call.id, detail });
      break;
    }

    case 'tool_result': {
      const content = typeof event.result.content === 'string'
        ? event.result.content
        : JSON.stringify(event.result.content);
      const ctx = _toolContextMap.get(event.result.tool_use_id);
      _toolContextMap.delete(event.result.tool_use_id);
      app.pushMessage({
        type: 'tool_result',
        content,
        isError: event.result.is_error ?? false,
        toolName: ctx?.name,
        detail: ctx?.detail,
      });
      break;
    }

    case 'turn_end':
      budget?.addTurnUsage(event.usage);
      break;

    case 'loop_end':
      break;

    case 'error':
      app.pushMessage({ type: 'error', text: event.error.message });
      break;
  }
}

// ─── Tool detail extraction ───────────────────────────

/**
 * Extract a human-readable detail from tool input.
 * Shows the path, command, or pattern instead of the cryptic tool_use ID.
 */
export function extractToolDetail(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash': {
      const cmd = (input['command'] as string) ?? '';
      return cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd;
    }
    case 'Read':
    case 'Write':
    case 'Edit': {
      const fp = (input['file_path'] as string) ?? '';
      const parts = fp.replace(/\\/g, '/').split('/');
      return parts.length > 2 ? parts.slice(-2).join('/') : fp;
    }
    case 'Glob': {
      return (input['pattern'] as string) ?? '';
    }
    case 'Grep': {
      const pat = (input['pattern'] as string) ?? '';
      const path = (input['path'] as string) ?? '';
      const shortPath = path.replace(/\\/g, '/').split('/').pop() ?? '';
      return pat + (shortPath ? ` in ${shortPath}` : '');
    }
    case 'WebFetch': {
      const url = (input['url'] as string) ?? '';
      try { return new URL(url).hostname; } catch { return url.slice(0, 60); }
    }
    case 'WebSearch': {
      return (input['query'] as string) ?? '';
    }
    case 'Agent': {
      return ((input['description'] as string) ?? '').slice(0, 60);
    }
    case 'Obsidian': {
      const op = (input['operation'] as string) ?? '';
      const q = (input['query'] as string) ?? (input['path'] as string) ?? (input['title'] as string) ?? '';
      return `${op}${q ? ': ' + q.slice(0, 50) : ''}`;
    }
    default:
      return '';
  }
}

// ─── Helpers ──────────────────────────────────────────

export function formatTimeAgo(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
