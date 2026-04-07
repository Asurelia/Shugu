/**
 * Tests for Layer 11 — UI: Markdown Renderer
 *
 * Only tests parseInlineSegments (pure function).
 * React rendering is not tested here (requires a test renderer).
 */

import { describe, it, expect } from 'vitest';
import { parseInlineSegments } from '../src/ui/markdown.js';

// ─── Basic segments ───────────────────────────────────────────────────────────

describe('parseInlineSegments — basic', () => {
  it('returns single plain segment for plain text', () => {
    expect(parseInlineSegments('hello world')).toEqual([
      { type: 'plain', text: 'hello world' },
    ]);
  });

  it('parses bold', () => {
    expect(parseInlineSegments('**bold**')).toEqual([
      { type: 'bold', text: 'bold' },
    ]);
  });

  it('parses italic', () => {
    expect(parseInlineSegments('*italic*')).toEqual([
      { type: 'italic', text: 'italic' },
    ]);
  });

  it('parses inline code', () => {
    expect(parseInlineSegments('`code`')).toEqual([
      { type: 'code', text: 'code' },
    ]);
  });

  it('parses link', () => {
    expect(parseInlineSegments('[text](url)')).toEqual([
      { type: 'link', text: 'text', url: 'url' },
    ]);
  });
});

// ─── Mixed content ────────────────────────────────────────────────────────────

describe('parseInlineSegments — mixed', () => {
  it('handles text around bold', () => {
    expect(parseInlineSegments('before **bold** after')).toEqual([
      { type: 'plain', text: 'before ' },
      { type: 'bold', text: 'bold' },
      { type: 'plain', text: ' after' },
    ]);
  });

  it('handles multiple code spans', () => {
    const result = parseInlineSegments('use `foo` and `bar`');
    expect(result).toEqual([
      { type: 'plain', text: 'use ' },
      { type: 'code', text: 'foo' },
      { type: 'plain', text: ' and ' },
      { type: 'code', text: 'bar' },
    ]);
  });

  it('handles link surrounded by plain text', () => {
    const result = parseInlineSegments('see [docs](https://example.com) here');
    expect(result).toEqual([
      { type: 'plain', text: 'see ' },
      { type: 'link', text: 'docs', url: 'https://example.com' },
      { type: 'plain', text: ' here' },
    ]);
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe('parseInlineSegments — edge cases', () => {
  it('treats unmatched backtick as plain text', () => {
    const result = parseInlineSegments('hello ` world');
    // No closing backtick → whole string is plain (or backtick folded into plain)
    const joined = result.map(s => s.text).join('');
    expect(joined).toBe('hello ` world');
    for (const seg of result) {
      expect(seg.type).toBe('plain');
    }
  });

  it('treats unmatched bold markers as plain text', () => {
    const result = parseInlineSegments('**not closed');
    const joined = result.map(s => s.text).join('');
    expect(joined).toBe('**not closed');
    for (const seg of result) {
      expect(seg.type).toBe('plain');
    }
  });

  it('treats empty bold (****) as plain text', () => {
    const result = parseInlineSegments('****');
    for (const seg of result) {
      expect(seg.type).toBe('plain');
    }
  });

  it('code span containing asterisks is a single code segment', () => {
    expect(parseInlineSegments('`*not italic*`')).toEqual([
      { type: 'code', text: '*not italic*' },
    ]);
  });

  it('bold containing backticks is bold with literal content (no nesting)', () => {
    // v1: bold segment contains the literal backtick characters
    const result = parseInlineSegments('**`code` in bold**');
    expect(result).toEqual([
      { type: 'bold', text: '`code` in bold' },
    ]);
  });

  it('escaped asterisk becomes plain literal *', () => {
    const result = parseInlineSegments('\\*not italic\\*');
    const joined = result.map(s => s.text).join('');
    expect(joined).toBe('*not italic*');
    for (const seg of result) {
      expect(seg.type).toBe('plain');
    }
  });
});

// ─── Empty / whitespace ───────────────────────────────────────────────────────

describe('parseInlineSegments — empty and whitespace', () => {
  it('returns empty array for empty string', () => {
    expect(parseInlineSegments('')).toEqual([]);
  });

  it('returns single plain segment for whitespace-only string', () => {
    expect(parseInlineSegments('   ')).toEqual([
      { type: 'plain', text: '   ' },
    ]);
  });
});
