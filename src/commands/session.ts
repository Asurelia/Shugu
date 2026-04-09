/**
 * Layer 7 — Commands: Session management
 *
 * /file-revert          — revert most recent turn's file changes
 * /file-revert list     — show revert history
 * /file-revert N        — revert last N entries
 * /clone                — deep copy current session into new ID
 * /copy                 — copy last assistant response to clipboard
 * /snapshot [label]     — checkpoint current conversation
 * /snapshot list        — list snapshots
 */

import type { Command, CommandContext, CommandResult } from './registry.js';
import { FileRevertStack, revertEntry } from '../context/session/file-revert.js';
import type { SessionManager, SessionData } from '../context/session/persistence.js';
import { execFileSync } from 'node:child_process';

// ─── /file-revert ──────────────────────────────────────

export function createFileRevertCommand(revertStack: FileRevertStack): Command {
  return {
    name: 'file-revert',
    aliases: ['fr'],
    description: 'Revert file changes from recent turns',
    usage: '/file-revert [list|N]',

    async execute(args: string, ctx: CommandContext): Promise<CommandResult> {
      const trimmed = args.trim();

      if (trimmed === 'list') {
        const entries = revertStack.list(10);
        if (entries.length === 0) {
          ctx.info('  No file changes to revert.');
          return { type: 'handled' };
        }

        ctx.info('  File revert history:');
        for (const entry of entries) {
          const fileCount = entry.changes.length;
          const files = entry.changes.map(c => c.path.split(/[\\/]/).pop()).join(', ');
          ctx.info(`    Turn ${entry.turnIndex}: ${fileCount} file(s) — ${files} (${entry.timestamp})`);
        }
        ctx.info('');
        ctx.info('  Note: Bash file mutations are not tracked.');
        return { type: 'handled' };
      }

      // Parse count (default 1)
      const count = trimmed ? parseInt(trimmed, 10) : 1;
      if (isNaN(count) || count < 1) {
        ctx.error('  Usage: /file-revert [list|N]');
        return { type: 'handled' };
      }

      let totalReverted = 0;
      let totalFailed = 0;

      for (let i = 0; i < count; i++) {
        const entry = revertStack.pop();
        if (!entry) {
          if (i === 0) ctx.info('  No file changes to revert.');
          break;
        }

        const result = await revertEntry(entry);
        totalReverted += result.reverted.length;
        totalFailed += result.failed.length;

        for (const path of result.reverted) {
          ctx.info(`  Reverted: ${path}`);
        }
        for (const fail of result.failed) {
          ctx.error(`  Failed: ${fail.path} — ${fail.error}`);
        }
      }

      if (totalReverted > 0 || totalFailed > 0) {
        ctx.info(`  ${totalReverted} file(s) reverted, ${totalFailed} failed.`);
      }

      return { type: 'handled' };
    },
  };
}

// ─── /clone ────────────────────────────────────────────

export function createCloneCommand(
  sessionMgr: SessionManager,
  getSession: () => SessionData,
  setSession: (session: SessionData) => void,
): Command {
  return {
    name: 'clone',
    description: 'Clone current session into a new session ID',

    async execute(_args: string, ctx: CommandContext): Promise<CommandResult> {
      const current = getSession();

      try {
        const cloned = await sessionMgr.clone(current);
        setSession(cloned);
        ctx.info(`  Session cloned: ${current.id} -> ${cloned.id}`);
        ctx.info(`  Conversation preserved (${cloned.messages.length} messages).`);
        return { type: 'handled' };
      } catch (err: unknown) {
        ctx.error(`  Clone failed: ${err instanceof Error ? err.message : String(err)}`);
        return { type: 'error', message: 'Clone failed' };
      }
    },
  };
}

// ─── /copy ─────────────────────────────────────────────

export const copyCommand: Command = {
  name: 'copy',
  description: 'Copy last assistant response to clipboard',

  async execute(_args: string, ctx: CommandContext): Promise<CommandResult> {
    // Find last assistant message
    let lastAssistant: string | null = null;
    for (let i = ctx.messages.length - 1; i >= 0; i--) {
      const msg = ctx.messages[i];
      if (msg && msg.role === 'assistant') {
        if (typeof msg.content === 'string') {
          lastAssistant = msg.content;
        } else if (Array.isArray(msg.content)) {
          lastAssistant = msg.content
            .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
            .map(b => b.text)
            .join('\n');
        }
        break;
      }
    }

    if (!lastAssistant) {
      ctx.info('  No assistant response to copy.');
      return { type: 'handled' };
    }

    try {
      // Use execFileSync to avoid shell injection — input is piped via stdin
      if (process.platform === 'win32') {
        execFileSync('clip.exe', [], { input: lastAssistant, timeout: 5_000 });
      } else if (process.platform === 'darwin') {
        execFileSync('pbcopy', [], { input: lastAssistant, timeout: 5_000 });
      } else {
        execFileSync('xclip', ['-selection', 'clipboard'], { input: lastAssistant, timeout: 5_000 });
      }
      ctx.info(`  Copied ${lastAssistant.length} characters to clipboard.`);
    } catch {
      ctx.error('  Failed to copy to clipboard (clipboard tool not available).');
    }

    return { type: 'handled' };
  },
};

// ─── /snapshot ─────────────────────────────────────────

export function createSnapshotCommand(
  sessionMgr: SessionManager,
  getSession: () => SessionData,
): Command {
  return {
    name: 'snapshot',
    description: 'Create or manage conversation snapshots',
    usage: '/snapshot [label] | /snapshot list | /snapshot load <id>',

    async execute(args: string, ctx: CommandContext): Promise<CommandResult> {
      const parts = args.trim().split(/\s+/);
      const subcommand = parts[0]?.toLowerCase();

      if (subcommand === 'list') {
        const session = getSession();
        try {
          const snapshots = await sessionMgr.listSnapshots(session.id);
          if (snapshots.length === 0) {
            ctx.info('  No snapshots for this session.');
            return { type: 'handled' };
          }

          ctx.info('  Snapshots:');
          for (const snap of snapshots) {
            const label = snap.label ? ` "${snap.label}"` : '';
            ctx.info(`    ${snap.id}${label} — ${snap.turnIndex} messages (${snap.createdAt})`);
          }
          return { type: 'handled' };
        } catch (err: unknown) {
          ctx.error(`  Failed to list snapshots: ${err instanceof Error ? err.message : String(err)}`);
          return { type: 'error', message: 'List snapshots failed' };
        }
      }

      if (subcommand === 'load') {
        const snapshotId = parts[1];
        if (!snapshotId) {
          ctx.error('  Usage: /snapshot load <id>');
          return { type: 'handled' };
        }

        const session = getSession();
        try {
          const snapshot = await sessionMgr.loadSnapshot(snapshotId, session.id);
          if (!snapshot) {
            ctx.error(`  Snapshot not found: ${snapshotId}`);
            return { type: 'handled' };
          }

          // Restore messages
          ctx.messages.length = 0;
          ctx.messages.push(...snapshot.messages);
          const label = snapshot.label ? ` "${snapshot.label}"` : '';
          ctx.info(`  Restored snapshot ${snapshotId}${label} (${snapshot.turnIndex} messages).`);
          return { type: 'handled' };
        } catch (err: unknown) {
          ctx.error(`  Failed to load snapshot: ${err instanceof Error ? err.message : String(err)}`);
          return { type: 'error', message: 'Load snapshot failed' };
        }
      }

      // Default: create a snapshot
      const label = args.trim() || undefined;
      const session = getSession();

      try {
        const snapshot = await sessionMgr.createSnapshot(session, label);
        const labelStr = label ? ` "${label}"` : '';
        ctx.info(`  Snapshot created: ${snapshot.id}${labelStr} (${snapshot.turnIndex} messages)`);
        return { type: 'handled' };
      } catch (err: unknown) {
        ctx.error(`  Snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
        return { type: 'error', message: 'Snapshot failed' };
      }
    },
  };
}
