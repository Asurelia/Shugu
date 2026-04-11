/**
 * Meta-Harness: Trace Redaction
 *
 * Sanitizes execution traces and messages before archival to ensure
 * no secrets, credentials, or sensitive file paths leak into the
 * archive filesystem exposed to the proposer agent.
 *
 * Reuses SECRET_PATTERNS from the builtin secret-scanner hook.
 */

import { SECRET_PATTERNS } from '../plugins/builtin/behavior-hooks.js';
import type { Message, ContentBlock } from '../protocol/messages.js';
import type { TraceEvent } from '../utils/tracer.js';

// ─── Additional Sensitive Patterns ────────────────────

/** Patterns for sensitive filesystem paths */
const SENSITIVE_PATH_PATTERNS = [
  /~\/\.pcc\/credentials\//g,
  /\/\.pcc\/credentials\//g,
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g,
  /\/\.ssh\/id_[a-z]+/g,
  /\/\.env(?:\.local|\.production|\.staging)?/g,
];

// ─── Core Redaction ───────────────────────────────────

/**
 * Redact a single string, replacing all sensitive patterns with placeholders.
 */
export function redactString(text: string): string {
  let result = text;

  // Apply secret patterns (API keys, tokens, credentials)
  for (const pattern of SECRET_PATTERNS) {
    // Clone the regex to avoid lastIndex state issues
    const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
    result = result.replace(regex, '[REDACTED]');
  }

  // Apply sensitive path patterns
  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    result = result.replace(regex, '[REDACTED:path]');
  }

  return result;
}

// ─── Message Redaction ────────────────────────────────

/**
 * Redact sensitive content from a content block.
 */
function redactBlock(block: ContentBlock): ContentBlock {
  if ('text' in block && typeof block.text === 'string') {
    return { ...block, text: redactString(block.text) };
  }
  if ('thinking' in block && typeof block.thinking === 'string') {
    return { ...block, thinking: redactString(block.thinking) };
  }
  if ('content' in block && typeof block.content === 'string') {
    return { ...block, content: redactString(block.content) };
  }
  return block;
}

/**
 * Redact sensitive content from messages before archival.
 * Returns a new array — does NOT mutate the originals.
 */
export function redactMessages(messages: Message[]): Message[] {
  return messages.map((msg): Message => {
    if (typeof msg.content === 'string') {
      return { ...msg, content: redactString(msg.content) } as Message;
    }
    if (Array.isArray(msg.content)) {
      return { ...msg, content: msg.content.map(redactBlock) } as Message;
    }
    return msg;
  });
}

// ─── Trace Event Redaction ────────────────────────────

/**
 * Redact sensitive content from trace events before archival.
 * Returns a new array — does NOT mutate the originals.
 */
export function redactTraceEvents(events: TraceEvent[]): TraceEvent[] {
  return events.map(event => {
    const data = { ...event.data };

    // Redact string values in the data payload
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'string') {
        data[key] = redactString(value);
      }
    }

    return { ...event, data };
  });
}
