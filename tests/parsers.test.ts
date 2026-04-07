import { describe, it, expect } from 'vitest';
import {
  parseReadOutput,
  parseGrepOutput,
  parseWebFetchOutput,
  parseGlobOutput,
  contentTypeToLang,
} from '../src/ui/parsers.js';

// ---------------------------------------------------------------------------
// parseReadOutput
// ---------------------------------------------------------------------------

describe('parseReadOutput', () => {
  it('parses normal output into lines with lineNum and code', () => {
    const result = parseReadOutput('1\tconst x = 1;\n2\tconst y = 2;');
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]).toEqual({ lineNum: 1, code: 'const x = 1;' });
    expect(result.lines[1]).toEqual({ lineNum: 2, code: 'const y = 2;' });
    expect(result.footer).toBeUndefined();
  });

  it('extracts truncation footer and excludes it from lines', () => {
    const content =
      '1\tconst x = 1;\n2\tconst y = 2;\n\n(Showing lines 1-100 of 500. Use offset and limit to read more.)';
    const result = parseReadOutput(content);
    expect(result.lines).toHaveLength(2);
    expect(result.footer).toBe(
      '(Showing lines 1-100 of 500. Use offset and limit to read more.)'
    );
  });

  it('handles (Empty file) as footer with zero lines', () => {
    const result = parseReadOutput('(Empty file)');
    expect(result.lines).toHaveLength(0);
    expect(result.footer).toBe('(Empty file)');
  });

  it('treats a line without a tab as lineNum 0', () => {
    const result = parseReadOutput('no tab here');
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toEqual({ lineNum: 0, code: 'no tab here' });
  });
});

// ---------------------------------------------------------------------------
// parseGrepOutput
// ---------------------------------------------------------------------------

describe('parseGrepOutput', () => {
  it('parses a simple match line', () => {
    const result = parseGrepOutput('src/foo.ts:42:const x = 1');
    expect(result).toHaveLength(1);
    const line = result[0];
    expect(line.type).toBe('match');
    if (line.type === 'match') {
      expect(line.file).toBe('src/foo.ts');
      expect(line.lineNum).toBe('42');
      expect(line.content).toBe('const x = 1');
    }
  });

  it('handles Windows absolute paths correctly', () => {
    const result = parseGrepOutput('C:\\Users\\dev\\foo.ts:42:const x = 1');
    expect(result).toHaveLength(1);
    const line = result[0];
    expect(line.type).toBe('match');
    if (line.type === 'match') {
      expect(line.file).toBe('C:\\Users\\dev\\foo.ts');
      expect(line.lineNum).toBe('42');
      expect(line.content).toBe('const x = 1');
    }
  });

  it('parses a context line with dash separator', () => {
    const result = parseGrepOutput('src/foo.ts-40-  // comment');
    expect(result).toHaveLength(1);
    const line = result[0];
    expect(line.type).toBe('context');
    if (line.type === 'context') {
      expect(line.file).toBe('src/foo.ts');
      expect(line.lineNum).toBe('40');
      expect(line.content).toBe('  // comment');
    }
  });

  it('parses -- as separator', () => {
    const result = parseGrepOutput('--');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: 'separator' });
  });

  it('handles mixed lines including separators', () => {
    const input = [
      'src/foo.ts:10:match line',
      'src/foo.ts-9-context before',
      '--',
      'src/bar.ts:20:another match',
    ].join('\n');
    const result = parseGrepOutput(input);
    expect(result).toHaveLength(4);
    expect(result[0].type).toBe('match');
    expect(result[1].type).toBe('context');
    expect(result[2].type).toBe('separator');
    expect(result[3].type).toBe('match');
  });

  it('parses count mode lines (file:N with no content) without throwing', () => {
    const result = parseGrepOutput('src/foo.ts:5');
    expect(result).toHaveLength(1);
    expect(['match', 'plain']).toContain(result[0].type);
  });

  it('parses files_with_matches mode (no colon+digits) as plain', () => {
    const result = parseGrepOutput('src/foo.ts');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: 'plain', text: 'src/foo.ts' });
  });

  it('returns empty array for empty content', () => {
    expect(parseGrepOutput('')).toEqual([]);
    expect(parseGrepOutput('   ')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseWebFetchOutput
// ---------------------------------------------------------------------------

describe('parseWebFetchOutput', () => {
  it('parses an HTML response with external-content wrapper', () => {
    const content = [
      'HTTP 200 OK (text/html)',
      '',
      '<external-content source="https://example.com">',
      '<html>...</html>',
      '</external-content>',
    ].join('\n');
    const result = parseWebFetchOutput(content);
    expect(result.status).toBe('HTTP 200 OK (text/html)');
    expect(result.contentType).toBe('text/html');
    expect(result.body).toBe('<html>...</html>');
  });

  it('parses a JSON response with external-content wrapper', () => {
    const body = '{"key":"value"}';
    const content = [
      'HTTP 200 OK (application/json)',
      '',
      '<external-content source="https://api.example.com/data">',
      body,
      '</external-content>',
    ].join('\n');
    const result = parseWebFetchOutput(content);
    expect(result.contentType).toBe('application/json');
    expect(result.body).toBe(body);
  });

  it('handles response with no external-content wrapper', () => {
    const content = ['HTTP 200 OK (text/plain)', '', 'plain text body'].join('\n');
    const result = parseWebFetchOutput(content);
    expect(result.status).toBe('HTTP 200 OK (text/plain)');
    expect(result.contentType).toBe('text/plain');
    expect(result.body).toBe('plain text body');
  });
});

// ---------------------------------------------------------------------------
// contentTypeToLang
// ---------------------------------------------------------------------------

describe('contentTypeToLang', () => {
  it('maps text/html to html', () => {
    expect(contentTypeToLang('text/html')).toBe('html');
  });

  it('maps application/json to json', () => {
    expect(contentTypeToLang('application/json')).toBe('json');
  });

  it('maps text/plain to generic', () => {
    expect(contentTypeToLang('text/plain')).toBe('generic');
  });

  it('maps text/markdown to markdown', () => {
    expect(contentTypeToLang('text/markdown')).toBe('markdown');
  });

  it('maps unknown types to generic', () => {
    expect(contentTypeToLang('application/octet-stream')).toBe('generic');
  });
});

// ---------------------------------------------------------------------------
// parseGlobOutput
// ---------------------------------------------------------------------------

describe('parseGlobOutput', () => {
  it('parses mixed paths and extracts extensions', () => {
    const input = 'src/foo.ts\nsrc/bar.py\nREADME.md\nsrc/';
    const result = parseGlobOutput(input);
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ path: 'src/foo.ts', ext: '.ts' });
    expect(result[1]).toEqual({ path: 'src/bar.py', ext: '.py' });
    expect(result[2]).toEqual({ path: 'README.md', ext: '.md' });
    expect(result[3]).toEqual({ path: 'src/', ext: '' });
  });

  it('filters empty lines', () => {
    const input = 'src/foo.ts\n\n\nsrc/bar.ts\n';
    const result = parseGlobOutput(input);
    expect(result).toHaveLength(2);
  });

  it('returns empty array for empty input', () => {
    expect(parseGlobOutput('')).toEqual([]);
    expect(parseGlobOutput('\n\n')).toEqual([]);
  });
});
