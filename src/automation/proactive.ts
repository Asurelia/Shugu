/**
 * Layer 9 — Automation: Proactive Loop
 *
 * Enables the agent to continue working without user prompts.
 * In proactive mode, the agent autonomously decides what to do next
 * based on the current project state, pending tasks, and context.
 *
 * Use cases:
 * - "Finish implementing all pending TODOs in this file"
 * - "Monitor the CI pipeline and fix failures"
 * - "Keep improving test coverage until it reaches 80%"
 *
 * The proactive loop wraps the standard runLoop() but generates
 * its own continuation prompts when the model stops.
 */

import { runLoop, type LoopConfig, type LoopEvent } from '../engine/loop.js';
import { InterruptController } from '../engine/interrupts.js';
import type { Message, AssistantMessage } from '../protocol/messages.js';
import { isTextBlock } from '../protocol/messages.js';
import { EventEmitter } from 'node:events';

// ─── Proactive Config ──────────────────────────────────

export interface ProactiveConfig {
  /** The initial goal/objective */
  goal: string;
  /** Loop config for the agentic loop */
  loopConfig: LoopConfig;
  /** Maximum number of proactive iterations (default: 10) */
  maxIterations?: number;
  /** Delay between iterations (ms) — gives user time to interrupt */
  iterationDelayMs?: number;
  /** Custom continuation prompt generator */
  continuationPrompt?: (goal: string, iteration: number, lastResponse: string) => string;
  /** Callback to check if the goal is achieved (optional — model decides otherwise) */
  isGoalAchieved?: (response: string) => boolean;
}

// ─── Default Continuation Prompt ───────────────────────

const DEFAULT_CONTINUATION = (goal: string, iteration: number, lastResponse: string): string => {
  return `You are in proactive mode working toward this goal: "${goal}"

This is iteration ${iteration}. Your last response ended with:
"""
${lastResponse.slice(-500)}
"""

Continue working toward the goal. If you believe the goal is fully achieved, respond with exactly "[GOAL_ACHIEVED]" as the first line. If you need more iterations, continue working.

Do not ask for user input — make your best judgment and proceed.`;
};

// ─── Proactive Result ──────────────────────────────────

export interface ProactiveResult {
  /** Whether the goal was achieved */
  goalAchieved: boolean;
  /** Number of iterations completed */
  iterations: number;
  /** Final response from the last iteration */
  finalResponse: string;
  /** All events from all iterations */
  allEvents: LoopEvent[];
  /** Total cost across all iterations */
  totalCostUsd: number;
  /** Why the loop stopped */
  endReason: 'goal_achieved' | 'max_iterations' | 'aborted' | 'error';
}

// ─── Proactive Loop ────────────────────────────────────

export class ProactiveLoop extends EventEmitter {
  private interrupt: InterruptController;
  private running = false;

  constructor() {
    super();
    this.interrupt = new InterruptController();
  }

  /**
   * Run the proactive loop.
   * Yields events from each iteration.
   */
  async *run(config: ProactiveConfig): AsyncGenerator<LoopEvent & { iteration?: number }> {
    const {
      goal,
      loopConfig,
      maxIterations = 10,
      iterationDelayMs = 2000,
      continuationPrompt = DEFAULT_CONTINUATION,
      isGoalAchieved,
    } = config;

    this.running = true;
    this.interrupt.reset();

    const allEvents: LoopEvent[] = [];
    let totalCost = 0;
    let lastResponse = '';
    let goalDone = false;
    // Carry full history forward between iterations so tool_results are preserved
    let carryHistory: Message[] = [];

    try {
      for (let iteration = 1; iteration <= maxIterations; iteration++) {
        if (this.interrupt.aborted) break;

        this.emit('iteration:start', iteration);

        // Build the messages for this iteration
        const messages: Message[] = iteration === 1
          ? [{ role: 'user', content: `[PROACTIVE MODE] Goal: ${goal}\n\nBegin working toward this goal. Do not ask for confirmation — proceed autonomously.` }]
          : [...carryHistory, { role: 'user', content: continuationPrompt(goal, iteration, lastResponse) }];

        // Run one iteration of the agentic loop
        for await (const event of runLoop(messages, loopConfig, this.interrupt)) {
          allEvents.push(event);
          yield { ...event, iteration };

          if (event.type === 'assistant_message') {
            lastResponse = event.message.content
              .filter(isTextBlock)
              .map((b) => b.text)
              .join('');
          }

          if (event.type === 'history_sync') {
            carryHistory = [...event.messages];
          }

          if (event.type === 'loop_end') {
            totalCost += event.totalCost;
          }
        }

        // Check if goal is achieved
        if (isGoalAchieved) {
          goalDone = isGoalAchieved(lastResponse);
        } else {
          goalDone = lastResponse.trimStart().startsWith('[GOAL_ACHIEVED]');
        }

        this.emit('iteration:end', iteration, goalDone);

        if (goalDone) break;

        // Delay between iterations (interruptible)
        if (iteration < maxIterations && iterationDelayMs > 0) {
          await this.interruptibleDelay(iterationDelayMs);
        }
      }
    } catch (error) {
      if (!this.interrupt.aborted) {
        throw error;
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Execute the proactive loop and return a summary result.
   * (Non-generator version for simpler usage.)
   */
  async execute(config: ProactiveConfig): Promise<ProactiveResult> {
    const allEvents: LoopEvent[] = [];
    let iterations = 0;
    let finalResponse = '';
    let goalAchieved = false;
    let totalCostUsd = 0;
    let endReason: ProactiveResult['endReason'] = 'max_iterations';

    try {
      for await (const event of this.run(config)) {
        allEvents.push(event);

        if (event.type === 'assistant_message') {
          finalResponse = event.message.content
            .filter(isTextBlock)
            .map((b) => b.text)
            .join('');
        }

        if (event.type === 'loop_end') {
          totalCostUsd += event.totalCost;
          iterations++;
        }
      }

      // Check if goal was achieved
      goalAchieved = finalResponse.trimStart().startsWith('[GOAL_ACHIEVED]');
      if (config.isGoalAchieved) {
        goalAchieved = config.isGoalAchieved(finalResponse);
      }

      endReason = goalAchieved ? 'goal_achieved'
        : this.interrupt.aborted ? 'aborted'
        : 'max_iterations';
    } catch {
      endReason = this.interrupt.aborted ? 'aborted' : 'error';
    }

    return {
      goalAchieved,
      iterations,
      finalResponse,
      allEvents,
      totalCostUsd,
      endReason,
    };
  }

  /**
   * Abort the proactive loop.
   */
  abort(): void {
    this.interrupt.abort('User aborted proactive loop');
  }

  /**
   * Whether the loop is currently running.
   */
  get isRunning(): boolean {
    return this.running;
  }

  // ─── Private ────────────────────────────────────────

  private async interruptibleDelay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.interrupt.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
