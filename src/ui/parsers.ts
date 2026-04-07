/**
 * Layer 11 — UI: Tool output parsers
 *
 * Parse structured output from each tool type so the renderer
 * can apply per-surface syntax highlighting.
 */

// ---------------------------------------------------------------------------
// parseReadOutput
// ---------------------------------------------------------------------------

export interface ReadLine {
  lineNum: number;
  code: string;
}

export interface ReadOutput {
  lines: ReadLine[];
  footer?: string;
}

const FOOTER_TRUNCATION = /^\(Showing lines \d+-\d+ of \d+\. Use offset and limit to read more\.\)$/;
const FOOTER_EMPTY = '(Empty file)';

export function parseReadOutput(content: string): ReadOutput {
  if (content === FOOTER_EMPTY) {
    return { lines: [], footer: FOOTER_EMPTY };
  }

  const rawLines = content.split('\n');
  let footer: string | undefined;

  const last = rawLines[rawLines.length - 1] ?? '';
  if (FOOTER_TRUNCATION.test(last) || last === FOOTER_EMPTY) {
    footer = last;
    rawLines.pop();
    if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
      rawLines.pop();
    }
  }

  const lines: ReadLine[] = rawLines.map((line) => {
    const tab = line.indexOf('\t');
    if (tab === -1) {
      return { lineNum: 0, code: line };
    }
    const num = parseInt(line.slice(0, tab), 10);
    return { lineNum: isNaN(num) ? 0 : num, code: line.slice(tab + 1) };
  });

  return { lines, footer };
}

// ---------------------------------------------------------------------------
// parseGrepOutput
// ---------------------------------------------------------------------------

export type GrepLine =
  | { type: 'match'; file: string; lineNum: string; content: string }
  | { type: 'context'; file: string; lineNum: string; content: string }
  | { type: 'separator' }
  | { type: 'plain'; text: string };

function stripDrive(line: string): [string, string] {
  if (line.length >= 2 && line[1] === ':' && /[a-zA-Z]/.test(line[0] ?? '')) {
    return [line.slice(0, 2), line.slice(2)];
  }
  return ['', line];
}

function parseGrepLine(line: string): GrepLine {
  if (line === '--') {
    return { type: 'separator' };
  }

  const [drive, rest] = stripDrive(line);

  const matchRe = /^(.*?):(\d+):(.*)$/s;
  const contextRe = /^(.*?)-(\d+)-(.*)$/s;

  const mMatch = matchRe.exec(rest);
  if (mMatch) {
    return { type: 'match', file: drive + (mMatch[1] ?? ''), lineNum: mMatch[2] ?? '', content: mMatch[3] ?? '' };
  }

  const mContext = contextRe.exec(rest);
  if (mContext) {
    return { type: 'context', file: drive + (mContext[1] ?? ''), lineNum: mContext[2] ?? '', content: mContext[3] ?? '' };
  }

  return { type: 'plain', text: line };
}

export function parseGrepOutput(content: string): GrepLine[] {
  if (!content.trim()) return [];
  return content.split('\n').map(parseGrepLine);
}

// ---------------------------------------------------------------------------
// parseWebFetchOutput
// ---------------------------------------------------------------------------

export interface WebFetchOutput {
  status: string;
  contentType: string;
  body: string;
}

export function contentTypeToLang(ct: string): string {
  const base = (ct.split(';')[0] ?? '').trim().toLowerCase();
  if (base === 'text/html') return 'html';
  if (base === 'application/json') return 'json';
  if (base === 'text/markdown') return 'markdown';
  return 'generic';
}

export function parseWebFetchOutput(content: string): WebFetchOutput {
  const lines = content.split('\n');
  const statusLine = lines[0] ?? '';

  const ctMatch = /\(([^)]+)\)/.exec(statusLine);
  const contentType = ctMatch?.[1] ?? '';

  const blankIdx = lines.indexOf('');
  const afterBlank = blankIdx !== -1 ? lines.slice(blankIdx + 1).join('\n') : '';

  const openTag = /<external-content[^>]*>/;
  const closeTag = '</external-content>';

  const openMatch = openTag.exec(afterBlank);
  if (openMatch) {
    const innerStart = openMatch.index + openMatch[0].length;
    const innerEnd = afterBlank.indexOf(closeTag, innerStart);
    const body =
      innerEnd !== -1
        ? afterBlank.slice(innerStart, innerEnd)
        : afterBlank.slice(innerStart);
    return { status: statusLine, contentType, body: body.replace(/^\n/, '').replace(/\n$/, '') };
  }

  return { status: statusLine, contentType, body: afterBlank };
}

// ---------------------------------------------------------------------------
// parseGlobOutput
// ---------------------------------------------------------------------------

export interface GlobEntry {
  path: string;
  ext: string;
}

export function parseGlobOutput(content: string): GlobEntry[] {
  return content
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const parts = line.split('.');
      const ext = parts.length > 1 ? '.' + (parts[parts.length - 1] ?? '') : '';
      return { path: line, ext };
    });
}
