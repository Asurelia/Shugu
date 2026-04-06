/**
 * Bundled Skill: Bug Hunter
 *
 * Systematically hunts for bugs, security issues, and code quality problems.
 * Generates a detailed report with severity ratings and fix suggestions.
 *
 * Use cases:
 * - "/hunt" → full codebase scan
 * - "/hunt src/auth/" → focused scan on auth module
 * - "/hunt security" → security-focused review
 */

import type { Skill, SkillContext, SkillResult } from '../loader.js';

export const hunterSkill: Skill = {
  name: 'hunter',
  description: 'Hunt for bugs, security issues, and code quality problems across the codebase',
  category: 'analysis',
  triggers: [
    { type: 'command', command: 'hunt' },
    { type: 'command', command: 'bughunter' },
    { type: 'keyword', keywords: ['hunt for bugs', 'find bugs', 'security audit'] },
  ],
  requiredTools: ['Read', 'Glob', 'Grep', 'Bash'],

  async execute(ctx: SkillContext): Promise<SkillResult> {
    const target = ctx.args.trim() || '.';

    ctx.info(`\n🔎 Bug Hunter — scanning: ${target}\n`);

    const prompt = `You are the Bug Hunter — systematically scan for issues.

Target: "${target}" (directory, file, or focus area)

Scan methodology:
1. **Discovery** — Use Glob to find all source files in the target area
2. **Static analysis** — Use Grep to find common bug patterns:
   - Unhandled promises (missing await, no .catch)
   - Type assertions (as any, as unknown)
   - Console.log left in production code
   - Hard-coded secrets or credentials
   - SQL/command injection risks
   - Unused variables or imports
   - Missing null/undefined checks
   - Race conditions in async code
3. **Deep read** — Read suspicious files and analyze:
   - Logic errors
   - Off-by-one errors
   - Missing error handling
   - Resource leaks (unclosed handles)
   - Incorrect API usage
4. **Security** — Check for:
   - Input validation gaps
   - Authentication/authorization bypasses
   - Insecure defaults
   - Sensitive data exposure
5. **Report** — Generate a structured report:
   - 🔴 CRITICAL: Must fix immediately
   - 🟠 HIGH: Should fix soon
   - 🟡 MEDIUM: Fix when convenient
   - 🔵 LOW: Nice to have
   Each issue: file:line, description, suggested fix

Be thorough and specific. Reference actual code. No generic advice.`;

    return { type: 'prompt', prompt };
  },
};
