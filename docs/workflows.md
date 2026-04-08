# Shugu Workflows & Agents

## Session Workflow

### New Project Setup
```bash
cd my-project
shugu              # Start REPL
> /init             # Generates SHUGU.md + .pcc/
> /doctor           # Verify everything is connected
```

### Resume a Session
```bash
shugu --continue    # Resume last session in this directory
shugu --resume      # Pick from recent sessions
shugu --resume=abc  # Resume specific session
```

Inside a session:
```
> /resume           # Show session picker
> /resume abc123    # Load specific session
```

### Export & Rewind
```
> /export review.md    # Save conversation to file
> /rewind              # Undo last turn
> /rewind 3            # Undo last 3 turns
```

## Vibe Workflow (6-Stage)

The `/vibe` skill implements a complete project generation workflow:

```
/vibe MyApp A REST API for managing tasks    # Start new workflow
/vibe MyApp                                   # Resume from breakpoint
/vibe MyApp --from=04-codegen                 # Re-run from specific stage
```

### Stages
1. **01-analysis** -- Parse requirements, identify users, list features, determine tech stack. Produces `requirement-breakdown.json`.
2. **02-architecture** -- Design file structure, module boundaries, data flow, dependency graph. Produces `solution-design.json`. Requires: requirement-breakdown.
3. **03-planning** -- Task decomposition into ordered checkpoints with verification commands. Produces `workflow-todolist.json`. Requires: requirement-breakdown + solution-design.
4. **04-codegen** -- Execute all tasks with complete code. No stubs or TODOs. Verify after each checkpoint. Requires: solution-design + workflow-todolist.
5. **05-validate** -- Type-check, tests, lint. Fix all issues before moving on.
6. **06-ship** -- Git commit, build summary, next steps report. Does NOT push to remote.

### Workflow State
State persisted in `.pcc/workflow/{AppName}/workflow.json`:
- `appName`, `mode` (create/change), `description`
- `currentStage` -- which stage is active
- Per-stage status: `pending`, `in_progress`, `completed`
- Timestamps: `createdAt`, `updatedAt`

Stage artifacts saved to `.pcc/workflow/{AppName}/outputs/`.

### Error Recovery
If a stage fails:
- The stage is reset to `pending`
- User sees the exact error
- Resume: `/vibe AppName`
- Re-run from specific stage: `/vibe AppName --from=04-codegen`
- JSON artifacts are validated (must parse) before marking a stage complete

## Agent Delegation

### Spawn Sub-Agents
The model decides when to spawn agents via the `Agent` tool:
```
Agent({ prompt: "Search for all TODO comments", subagent_type: "explore" })
```

### Parallel Delegation
```typescript
import { delegateParallel } from './agents/delegation.js';
const results = await delegateParallel(orchestrator, [
  { id: "frontend", prompt: "Search frontend code", agentType: "explore" },
  { id: "backend", prompt: "Search backend code", agentType: "explore" },
]);
// results.results: Map<string, AgentResult>
// results.totalCostUsd, results.allSucceeded
```

### Chain Delegation
```typescript
import { delegateChain } from './agents/delegation.js';
const results = await delegateChain(orchestrator, [
  { id: "find", prompt: "Find the bug", agentType: "explore" },
  { id: "fix", prompt: "Fix the bug based on findings", agentType: "code" },
  { id: "test", prompt: "Write tests for the fix", agentType: "test" },
]);
// Each step receives the previous step's result as context
// Chain stops if any step fails
```

### Agent Teams
Three built-in team templates:

```
> /team Refactor the auth module          # Default: explore -> code -> review (chain)
> /team --parallel Process all API routes # 3 parallel general workers
> /team --review Audit the security layer # 3 parallel reviewers (security/logic/arch)
> /team list                              # Show all templates with members
```

The review template auto-loads repo review rules from instruction files.

## Batch Execution (Worktree-Isolated)

### How It Works
1. `/batch <task>` sends the task to the model for decomposition
2. Model returns 2-15 independent units with non-overlapping file sets
3. Overlap detection prevents units that touch the same files
4. Each unit runs as a `code` agent in its own git worktree
5. Results are held in pending state for review

### Usage
```
> /batch Implement REST endpoints for users, posts, and comments

# Model decomposes into 3 units:
#   users-api: Implement user CRUD endpoints (files: src/routes/users.ts)
#   posts-api: Implement post CRUD endpoints (files: src/routes/posts.ts)
#   comments-api: Implement comment CRUD endpoints (files: src/routes/comments.ts)

# After completion:
> /batch status                     # See pending units with branch, turns, cost
> /batch merge users-api            # Merge worktree into base branch
> /batch merge posts-api            # Merge another
> /batch discard comments-api       # Discard if not needed
```

### Merge Conflict Handling
If a merge produces conflicts:
- The merge is aborted (no partial merges)
- Conflict files are listed
- User must resolve manually and retry

## Worktree Agent Isolation

### How Worktrees Work for Agents
When `isolation: 'worktree'` is set in spawn options:

1. **Create**: `git worktree add -b pcc-agent-{id} .pcc-worktrees/pcc-agent-{id}`
   - New branch from current HEAD
   - Worktree directory: `.pcc-worktrees/{branch}/`
2. **Execute**: Agent runs with `cwd` set to the worktree path
   - All file operations happen in the isolated worktree
   - No interference with the main workspace
3. **Merge**: On success, changes are committed in the worktree, then merged with `--no-ff` into the base branch
4. **Cleanup**: `git worktree remove --force` + `git branch -D` (with fallback to manual `rm -rf` + `git worktree prune`)

### Worktree API
```typescript
import { createWorktree, mergeWorktree, removeWorktree } from './agents/worktree.js';

const wt = await createWorktree(repoDir, 'pcc-agent');
// wt.path, wt.branch, wt.baseBranch

const merge = await mergeWorktree(repoDir, wt, 'commit message');
// merge.merged, merge.conflicts, merge.conflictFiles

const cleanup = await removeWorktree(repoDir, wt);
// cleanup.removed, cleanup.branchDeleted, cleanup.warnings
```

## Strategic Brain

### How It Works
1. User types input
2. `analyzeTask()` classifies complexity (heuristic -> LLM fallback)
3. Strategy hints injected into system prompt for THIS turn only
4. Model receives enriched context and plans accordingly

### Complexity Levels
| Level | Heuristic | Strategy | Reflection |
|-------|-----------|----------|------------|
| trivial | < 8 words, no action verbs | None | Never |
| simple | 1-2 action verbs | Basic tool hints | Every 5 turns |
| complex | 3+ action verbs or multi-step | Planning + agent routing | Every 3 turns |
| epic | Project-scale keywords | Full breakdown + sub-agents | Every 3 turns + 50% budget |

## Automation

### Background Sessions
```
> /bg "Monitor CI and fix failures"     # Runs in background (same process, concurrent)
> /bg list                               # Show running/completed sessions
> /bg attach bg-1                        # See live output (replays log buffer)
> /bg kill bg-1                          # Abort a running session
> /bg remove bg-1                        # Remove a completed session from list
```

Background sessions:
- Share the same Node.js process as the REPL
- Run the full agentic loop (model calls, tool execution, hooks)
- Maintain a log buffer (last 200 lines) for attach/review
- Track status: `running`, `completed`, `error`, `aborted`
- Report turns, cost, and final response

### Proactive Mode
```
> /proactive "Keep improving test coverage until 80%"
```
Agent loops autonomously with `[PROACTIVE MODE]` system injection. The agent uses its best judgment without asking for confirmation. Stops when:
- Goal achieved (agent says `[GOAL_ACHIEVED]`)
- Max turns/budget reached
- User sends `/proactive stop` or Ctrl+C

### Scheduled Jobs (Cron)
```
> /schedule add "0 */6 * * *" "Run security audit"     # Every 6 hours
> /schedule add "0 9 * * 1-5" "Check CI and report"    # Weekdays at 9am
> /schedule interval 300000 "Check for new issues"      # Every 5 minutes
> /schedule list                                         # Show all jobs with status
> /schedule run job-1                                    # Force-run immediately
> /schedule enable job-1                                 # Enable a disabled job
> /schedule disable job-1                                # Disable without removing
> /schedule remove job-1                                 # Delete a job
> /schedule start                                        # Start the scheduler tick
> /schedule stop                                         # Stop all scheduled execution
```

Cron expressions: 5-field format (minute hour day-of-month month day-of-week). Supports `*`, `/step`, and comma-separated values. The scheduler ticks every 60 seconds for cron jobs and starts interval timers immediately. Jobs have a `runCount`, `lastRunAt`, and optional `timeoutMs`. Jobs cannot overlap (skipped if already running).

### Recurring Loops
```
> /loop 5m check CI status     # Every 5 minutes
> /loop 1h run tests           # Every hour
> /loop 30s git status         # Every 30 seconds
> /loop list                   # Show active loops
> /loop stop loop-1            # Stop a specific loop
> /loop stop                   # Stop all loops
```

Loops run the first iteration immediately, then repeat on the interval. Each iteration spawns a full agent via `ctx.runAgent()`. Intervals: `Ns` (seconds), `Nm` (minutes), `Nh` (hours).

## Daemon Mode

### Overview
Daemon mode runs Shugu as a detached background process via `node child_process.fork()`. It enables agentic loops without a terminal attached.

### Features
- **Detached execution**: Child process is unref'd so parent can exit
- **Auto-restart**: Configurable restart on crash (max attempts + cooldown)
- **IPC communication**: JSON-lines protocol over `process.send()`
- **Heartbeat monitoring**: 30-second heartbeat to detect dead processes
- **PID tracking**: State file at `{stateDir}/daemon.json` for reconnection
- **Log persistence**: Append-only log at `{stateDir}/daemon.log`

### IPC Message Types
| Type | Direction | Purpose |
|------|-----------|---------|
| `prompt` | Parent -> Child | Send a prompt for execution |
| `status` | Both | Request/report status |
| `stop` | Parent -> Child | Graceful shutdown request |
| `result` | Child -> Parent | Execution result |
| `heartbeat` | Both | Liveness check |
| `log` | Child -> Parent | Log output |

### Daemon Lifecycle
```
DaemonController.start()
  -> fork(entrypoint, ['--daemon'], { detached: true })
  -> env: PCC_DAEMON=1, PCC_DAEMON_SOCKET=<path>
  -> Heartbeat monitoring (30s interval)
  -> Log stdout/stderr to daemon.log

DaemonController.stop()
  -> Send IPC 'stop' message
  -> Wait 5s for graceful shutdown
  -> SIGTERM -> SIGKILL if needed

DaemonController.isRunning(stateDir)
  -> Read daemon.json for PID
  -> process.kill(pid, 0) to check existence
```

### Auto-Restart Configuration
```typescript
const daemon = new DaemonController({
  stateDir: '~/.pcc/daemon',
  entrypoint: './dist/cli.js',
  cwd: '/path/to/project',
  autoRestart: true,
  maxRestarts: 5,
  restartCooldownMs: 5000,
});
```

## KAIROS Time Awareness

### Events
| Event | Trigger | Action |
|-------|---------|--------|
| Away Summary | >10min idle between inputs | Show "Welcome back!" message with idle duration |
| Break Suggestion | >45min active work | Suggest taking a break (one-shot per session) |
| Time Context | Every 5 turns | Inject `[TIME: Session Xm elapsed, Ym active, Z turns]` into system prompt |
| Session Summary | /quit | Display duration, active time, turns, and recent topics |

### Active Time Tracking
- Idle periods > 2 minutes are excluded from active time
- Turn timestamps are recorded for all user inputs
- Session start time is captured at construction

## Meta-Harness Workflow

The Meta-Harness is an outer-loop optimizer that searches for better harness configurations by running candidates against a task dataset and using Pareto-optimal selection.

### Setup
```
> /meta init
# Creates:
#   harnesses/default/config.yaml   -- Base harness config
#   ~/.pcc/meta/datasets/default.yaml -- Default evaluation dataset
```

### Optimization Run
```
> /meta run --gen=5 --candidates=2 --repeat=1

# Flow:
# 1. Load base config from harnesses/default/config.yaml
# 2. Load and split dataset (70% search / 30% holdout)
# 3. Evaluate baseline on search set
# 4. For each generation:
#    a. Select parents from Pareto frontier (top 3)
#    b. Proposer generates new candidate configs
#    c. Evaluate each candidate on search set
# 5. Report final Pareto frontier
```

### Evaluation and Promotion
```
> /meta status                     # Check progress
> /meta top 5                      # See best candidates
> /meta inspect gen2-abc123        # Detailed candidate report
> /meta diff baseline-xyz gen2-abc # Compare two configs
> /meta validate gen2-abc123       # Run on holdout set
> /meta promote gen2-abc123        # Promote to active (requires holdout >50%)
> /meta abort                      # Abort current run
```

### Architecture
- **MetaArchive**: Persists runs, candidates, and results to `~/.pcc/meta/`
- **MetaEvaluator**: Runs candidates against task datasets (configurable repeat count, aggregation, temperature, budget cap)
- **MetaProposer**: Uses the model + parent candidates to propose new configurations
- **Selector**: Computes Pareto frontier across objectives (accuracy, cost, tokens, turns, error rate), ranks by weighted score
- **Non-interactive runtime** (`bootstrapMeta`): Full pipeline without TTY (vault via env var, fullAuto permissions, auto-accept plugins)

### Runtime (`bootstrapMeta`)
Replicates the full REPL bootstrap pipeline in headless mode:
- Client with harness config overrides (temperature, maxTokens)
- Credential vault via `PCC_VAULT_PASSWORD` env var (no TTY prompt)
- Tool registry, permissions (fullAuto), plugins (auto-accept local)
- Behavior hooks + verification hook
- Agent orchestrator with harness-overridden agent profiles
- System prompt built from SHUGU.md + harness config
- LoopConfig with harness limits (maxTurns, maxBudgetUsd, toolTimeoutMs, reflectionInterval)

## Plugin Development Workflow

### Plugin Structure
```
my-plugin/
  plugin.json       # Manifest (name, version, description, entry, hooks, permissions)
  index.ts          # Entry point exporting a PluginInit function
  .data/            # Plugin-managed data directory
```

### plugin.json Manifest
```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "What this plugin does",
  "entry": "index.js",
  "hooks": ["PreToolUse", "PostToolUse"],
  "permissions": ["bash", "files"],
  "author": "your-name"
}
```

### Plugin Init API
The entry file exports a default function (or named `init`) that receives a `PluginAPI`:
```typescript
export default async function init(api: PluginAPI) {
  api.registerTool(myCustomTool);
  api.registerCommand(myCommand);
  api.registerSkill(mySkill);
  api.registerHook('PostToolUse', myHookHandler, 50);
  const dataDir = api.getDataDir();
  api.log('Plugin loaded');
}
```

### Installation Locations
| Location | Trust Level | Confirmation |
|----------|-------------|-------------|
| `~/.pcc/plugins/` | Global (user-installed) | Auto-loaded, trusted |
| `.pcc/plugins/` | Local (repo-controlled) | Requires explicit user confirmation via `onConfirmLocal` callback |

### Plugin Loading Order
1. Discover plugin directories (global first, then local)
2. Read `plugin.json` manifest from each subdirectory
3. For local plugins: prompt user for trust confirmation
4. Dynamic import the entry file
5. Call the init function with the PluginAPI
6. Register tools, commands, skills, and hooks into the main registries

## Skill Creation Workflow

### Bundled vs Custom Skills
| Type | Location | Loading | Example |
|------|----------|---------|---------|
| Bundled | `src/skills/bundled/*.ts` | Compiled into PCC, imported directly | Vibe, Dream, Hunter, Loop, Schedule, Brain |
| External | `~/.pcc/skills/*.ts` | Dynamically imported at startup | User-created skills |

### Creating a Custom Skill

#### Via Generator
```
> /skill-create "deploy" "Deploy the current project to production with pre-checks"
# Creates ~/.pcc/skills/deploy.ts with proper structure
```

#### Manual Structure
```typescript
import type { Skill, SkillContext, SkillResult } from '../loader.js';

export const deploySkill: Skill = {
  name: 'deploy',
  description: 'Deploy the current project to production with pre-checks',
  category: 'automation',
  triggers: [
    { type: 'command', command: 'deploy' },
    { type: 'keyword', keywords: ['deploy to production'] },
  ],
  requiredTools: ['Bash', 'Read'],

  async execute(ctx: SkillContext): Promise<SkillResult> {
    const args = ctx.args.trim();
    // Access: ctx.cwd, ctx.messages, ctx.info(), ctx.error(), ctx.query(), ctx.runAgent()
    return { type: 'prompt', prompt: `Deploy with args: ${args}` };
  },
};
```

### Skill Context API
| Property/Method | Description |
|----------------|-------------|
| `ctx.input` | The user's full input that triggered the skill |
| `ctx.args` | Arguments extracted from the trigger match |
| `ctx.cwd` | Working directory |
| `ctx.messages` | Conversation history |
| `ctx.tools` | Available tools map |
| `ctx.info(msg)` | Display info to the user |
| `ctx.error(msg)` | Display error to the user |
| `ctx.query(prompt)` | Query the model directly (single turn) |
| `ctx.runAgent(prompt)` | Run a full agentic loop with the prompt |

### Skill Result Types
| Type | Effect |
|------|--------|
| `{ type: 'handled' }` | Skill handled everything, nothing more needed |
| `{ type: 'prompt', prompt: string }` | Inject prompt as a user message to the model |
| `{ type: 'error', message: string }` | Display error and stop |

## Credential Vault Workflow

### Setup
The credential vault uses AES-256 encryption and is stored in `~/.pcc/vault.db`. First use creates the vault:
```
> /vault add github
  # Guided prompts for each field (secrets are masked)
  # Asks for a label (e.g., "personal", "work")
  # Encrypted and stored
```

### Available Service Templates
Each service template defines required fields (some secret, some plain):
```
> /vault services
# Shows all templates with fields marked * for secret
```

### Operations
```
> /vault                        # Show status (locked/unlocked, path, credential count)
> /vault list                   # List all credentials (service, label, added date)
> /vault add <service>          # Add via guided prompts
> /vault remove <service> [label]  # Remove specific credential
> /vault change-password        # Re-encrypt with new password
```

### Auto-Unlock
In daemon and meta-harness modes, the vault auto-unlocks via `PCC_VAULT_PASSWORD` environment variable (no TTY prompt).

### Domain-Based Injection
Credentials have associated `domains`. When a tool call targets a URL matching a credential's domain, the credential provider can inject the appropriate auth headers or tokens automatically.

## Memory System

### Dual Storage
Memories are saved to TWO locations:
1. **`.pcc/memory/`** -- Local project memories (loaded every startup)
2. **Obsidian vault** -- If configured, also saved as vault notes

### Memory Sources
- **Post-turn intelligence**: Automatic extraction after each model response
- **Knowledge hook**: Pattern detection in messages ("remember that...", "I'm a...", "the decision is...")
- **Manual**: `/memory save <title>` command

### Memory Loading
At startup, `buildSystemPrompt()`:
1. Reads all `.md` files from `~/.pcc/memory/` (global)
2. Reads all `.md` files from `.pcc/memory/` (project-local)
3. Formats and injects into system prompt

## Obsidian Integration (Second Brain)

### Vault Discovery (priority order)
1. `PCC_OBSIDIAN_VAULT` environment variable
2. `.pcc/vault.path` file in project
3. Check if cwd is a vault (has `.obsidian/`)
4. Common locations: `~/Obsidian`, `~/Documents/Obsidian`

### Operations
| Command | Description |
|---------|-------------|
| `/brain search <query>` | Full-text content search (up to 8 results with preview) |
| `/brain read <title>` | Read a note, list its wikilinks |
| `/brain create <title>` | Create a note in `Agent/` folder with YAML frontmatter and wikilinks |
| `/brain daily` | Read or create today's daily note (`Daily Notes/YYYY-MM-DD.md`) |
| `/brain link <note>` | Follow wikilinks, build a knowledge graph summary |
| `/brain context` | Search vault for knowledge relevant to current conversation |
| `/brain zettel <concept>` | Create atomic Zettelkasten note in `Zettelkasten/` with unique ID |
| `/brain tags [tag]` | List all tags (sorted by frequency) or filter notes by tag |
| `/brain recent [days]` | Show recently modified notes (default: 7 days) |

### Auto-Extraction (Knowledge Hook)
The built-in knowledge hook detects memory-worthy patterns in assistant messages:
- "Remember that..."
- "I'm a..."
- "The decision is..."

Detected hints are saved to the Obsidian vault as auto-extracted notes with tags `[<type>, auto-extracted]`. This is fire-and-forget (silent on failure).

### Vault Maintenance (auto, on startup)
- Create `.schema.md` convention file
- Archive notes untouched > 30 days
- Generate weekly digests

## Hook System

### Hook Lifecycle
```
User Request -> [PreToolUse] -> Tool Execution -> [PostToolUse] -> Result
                    |                                |
               Can BLOCK                       Can MODIFY
               Can MODIFY input                result content

Assistant Message -> [OnMessage] -> (memory extraction, vault save)
```

### PreToolUse Result Options
| Field | Type | Effect |
|-------|------|--------|
| `proceed` | `boolean` | `false` blocks the tool call entirely |
| `blockReason` | `string` | Reason shown when blocking |
| `modifiedCall` | `object` | Replace the tool call input (e.g., normalize paths) |

### PostToolUse Result Options
| Field | Type | Effect |
|-------|------|--------|
| `modifiedResult` | `object` | Replace the tool result content (e.g., append warnings) |

### Built-in Hook Pipeline
```
Priority 5:  Path Safety        -- Block .env writes, normalize paths, fix Bash commands
Priority 10: Secret Scanner     -- Detect credentials in Bash/WebFetch output
Priority 40: Verification Agent -- Auto-typecheck .ts/.tsx after Write/Edit
Priority 80: Anti-Laziness      -- Detect TODO/stub in written code
Priority 90: Knowledge Hook     -- Auto-extract memories from assistant messages to vault
```

### Custom Hooks via Plugins
```typescript
api.registerHook('PostToolUse', async (payload) => {
  // payload.tool, payload.call, payload.result
  if (payload.tool === 'Bash') {
    // Inspect or modify the result
    return { modifiedResult: { ...payload.result, content: '...' } };
  }
  return {};
}, 50); // priority 50
```
