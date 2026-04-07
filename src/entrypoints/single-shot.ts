/**
 * Entrypoint — Single-shot query runner
 *
 * Executes a single prompt through the agentic loop and exits.
 */

import { runLoop, type LoopConfig } from '../engine/loop.js';
import { InterruptController } from '../engine/interrupts.js';
import type { Message } from '../protocol/messages.js';
import { handleEvent } from './cli-handlers.js';
import type { RuntimeServices } from './services.js';

export async function runSingleQuery(
  services: RuntimeServices,
  prompt: string,
  systemPrompt: string,
): Promise<void> {
  const { client, registry, toolContext, hookRegistry, renderer } = services;
  const messages: Message[] = [{ role: 'user', content: prompt }];
  const interrupt = new InterruptController();

  process.on('SIGINT', () => {
    interrupt.abort('User interrupted');
  });

  const config: LoopConfig = {
    client,
    systemPrompt,
    tools: new Map(registry.getAll().map(t => [t.definition.name, t])),
    toolDefinitions: registry.getDefinitions(),
    toolContext,
    maxTurns: 25,
    hookRegistry,
  };

  let lastUsage = { input_tokens: 0, output_tokens: 0 };
  let totalCost = 0;
  for await (const event of runLoop(messages, config, interrupt)) {
    handleEvent(event, renderer);
    if (event.type === 'turn_end') lastUsage = event.usage;
    if (event.type === 'loop_end') totalCost = event.totalCost;
  }

  renderer.endStream(lastUsage.output_tokens);

  renderer.printStatusBar({
    model: client.model,
    project: toolContext.cwd.split(/[\\/]/).pop() ?? '',
    contextPercent: Math.round((lastUsage.input_tokens / 204800) * 100),
    contextUsed: lastUsage.input_tokens,
    contextTotal: 204800,
    costSession: totalCost,
    costTotal: totalCost,
    mode: toolContext.permissionMode,
  });
}
