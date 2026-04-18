# Shugu Commands & Features Reference

## CLI Flags

| Flag | Short | Description |
|------|-------|-------------|
| `--continue` | `-c` | Resume most recent session for current directory |
| `--resume` | `-r` | Interactive session picker |
| `--resume=<id>` | | Resume specific session by ID |
| `--mode=<mode>` | | Set permission mode (plan/default/accept-edits/auto/bypass) |
| `--bypass` | | Shorthand for --mode=bypass |
| `--daemon` | | Start in daemon mode (detached background process) |
| `--help` | `-h` | Show help |

## Slash Commands (30)

### Session & Context

| Command | Aliases | Description |
|---------|---------|-------------|
| `/help` | `/h`, `/?` | Show available commands |
| `/quit` | `/exit`, `/q` | Exit the session |
| `/clear` | | Clear conversation history |
| `/compact` | | Summarize older turns to save context |
| `/context` | | Show context window usage (tokens, budget) |
| `/cost` | | Show token usage and cost |
| `/resume [id]` | `/continue` | Resume a previous session or show picker |
| `/export [file]` | | Export conversation to markdown file |
| `/rewind [N]` | `/undo` | Remove last N turn pairs (default: 1) |
| `/thinking` | | Toggle expanded thinking display |
| `/expand` | | Dump full conversation transcript |

### Project & Setup

| Command | Aliases | Description |
|---------|---------|-------------|
| `/init` | `/setup` | Initialize project (SHUGU.md + .pcc/ directory) |
| `/doctor` | `/health`, `/diag` | Run 10-point diagnostic health check |
| `/status` | `/st` | Show git status and project info |
| `/commit [msg]` | | Generate commit message or commit staged changes |
| `/review` | | Review code changes with 3 parallel specialist agents (security, logic, architecture) |
| `/socratic [--scope diff\|feature\|full] [--topic <n>]` | | Rodin-style adversarial review (read-only). Writes to `.pcc/rodin/YYYY-MM-DD-HHMMSS-<scope>-<slug>.md` and appends metrics to `.pcc/rodin/metrics.jsonl`. |
| `/finish-feature` | | Verify branch is clean, run `/socratic --scope diff`, then merge `--no-ff` into main on user confirmation. Never pushes. Blocks on any `✗ Faux`. |
| `/diff` | | Show git diff with colors (truncated at 100 lines) |

### Configuration

| Command | Aliases | Description |
|---------|---------|-------------|
| `/mode <mode>` | | Change permission mode (plan/default/accept-edits/auto/bypass) |
| `/model [name]` | | Show or change active model (accepts tier aliases: best, balanced, fast) |
| `/fast` | | Toggle between best and fast model (M2.5-highspeed) |

### Observability

| Command | Aliases | Description |
|---------|---------|-------------|
| `/trace [id]` | `/traces` | Show recent trace events or detail for a specific trace |
| `/health` | `/stats`, `/dashboard` | Show session health dashboard (model calls, tool calls, agent spawns, errors, tokens, tool usage bar chart) |

### Memory & Knowledge

| Command | Aliases | Description |
|---------|---------|-------------|
| `/memory` | `/mem` | Show vault summary |
| `/memory search <query>` | `/memory s` | Search Obsidian vault notes |
| `/memory save <title>` | | Save a note to Obsidian vault |
| `/memory recent [days]` | `/memory r` | Show recently modified notes (default: 7 days) |
| `/memory tags <tag>` | `/memory t` | Show notes with a specific tag |

### Credential Vault

| Command | Aliases | Description |
|---------|---------|-------------|
| `/vault` | `/creds` | Show credential vault status (locked/unlocked, path, count) |
| `/vault list` | `/vault ls` | List stored credentials (service, label, added date) |
| `/vault add <service>` | | Add a credential via guided prompts (shows available services if no arg) |
| `/vault remove <service> [label]` | `/vault rm` | Remove a credential |
| `/vault change-password` | `/vault passwd` | Change vault encryption password |
| `/vault services` | | List all available service templates with field details |

### Agent Teams

| Command | Aliases | Description |
|---------|---------|-------------|
| `/team <task>` | | Run task with default team (explore -> code -> review chain) |
| `/team --parallel <task>` | | Run task with 3 parallel general workers |
| `/team --review <task>` | | Run 3-way parallel code review (security, logic, architecture) |
| `/team list` | | List available team templates with members |

### Batch Execution

| Command | Aliases | Description |
|---------|---------|-------------|
| `/batch <task>` | | Decompose task into 2-15 parallel worktree-isolated units via the model |
| `/batch status` | | Show pending batch units with branch, turns, and cost |
| `/batch merge <name>` | | Merge a completed unit's worktree changes into the base branch |
| `/batch discard <name>` | | Discard a unit's worktree and delete its branch |

### Automation

| Command | Aliases | Description |
|---------|---------|-------------|
| `/bg <prompt>` | `/background` | Start a background session |
| `/bg list` | `/bg ls` | Show running/completed background sessions |
| `/bg attach <id>` | | Attach to a session's live output |
| `/bg kill <id>` | `/bg stop` | Abort a running session |
| `/bg remove <id>` | `/bg rm` | Remove a completed/aborted session from the list |
| `/proactive <goal>` | `/auto` | Start autonomous goal-pursuit mode (agent loops until goal achieved) |
| `/proactive stop` | | Stop proactive mode |

### Meta-Harness (Optimization)

| Command | Aliases | Description |
|---------|---------|-------------|
| `/meta init` | `/mh init` | Initialize harness structure + default dataset |
| `/meta run [opts]` | | Start an optimization run (`--gen=N`, `--candidates=N`, `--repeat=N`, `--dataset=path`) |
| `/meta resume [id]` | | Resume a paused/interrupted run |
| `/meta status` | | Show current run status (generation, candidates, cost, best) |
| `/meta top [N]` | | Show top N candidates ranked by weighted score (default: 5) |
| `/meta inspect <id>` | | Detailed candidate report with per-task results |
| `/meta diff <a> <b>` | | Diff two candidate configs side by side |
| `/meta validate <id>` | | Evaluate a candidate on the holdout set |
| `/meta promote <id>` | | Promote a validated candidate to `harnesses/active/config.yaml` (requires holdout validation with >50% success) |
| `/meta abort` | | Abort the current optimization run |

### Companion

| Command | Aliases | Description |
|---------|---------|-------------|
| `/buddy` | `/pet` | Show companion sprite |
| `/buddy card` | `/buddy info`, `/buddy stats` | Show companion stats card |
| `/buddy pet` | | Pet your companion |
| `/buddy name <n>` | | Rename companion |
| `/buddy mute` | | Mute companion reactions |
| `/buddy unmute` | | Unmute companion |

## Bundled Skills (7 + Generator)

### Workflow

| Skill | Triggers | Description |
|-------|----------|-------------|
| **vibe** | `/vibe <AppName> <description>` | 6-stage project generation workflow (analysis, architecture, planning, codegen, validate, ship). Supports resume (`/vibe AppName`) and re-run from stage (`/vibe AppName --from=04-codegen`). State persisted in `.pcc/workflow/{AppName}/workflow.json`. |

### Analysis

| Skill | Triggers | Description |
|-------|----------|-------------|
| **dream** | `/dream [focus]` | Read-only codebase exploration mode. The agent freely investigates the codebase, identifies patterns, and generates insights. Focus areas: architecture, performance, security. Insights auto-extracted as memory statements. |
| **hunter** | `/hunt [target]`, `/bughunter` | Systematic bug, security, and code quality scanner. Generates severity-rated report (CRITICAL/HIGH/MEDIUM/LOW) with file:line references and fix suggestions. Target: directory, file path, or focus area like "security". |

### Automation

| Skill | Triggers | Description |
|-------|----------|-------------|
| **loop** | `/loop <interval> <prompt>` | Recurring interval execution. Intervals: `30s`, `5m`, `1h`. Subcommands: `list` (show active), `stop [id]` (stop one or all). Runs first iteration immediately, then repeats. |
| **schedule** | `/schedule`, `/cron` | Cron-based and interval job scheduling. Subcommands: `add "<cron>" "<prompt>"`, `interval <ms> "<prompt>"`, `list`, `remove <id>`, `run <id>`, `enable/disable <id>`, `start`, `stop`. Uses a tick-based in-process scheduler (60s tick for cron). |

### Knowledge

| Skill | Triggers | Description |
|-------|----------|-------------|
| **brain** | `/brain`, `/obsidian`, `/note` | Deep Obsidian vault integration. Subcommands: `search`, `read`, `create`, `daily`, `link` (graph navigation), `context` (find vault knowledge relevant to conversation), `zettel` (Zettelkasten atomic notes), `tags`, `recent`. Also triggered by keywords: "second brain", "obsidian vault", "my notes". |

### Utility

| Skill | Triggers | Description |
|-------|----------|-------------|
| **skill-create** | `/skill-create`, `/create-skill` | Generate a new custom skill from a name and description. Creates a properly structured `.ts` file in `~/.pcc/skills/` with imports, triggers, execute function, and documentation. Usage: `/skill-create "name" "description"`. |

### Skill Categories

| Category | Purpose | Examples |
|----------|---------|---------|
| `workflow` | Multi-step generation pipelines | Vibe |
| `analysis` | Code analysis, review, exploration | Dream, Hunter |
| `automation` | Recurring/proactive tasks | Loop, Schedule |
| `knowledge` | Second brain, Obsidian, memory | Brain |
| `utility` | One-shot utilities | Skill-create |
| `custom` | User-defined skills | Loaded from `~/.pcc/skills/` |

### Skill Trigger Types

| Type | Syntax | Example |
|------|--------|---------|
| `command` | Matches `/skillname` exactly | `{ type: 'command', command: 'vibe' }` |
| `keyword` | Matches if any keyword is present in input | `{ type: 'keyword', keywords: ['second brain'] }` |
| `pattern` | Matches a regex against input | `{ type: 'pattern', regex: /^\/vibe\s+(.+)/i }` |
| `always` | Always active, injected into prompt | `{ type: 'always' }` |

## Agent Types

| Type | Allowed Tools | Max Turns | Role Description |
|------|--------------|-----------|------------------|
| `general` | All (except Agent at depth > 0) | 15 | Default sub-agent. Full capability, best judgment, no clarifying questions. |
| `explore` | Read, Glob, Grep, Bash | 10 | Code exploration only. Search, read, understand. No file modifications. Structured summary output. |
| `code` | All | 20 | Coding agent. Read before modify, Edit for changes, Write for new files. Tests changes. |
| `review` | Read, Glob, Grep, Bash | 10 | Code review only. No file modifications. Specific actionable feedback with file paths and line references. |
| `socratic` | Read, Glob, Grep, Bash (denylist on mutations) | 25 | Rodin-style adversarial reviewer. Five-label taxonomy (✓/~/⚡/◐/✗), mandatory file:line citations, banned hedge phrases. Invoked by `/socratic`. |
| `test` | All | 15 | Testing agent. Write and run tests, report pass/fail status. |

### Agent Teams (Templates)

| Template | Mode | Members |
|----------|------|---------|
| `default` | Chain (sequential) | explorer (explore) -> coder (code) -> reviewer (review) |
| `parallel` | Parallel | 3 x general workers |
| `review` | Parallel | security reviewer + logic reviewer + architecture reviewer |

## Built-in Hooks

### Hook Lifecycle

```
User Request -> [PreToolUse] -> Tool Execution -> [PostToolUse] -> Result
                    |                                |
               Can BLOCK                       Can MODIFY
               Can MODIFY input                result content

Assistant Message -> [OnMessage] -> (extraction, memory save)
```

### Hook Pipeline (by priority)

| Priority | Hook | Plugin Name | Type | Trigger | Function |
|----------|------|-------------|------|---------|----------|
| 5 | **Path Safety** | `builtin:path-safety` | PreToolUse | Write/Edit/Read/Bash | Blocks `.env`/`.env.local`/`.env.production` writes, blocks private key file writes (`id_rsa`, `id_ed25519`, `.pem`). Normalizes backslash paths to forward slashes. Strips redundant `cd && ` prefixes in Bash. Fixes `\\;` in find -exec. Strips trailing whitespace in Write (except markdown). |
| 10 | **Secret Scanner** | `builtin:secret-scanner` | PostToolUse | Bash, WebFetch output | Detects API keys, AWS credentials, bearer tokens, private keys, GitHub tokens (`ghp_`/`gho_`), Slack tokens (`xox`), generic hex secrets. Appends security warning to result (does not block). |
| 40 | **Verification Agent** | `builtin:verification-agent` | PostToolUse | Write/Edit on `.ts`/`.tsx` files | Runs `npx tsc --noEmit --pretty false <file>` (15s timeout). If TypeScript errors detected, appends warning with first 3 errors so the model auto-corrects. Zero LLM cost. |
| 80 | **Anti-Laziness** | `builtin:anti-lazy` | PostToolUse | Write/Edit content | Detects incomplete patterns: `// ... rest remains`, `// ... same as before`, `// TODO: implement`, `// FIXME: implement`, `/* ... */`, `# ... rest remains`, `pass # TODO`, `raise NotImplementedError`, `throw new Error('not implemented')`. Appends completeness warning. |
| 90 | **Knowledge Hook** | `builtin:knowledge` | OnMessage | Assistant messages (>20 chars) | Detects memory-worthy hints using `detectMemoryHints()` (patterns: "remember that...", "I'm a...", "the decision is..."). Saves to Obsidian vault as auto-extracted notes. Fire-and-forget (silent failures). |

### Secret Patterns Detected

- API keys: `api_key=`, `apikey=`
- AWS: `AKIA` prefix, `aws_secret_access_key`
- Generic tokens: `token=`, `secret=`, `password=`, `api_secret=`
- Bearer tokens: `Bearer` + 20+ char token
- Private keys: `-----BEGIN PRIVATE KEY-----`
- GitHub: `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` tokens
- Slack: `xoxb-`, `xoxa-`, `xoxp-`, `xoxr-`, `xoxs-` tokens
- Generic hex: `secret/key/token` + 32+ hex chars

### Lazy Code Patterns Detected

- `// ... rest remains the same`
- `// ... same as before`
- `// TODO: implement`
- `// FIXME: implement`
- `/* ... */`
- `# ... rest remains`
- `pass  # TODO`
- `raise NotImplementedError`
- `throw new Error('not implemented')`

## Intelligent Features

### Strategic Brain (Pre-Turn)

Classifies task complexity before each model turn using heuristic analysis (word count, action verb detection) with LLM fallback:

| Level | Heuristic | Strategy Injection | Reflection Interval |
|-------|-----------|-------------------|---------------------|
| **trivial** | < 8 words, no action verbs | None | Never |
| **simple** | 1-2 action verbs | Basic tool hints | Every 5 turns |
| **complex** | 3+ action verbs or multi-step | Planning prompt + agent routing suggestions | Every 3 turns |
| **epic** | Project-scale keywords | Full task breakdown + sub-agent coordination | Every 3 turns + 50% budget warning |

### Mid-Turn Reflection

Injects self-evaluation prompts every N turns (configurable by complexity). Forces the model to assess its own progress and adjust approach.

### Post-Turn Intelligence

Three parallel background agents after each model response:
1. **Prompt Suggestion**: Predicts what user might type next
2. **Speculation**: Pre-analyzes the suggestion to have a head start
3. **Memory Extraction**: Extracts knowledge-worthy facts for vault storage

### KAIROS (Time Awareness)

Tracks session duration, active time, and turn count. Provides time-aware notifications:

| Event | Trigger | Action |
|-------|---------|--------|
| Away Summary | >10min idle between inputs | Show "Welcome back!" message with idle duration |
| Break Suggestion | >45min active work (one-shot) | Suggest taking a short break |
| Time Context | Every 5 turns | Inject `[TIME: Session Xm elapsed, Ym active, Z turns]` into system prompt |
| Session Summary | /quit | Display duration, active time, turn count, and recent topics |

### Verification Agent (PostToolUse Hook)

PostToolUse hook that auto-runs `tsc --noEmit` after Write/Edit on TypeScript files. If errors detected, appends the first 3 errors into the tool result so the model sees them and auto-corrects. Zero LLM token cost (pure shell execution, 15s timeout).

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MINIMAX_API_KEY` | Yes | API key for MiniMax M2.7 model |
| `MINIMAX_BASE_URL` | No | Override API base URL (default: `https://api.minimax.io/anthropic/v1`) |
| `MINIMAX_MODEL` | No | Override default model name |
| `ANTHROPIC_AUTH_TOKEN` | No | Fallback API key (if MINIMAX_API_KEY not set) |
| `ANTHROPIC_API_KEY` | No | Second fallback API key |
| `ANTHROPIC_BASE_URL` | No | Fallback base URL |
| `PCC_OBSIDIAN_VAULT` | No | Path to Obsidian vault for memory/knowledge features |
| `PCC_VAULT_PASSWORD` | No | Password for credential vault auto-unlock (used in daemon/meta mode) |
| `PCC_DAEMON` | No | Set to `1` when running in daemon mode (set automatically) |
| `PCC_DAEMON_SOCKET` | No | IPC socket path for daemon communication (set automatically) |

## File Structure

```
~/.pcc/                         Global Shugu data
  sessions/{id}.json            Conversation sessions
  memory/                       Global memories (loaded at startup)
  companion.json                Companion data
  plugins/                      User-installed global plugins (trusted)
  skills/                       User-created external skills
  meta/                         Meta-Harness archive
    datasets/                   Evaluation task datasets
    runs/{id}/                  Optimization run data
  shugu.log                     Debug log

.pcc/                           Project-local data
  memory/                       Project memories (loaded at startup)
  workflow/{app}/               Vibe workflow state
    workflow.json               Current stage, status, timestamps
    outputs/                    Stage artifacts (JSON files)
  plugins/                      Project-local plugins (require trust confirmation)
  vault.path                    Points to Obsidian vault path

harnesses/                      Meta-Harness configurations
  default/config.yaml           Base harness config
  active/config.yaml            Promoted (best) harness config

SHUGU.md                        Project instructions (read at startup)
```

## /doctor Diagnostic Checks (10)

1. **API Key** -- Verifies `MINIMAX_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is set and >10 chars
2. **API Connectivity** -- Sends a minimal API request to verify the endpoint responds
3. **Node.js** -- Checks version >= 20
4. **Git** -- Verifies git is installed and in PATH
5. **Git Repo** -- Confirms current directory is a git repository
6. **.pcc/ Directory** -- Checks for project-local data directory
7. **SHUGU.md** -- Checks for project instruction file and shows size
8. **Sessions Dir** -- Checks for `~/.pcc/sessions/`
9. **Companion** -- Checks if companion has been hatched (`~/.pcc/companion.json`)
10. **Obsidian Vault** -- If `PCC_OBSIDIAN_VAULT` set, verifies the vault exists
