/**
 * Layer 11 — UI: Markdown Renderer
 *
 * Renders markdown text as React/Ink elements with proper formatting:
 * headings, code fences, inline code, bold, italic, links, lists, tables.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { colorizeCode, detectLanguage } from './highlight.js';

// ─── Inline Segment Types ─────────────────────────────────────────────────────

type InlineSegment =
  | { type: 'plain'; text: string }
  | { type: 'bold'; text: string }
  | { type: 'italic'; text: string }
  | { type: 'code'; text: string }
  | { type: 'link'; text: string; url: string };

// ─── parseInlineSegments ──────────────────────────────────────────────────────

/**
 * Pure function — parse a single markdown line into typed inline segments.
 * Exported for testing.
 *
 * Priority order: code span > link > bold > italic.
 * Unmatched markers are emitted as plain text.
 * Escaped `\*` → literal `*` (plain).
 */
export function parseInlineSegments(line: string): InlineSegment[] {
  if (line.length === 0) return [];

  const segments: InlineSegment[] = [];
  let pos = 0;
  let plain = '';

  const flush = () => {
    if (plain.length > 0) {
      segments.push({ type: 'plain', text: plain });
      plain = '';
    }
  };

  while (pos < line.length) {
    const ch = line[pos]!;

    // ── Escaped asterisk ──────────────────────────────────────────────────────
    if (ch === '\\' && pos + 1 < line.length && line[pos + 1] === '*') {
      plain += '*';
      pos += 2;
      continue;
    }

    // ── Code span: `...` ─────────────────────────────────────────────────────
    if (ch === '`') {
      const closeIdx = line.indexOf('`', pos + 1);
      if (closeIdx !== -1) {
        const content = line.slice(pos + 1, closeIdx);
        if (content.length > 0) {
          flush();
          segments.push({ type: 'code', text: content });
          pos = closeIdx + 1;
          continue;
        }
        // empty code span (``): treat as plain
      }
      plain += ch;
      pos++;
      continue;
    }

    // ── Link: [text](url) ────────────────────────────────────────────────────
    if (ch === '[') {
      const closeText = line.indexOf(']', pos + 1);
      if (closeText !== -1 && line[closeText + 1] === '(') {
        const closeUrl = line.indexOf(')', closeText + 2);
        if (closeUrl !== -1) {
          const linkText = line.slice(pos + 1, closeText);
          const url = line.slice(closeText + 2, closeUrl);
          flush();
          segments.push({ type: 'link', text: linkText, url });
          pos = closeUrl + 1;
          continue;
        }
      }
      plain += ch;
      pos++;
      continue;
    }

    // ── Bold: **text** ───────────────────────────────────────────────────────
    if (ch === '*' && line[pos + 1] === '*') {
      const closeIdx = line.indexOf('**', pos + 2);
      if (closeIdx !== -1) {
        const content = line.slice(pos + 2, closeIdx);
        if (content.length > 0) {
          flush();
          segments.push({ type: 'bold', text: content });
          pos = closeIdx + 2;
          continue;
        }
        // empty bold (****): treat as plain
      }
      plain += '**';
      pos += 2;
      continue;
    }

    // ── Italic: *text* (single star, not **) ─────────────────────────────────
    if (ch === '*') {
      // Already handled ** above; here pos+1 is NOT another *
      const closeIdx = line.indexOf('*', pos + 1);
      if (closeIdx !== -1) {
        const content = line.slice(pos + 1, closeIdx);
        if (content.length > 0) {
          flush();
          segments.push({ type: 'italic', text: content });
          pos = closeIdx + 1;
          continue;
        }
        // empty italic (**) but we already handled ** above → shouldn't reach here
      }
      plain += ch;
      pos++;
      continue;
    }

    plain += ch;
    pos++;
  }

  flush();
  return segments;
}

// ─── renderInline ─────────────────────────────────────────────────────────────

function renderSegment(seg: InlineSegment, key: number): React.ReactElement {
  switch (seg.type) {
    case 'plain':
      return <Text key={key}>{seg.text}</Text>;
    case 'bold':
      return <Text key={key} bold>{seg.text}</Text>;
    case 'italic':
      return <Text key={key} italic>{seg.text}</Text>;
    case 'code':
      return <Text key={key} color="cyan">{seg.text}</Text>;
    case 'link':
      return (
        <React.Fragment key={key}>
          <Text color="blue">{seg.text}</Text>
          <Text dimColor>{' ('}{seg.url}{')'}</Text>
        </React.Fragment>
      );
  }
}

/**
 * Render a single markdown line with inline formatting.
 * Exported for testing and external use.
 */
export function renderInline(line: string): React.ReactElement {
  const segs = parseInlineSegments(line);
  if (segs.length === 0) return <Text>{line}</Text>;
  return <>{segs.map((seg, i) => renderSegment(seg, i))}</>;
}

// ─── renderMarkdown ───────────────────────────────────────────────────────────

/**
 * Main entry point. Renders a full markdown string as Ink elements.
 * Replaces the assistant_text case in StaticMessage.
 */
export function renderMarkdown(text: string): React.ReactElement {
  const lines = text.split('\n');
  const elements: React.ReactElement[] = [];

  let inCodeBlock = false;
  let codeLang = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // ── Code fence ───────────────────────────────────────────────────────────
    if (line.startsWith('```')) {
      if (!inCodeBlock) {
        // Entering code block
        const lang = detectLanguage(line.slice(3));
        codeLang = lang;
        inCodeBlock = true;
        elements.push(
          <Text key={i} dimColor>{'┌─ '}{lang}{' ────────────────────────'}</Text>
        );
      } else {
        // Leaving code block
        inCodeBlock = false;
        codeLang = '';
        elements.push(
          <Text key={i} dimColor>{'└──────────────────────────────'}</Text>
        );
      }
      continue;
    }

    // ── Inside code block ────────────────────────────────────────────────────
    if (inCodeBlock) {
      elements.push(
        <Text key={i}>
          <Text dimColor>{'│ '}</Text>
          {colorizeCode(line, codeLang)}
        </Text>
      );
      continue;
    }

    // ── Headings ─────────────────────────────────────────────────────────────
    if (line.startsWith('### ')) {
      elements.push(<Text key={i} bold color="cyan">{line.slice(4)}</Text>);
      continue;
    }
    if (line.startsWith('## ')) {
      elements.push(<Text key={i} bold color="cyan">{line.slice(3)}</Text>);
      continue;
    }
    if (line.startsWith('# ')) {
      elements.push(<Text key={i} bold color="cyan">{line.slice(2)}</Text>);
      continue;
    }

    // ── List items ───────────────────────────────────────────────────────────
    if (line.startsWith('- ') || line.startsWith('* ')) {
      elements.push(<Text key={i}>{'  '}{renderInline(line)}</Text>);
      continue;
    }

    // ── Numbered list ────────────────────────────────────────────────────────
    if (/^\d+\.\s/.test(line)) {
      elements.push(<Text key={i}>{'  '}{renderInline(line)}</Text>);
      continue;
    }

    // ── Table row ─────────────────────────────────────────────────────────────
    if (line.startsWith('| ') && line.endsWith(' |')) {
      elements.push(<Text key={i} dimColor>{line}</Text>);
      continue;
    }

    // ── Table separator ───────────────────────────────────────────────────────
    if (/^[|\-:]+$/.test(line.replace(/\s/g, ''))) {
      elements.push(<Text key={i} dimColor>{line}</Text>);
      continue;
    }

    // ── Horizontal rule ───────────────────────────────────────────────────────
    if (line.startsWith('---') || line.startsWith('***')) {
      elements.push(
        <Text key={i} dimColor>{'────────────────────────────────────────'}</Text>
      );
      continue;
    }

    // ── Blockquote ────────────────────────────────────────────────────────────
    if (line.startsWith('>')) {
      elements.push(
        <Text key={i} dimColor italic>{'  │ '}{line.slice(1).trim()}</Text>
      );
      continue;
    }

    // ── Normal line with inline formatting ────────────────────────────────────
    elements.push(<React.Fragment key={i}>{renderInline(line)}</React.Fragment>);
  }

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {elements}
    </Box>
  );
}
