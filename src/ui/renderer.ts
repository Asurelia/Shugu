/**
 * Layer 11 — UI: Rich terminal renderer
 *
 * Full-featured ANSI terminal UI with:
 * - ASCII art startup banner with live info panels
 * - Persistent bottom status bar (model, context%, cost, uptime, mode)
 * - Buddy companion with contextual reactions
 * - Brew timer for response time tracking
 * - Box-drawing for tool results
 * - Permission prompts
 *
 * No React/Ink — pure ANSI escape codes.
 */

import * as readline from 'node:readline';
import { renderBanner, renderSeparator, renderStatusLine, type BannerInfo } from './banner.js';
import { StatusBar, type StatusBarState } from './statusbar.js';
import { Buddy } from './buddy.js';

// ─── ANSI Colors ────────────────────────────────────────

const R = '\x1b[0m';
const B = '\x1b[1m';
const D = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const MAGENTA = '\x1b[35m';
const BLUE = '\x1b[34m';
const GRAY = '\x1b[90m';
const WHITE = '\x1b[37m';

// ─── Renderer ───────────────────────────────────────────

export class TerminalRenderer {
  private isStreaming = false;
  private brewStartTime: number | null = null;
  public statusBar: StatusBar;
  public buddy: Buddy;
  private statusInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.statusBar = new StatusBar();
    this.buddy = new Buddy(true);
  }

  // ─── Banner ─────────────────────────────────────────

  /**
   * Print the full startup banner.
   */
  banner(model: string, baseUrl: string): void {
    // Simple fallback banner (rich banner needs full info)
    console.log('');
    console.log(`${B}${CYAN}  ╔═══ Shugu v1.0.0 ═══╗${R}`);
    console.log(`${D}  Model: ${model}${R}`);
    console.log(`${D}  API:   ${baseUrl}${R}`);
    console.log('');
  }

  /**
   * Print the rich banner with all info.
   */
  richBanner(info: BannerInfo): void {
    console.log(renderBanner(info));
  }

  // ─── Prompt Footer ──────────────────────────────────
  //
  //  ✻ Brewed for 2m 40s
  //                                                                           (___)
  //  ──────────────────────────────── minimax-m2.7-shugu-runtime ──          /\_/\
  //  >                                                                      ( @   @)
  //  ──────────────────────────────────────────────────────────────────    (  ω  )
  //    M2.7-hs | Project_cc (main) | 52% (483k/1000k) | $$0.04            (")_(")
  //    ⏵⏵ bypass permissions on                                             Shugu
  //

  /**
   * Print the full footer block: separator + buddy + prompt + status.
   */
  printFooter(statusInfo: {
    model: string; project: string; branch?: string;
    contextPercent: number; contextUsed: number; contextTotal: number;
    costSession: number; costTotal: number; mode: string;
  }): void {
    const w = process.stdout.columns ?? 120;
    const buddyLines = this.buddy.render().split('\n').filter(l => l.length > 0);
    const buddyW = 12;
    const buddyCol = w - buddyW - 2;

    // Buddy frame (rendered to the right)
    const buddyPadded = buddyLines.map(l => {
      const pad = Math.max(0, buddyCol - 2);
      return ' '.repeat(pad) + l;
    });

    // Runtime label for separator
    const runtimeLabel = 'minimax-m2.7-shugu-runtime';
    const dashLen = Math.max(10, w - runtimeLabel.length - buddyW - 8);

    // Line 0: buddy top (if exists)
    if (buddyPadded.length > 0) console.log(buddyPadded[0] ?? '');

    // Line 1: separator with runtime name + buddy line 1
    const sep1 = `${GRAY}${'─'.repeat(dashLen)} ${runtimeLabel} ──${R}`;
    const bud1 = buddyPadded[1] ?? '';
    console.log(sep1 + (bud1 ? `  ${bud1.trimStart()}` : ''));

    // Line 2: prompt + buddy line 2
    const promptLine = `${B}${GREEN}> ${R}`;
    const bud2 = buddyPadded[2] ?? '';
    process.stdout.write(promptLine);
    // Don't print buddy on prompt line — user types here

    // We need to show remaining buddy lines AFTER the second separator
    // But since this is before user input, we just print the prompt
  }

  /**
   * Print the bottom status + second separator (called AFTER user input, before loop).
   */
  printStatusBar(statusInfo: {
    model: string; project: string; branch?: string;
    contextPercent: number; contextUsed: number; contextTotal: number;
    costSession: number; costTotal: number; mode: string;
  }): void {
    const w = process.stdout.columns ?? 120;

    // Second separator
    console.log(`${GRAY}${'─'.repeat(w)}${R}`);

    // Status line
    console.log(renderStatusLine(statusInfo));

    // Mode line
    const modeColor = statusInfo.mode === 'bypass' ? RED : statusInfo.mode === 'fullAuto' ? YELLOW : GREEN;
    console.log(`  ${D}⏵⏵ ${modeColor}${statusInfo.mode}${R} ${D}permissions on${R}`);
  }

  // Keep old methods for compatibility
  promptSeparator(): void {
    console.log(renderSeparator());
  }

  printStatusLine(info: {
    model: string; project: string; branch?: string;
    contextPercent: number; contextUsed: number; contextTotal: number;
    costSession: number; costTotal: number; mode: string;
  }): void {
    console.log(renderStatusLine(info));
  }

  promptIndicator(): void {
    process.stdout.write(`${B}${GREEN}> ${R}`);
  }

  // ─── Streaming ──────────────────────────────────────

  startStream(): void {
    if (this.isStreaming) return;
    this.isStreaming = true;
    this.brewStartTime = Date.now();
    this.statusBar.update({ isStreaming: true, brewStartTime: this.brewStartTime });

    // Show hatching indicator
    process.stdout.write(`\n${MAGENTA}✻ Hatching...${R}\n`);
    process.stdout.write(`${B}${CYAN}assistant${R} ${D}→${R} `);
    this.buddy.onEvent('thinking');
  }

  streamText(text: string): void {
    process.stdout.write(text);
  }

  streamThinking(text: string): void {
    process.stdout.write(`${D}${text}${R}`);
  }

  endStream(outputTokens?: number): void {
    if (this.isStreaming) {
      if (this.brewStartTime) {
        const brewMs = Date.now() - this.brewStartTime;
        const brewStr = formatBrewTime(brewMs);
        const tokStr = outputTokens ? ` · ↓ ${outputTokens} tokens` : '';
        console.log(`\n${D}${MAGENTA}✻ ${brewStr}${tokStr}${R}`);
        this.brewStartTime = null;
      } else {
        console.log('');
      }
      this.isStreaming = false;
      this.statusBar.update({ isStreaming: false, brewStartTime: undefined });
      this.buddy.onEvent('done');
    }
  }

  // ─── Thinking ───────────────────────────────────────

  thinkingHeader(): void {
    this.buddy.onEvent('thinking');
    process.stdout.write(`\n${D}${MAGENTA}thinking${R} ${D}→ ${R}`);
  }

  // ─── Tool Calls ─────────────────────────────────────

  toolCall(name: string, id: string): void {
    this.buddy.onEvent(`tool_${name}`);

    const shortId = id.length > 12 ? id.slice(-8) : id;
    const termWidth = process.stdout.columns ?? 120;
    const headerWidth = Math.min(termWidth - 4, 80);

    console.log('');
    console.log(`${YELLOW}┌${'─'.repeat(headerWidth)}${R}`);
    console.log(`${YELLOW}│${R} ${B}${name}${R} ${D}${shortId}${R}`);
  }

  toolResult(toolId: string, content: string, isError: boolean): void {
    const color = isError ? RED : GREEN;
    const icon = isError ? '✗' : '✓';
    const termWidth = process.stdout.columns ?? 120;
    const headerWidth = Math.min(termWidth - 4, 80);

    // Truncate long results but show more than before
    const maxLen = 1000;
    const truncated = content.length > maxLen
      ? content.slice(0, maxLen) + `\n${D}... (${content.length} chars total)${R}`
      : content;

    // Indent each line
    const indented = truncated.split('\n').map((l) => `${YELLOW}│${R} ${l}`).join('\n');

    console.log(indented);
    console.log(`${YELLOW}└${color}${icon}${R}${YELLOW}${'─'.repeat(headerWidth - 1)}${R}`);

    if (isError) this.buddy.onEvent('error');
  }

  // ─── Info / Error / Usage ───────────────────────────

  usage(summary: string): void {
    console.log(`\n${D}${summary}${R}`);
  }

  error(message: string): void {
    this.buddy.onEvent('error');
    console.error(`\n${RED}${B}error${R}${RED} → ${message}${R}`);
  }

  info(message: string): void {
    console.log(`${BLUE}${message}${R}`);
  }

  separator(): void {
    const w = Math.min(process.stdout.columns ?? 80, 80);
    console.log(`${D}${'─'.repeat(w)}${R}`);
  }

  // ─── Session End ────────────────────────────────────

  loopEnd(reason: string, totalCost: number): void {
    console.log('');
    this.separator();
    console.log(`${D}Session ended: ${reason} | Cost: $${totalCost.toFixed(4)}${R}`);
    this.buddy.onEvent('idle');
    this.stopStatusBar();
  }

  // ─── Permission Prompts ─────────────────────────────

  permissionDenied(tool: string, action: string, reason: string): void {
    const truncAction = action.length > 80 ? action.slice(0, 80) + '...' : action;
    console.log(`\n${RED}${B}denied${R} ${D}→${R} ${B}${tool}${R}: ${truncAction}`);
    console.log(`${D}  Reason: ${reason}${R}`);
  }

  async permissionPrompt(tool: string, action: string, reason: string): Promise<boolean> {
    const truncAction = action.length > 120 ? action.slice(0, 120) + '...' : action;
    console.log(`\n${YELLOW}${B}permission${R} ${D}→${R} ${B}${tool}${R}: ${truncAction}`);
    console.log(`${D}  ${reason}${R}`);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    return new Promise((resolve) => {
      rl.question(`${YELLOW}  Allow? [Y/n/a(lways)] ${R}`, (answer) => {
        rl.close();
        const trimmed = answer.trim().toLowerCase();
        resolve(trimmed === '' || trimmed === 'y' || trimmed === 'yes' || trimmed === 'a' || trimmed === 'always');
      });
    });
  }

  // ─── Status Bar Control ─────────────────────────────

  startStatusBar(): void {
    this.statusInterval = setInterval(() => {
      this.statusBar.draw();
    }, 1000);
  }

  stopStatusBar(): void {
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = null;
    }
    this.statusBar.clear();
  }
}

// ─── Helpers ────────────────────────────────────────────

function formatBrewTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes > 0) return `Brewed for ${minutes}m ${seconds % 60}s`;
  return `Brewed for ${seconds}s`;
}
