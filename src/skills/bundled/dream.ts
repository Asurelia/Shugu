/**
 * Bundled Skill: Explore Mode (formerly Dream Mode)
 *
 * An exploration/brainstorming mode where the agent freely investigates
 * the codebase, identifies patterns, and generates insights. The agent
 * doesn't modify files — it only reads and analyzes.
 *
 * Use cases:
 * - "Explore this codebase" → architecture analysis
 * - "Explore performance" → performance investigation
 * - "Explore security" → security review
 */

import type { Skill, SkillContext, SkillResult } from '../loader.js';

export const exploreSkill: Skill = {
  name: 'explore',
  description: 'Explore and analyze the codebase freely, generating insights without modifying files',
  category: 'analysis',
  triggers: [
    { type: 'command', command: 'explore' },
    { type: 'keyword', keywords: ['explore codebase', 'analyze architecture', 'dream about'] },
  ],
  requiredTools: ['Read', 'Glob', 'Grep', 'Bash'],

  async execute(ctx: SkillContext): Promise<SkillResult> {
    const focus = ctx.args.trim() || 'architecture and patterns';

    ctx.info(`\n🔍 Explore Mode — investigating: ${focus}\n`);

    const prompt = `You are in EXPLORE MODE — an exploration mode where you freely investigate the codebase.

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
Be insightful, not generic. Reference actual code you found.

IMPORTANT: At the end of your analysis, summarize your key findings as explicit statements that can be remembered:
- "Decision: [what was decided and why]"
- "Pattern: [pattern name] used in [files]"
- "Risk: [what could go wrong]"
- "Improvement: [specific suggestion]"
These statements will be automatically extracted and saved for future sessions.`;

    return { type: 'prompt', prompt };
  },
};
