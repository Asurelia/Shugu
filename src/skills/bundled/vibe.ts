/**
 * Bundled Skill: Vibe Workflow
 *
 * Ported from OpenRoom's Vibe Workflow — a staged pipeline that takes
 * a project description and generates a complete codebase.
 *
 * 6 creation stages (from OpenRoom):
 *   01-analysis     → Requirement analysis
 *   02-architecture → Architecture & component design
 *   03-planning     → Task decomposition into implementable chunks
 *   04-codegen      → Code generation (the actual writing)
 *   05-validate     → Type-check, tests, lint
 *   06-ship         → Git commit, build, summary
 *
 * Key features (ported from OpenRoom):
 * - Workflow state persistence (JSON checkpoint)
 * - Resume from breakpoint (/vibe AppName)
 * - Re-run from specific stage (/vibe AppName --from=04-codegen)
 * - Rule files loaded on-demand per stage (token savings)
 * - Stage artifacts saved to .pcc/workflow/{AppName}/outputs/
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Skill, SkillContext, SkillResult } from '../loader.js';

// ─── Stage Definitions ─────────────────────────────────

interface StageDefinition {
  id: string;
  name: string;
  emoji: string;
  description: string;
  /** Rule/context markdown to load as additional prompt context */
  rules: string[];
  /** Outputs from previous stages to load */
  requiresOutputs: string[];
  /** Artifact filename this stage produces (null = no artifact) */
  produces: string | null;
  /** The stage prompt (receives project context + loaded rules + previous outputs) */
  prompt: string;
}

const CREATION_STAGES: StageDefinition[] = [
  {
    id: '01-analysis',
    name: 'Analysis',
    emoji: '🔍',
    description: 'Requirement analysis — understand the vision',
    rules: [],
    requiresOutputs: [],
    produces: 'requirement-breakdown.json',
    prompt: `# Stage 1: Requirement Analysis

You are analyzing a project requirement. Your job:
1. Parse the user's vision — extract core requirements
2. Identify the target users and use cases
3. List features with priority (must/should/could)
4. Determine tech stack (framework, language, build tools)
5. Note assumptions and constraints

Output a JSON file at the artifacts path with:
{
  "appInfo": { "name": "", "description": "", "category": "" },
  "features": [{ "id": "feat-001", "title": "", "priority": "must|should|could" }],
  "techStack": { "language": "", "framework": "", "buildTool": "", "testRunner": "" },
  "assumptions": [],
  "constraints": []
}`,
  },
  {
    id: '02-architecture',
    name: 'Architecture',
    emoji: '📐',
    description: 'Architecture & component design',
    rules: [],
    requiresOutputs: ['requirement-breakdown.json'],
    produces: 'solution-design.json',
    prompt: `# Stage 2: Architecture Design

Based on the requirement breakdown, design the architecture:
1. File/directory structure (every file that will be created)
2. Module boundaries and data flow
3. Component design (interfaces, types, key functions)
4. Dependency graph (what depends on what)
5. Build/dev/test scripts

Output a JSON file at the artifacts path with:
{
  "structure": [{ "path": "", "purpose": "" }],
  "modules": [{ "name": "", "responsibility": "", "dependencies": [] }],
  "dataFlow": "",
  "buildScripts": { "dev": "", "build": "", "test": "" }
}`,
  },
  {
    id: '03-planning',
    name: 'Planning',
    emoji: '📋',
    description: 'Task decomposition into implementable chunks',
    rules: [],
    requiresOutputs: ['requirement-breakdown.json', 'solution-design.json'],
    produces: 'workflow-todolist.json',
    prompt: `# Stage 3: Task Planning

Decompose the architecture into ordered, implementable tasks:
1. Each task = one file or one logical unit to create/modify
2. Order by dependencies (foundational first)
3. Group into checkpoints (verifiable milestones)
4. Include verification for each checkpoint

Output a JSON file at the artifacts path with:
{
  "checkpoints": [
    {
      "id": "cp-01",
      "name": "",
      "tasks": [
        { "id": "task-001", "type": "create_file|generate_code|run_command", "target": "", "description": "" }
      ],
      "verification": "command to verify this checkpoint"
    }
  ]
}`,
  },
  {
    id: '04-codegen',
    name: 'Code Generation',
    emoji: '⚡',
    description: 'Generate all code — complete implementations only',
    rules: [],
    requiresOutputs: ['solution-design.json', 'workflow-todolist.json'],
    produces: null,
    prompt: `# Stage 4: Code Generation

Execute every task from the workflow todolist IN ORDER:
1. For each task: create/modify the file with COMPLETE, working code
2. No stubs, TODOs, placeholders, or "rest remains the same"
3. After each checkpoint's tasks: run the verification command
4. If verification fails: fix immediately, do not continue
5. Use Write for new files, Edit for modifications

Quality requirements:
- Full type safety (no 'any')
- Real error handling (catch specific errors)
- All imports resolved
- All functions complete`,
  },
  {
    id: '05-validate',
    name: 'Validate',
    emoji: '✅',
    description: 'Type-check, tests, lint — fix all issues',
    rules: [],
    requiresOutputs: [],
    produces: null,
    prompt: `# Stage 5: Validation

Run all verification:
1. Type-check: run the configured type checker (tsc --noEmit, etc.)
2. Tests: run the test suite (vitest, jest, pytest, etc.)
3. Build: run the build command to verify it compiles
4. If any step fails: FIX THE ISSUE immediately, then re-run
5. Do NOT move on until everything passes

Report what was checked and the results.`,
  },
  {
    id: '06-ship',
    name: 'Ship',
    emoji: '🚢',
    description: 'Git commit, build summary, next steps',
    rules: [],
    requiresOutputs: [],
    produces: null,
    prompt: `# Stage 6: Ship

Final steps:
1. Run final build to confirm everything works
2. Run git status to see all changes
3. Create a meaningful git commit with all changes
4. Report a summary:
   - Files created/modified (count and list)
   - Key features implemented
   - How to run/test the project
   - Known limitations or next steps

Do NOT push to remote — just commit locally.`,
  },
];

// ─── Workflow State ────────────────────────────────────

interface WorkflowState {
  appName: string;
  mode: 'create' | 'change';
  description: string;
  currentStage: string;
  stages: Record<string, { status: 'pending' | 'in_progress' | 'completed'; outputFile: string | null }>;
  createdAt: string;
  updatedAt: string;
}

function getWorkflowDir(cwd: string, appName: string): string {
  return join(cwd, '.pcc', 'workflow', appName);
}

function getWorkflowPath(cwd: string, appName: string): string {
  return join(getWorkflowDir(cwd, appName), 'workflow.json');
}

function loadWorkflow(cwd: string, appName: string): WorkflowState | null {
  const path = getWorkflowPath(cwd, appName);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as WorkflowState;
  } catch {
    return null;
  }
}

function saveWorkflow(cwd: string, appName: string, state: WorkflowState): void {
  const dir = getWorkflowDir(cwd, appName);
  mkdirSync(join(dir, 'outputs'), { recursive: true });
  state.updatedAt = new Date().toISOString();
  writeFileSync(getWorkflowPath(cwd, appName), JSON.stringify(state, null, 2));
}

function createWorkflow(appName: string, description: string): WorkflowState {
  const stages: WorkflowState['stages'] = {};
  for (const stage of CREATION_STAGES) {
    stages[stage.id] = { status: 'pending', outputFile: stage.produces };
  }
  return {
    appName,
    mode: 'create',
    description,
    currentStage: CREATION_STAGES[0]!.id,
    stages,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ─── Skill Definition ──────────────────────────────────

export const vibeSkill: Skill = {
  name: 'vibe',
  description: 'Generate a complete project using the 6-stage Vibe Workflow (OpenRoom pattern). Supports resume and checkpoint.',
  category: 'workflow',
  triggers: [
    { type: 'command', command: 'vibe' },
    { type: 'pattern', regex: /^\/vibe\s+(.+)/i },
  ],

  async execute(ctx: SkillContext): Promise<SkillResult> {
    // Parse: /vibe AppName [description] [--from=stage]
    const rawArgs = ctx.args.trim();
    if (!rawArgs) {
      return {
        type: 'error',
        message: `Usage: /vibe <AppName> <description>
  /vibe <AppName>                    — resume from breakpoint
  /vibe <AppName> --from=04-codegen  — re-run from specific stage
Example: /vibe TaskAPI A REST API for managing tasks with auth`,
      };
    }

    const parts = rawArgs.split(/\s+/);
    const appName = parts[0]!;
    let fromStage: string | null = null;
    const descParts: string[] = [];

    for (let i = 1; i < parts.length; i++) {
      const part = parts[i]!;
      if (part.startsWith('--from=')) {
        fromStage = part.slice(7);
      } else {
        descParts.push(part);
      }
    }

    const description = descParts.join(' ');
    const existing = loadWorkflow(ctx.cwd, appName);

    // ── Mode determination (OpenRoom pattern) ──
    let workflow: WorkflowState;

    if (!existing && !description) {
      return { type: 'error', message: `No existing workflow for "${appName}". Provide a description: /vibe ${appName} <description>` };
    }

    if (!existing) {
      // Creation mode
      workflow = createWorkflow(appName, description);
      saveWorkflow(ctx.cwd, appName, workflow);
      ctx.info(`\n🌊 Vibe Workflow — creating "${appName}"`);
      ctx.info(`Vision: ${description}\n`);
    } else if (!description && !fromStage) {
      // Resume mode
      workflow = existing;
      ctx.info(`\n🌊 Vibe Workflow — resuming "${appName}" from ${workflow.currentStage}`);
    } else if (fromStage) {
      // Re-run from specific stage
      workflow = existing;
      const stageIds = CREATION_STAGES.map(s => s.id);
      const fromIdx = stageIds.indexOf(fromStage);
      if (fromIdx === -1) {
        return { type: 'error', message: `Unknown stage: ${fromStage}. Valid: ${stageIds.join(', ')}` };
      }
      // Reset this stage and all following to pending
      for (let i = fromIdx; i < stageIds.length; i++) {
        const stageState = workflow.stages[stageIds[i]!];
        if (stageState) stageState.status = 'pending';
      }
      workflow.currentStage = fromStage;
      saveWorkflow(ctx.cwd, appName, workflow);
      ctx.info(`\n🌊 Vibe Workflow — re-running "${appName}" from ${fromStage}`);
    } else {
      // All completed + new description → would be change mode
      // For simplicity, create a fresh workflow
      workflow = createWorkflow(appName, description);
      saveWorkflow(ctx.cwd, appName, workflow);
      ctx.info(`\n🌊 Vibe Workflow — fresh run for "${appName}"`);
      ctx.info(`Vision: ${description}\n`);
    }

    // ── Stage execution loop ──
    const outputsDir = join(getWorkflowDir(ctx.cwd, appName), 'outputs');

    for (const stage of CREATION_STAGES) {
      const stageState = workflow.stages[stage.id];
      if (!stageState || stageState.status === 'completed') continue;

      // Mark in_progress
      stageState.status = 'in_progress';
      workflow.currentStage = stage.id;
      saveWorkflow(ctx.cwd, appName, workflow);

      ctx.info(`\n${'─'.repeat(50)}`);
      ctx.info(`${stage.emoji} Stage ${stage.id}: ${stage.name} — ${stage.description}`);
      ctx.info(`${'─'.repeat(50)}\n`);

      // Load required outputs from previous stages
      let context = `Project: ${appName}\nDescription: ${workflow.description}\n\n`;

      for (const outputFile of stage.requiresOutputs) {
        const outputPath = join(outputsDir, outputFile);
        if (existsSync(outputPath)) {
          try {
            const content = readFileSync(outputPath, 'utf-8');
            context += `\n--- ${outputFile} ---\n${content.slice(0, 5000)}\n`;
          } catch {
            // Skip unreadable outputs
          }
        }
      }

      // Build the full prompt: stage instructions + context + artifact path
      const artifactInfo = stage.produces
        ? `\nSave the artifact to: ${join(outputsDir, stage.produces)}`
        : '';

      const fullPrompt = `${stage.prompt}\n\n## Project Context\n${context}${artifactInfo}`;

      try {
        const result = await ctx.runAgent(fullPrompt);

        // Validate artifact if this stage produces one
        if (stage.produces) {
          const artifactPath = join(outputsDir, stage.produces);
          if (!existsSync(artifactPath)) {
            stageState.status = 'pending';
            saveWorkflow(ctx.cwd, appName, workflow);
            ctx.error(`  ✗ ${stage.name}: expected artifact not found — ${stage.produces}`);
            ctx.info(`  Re-run with: /vibe ${appName} --from=${stage.id}`);
            return { type: 'error', message: `Stage ${stage.id} did not produce: ${stage.produces}` };
          }
          if (stage.produces.endsWith('.json')) {
            try {
              JSON.parse(readFileSync(artifactPath, 'utf-8'));
            } catch (parseErr) {
              stageState.status = 'pending';
              saveWorkflow(ctx.cwd, appName, workflow);
              const parseMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
              ctx.error(`  ✗ ${stage.name}: invalid JSON artifact — ${parseMsg}`);
              ctx.info(`  Re-run with: /vibe ${appName} --from=${stage.id}`);
              return { type: 'error', message: `Stage ${stage.id} artifact invalid JSON: ${parseMsg}` };
            }
          }
        }

        // Mark completed only after validation passes
        stageState.status = 'completed';
        saveWorkflow(ctx.cwd, appName, workflow);
        ctx.info(`  ✓ ${stage.name} complete`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        ctx.error(`  ✗ ${stage.name} failed: ${msg}`);
        ctx.info(`  Resume with: /vibe ${appName}`);
        ctx.info(`  Re-run from here with: /vibe ${appName} --from=${stage.id}`);
        saveWorkflow(ctx.cwd, appName, workflow);
        return { type: 'error', message: `Vibe Workflow failed at ${stage.id}: ${msg}` };
      }
    }

    ctx.info(`\n╔══════════════════════════════════════════════╗`);
    ctx.info(`║  🌊 Vibe Workflow Complete: ${appName.padEnd(18)}║`);
    ctx.info(`╚══════════════════════════════════════════════╝`);
    ctx.info(`Artifacts: ${outputsDir}`);

    return { type: 'handled' };
  },
};
