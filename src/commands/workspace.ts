/**
 * Layer 7 — Commands: Workspace index management
 *
 * /workspace init    — Build the workspace index
 * /workspace sync    — Incremental sync (re-index changed files)
 * /workspace status  — Show index stats
 * /workspace search  — Search the index (also available as SemSearch tool)
 */

import type { Command, CommandContext, CommandResult } from './registry.js';
import { WorkspaceIndexer } from '../context/workspace/indexer.js';
import { IndexStore } from '../context/workspace/store.js';
import { WorkspaceQueryEngine } from '../context/workspace/query.js';

export const workspaceCommand: Command = {
  name: 'workspace',
  aliases: ['ws'],
  description: 'Manage workspace search index: init, sync, status, search',
  usage: '/workspace <init|sync|status|search> [args]',

  async execute(args: string, ctx: CommandContext): Promise<CommandResult> {
    const parts = args.trim().split(/\s+/);
    const subcommand = parts[0]?.toLowerCase();
    const rest = parts.slice(1).join(' ');

    switch (subcommand) {
      case 'init':
        return handleInit(ctx);
      case 'sync':
        return handleSync(ctx);
      case 'status':
        return handleStatus(ctx);
      case 'search':
        return handleSearch(rest, ctx);
      default:
        ctx.info('Usage: /workspace <init|sync|status|search> [args]');
        ctx.info('  init   — Build the full workspace index');
        ctx.info('  sync   — Re-index changed files only');
        ctx.info('  status — Show index statistics');
        ctx.info('  search — Search the index (e.g., /workspace search runLoop)');
        return { type: 'handled' };
    }
  },
};

async function handleInit(ctx: CommandContext): Promise<CommandResult> {
  ctx.info('  Building workspace index...');
  const indexer = new WorkspaceIndexer(ctx.cwd);

  try {
    const stats = await indexer.indexWorkspace();
    ctx.info(`  Index built: ${stats.indexed} files indexed, ${stats.skipped} skipped, ${stats.updated} updated`);
    ctx.info(`  Duration: ${stats.durationMs}ms`);
    return { type: 'handled' };
  } catch (err: unknown) {
    ctx.error(`  Indexing failed: ${err instanceof Error ? err.message : String(err)}`);
    return { type: 'error', message: 'Workspace indexing failed' };
  }
}

async function handleSync(ctx: CommandContext): Promise<CommandResult> {
  const store = new IndexStore(ctx.cwd);
  const meta = await store.getMeta();

  if (!meta) {
    ctx.error('  No workspace index found. Run /workspace init first.');
    return { type: 'error', message: 'No workspace index' };
  }

  ctx.info('  Syncing workspace index...');
  const indexer = new WorkspaceIndexer(ctx.cwd);

  try {
    const stats = await indexer.indexWorkspace();
    ctx.info(`  Sync complete: ${stats.updated} files updated, ${stats.indexed} total`);
    ctx.info(`  Duration: ${stats.durationMs}ms`);
    return { type: 'handled' };
  } catch (err: unknown) {
    ctx.error(`  Sync failed: ${err instanceof Error ? err.message : String(err)}`);
    return { type: 'error', message: 'Workspace sync failed' };
  }
}

async function handleStatus(ctx: CommandContext): Promise<CommandResult> {
  const store = new IndexStore(ctx.cwd);
  const meta = await store.getMeta();

  if (!meta) {
    ctx.info('  No workspace index. Run /workspace init to build one.');
    return { type: 'handled' };
  }

  ctx.info(`  Workspace index status:`);
  ctx.info(`    Root:     ${meta.workspaceRoot}`);
  ctx.info(`    Files:    ${meta.fileCount}`);
  ctx.info(`    Last sync: ${meta.lastSync}`);
  ctx.info(`    Version:  ${meta.version}`);
  return { type: 'handled' };
}

async function handleSearch(query: string, ctx: CommandContext): Promise<CommandResult> {
  if (!query.trim()) {
    ctx.error('  Usage: /workspace search <query>');
    return { type: 'handled' };
  }

  const store = new IndexStore(ctx.cwd);
  const meta = await store.getMeta();

  if (!meta) {
    ctx.error('  No workspace index. Run /workspace init first.');
    return { type: 'error', message: 'No workspace index' };
  }

  const engine = new WorkspaceQueryEngine(store);

  try {
    const hits = await engine.search(query, { maxResults: 15 });

    if (hits.length === 0) {
      ctx.info(`  No results for "${query}"`);
      return { type: 'handled' };
    }

    ctx.info(`  Found ${hits.length} result(s) for "${query}":`);
    for (const hit of hits) {
      const icon = hit.matchType === 'symbol' ? '◆' :
                   hit.matchType === 'filename' ? '📄' : '≡';
      ctx.info(`    ${icon} ${hit.path}:${hit.line} [${hit.matchType}] (${hit.score.toFixed(1)})`);
      if (hit.snippet && hit.matchType !== 'filename') {
        const firstLine = (hit.snippet.split('\n')[0] ?? '').trim().slice(0, 100);
        ctx.info(`      ${firstLine}`);
      }
    }
    return { type: 'handled' };
  } catch (err: unknown) {
    ctx.error(`  Search failed: ${err instanceof Error ? err.message : String(err)}`);
    return { type: 'error', message: 'Workspace search failed' };
  }
}
