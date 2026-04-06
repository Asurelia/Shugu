/**
 * Bundled Skill: Dream Mode
 *
 * An exploration/brainstorming mode where the agent freely investigates
 * the codebase, identifies patterns, and generates insights. The agent
 * doesn't modify files — it only reads and analyzes.
 *
 * Use cases:
 * - "Dream about this codebase" → architecture analysis
 * - "Dream about performance" → performance investigation
 * - "Dream about security" → security review
 */

import type { Skill, SkillContext, SkillResult } from '../loader.js';

export const dreamSkill: Skill = {
  name: 'dream',
  description: 'Explore and analyze the codebase freely, generating insights without modifying files',
  category: 'analysis',
  triggers: [
    { type: 'command', command: 'dream' },
    { type: 'keyword', keywords: ['dream about', 'explore codebase', 'analyze architecture'] },
  ],
  requiredTools: ['Read', 'Glob', 'Grep', 'Bash'],

  async execute(ctx: SkillContext): Promise<SkillResult> {
    const focus = ctx.args.trim() || 'architecture and patterns';

    ctx.info(`\n💭 Dream Mode — exploring: ${focus}\n`);

    const prompt = `You are in DREAM MODE — an exploration mode where you freely investigate the codebase.

Focus area: "${focus}"

Rules:
- Do NOT modify any files. Read only.
- Use Glob to discover file structure
- Use Grep to find patterns
- Use Read to examine interesting files
- Use Bash for git log, git blame, or analysis commands

Your task:
1. Explore the project structure (Glob **/*.ts, **/*.tsx, etc.)
2. Read key files to understand the architecture
3. Identify patterns: design patterns, conventions, common abstractions
4. Look for the focus area specifically: ${focus}
5. Generate insights:
   - What's well-designed?
   - What could be improved?
   - What patterns are used?
   - What risks or tech debt exist?
   - What opportunities for improvement exist?

Output a structured analysis with specific file references and line numbers.
Be insightful, not generic. Reference actual code you found.`;

    return { type: 'prompt', prompt };
  },
};
