/**
 * Bracketed Paste Mode handler for terminal input.
 *
 * Terminals that support bracketed paste wrap pasted content between
 * escape sequences: \x1b[200~ (start) and \x1b[201~ (end).
 * This lets us receive the entire paste as one atomic block instead
 * of character-by-character through Ink's useInput.
 *
 * Reference: Gemini CLI bracketedPaste.ts, Claude Code paste handling.
 */

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** Strip any residual paste markers (full or partial) from text */
function sanitizePasteMarkers(text: string): string {
  return text
    .replace(/\x1b\[200~/g, '')
    .replace(/\x1b\[201~/g, '')
    .replace(/\[200~/g, '')
    .replace(/\[201~/g, '')
    .replace(/200~/g, '')
    .replace(/201~/g, '');
}

export interface PasteHandler {
  /** Enable bracketed paste mode on the terminal */
  enable(): void;
  /** Disable bracketed paste mode (MUST call on exit) */
  disable(): void;
  /** Set callback for when a paste is received */
  onPaste(callback: (text: string) => void): void;
}

/**
 * Create a bracketed paste handler that intercepts stdin data events.
 * Must be created BEFORE Ink takes over stdin.
 */
export function createPasteHandler(): PasteHandler {
  let inPaste = false;
  let pasteBuffer = '';
  let callback: ((text: string) => void) | null = null;
  let stdinListener: ((data: Buffer) => void) | null = null;

  return {
    enable() {
      // Tell terminal to use bracketed paste mode
      process.stdout.write(PASTE_START.replace('200~', '?2004h'));

      // Clean up on exit
      process.on('exit', () => {
        process.stdout.write('\x1b[?2004l');
      });

      // Listen on stdin for paste markers
      stdinListener = (data: Buffer) => {
        const str = data.toString();

        // Check for paste start
        if (str.includes(PASTE_START)) {
          inPaste = true;
          pasteBuffer = str.split(PASTE_START).slice(1).join(PASTE_START);

          // Check if paste end is in the same chunk
          if (pasteBuffer.includes(PASTE_END)) {
            const content = pasteBuffer.split(PASTE_END)[0] ?? '';
            inPaste = false;
            pasteBuffer = '';
            if (callback && content.length > 0) {
              callback(sanitizePasteMarkers(content));
            }
          }
          return;
        }

        // Accumulate paste content
        if (inPaste) {
          pasteBuffer += str;
          if (pasteBuffer.includes(PASTE_END)) {
            const content = pasteBuffer.split(PASTE_END)[0] ?? '';
            inPaste = false;
            pasteBuffer = '';
            if (callback && content.length > 0) {
              callback(sanitizePasteMarkers(content));
            }
          }
          return;
        }

        // Not a paste — let it pass through to Ink normally
      };

      // Prepend our listener so it fires before Ink's
      process.stdin.on('data', stdinListener);
    },

    disable() {
      process.stdout.write('\x1b[?2004l');
      if (stdinListener) {
        process.stdin.removeListener('data', stdinListener);
        stdinListener = null;
      }
    },

    onPaste(cb: (text: string) => void) {
      callback = cb;
    },
  };
}
