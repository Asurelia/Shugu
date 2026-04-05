/**
 * Layer 7 — Commands: Builtin slash commands
 *
 * Core commands available in every session.
 */

import type { Command, CommandContext, CommandResult } from './registry.js';
import { ObsidianVault, discoverVault } from '../context/memory/obsidian.js';

// ─── /help ──────────────────────────────────────────────

export const helpCommand: Command = {
  name: 'help',
  aliases: ['h', '?'],
  description: 'Show available commands',
  async execute(args, ctx) {
    ctx.info('Available commands:');
    ctx.info('  /help          Show this help');
    ctx.info('  /quit, /exit   Exit the session');
    ctx.info('  /clear         Clear conversation history');
    ctx.info('  /compact       Compact conversation (summarize old turns)');
    ctx.info('  /cost          Show token usage and cost');
    ctx.info('  /context       Show context window status');
    ctx.info('  /mode <mode>   Change permission mode (plan/default/accept-edits/auto/bypass)');
    ctx.info('  /memory        Search Obsidian vault / agent memories');
    ctx.info('  /memory save   Save a note to the vault');
    ctx.info('  /commit        Generate commit message and commit');
    ctx.info('  /status        Show git status and project info');
    ctx.info('  /review        Review recent changes');
    return { type: 'handled' };
  },
};

// ─── /quit, /exit ───────────────────────────────────────

export const quitCommand: Command = {
  name: 'quit',
  aliases: ['exit', 'q'],
  description: 'Exit the session',
  async execute() {
    return { type: 'exit', reason: 'user_exit' };
  },
};

// ─── /clear ─────────────────────────────────────────────

export const clearCommand: Command = {
  name: 'clear',
  description: 'Clear conversation history',
  async execute(args, ctx) {
    ctx.info('Conversation cleared.');
    return { type: 'clear' };
  },
};

// ─── /compact ───────────────────────────────────────────

export const compactCommand: Command = {
  name: 'compact',
  description: 'Compact conversation by summarizing older turns',
  async execute(args, ctx) {
    // This is handled specially in the REPL — here we just signal it
    return { type: 'prompt', prompt: '[System: User requested /compact. Summarize the conversation so far into key points, then confirm compaction is done.]' };
  },
};

// ─── /commit ────────────────────────────────────────────

export const commitCommand: Command = {
  name: 'commit',
  description: 'Generate a commit message and commit staged changes',
  usage: '/commit [message]',
  async execute(args, ctx) {
    if (args) {
      // User provided a message directly
      return { type: 'prompt', prompt: `Run \`git add -A && git commit -m "${args}"\` and show the result.` };
    }
    // Ask the model to generate a commit message
    return {
      type: 'prompt',
      prompt: `Look at the current git diff (staged and unstaged), then:
1. Run \`git status --short\` to see changed files
2. Run \`git diff\` to see the actual changes
3. Generate a concise commit message following conventional commits (feat/fix/refactor/docs/chore)
4. Show me the proposed message and ask for confirmation before committing
Do not commit without my approval.`,
    };
  },
};

// ─── /status ────────────────────────────────────────────

export const statusCommand: Command = {
  name: 'status',
  aliases: ['st'],
  description: 'Show git status and project info',
  async execute(args, ctx) {
    return {
      type: 'prompt',
      prompt: 'Run `git status` and show a summary of the project state (branch, uncommitted changes, recent commits).',
    };
  },
};

// ─── /review ────────────────────────────────────────────

export const reviewCommand: Command = {
  name: 'review',
  description: 'Review recent code changes',
  async execute(args, ctx) {
    return {
      type: 'prompt',
      prompt: `Review the recent code changes:
1. Run \`git diff\` to see unstaged changes
2. Run \`git diff --cached\` to see staged changes
3. Analyze the changes for:
   - Potential bugs or logic errors
   - Security concerns
   - Code quality and readability
4. Provide a concise review with specific actionable feedback.`,
    };
  },
};

// ─── /memory ────────────────────────────────────────────

export const memoryCommand: Command = {
  name: 'memory',
  aliases: ['mem', 'vault'],
  description: 'Search or save to Obsidian vault',
  usage: '/memory [search <query> | save <title> | recent | tags <tag>]',
  async execute(args, ctx) {
    const vaultPath = await discoverVault(ctx.cwd);

    if (!vaultPath) {
      ctx.info('No Obsidian vault found. Set PCC_OBSIDIAN_VAULT env var or create .pcc/vault.path');
      ctx.info('Common locations checked: ~/Obsidian, ~/Documents/Obsidian, cwd/.obsidian');
      return { type: 'handled' };
    }

    const vault = new ObsidianVault(vaultPath);
    const parts = args.split(/\s+/);
    const subcommand = parts[0]?.toLowerCase() ?? '';
    const rest = parts.slice(1).join(' ');

    switch (subcommand) {
      case 'search':
      case 's': {
        if (!rest) {
          ctx.error('Usage: /memory search <query>');
          return { type: 'handled' };
        }
        const results = await vault.searchContent(rest, 5);
        if (results.length === 0) {
          ctx.info(`No notes found for "${rest}"`);
        } else {
          ctx.info(`Found ${results.length} notes for "${rest}":`);
          for (const note of results) {
            const preview = note.body.slice(0, 100).replace(/\n/g, ' ').trim();
            const tags = note.tags.length > 0 ? ` [${note.tags.join(', ')}]` : '';
            ctx.info(`  ${note.path}${tags}`);
            ctx.info(`    ${preview}...`);
          }
        }
        return { type: 'handled' };
      }

      case 'save': {
        if (!rest) {
          ctx.error('Usage: /memory save <title> — then type the note content');
          return { type: 'handled' };
        }
        // Delegate to the model to gather content and save
        return {
          type: 'prompt',
          prompt: `The user wants to save a note titled "${rest}" to their Obsidian vault at ${vaultPath}/Agent/.
Create the file using Write with:
- YAML frontmatter (title, created date, type: agent-memory, relevant tags)
- The note content based on our conversation context
- Any relevant [[wikilinks]] to related concepts
Save it to: ${vaultPath}/Agent/${slugify(rest)}.md`,
        };
      }

      case 'recent':
      case 'r': {
        const days = parseInt(rest) || 7;
        const recent = await vault.getRecentNotes(days, 10);
        if (recent.length === 0) {
          ctx.info(`No notes modified in the last ${days} days`);
        } else {
          ctx.info(`Recent notes (last ${days} days):`);
          for (const note of recent) {
            const tags = note.tags.length > 0 ? ` [${note.tags.join(', ')}]` : '';
            ctx.info(`  ${note.path}${tags} — ${note.title}`);
          }
        }
        return { type: 'handled' };
      }

      case 'tags':
      case 't': {
        if (!rest) {
          ctx.error('Usage: /memory tags <tag>');
          return { type: 'handled' };
        }
        const tagged = await vault.searchByTag(rest);
        if (tagged.length === 0) {
          ctx.info(`No notes with tag #${rest}`);
        } else {
          ctx.info(`Notes with #${rest}:`);
          for (const note of tagged) {
            ctx.info(`  ${note.path} — ${note.title}`);
          }
        }
        return { type: 'handled' };
      }

      default: {
        // No subcommand — show vault summary
        const summary = await vault.getContextSummary();
        if (summary) {
          ctx.info(summary);
        } else {
          ctx.info(`Vault: ${vaultPath}`);
        }
        ctx.info('\nUsage: /memory search|save|recent|tags <args>');
        return { type: 'handled' };
      }
    }
  },
};

// ─── Helpers ────────────────────────────────────────────

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}
