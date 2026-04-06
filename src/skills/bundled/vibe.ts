/**
 * Bundled Skill: Vibe Workflow
 *
 * A 10-stage pipeline that takes a project description and generates
 * a complete, production-ready codebase. Each stage builds on the previous.
 *
 * Stages:
 * 1. Understand  — Parse the user's vision, clarify ambiguity
 * 2. Analyze     — Research existing code, tech stack, constraints
 * 3. Plan        — Architecture, file structure, dependencies
 * 4. Scaffold    — Create project structure, configs, boilerplate
 * 5. Implement   — Write the actual code
 * 6. Validate    — Run tests, type-check, lint
 * 7. Optimize    — Performance, bundle size, caching
 * 8. Document    — README, API docs, inline comments
 * 9. Review      — Self-review for bugs, security, quality
 * 10. Ship       — Git commit, build, deployment prep
 *
 * From OpenRoom's Vibe Workflow plan — reimplemented as a clean skill.
 */

import type { Skill, SkillContext, SkillResult } from '../loader.js';

// ─── Stage Definition ──────────────────────────────────

interface VibeStage {
  name: string;
  emoji: string;
  description: string;
  prompt: (projectName: string, projectDesc: string, previousOutput: string) => string;
}

const STAGES: VibeStage[] = [
  {
    name: 'Understand',
    emoji: '🔍',
    description: 'Parse the vision, extract requirements',
    prompt: (name, desc, _prev) => `
# Stage 1: Understand

You are beginning the Vibe Workflow for project "${name}".

User's vision: "${desc}"

Your task:
1. Extract the core requirements from the description
2. Identify the target users and use cases
3. List the key features (MVP scope)
4. Note any ambiguities or assumptions you're making
5. Determine the tech stack if mentioned, or recommend one

Output a structured requirements document. Be concise but thorough.`,
  },
  {
    name: 'Analyze',
    emoji: '📊',
    description: 'Research existing code, constraints',
    prompt: (name, desc, prev) => `
# Stage 2: Analyze

Project "${name}" — continuing from the requirements.

Previous stage output:
${prev.slice(-2000)}

Your task:
1. Check the current directory for any existing code (use Glob and Read)
2. Identify the tech stack to use based on requirements
3. Research any libraries or frameworks needed
4. List constraints (performance, compatibility, security)
5. Note any risks or technical challenges

Be practical — recommend proven tools over experimental ones.`,
  },
  {
    name: 'Plan',
    emoji: '📋',
    description: 'Architecture and file structure',
    prompt: (name, desc, prev) => `
# Stage 3: Plan

Project "${name}" — architecture phase.

Previous analysis:
${prev.slice(-2000)}

Your task:
1. Design the file/directory structure
2. Define the module boundaries and data flow
3. List all files to create with their purpose
4. Define the build/dev/test scripts
5. Plan the implementation order (what depends on what)

Output a concrete plan with file paths and descriptions. No code yet — just architecture.`,
  },
  {
    name: 'Scaffold',
    emoji: '🏗️',
    description: 'Create project structure and configs',
    prompt: (name, desc, prev) => `
# Stage 4: Scaffold

Project "${name}" — scaffolding phase.

Architecture plan:
${prev.slice(-2000)}

Your task:
1. Create the project directory structure
2. Write package.json / config files (tsconfig, etc.)
3. Create stub files with TODO comments for each module
4. Set up the build pipeline
5. Install dependencies if needed

Use Write to create files and Bash to run setup commands. Create REAL files, not stubs.`,
  },
  {
    name: 'Implement',
    emoji: '⚡',
    description: 'Write the actual code',
    prompt: (name, desc, prev) => `
# Stage 5: Implement

Project "${name}" — core implementation phase.

This is the main coding stage. Previous scaffolding:
${prev.slice(-2000)}

Your task:
1. Implement each module in dependency order
2. Write COMPLETE, working code — no stubs, no TODOs
3. Handle errors properly
4. Follow the architecture from the plan
5. Use the appropriate tools (Write for new files, Edit for modifications)

Write production-quality code. Every file must be complete and functional.`,
  },
  {
    name: 'Validate',
    emoji: '✅',
    description: 'Run tests, type-check, lint',
    prompt: (name, desc, prev) => `
# Stage 6: Validate

Project "${name}" — validation phase.

Implementation summary:
${prev.slice(-1500)}

Your task:
1. Run the type checker if TypeScript (tsc --noEmit)
2. Run any existing tests
3. If no tests exist, write basic smoke tests
4. Fix any type errors or test failures
5. Verify the project builds successfully

Use Bash to run commands. Fix issues immediately — do not leave broken code.`,
  },
  {
    name: 'Optimize',
    emoji: '🚀',
    description: 'Performance and quality pass',
    prompt: (name, desc, prev) => `
# Stage 7: Optimize

Project "${name}" — optimization phase.

Validation results:
${prev.slice(-1500)}

Your task:
1. Review for obvious performance issues
2. Check bundle size if applicable
3. Add caching where beneficial
4. Remove dead code or unused imports
5. Ensure error messages are helpful

Keep changes minimal and targeted. Don't over-engineer.`,
  },
  {
    name: 'Document',
    emoji: '📝',
    description: 'README and API docs',
    prompt: (name, desc, prev) => `
# Stage 8: Document

Project "${name}" — documentation phase.

Your task:
1. Write a clear README.md with:
   - Project description
   - Installation steps
   - Usage examples
   - API reference (if applicable)
   - Contributing guide
2. Add inline comments only where logic is non-obvious
3. Ensure all public APIs have JSDoc/docstrings

Focus on practical documentation that helps someone use the project.`,
  },
  {
    name: 'Review',
    emoji: '🔬',
    description: 'Self-review for quality and security',
    prompt: (name, desc, prev) => `
# Stage 9: Review

Project "${name}" — self-review phase.

Your task:
1. Read through ALL created files
2. Check for:
   - Logic bugs
   - Security vulnerabilities (injection, XSS, auth issues)
   - Missing error handling
   - Inconsistent naming or patterns
   - Hard-coded values that should be configurable
3. Fix any issues found
4. Report a summary of what was reviewed and fixed

Be thorough but pragmatic. Fix real issues, not style nits.`,
  },
  {
    name: 'Ship',
    emoji: '🚢',
    description: 'Git commit and deployment prep',
    prompt: (name, desc, prev) => `
# Stage 10: Ship

Project "${name}" — shipping phase.

Review summary:
${prev.slice(-1500)}

Your task:
1. Run the final build to confirm everything works
2. Run git status to see all changes
3. Create a meaningful git commit message
4. Report a summary of what was built:
   - Files created/modified
   - Key features implemented
   - How to run/test the project
   - Any known limitations or next steps

Do NOT push to remote — just commit locally. Show the user what was built.`,
  },
];

// ─── Vibe Skill ────────────────────────────────────────

export const vibeSkill: Skill = {
  name: 'vibe',
  description: 'Generate a complete project from a description using the 10-stage Vibe Workflow pipeline',
  category: 'workflow',
  triggers: [
    { type: 'command', command: 'vibe' },
    { type: 'pattern', regex: /^\/vibe\s+(.+)/i },
  ],

  async execute(ctx: SkillContext): Promise<SkillResult> {
    // Parse: /vibe ProjectName description of the project
    const parts = ctx.args.trim().split(/\s+/);
    if (parts.length < 2) {
      return {
        type: 'error',
        message: 'Usage: /vibe <ProjectName> <description>\nExample: /vibe TaskAPI A REST API for managing tasks with authentication',
      };
    }

    const projectName = parts[0]!;
    const projectDesc = parts.slice(1).join(' ');

    ctx.info(`\n╔══════════════════════════════════════════════╗`);
    ctx.info(`║  🌊 Vibe Workflow — ${projectName.padEnd(25)}║`);
    ctx.info(`╚══════════════════════════════════════════════╝\n`);
    ctx.info(`Vision: ${projectDesc}\n`);

    let previousOutput = '';
    let stageIndex = 0;

    for (const stage of STAGES) {
      stageIndex++;
      const header = `${stage.emoji} Stage ${stageIndex}/10: ${stage.name} — ${stage.description}`;
      ctx.info(`\n${'─'.repeat(50)}`);
      ctx.info(header);
      ctx.info(`${'─'.repeat(50)}\n`);

      const prompt = stage.prompt(projectName, projectDesc, previousOutput);

      try {
        const result = await ctx.runAgent(prompt);
        previousOutput = result;
        ctx.info(`  ✓ ${stage.name} complete`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        ctx.error(`  ✗ ${stage.name} failed: ${msg}`);
        return {
          type: 'error',
          message: `Vibe Workflow failed at stage ${stageIndex} (${stage.name}): ${msg}`,
        };
      }
    }

    ctx.info(`\n╔══════════════════════════════════════════════╗`);
    ctx.info(`║  🌊 Vibe Workflow Complete!                  ║`);
    ctx.info(`╚══════════════════════════════════════════════╝\n`);

    return { type: 'handled' };
  },
};
