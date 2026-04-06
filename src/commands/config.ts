/**
 * Configuration & utility commands
 *
 * /model, /fast, /diff, /export, /rewind
 */

import { writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isTextBlock } from '../protocol/messages.js';
import type { Command, CommandContext, CommandResult } from './registry.js';

const execAsync = promisify(execFile);

// ─── /model ───────────────────────────────────────────

export const modelCommand: Command = {
  name: 'model',
  aliases: [],
  description: 'Show or change the active model',
  async execute(args: string, ctx: CommandContext): Promise<CommandResult> {
    if (!args.trim()) {
      ctx.info('  Available models:');
      ctx.info('    MiniMax-M2.7-highspeed  (best, default)');
      ctx.info('    MiniMax-M2.7            (balanced)');
      ctx.info('    MiniMax-M2.5-highspeed  (fast, cheaper)');
      ctx.info('  Usage: /model <name>');
      return { type: 'handled' };
    }
    // Model switching requires client reconfiguration — delegate to the model
    return {
      type: 'prompt',
      prompt: `The user wants to switch to model "${args.trim()}". Note: model switching mid-session requires restarting. Inform the user they can restart with: shugu --model=${args.trim()}`,
    };
  },
};

// ─── /fast ────────────────────────────────────────────

export const fastCommand: Command = {
  name: 'fast',
  aliases: [],
  description: 'Toggle fast mode (M2.5-highspeed)',
  async execute(_args: string, ctx: CommandContext): Promise<CommandResult> {
    ctx.info('  Fast mode toggled. Restart shugu to apply: shugu --model=fast');
    return { type: 'handled' };
  },
};

// ─── /diff ────────────────────────────────────────────

export const diffCommand: Command = {
  name: 'diff',
  aliases: [],
  description: 'Show git diff with colors',
  async execute(args: string, ctx: CommandContext): Promise<CommandResult> {
    try {
      const diffArgs = args.trim() ? ['diff', ...args.trim().split(/\s+/)] : ['diff'];
      const { stdout } = await execAsync('git', diffArgs, { cwd: ctx.cwd, timeout: 10_000 });
      if (!stdout.trim()) {
        ctx.info('  No changes.');
        return { type: 'handled' };
      }
      // Display with colors
      for (const line of stdout.split('\n').slice(0, 100)) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          ctx.info(`\x1b[42m\x1b[37m${line}\x1b[0m`);
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          ctx.info(`\x1b[41m\x1b[37m${line}\x1b[0m`);
        } else if (line.startsWith('@@')) {
          ctx.info(`\x1b[36m${line}\x1b[0m`);
        } else if (line.startsWith('diff ') || line.startsWith('index ')) {
          ctx.info(`\x1b[1m${line}\x1b[0m`);
        } else {
          ctx.info(`  ${line}`);
        }
      }
      const totalLines = stdout.split('\n').length;
      if (totalLines > 100) ctx.info(`\x1b[2m  ... +${totalLines - 100} more lines\x1b[0m`);
      return { type: 'handled' };
    } catch (err) {
      ctx.error(`git diff failed: ${err instanceof Error ? err.message : String(err)}`);
      return { type: 'handled' };
    }
  },
};

// ─── /export ──────────────────────────────────────────

export const exportCommand: Command = {
  name: 'export',
  aliases: [],
  description: 'Export conversation to a text file',
  async execute(args: string, ctx: CommandContext): Promise<CommandResult> {
    const filename = args.trim() || `shugu-export-${new Date().toISOString().split('T')[0]}.md`;
    const lines: string[] = [`# Shugu Conversation Export\n`, `Date: ${new Date().toISOString()}\n`, '---\n'];

    for (const msg of ctx.messages) {
      if (msg.role === 'user') {
        const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        lines.push(`\n## User\n\n${text}\n`);
      } else if (msg.role === 'assistant') {
        const text = (msg.content as Array<{ type: string; text?: string }>)
          .filter((b: { type: string }) => b.type === 'text')
          .map((b: { text?: string }) => b.text ?? '')
          .join('\n');
        lines.push(`\n## Assistant\n\n${text}\n`);
      }
    }

    const filePath = `${ctx.cwd}/${filename}`;
    await writeFile(filePath, lines.join(''), 'utf-8');
    ctx.info(`  Exported ${ctx.messages.length} messages to ${filename}`);
    return { type: 'handled' };
  },
};

// ─── /rewind ──────────────────────────────────────────

export const rewindCommand: Command = {
  name: 'rewind',
  aliases: ['undo'],
  description: 'Remove last N turn pairs from conversation',
  async execute(args: string, ctx: CommandContext): Promise<CommandResult> {
    const n = parseInt(args.trim() || '1', 10);
    if (isNaN(n) || n < 1) {
      ctx.error('Usage: /rewind [N] — remove last N turns (default: 1)');
      return { type: 'handled' };
    }

    // Remove N pairs of user+assistant messages from the end
    let removed = 0;
    while (removed < n && ctx.messages.length >= 2) {
      // Pop from end: should be assistant then user
      ctx.messages.pop(); // assistant
      ctx.messages.pop(); // user
      removed++;
    }

    ctx.info(`  Rewound ${removed} turn(s). ${ctx.messages.length} messages remaining.`);
    return { type: 'handled' };
  },
};
