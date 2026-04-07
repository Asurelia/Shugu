/**
 * Layer 11 — UI: Syntax Highlighting
 *
 * Multi-language regex tokenizer. Returns React elements for Ink rendering.
 * Languages: javascript, python, json, shell, markdown, generic.
 */

import React from 'react';
import { Text } from 'ink';

// ─── Types ─────────────────────────────────────────────────────────

export type TokenType =
  | 'keyword'
  | 'string'
  | 'comment'
  | 'number'
  | 'decorator'
  | 'type'
  | 'variable'
  | 'plain';

export interface Token {
  start: number;
  end: number;
  type: TokenType;
}

export interface LanguageRules {
  keywords?: RegExp;
  strings: RegExp;
  comments: RegExp;
  numbers: RegExp;
  decorators?: RegExp;
  types?: RegExp;
  variables?: RegExp;
}

// ─── Color Map ─────────────────────────────────────────────────────

const COLOR_MAP: Record<TokenType, string> = {
  keyword: 'magenta',
  string: 'green',
  comment: 'gray',
  number: 'yellow',
  decorator: 'yellow',
  type: 'cyan',
  variable: 'cyan',
  plain: 'white',
};

// ─── Language Definitions ───────────────────────────────────────────

const LANG_JAVASCRIPT: LanguageRules = {
  keywords:
    /\b(const|let|var|function|class|import|export|from|return|if|else|for|while|switch|case|break|default|new|this|type|interface|async|await|try|catch|throw|finally|extends|implements|typeof|instanceof|in|of|as|is|void|null|undefined|true|false|enum|readonly|abstract|declare|namespace|keyof|infer|satisfies|override)\b/g,
  strings:
    /('[^'\\]*(?:\\\\.[^'\\]*)*'|"[^"\\]*(?:\\\\.[^"\\]*)*"|`[^`\\]*(?:\\\\.[^`\\]*)*`)/g,
  comments: /(\/\/.*$|\/\*[\s\S]*?\*\/)/gm,
  numbers: /\b(\d+\.?\d*(?:e[+-]?\d+)?)\b/gi,
  decorators: /(@\w+)/g,
  types: /\b([A-Z][A-Za-z0-9]*(?:<[^>]*>)?)\b/g,
};

const LANG_PYTHON: LanguageRules = {
  keywords:
    /\b(def|class|import|from|return|if|elif|else|for|while|try|except|finally|with|as|yield|lambda|pass|break|continue|raise|not|and|or|in|is|del|global|nonlocal|assert|True|False|None|async|await)\b/g,
  strings:
    /('[^'\\]*(?:\\\\.[^'\\]*)*'|"[^"\\]*(?:\\\\.[^"\\]*)*"|'''[\s\S]*?'''|"""[\s\S]*?""")/g,
  comments: /(#.*$)/gm,
  numbers: /\b(\d+\.?\d*(?:e[+-]?\d+)?)\b/gi,
  decorators: /(@\w+(?:\.\w+)*)/g,
};

const LANG_JSON: LanguageRules = {
  strings: /("(?:[^"\\]|\\.)*")/g,
  comments: /(\/\/.*$)/gm,
  numbers: /\b(-?\d+\.?\d*(?:e[+-]?\d+)?)\b/gi,
  keywords: /\b(true|false|null)\b/g,
  types: /("(?:[^"\\]|\\.)*")(?=\s*:)/g,
};

const LANG_SHELL: LanguageRules = {
  keywords:
    /\b(if|then|else|elif|fi|for|do|done|while|until|case|esac|function|in|select|export|local|return|exit|source|alias|unalias|set|unset|readonly|declare|typeset)\b/g,
  strings: /('[^']*'|"[^"]*")/g,
  comments: /(#.*$)/gm,
  numbers: /\b(\d+)\b/g,
  variables: /(\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)/g,
};

const LANG_MARKDOWN: LanguageRules = {
  comments: /(^#{1,6}\s.*$)/gm,
  strings: /(`[^`]+`)/g,
  keywords: /(\*\*[^*]+\*\*)/g,
  numbers: /\b(\d+)\b/g,
};

const LANG_GENERIC: LanguageRules = {
  strings: /('[^']*'|"[^"]*")/g,
  comments: /(\/\/.*$|#.*$)/gm,
  numbers: /\b(\d+\.?\d*)\b/g,
};

export const LANGUAGES: Record<string, LanguageRules> = {
  javascript: LANG_JAVASCRIPT,
  python: LANG_PYTHON,
  json: LANG_JSON,
  shell: LANG_SHELL,
  markdown: LANG_MARKDOWN,
  generic: LANG_GENERIC,
};

// ─── Extension / Language Maps ─────────────────────────────────────────

const EXT_MAP: Record<string, string> = {
  '.ts': 'javascript',
  '.tsx': 'javascript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.json': 'json',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.md': 'markdown',
};

const HINT_MAP: Record<string, string> = {
  ts: 'javascript',
  typescript: 'javascript',
  py: 'python',
  bash: 'shell',
  sh: 'shell',
  zsh: 'shell',
  js: 'javascript',
  jsx: 'javascript',
  tsx: 'javascript',
  javascript: 'javascript',
  python: 'python',
  json: 'json',
  shell: 'shell',
  markdown: 'markdown',
  generic: 'generic',
};

// ─── Helpers ────────────────────────────────────────────────────────

export function extFromPath(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? '';
  if (base === 'Dockerfile') return 'dockerfile';
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot) : '';
}

// Token priority: lower index = higher priority
const PRIORITY: TokenType[] = [
  'comment',
  'string',
  'keyword',
  'decorator',
  'type',
  'variable',
  'number',
  'plain',
];

function priorityOf(t: TokenType): number {
  const idx = PRIORITY.indexOf(t);
  return idx === -1 ? PRIORITY.length : idx;
}

function overlaps(a: Token, b: Token): boolean {
  return a.start < b.end && b.start < a.end;
}

function collectMatches(
  line: string,
  regex: RegExp,
  type: TokenType,
): Token[] {
  const tokens: Token[] = [];
  regex.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(line)) !== null) {
    const value = m[1] ?? m[0];
    const matchStart = m.index + (m[0].length - value.length);
    tokens.push({ start: matchStart, end: matchStart + value.length, type });
    if (m[0].length === 0) regex.lastIndex++;
  }
  return tokens;
}

// ─── tokenize ─────────────────────────────────────────────────────────

export function tokenize(line: string, lang: string): Token[] {
  if (line.length === 0) return [];

  const rules = LANGUAGES[lang] ?? LANG_GENERIC;
  const isJson = lang === 'json';

  const candidates: Token[] = [];

  // JSON: collect keys (type) before generic strings so they take priority
  if (isJson && rules.types) {
    candidates.push(
      ...collectMatches(
        line,
        new RegExp(rules.types.source, rules.types.flags),
        'type',
      ),
    );
  }

  if (rules.comments) {
    candidates.push(
      ...collectMatches(
        line,
        new RegExp(rules.comments.source, rules.comments.flags),
        'comment',
      ),
    );
  }

  if (rules.strings) {
    const stringCandidates = collectMatches(
      line,
      new RegExp(rules.strings.source, rules.strings.flags),
      'string',
    );
    // For JSON, skip string tokens that are already covered by a key (type) token
    const filtered = isJson
      ? stringCandidates.filter(
          (sc) => !candidates.some((tc) => tc.type === 'type' && overlaps(sc, tc)),
        )
      : stringCandidates;
    candidates.push(...filtered);
  }

  if (rules.keywords) {
    candidates.push(
      ...collectMatches(
        line,
        new RegExp(rules.keywords.source, rules.keywords.flags),
        'keyword',
      ),
    );
  }

  if (!isJson && rules.types) {
    candidates.push(
      ...collectMatches(
        line,
        new RegExp(rules.types.source, rules.types.flags),
        'type',
      ),
    );
  }

  if (rules.variables) {
    candidates.push(
      ...collectMatches(
        line,
        new RegExp(rules.variables.source, rules.variables.flags),
        'variable',
      ),
    );
  }

  if (rules.decorators) {
    candidates.push(
      ...collectMatches(
        line,
        new RegExp(rules.decorators.source, rules.decorators.flags),
        'decorator',
      ),
    );
  }

  if (rules.numbers) {
    candidates.push(
      ...collectMatches(
        line,
        new RegExp(rules.numbers.source, rules.numbers.flags),
        'number',
      ),
    );
  }

  // Resolve overlaps: keep higher-priority token
  const accepted: Token[] = [];
  for (const candidate of candidates) {
    let dominated = false;
    for (const existing of accepted) {
      if (overlaps(candidate, existing)) {
        if (priorityOf(candidate.type) >= priorityOf(existing.type)) {
          dominated = true;
          break;
        }
      }
    }
    if (!dominated) {
      for (let i = accepted.length - 1; i >= 0; i--) {
        const existing = accepted[i]!;
        if (
          overlaps(candidate, existing) &&
          priorityOf(candidate.type) < priorityOf(existing.type)
        ) {
          accepted.splice(i, 1);
        }
      }
      accepted.push(candidate);
    }
  }

  accepted.sort((a, b) => a.start - b.start);
  return accepted;
}

// ─── colorizeCode ─────────────────────────────────────────────────────

export function colorizeCode(
  line: string,
  lang?: string,
): React.ReactElement {
  const resolvedLang = lang ?? 'generic';
  const tokens = tokenize(line, resolvedLang);
  const parts: React.ReactElement[] = [];
  let cursor = 0;
  let keyIdx = 0;

  for (const token of tokens) {
    if (token.start > cursor) {
      parts.push(
        React.createElement(
          Text,
          { key: keyIdx++, color: 'white' },
          line.slice(cursor, token.start),
        ),
      );
    }

    const isComment = token.type === 'comment';
    parts.push(
      React.createElement(
        Text,
        { key: keyIdx++, color: COLOR_MAP[token.type], italic: isComment },
        line.slice(token.start, token.end),
      ),
    );

    cursor = token.end;
  }

  if (cursor < line.length) {
    parts.push(
      React.createElement(
        Text,
        { key: keyIdx++, color: 'white' },
        line.slice(cursor),
      ),
    );
  }

  return React.createElement(React.Fragment, null, ...parts);
}

// ─── detectLanguage ───────────────────────────────────────────────────

export function detectLanguage(
  hint?: string,
  filePath?: string,
  firstLines?: string[],
): string {
  if (hint) {
    const mapped = HINT_MAP[hint.toLowerCase()];
    if (mapped) return mapped;
  }

  if (filePath) {
    const ext = extFromPath(filePath);
    if (ext === 'dockerfile') return 'dockerfile';
    const fromExt = EXT_MAP[ext];
    if (fromExt) return fromExt;
  }

  if (firstLines && firstLines.length > 0) {
    for (const line of firstLines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (
        trimmed.startsWith('#!/usr/bin/env python') ||
        trimmed.startsWith('#!/usr/bin/python')
      ) {
        return 'python';
      }

      if (
        trimmed.startsWith('#!/bin/bash') ||
        trimmed.startsWith('#!/bin/sh')
      ) {
        return 'shell';
      }

      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        return 'json';
      }

      if (trimmed.includes('def ') && trimmed.includes(':')) {
        return 'python';
      }

      break;
    }
  }

  return 'generic';
}
