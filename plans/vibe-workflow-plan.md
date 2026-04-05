# Plan: Port Vibe Workflow + Dynamic Tool Discovery + Action Protocol + contextCollapse Fix

## Context

After making MiniMax M2.7 a first-class provider (committed), we now need to:
1. **Fix contextCollapse** — ✅ DONE (committed `d24285f`)
2. **Port OpenRoom's Vibe Workflow** — Multi-stage project generation via `/vibe`
3. **Dynamic Tool Discovery** — `meta.yaml` manifests for project-specific tools
4. **Action Protocol** — Structured tool tracking with ActionTriggerBy

---

## 1. Vibe Workflow — `/vibe` Slash Command

### Architecture

OpenRoom's Vibe Workflow is a **state machine orchestrator** with 10 stages (6 create + 4 change), frontmatter-declared dependencies, and `workflow.json` for persistence. We adapt it from "UI app generation" to "coding project generation".

### File Structure

```
.claude/skills/vibe/
├── SKILL.md                          ← /vibe entry (orchestrator)
└── workflow/
    ├── stages/
    │   ├── 01-analysis.md            ← Requirements analysis
    │   ├── 02-architecture.md        ← Technical architecture
    │   ├── 03-planning.md            ← Task breakdown
    │   ├── 04-codegen.md             ← Code generation
    │   ├── 05-testing.md             ← Test generation (replaces assets)
    │   ├── 06-integration.md         ← Build verification & docs
    │   ├── 01-change-analysis.md     ← Change impact analysis
    │   ├── 02-change-planning.md     ← Change task planning
    │   ├── 03-change-codegen.md      ← Incremental implementation
    │   └── 04-change-verification.md ← Change verification
    └── rules/
        ├── code-standards.md         ← Language/framework conventions
        ├── testing-strategy.md       ← Test patterns & coverage
        ├── project-structure.md      ← File organization rules
        └── post-task-check.md        ← Post-modification checklist
```

State persists in `.claude/thinking/{ProjectName}/workflow.json`.
Artifacts flow between stages via `.claude/thinking/{ProjectName}/outputs/`.

### SKILL.md Content (Orchestrator)

The orchestrator is a **single SKILL.md** that contains the full state machine logic. When invoked as `/vibe ProjectName description...`, it:

1. Parses arguments: `{ProjectName} [description] [--from=XX]`
2. Reads/creates `.claude/thinking/{ProjectName}/workflow.json`
3. Determines mode: **create** (new project), **change** (modify existing), **resume** (continue interrupted)
4. For each pending stage:
   a. Reads the stage's SKILL.md from `workflow/stages/`
   b. Loads `requires_rules` from `workflow/rules/`
   c. Loads `requires_outputs` artifacts from previous stages
   d. Executes the stage instructions
   e. Saves artifacts to `outputs/`
   f. Updates `workflow.json` (current stage → completed, next → in_progress)
5. Outputs completion report

### Key Adaptations from OpenRoom

| OpenRoom | Shugu |
|----------|-------|
| UI app generation | Coding project generation |
| `05-assets.md` (image generation) | `05-testing.md` (test generation) |
| `app-definition.md` (iframe lifecycle) | `code-standards.md` (language conventions) |
| `responsive-layout.md` (CSS rules) | `project-structure.md` (file organization) |
| `design-tokens.md` (colors/spacing) | Removed (not relevant) |
| `data-interaction.md` (Action API) | Removed (not relevant for codegen) |
| `meta-yaml.md` (app manifest) | Kept but adapted for project tool manifests |
| `guide-md.md` (user guide) | Kept but adapted for project README |
| `concurrent-execution.md` (batch ops) | Removed (handled by Shugu natively) |

### Stage Contents (Create Mode)

**01-analysis**: Role = product architect. Analyze requirements, research similar projects, define scope boundaries, identify tech stack, define data models. Output: `requirement-breakdown.json`.

**02-architecture**: Role = senior architect. Design system architecture, component hierarchy, API contracts, data flow, error handling strategy. Output: `solution-design.json`.

**03-planning**: Role = project manager. Break architecture into ordered tasks with dependencies. Define checkpoints. Output: `workflow-todolist.json`.

**04-codegen**: Role = senior developer. Execute tasks sequentially. Per-task verification (file exists, builds, imports valid). Checkpoint acceptance. No mocks/placeholders/TODOs.

**05-testing**: Role = QA engineer. Generate tests for all modules. Unit tests + integration tests. Coverage targets. Output: test files + `test-manifest.json`.

**06-integration**: Role = DevOps engineer. Verify build, run tests, generate README, verify all imports, clean unused dependencies.

### workflow.json Schema

```json
{
  "projectName": "MyProject",
  "mode": "create",
  "description": "User's requirement",
  "currentStage": "01-analysis",
  "stages": {
    "01-analysis":     { "status": "pending", "outputFile": "outputs/requirement-breakdown.json" },
    "02-architecture": { "status": "pending", "outputFile": "outputs/solution-design.json" },
    "03-planning":     { "status": "pending", "outputFile": "outputs/workflow-todolist.json" },
    "04-codegen":      { "status": "pending", "outputFile": null },
    "05-testing":      { "status": "pending", "outputFile": "outputs/test-manifest.json" },
    "06-integration":  { "status": "pending", "outputFile": null }
  },
  "createdAt": "2026-04-05T...",
  "updatedAt": "2026-04-05T..."
}
```

---

## 2. Dynamic Tool Discovery via meta.yaml

### Concept

Projects can define a `shugu-tools.yaml` (or `meta.yaml`) at their root describing project-specific tools the agent can use. The agent reads this at startup and registers them dynamically.

### Implementation

This is a **later phase** after the Vibe Workflow is working. The key idea from OpenRoom:
- `meta.yaml` files describe available actions with typed parameters
- `loadActionsFromMeta()` reads them at runtime
- A generic `project_action` tool wraps all discovered actions

For Shugu, this would mean a project can define custom bash scripts, API endpoints, or data queries as tools the agent discovers automatically.

### Deferred — implement after Vibe Workflow proves the stage pipeline works.

---

## 3. Action Protocol

### Concept

Add `ActionTriggerBy` tracking to tool executions so the agent knows whether an action was triggered by the user, the agent itself, or the system.

### Implementation

Lightweight — add to the existing tool execution layer:
- `ActionTriggerBy` enum in `src/services/tools/toolExecution.ts`
- Track in tool result metadata
- No IPC/iframe complexity from OpenRoom

### Deferred — implement after Vibe Workflow.

---

## Verification

1. `/vibe TestProject A simple CLI calculator` — should create workflow.json and run through 6 stages
2. `/vibe TestProject` — should resume from last interrupted stage
3. `/vibe TestProject Add multiplication support` — should run change mode (4 stages)
4. `/vibe TestProject --from=04-codegen` — should re-run from codegen stage
5. All with `MINIMAX_API_KEY` set — verify MiniMax handles the multi-turn orchestration

## Implementation Order

1. Create the directory structure `.claude/skills/vibe/`
2. Write `SKILL.md` (orchestrator) — the full state machine
3. Write all 10 stage files with adapted content for coding projects
4. Write 4 rule files
5. Test with MiniMax via `/vibe`
