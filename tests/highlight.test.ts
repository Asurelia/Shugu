/**
 * Tests for Layer 11 — UI: Syntax Highlighting
 */

import { describe, it, expect } from 'vitest';
import {
  detectLanguage,
  tokenize,
  extFromPath,
} from '../src/ui/highlight.js';

// ─── detectLanguage ──────────────────────────────────────────────────

describe('detectLanguage — hint mapping', () => {
  it('maps ts to javascript', () => {
    expect(detectLanguage('ts')).toBe('javascript');
  });

  it('maps python to python', () => {
    expect(detectLanguage('python')).toBe('python');
  });

  it('maps bash to shell', () => {
    expect(detectLanguage('bash')).toBe('shell');
  });

  it('maps json to json', () => {
    expect(detectLanguage('json')).toBe('json');
  });

  it('maps typescript to javascript', () => {
    expect(detectLanguage('typescript')).toBe('javascript');
  });

  it('maps sh to shell', () => {
    expect(detectLanguage('sh')).toBe('shell');
  });

  it('maps jsx to javascript', () => {
    expect(detectLanguage('jsx')).toBe('javascript');
  });

  it('maps tsx to javascript', () => {
    expect(detectLanguage('tsx')).toBe('javascript');
  });
});

describe('detectLanguage — file path', () => {
  it('detects typescript from .ts extension', () => {
    expect(detectLanguage(undefined, 'src/foo.ts')).toBe('javascript');
  });

  it('detects python from .py extension', () => {
    expect(detectLanguage(undefined, 'script.py')).toBe('python');
  });

  it('detects json from .json extension', () => {
    expect(detectLanguage(undefined, 'data.json')).toBe('json');
  });

  it('detects shell from .sh extension', () => {
    expect(detectLanguage(undefined, 'run.sh')).toBe('shell');
  });

  it('detects javascript from .js extension', () => {
    expect(detectLanguage(undefined, 'index.js')).toBe('javascript');
  });

  it('detects markdown from .md extension', () => {
    expect(detectLanguage(undefined, 'README.md')).toBe('markdown');
  });

  it('detects dockerfile from Dockerfile filename', () => {
    expect(detectLanguage(undefined, 'Dockerfile')).toBe('dockerfile');
  });

  it('detects dockerfile from path containing Dockerfile', () => {
    expect(detectLanguage(undefined, 'docker/Dockerfile')).toBe('dockerfile');
  });
});

describe('detectLanguage — content heuristics', () => {
  it('detects python from shebang env python', () => {
    expect(detectLanguage(undefined, undefined, ['#!/usr/bin/env python'])).toBe('python');
  });

  it('detects python from shebang python', () => {
    expect(detectLanguage(undefined, undefined, ['#!/usr/bin/python'])).toBe('python');
  });

  it('detects shell from bash shebang', () => {
    expect(detectLanguage(undefined, undefined, ['#!/bin/bash'])).toBe('shell');
  });

  it('detects shell from sh shebang', () => {
    expect(detectLanguage(undefined, undefined, ['#!/bin/sh'])).toBe('shell');
  });

  it('detects json from opening brace', () => {
    expect(detectLanguage(undefined, undefined, ['{'])).toBe('json');
  });

  it('detects json from opening bracket', () => {
    expect(detectLanguage(undefined, undefined, ['['])).toBe('json');
  });

  it('detects python from def keyword with colon', () => {
    expect(detectLanguage(undefined, undefined, ['def foo():'])).toBe('python');
  });

  it('skips empty lines and checks first non-empty', () => {
    expect(detectLanguage(undefined, undefined, ['', '  ', '{'])).toBe('json');
  });
});

describe('detectLanguage — fallback and priority', () => {
  it('returns generic when no hint, path, or content', () => {
    expect(detectLanguage()).toBe('generic');
  });

  it('returns generic when unknown hint', () => {
    expect(detectLanguage('cobol')).toBe('generic');
  });

  it('hint takes priority over file path', () => {
    expect(detectLanguage('python', 'foo.ts')).toBe('python');
  });

  it('returns generic for no-extension file', () => {
    expect(detectLanguage(undefined, 'Makefile')).toBe('generic');
  });
});

// ─── extFromPath ─────────────────────────────────────────────────────

describe('extFromPath', () => {
  it('extracts .ts extension', () => {
    expect(extFromPath('src/foo.ts')).toBe('.ts');
  });

  it('extracts .py extension from Windows path', () => {
    expect(extFromPath('C:\\Users\\dev\\foo.py')).toBe('.py');
  });

  it('returns dockerfile for Dockerfile', () => {
    expect(extFromPath('Dockerfile')).toBe('dockerfile');
  });

  it('returns empty string for file with no extension', () => {
    expect(extFromPath('no-extension')).toBe('');
  });

  it('extracts .json extension', () => {
    expect(extFromPath('config/data.json')).toBe('.json');
  });

  it('extracts .sh from nested path', () => {
    expect(extFromPath('/usr/local/bin/deploy.sh')).toBe('.sh');
  });
});

// ─── tokenize ────────────────────────────────────────────────────────

describe('tokenize — empty and unknown', () => {
  it('returns empty array for empty line', () => {
    expect(tokenize('', 'javascript')).toEqual([]);
  });

  it('falls back to generic for unknown language', () => {
    const tokens = tokenize('x = 1', 'rust');
    const numToken = tokens.find((t) => t.type === 'number');
    expect(numToken).toBeDefined();
    expect(numToken!.type).toBe('number');
  });
});

describe('tokenize — javascript', () => {
  it('identifies const as keyword', () => {
    const tokens = tokenize('const x = 1;', 'javascript');
    const kw = tokens.find((t) => t.type === 'keyword');
    expect(kw).toBeDefined();
    expect(kw!.start).toBe(0);
    expect(kw!.end).toBe(5);
  });

  it('identifies number literal', () => {
    const tokens = tokenize('const x = 1;', 'javascript');
    const num = tokens.find((t) => t.type === 'number');
    expect(num).toBeDefined();
    expect(num!.type).toBe('number');
  });

  it('identifies string literal with single quotes', () => {
    const tokens = tokenize("const s = 'hello';", 'javascript');
    const str = tokens.find((t) => t.type === 'string');
    expect(str).toBeDefined();
    const line = "const s = 'hello';";
    expect(line.slice(str!.start, str!.end)).toBe("'hello'");
  });

  it('identifies line comment', () => {
    const tokens = tokenize('// comment', 'javascript');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('comment');
    expect(tokens[0].start).toBe(0);
    expect(tokens[0].end).toBe(10);
  });

  it('does not tokenize keyword inside string', () => {
    const tokens = tokenize("'return value'", 'javascript');
    const str = tokens.find((t) => t.type === 'string');
    expect(str).toBeDefined();
    // No keyword token — return is inside the string
    const kw = tokens.find((t) => t.type === 'keyword');
    expect(kw).toBeUndefined();
  });

  it('identifies PascalCase type', () => {
    const tokens = tokenize('const x: MyType = {};', 'javascript');
    const typeToken = tokens.find((t) => t.type === 'type');
    expect(typeToken).toBeDefined();
    const line = 'const x: MyType = {};';
    expect(line.slice(typeToken!.start, typeToken!.end)).toContain('MyType');
  });

  it('identifies decorator', () => {
    const tokens = tokenize('@Component', 'javascript');
    const dec = tokens.find((t) => t.type === 'decorator');
    expect(dec).toBeDefined();
    expect(dec!.start).toBe(0);
  });

  it('tokens are sorted by start position', () => {
    const tokens = tokenize('const x = 1;', 'javascript');
    for (let i = 1; i < tokens.length; i++) {
      expect(tokens[i].start).toBeGreaterThanOrEqual(tokens[i - 1].start);
    }
  });
});

describe('tokenize — python', () => {
  it('identifies def as keyword', () => {
    const tokens = tokenize('def foo():', 'python');
    const kw = tokens.find((t) => t.type === 'keyword');
    expect(kw).toBeDefined();
    const line = 'def foo():';
    expect(line.slice(kw!.start, kw!.end)).toBe('def');
  });

  it('identifies hash comment', () => {
    const tokens = tokenize('# this is a comment', 'python');
    const comment = tokens.find((t) => t.type === 'comment');
    expect(comment).toBeDefined();
    expect(comment!.start).toBe(0);
  });

  it('identifies python decorator', () => {
    const tokens = tokenize('@property', 'python');
    const dec = tokens.find((t) => t.type === 'decorator');
    expect(dec).toBeDefined();
  });
});

describe('tokenize — json', () => {
  it('identifies key as type and value as string', () => {
    const tokens = tokenize('"name": "value"', 'json');
    const typeToken = tokens.find((t) => t.type === 'type');
    const strToken = tokens.find((t) => t.type === 'string');
    expect(typeToken).toBeDefined();
    expect(strToken).toBeDefined();
    const line = '"name": "value"';
    expect(line.slice(typeToken!.start, typeToken!.end)).toBe('"name"');
    expect(line.slice(strToken!.start, strToken!.end)).toBe('"value"');
  });

  it('identifies json number', () => {
    const tokens = tokenize('  "count": 42', 'json');
    const num = tokens.find((t) => t.type === 'number');
    expect(num).toBeDefined();
  });

  it('identifies json boolean keywords', () => {
    const tokens = tokenize('  "active": true', 'json');
    const kw = tokens.find((t) => t.type === 'keyword');
    expect(kw).toBeDefined();
    const line = '  "active": true';
    expect(line.slice(kw!.start, kw!.end)).toBe('true');
  });
});

describe('tokenize — shell', () => {
  it('identifies shell variable', () => {
    const tokens = tokenize('echo $HOME', 'shell');
    const variable = tokens.find((t) => t.type === 'variable');
    expect(variable).toBeDefined();
    const line = 'echo $HOME';
    expect(line.slice(variable!.start, variable!.end)).toBe('$HOME');
  });

  it('identifies shell keyword', () => {
    const tokens = tokenize('if [ -f file ]; then', 'shell');
    const kw = tokens.find((t) => t.type === 'keyword');
    expect(kw).toBeDefined();
    const line = 'if [ -f file ]; then';
    expect(line.slice(kw!.start, kw!.end)).toBe('if');
  });

  it('identifies shell comment', () => {
    const tokens = tokenize('# shell comment', 'shell');
    const comment = tokens.find((t) => t.type === 'comment');
    expect(comment).toBeDefined();
    expect(comment!.start).toBe(0);
  });
});

describe('tokenize — generic', () => {
  it('identifies number and comment', () => {
    const tokens = tokenize('x = 42 # comment', 'generic');
    const num = tokens.find((t) => t.type === 'number');
    const comment = tokens.find((t) => t.type === 'comment');
    expect(num).toBeDefined();
    expect(comment).toBeDefined();
    const line = 'x = 42 # comment';
    expect(line.slice(num!.start, num!.end)).toBe('42');
    expect(line.slice(comment!.start, comment!.end)).toBe('# comment');
  });

  it('identifies double-slash comment', () => {
    const tokens = tokenize('x = 1 // note', 'generic');
    const comment = tokens.find((t) => t.type === 'comment');
    expect(comment).toBeDefined();
    const line = 'x = 1 // note';
    expect(line.slice(comment!.start, comment!.end)).toBe('// note');
  });
});

describe('tokenize — no overlapping tokens', () => {
  it('produces non-overlapping tokens', () => {
    const tokens = tokenize("const msg = 'hello world'; // greeting", 'javascript');
    for (let i = 0; i < tokens.length; i++) {
      for (let j = i + 1; j < tokens.length; j++) {
        const a = tokens[i];
        const b = tokens[j];
        const overlapping = a.start < b.end && b.start < a.end;
        expect(overlapping).toBe(false);
      }
    }
  });
});
