/**
 * Layer 2 — Engine: Mid-Turn Reflection
 *
 * Injects self-evaluation prompts into the conversation at regular intervals.
 * Leverages M2.7's Interleaved Thinking — the model processes these reflections
 * between tool calls, allowing it to course-correct mid-task.
 *
 * Zero extra LLM calls — reflection is injected as a user message
 * that the model processes in its next thinking step.
 */

// ─── Reflection Prompt Builder ────────────────────────

/**
 * Build a reflection prompt for mid-task self-evaluation.
 * Injected as a user message between turns.
 */
export function buildReflectionPrompt(turnIndex: number, maxTurns: number, template?: string): string {
  // If a custom template is provided (e.g., from HarnessConfig), use it
  if (template) {
    return template
      .replace(/\{\{turnIndex\}\}/g, String(turnIndex))
      .replace(/\{\{maxTurns\}\}/g, String(maxTurns))
      .replace(/\{\{budgetPercent\}\}/g, String(Math.round((turnIndex / maxTurns) * 100)));
  }

  const budgetPercent = Math.round((turnIndex / maxTurns) * 100);
  const urgency = budgetPercent > 70
    ? '\n⚠️ You have used ' + budgetPercent + '% of your turn budget. Prioritize completing the most important remaining work.'
    : '';

  return `[REFLECTION — Turn ${turnIndex}/${maxTurns}]
Pause and evaluate your progress:
- What have you accomplished so far?
- Is your current approach working? If not, what should change?
- What are the remaining steps to complete the task?
- Are you stuck in a loop or repeating the same actions?
- Have you claimed any result without actually running a verification command? If so, verify now.
- If you hit an obstacle, did you diagnose the root cause or just retry blindly?
- If you wrote an explanation instead of running a command, stop and run the command.${urgency}
Continue working after this reflection.`;
}

/**
 * Check whether a reflection should be injected at this turn.
 */
export function shouldReflect(
  turnIndex: number,
  reflectionInterval: number,
  maxTurns: number,
): boolean {
  if (reflectionInterval <= 0) return false;
  if (turnIndex < 2) return false; // Don't reflect on first turns
  if (turnIndex % reflectionInterval === 0) return true;

  // Force reflection at 50% budget regardless of interval
  const halfBudget = Math.floor(maxTurns / 2);
  if (turnIndex === halfBudget && halfBudget > 2) return true;

  return false;
}
