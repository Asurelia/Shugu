/**
 * Entrypoint — CLI
 *
 * The main entry point for `shugu` / `pcc` command.
 * Thin orchestrator: parses args → bootstraps services → dispatches to mode.
 *
 * Usage:
 *   shugu "prompt"              Single-shot with default mode
 *   shugu --mode=auto "prompt"  Single-shot with fullAuto mode
 *   shugu --mode=plan           Interactive REPL in plan mode
 *   shugu --bypass              Interactive REPL, no permission prompts
 */

import { parseArgs, bootstrap } from './bootstrap.js';
import { runSingleQuery } from './single-shot.js';
import { runREPL } from './repl.js';

// ─── Entry ──────────────────────────────────────────────

async function main(): Promise<void> {
  const cliArgs = parseArgs();

  try {
    const { services, systemPrompt, needsHatchCeremony, resumedMessages, resumedWorkContext } = await bootstrap(cliArgs);

    if (cliArgs.prompt) {
      await runSingleQuery(services, cliArgs.prompt, systemPrompt);
    } else {
      await runREPL(services, systemPrompt, needsHatchCeremony, resumedMessages, resumedWorkContext);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('No API key')) {
      console.error(error.message);
      console.error('\nSet one of: MINIMAX_API_KEY, ANTHROPIC_AUTH_TOKEN, or ANTHROPIC_API_KEY');
      process.exit(1);
    }
    console.error('Fatal error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
