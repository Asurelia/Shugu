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
/vibe MyApp           # Start new workflow
/vibe MyApp --from=04 # Resume from stage 04
```

### Stages
1. **01-analysis** — Parse requirements, identify users, list features
2. **02-architecture** — Design file structure, module boundaries, data flow
3. **03-planning** — Task decomposition into checkpoints
4. **04-codegen** — Execute all tasks with complete code
5. **05-validate** — Type-check, tests, lint — fix all issues
6. **06-ship** — Git commit, build summary, next steps

State persisted in `.pcc/workflow/{AppName}/workflow.json`.

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
  { task: "Search frontend code", agentType: "explore" },
  { task: "Search backend code", agentType: "explore" },
]);
```

### Chain Delegation
```typescript
import { delegateChain } from './agents/delegation.js';
const result = await delegateChain(orchestrator, [
  { task: "Find the bug", agentType: "explore" },
  { task: "Fix the bug based on findings", agentType: "code" },
  { task: "Write tests for the fix", agentType: "test" },
]);
```

## Strategic Brain

### How It Works
1. User types input
2. `analyzeTask()` classifies complexity (heuristic → LLM fallback)
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
> /bg "Monitor CI and fix failures"     # Runs in background
> /bg list                               # Show running sessions
> /bg attach bg-1                        # See live output
> /bg kill bg-1                          # Stop session
```

### Proactive Mode
```
> /proactive "Keep improving test coverage until 80%"
```
Agent loops autonomously, checks progress each iteration, stops when goal achieved or max iterations reached.

### Scheduled Jobs
```
> /schedule add "0 */6 * * *" "Run security audit"   # Every 6 hours
> /schedule list                                       # Show all jobs
> /schedule run job-1                                  # Manual trigger
```

### Recurring Loops
```
> /loop 5m check CI status     # Every 5 minutes
> /loop 1h run tests           # Every hour
> /loop list                   # Show active loops
> /loop stop loop-1            # Stop a loop
```

## Hook System

### Hook Lifecycle
```
User Request → [PreToolUse] → Tool Execution → [PostToolUse] → Result
                    |                                |
               Can BLOCK                       Can MODIFY
               Can MODIFY input                result content
```

### Built-in Hook Pipeline
```
Priority 5:  Path Safety      — Block .env writes, normalize paths
Priority 10: Secret Scanner   — Detect credentials in output
Priority 40: Verification     — Auto-typecheck .ts/.tsx after Write/Edit
Priority 80: Anti-Laziness    — Detect TODO/stub in written code
Priority 90: Knowledge Hook   — Auto-extract memories to vault
```

## Memory System

### Dual Storage
Memories are saved to TWO locations:
1. **`.pcc/memory/`** — Local project memories (loaded every startup)
2. **Obsidian vault** — If configured, also saved as vault notes

### Memory Sources
- **Post-turn intelligence**: Automatic extraction after each model response
- **Knowledge hook**: Pattern detection in messages ("remember that...", "I'm a...")
- **Manual**: `/memory save <title>` command

### Memory Loading
At startup, `buildSystemPrompt()`:
1. Reads all `.md` files from `~/.pcc/memory/` (global)
2. Reads all `.md` files from `.pcc/memory/` (project-local)
3. Formats and injects into system prompt

## KAIROS Time Awareness

### Events
| Event | Trigger | Action |
|-------|---------|--------|
| Away Summary | >10min idle between inputs | Show welcome back message |
| Break Suggestion | >45min active work | Suggest taking a break |
| Time Context | Every 5 turns | Inject `[TIME: ...]` into system prompt |
| Session Summary | /quit | Display duration, turns, topics |

## Obsidian Integration

### Vault Discovery (priority order)
1. `PCC_OBSIDIAN_VAULT` environment variable
2. `.pcc/vault.path` file in project
3. Check if cwd is a vault (has `.obsidian/`)
4. Common locations: `~/Obsidian`, `~/Documents/Obsidian`

### Operations (11)
search, read, save, update, delete, archive, list, tags, recent, ingest, lint

### Vault Maintenance (auto, on startup)
- Create `.schema.md` convention file
- Archive notes untouched > 30 days
- Generate weekly digests
