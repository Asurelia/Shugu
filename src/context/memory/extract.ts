/**
 * Layer 5 — Context: Memory extraction
 *
 * Automatically extracts memorable information from conversations.
 * Adapted from OpenClaude's EXTRACT_MEMORIES concept.
 */

import type { Message } from '../../protocol/messages.js';
import type { MemoryType } from './store.js';

// ─── Extraction Hints ───────────────────────────────────

export interface MemoryCandidate {
  type: MemoryType;
  name: string;
  description: string;
  content: string;
  confidence: number; // 0-1
}

/**
 * Scan a user message for explicit memory requests.
 * Detects patterns like "remember that...", "note that...", "I'm a..."
 */
export function detectMemoryHints(userMessage: string): MemoryCandidate[] {
  const candidates: MemoryCandidate[] = [];
  const lower = userMessage.toLowerCase();

  // "Remember that..." / "Note that..."
  const rememberMatch = userMessage.match(/(?:remember|note|save|store)\s+(?:that\s+)?(.+)/i);
  if (rememberMatch) {
    candidates.push({
      type: 'project',
      name: summarizeName(rememberMatch[1]!),
      description: rememberMatch[1]!.slice(0, 100),
      content: rememberMatch[1]!,
      confidence: 0.9,
    });
  }

  // "I'm a..." / "I am a..." / "My role is..."
  const roleMatch = userMessage.match(/(?:i'?m\s+a|i\s+am\s+a|my\s+role\s+is)\s+(.+)/i);
  if (roleMatch) {
    candidates.push({
      type: 'user',
      name: 'User role',
      description: `User is ${roleMatch[1]!.slice(0, 80)}`,
      content: roleMatch[1]!,
      confidence: 0.8,
    });
  }

  // "Don't..." / "Stop..." / "Always..." / "Never..."
  const feedbackMatch = userMessage.match(/(?:don'?t|stop|always|never|please\s+don'?t)\s+(.+)/i);
  if (feedbackMatch && (lower.includes('code') || lower.includes('file') || lower.includes('test'))) {
    candidates.push({
      type: 'feedback',
      name: summarizeName(feedbackMatch[1]!),
      description: `User preference: ${userMessage.slice(0, 100)}`,
      content: userMessage,
      confidence: 0.6,
    });
  }

  return candidates;
}

function summarizeName(text: string): string {
  return text
    .replace(/[^\w\s-]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join(' ');
}

// ─── Memory Prompt Injection ────────────────────────────

/**
 * Format memories for injection into the system prompt.
 */
export function formatMemoriesForPrompt(memories: Array<{ name: string; type: string; content: string }>): string {
  if (memories.length === 0) return '';

  const lines = memories.map(
    (m) => `- [${m.type}] ${m.name}: ${m.content.slice(0, 200)}`,
  );

  return `\n\n# Relevant memories from previous sessions\n${lines.join('\n')}`;
}
