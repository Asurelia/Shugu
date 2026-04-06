# Shugu Commands & Features Reference

## CLI Flags

| Flag | Short | Description |
|------|-------|-------------|
| `--continue` | `-c` | Resume most recent session for current directory |
| `--resume` | `-r` | Interactive session picker |
| `--resume=<id>` | | Resume specific session by ID |
| `--mode=<mode>` | | Set permission mode (plan/default/accept-edits/auto/bypass) |
| `--bypass` | | Shorthand for --mode=bypass |
| `--help` | `-h` | Show help |

## Slash Commands (19)

### Session & Context

| Command | Aliases | Description |
|---------|---------|-------------|
| `/clear` | | Clear conversation history |
| `/compact` | | Summarize older turns to save context |
| `/context` | | Show context window usage |
| `/cost` | | Show token usage and cost |
| `/resume [id]` | `/continue` | Resume a previous session or show picker |
| `/export [file]` | | Export conversation to markdown file |
| `/rewind [N]` | `/undo` | Remove last N turn pairs |

### Project & Setup

| Command | Aliases | Description |
|---------|---------|-------------|
| `/init` | `/setup` | Initialize project (SHUGU.md + .pcc/) |
| `/doctor` | `/health`, `/diag` | Run diagnostic health checks |
| `/status` | `/st` | Show git status and project info |
| `/commit [msg]` | | Generate commit message or commit staged changes |
| `/review` | | Review recent code changes |
| `/diff` | | Show git diff with colors |

### Configuration

| Command | Aliases | Description |
|---------|---------|-------------|
| `/mode <mode>` | | Change permission mode |
| `/model [name]` | | Show or change model |
| `/fast` | | Toggle fast mode (M2.5-highspeed) |

### Memory & Knowledge

| Command | Aliases | Description |
|---------|---------|-------------|
| `/memory` | `/mem`, `/vault` | Search/save Obsidian vault |
| `/buddy` | `/pet` | Show companion |
| `/buddy card` | `/buddy info`, `/buddy stats` | Show companion stats card |
| `/buddy pet` | | Pet your companion |
| `/buddy name <n>` | | Rename companion |
| `/buddy mute` | | Mute companion reactions |
| `/buddy unmute` | | Unmute companion |

### Automation

| Command | Aliases | Description |
|---------|---------|-------------|
| `/bg` | | Background task runner |
| `/proactive` | | Proactive agent execution |

## Bundled Skills (7)

| Skill | Trigger | Description |
|-------|---------|-------------|
| **vibe** | `/vibe <AppName>` | 6-stage workflow (analysis, architecture, planning, codegen, validate, ship) |
| **dream** | `/dream` | Read-only codebase exploration and analysis |
| **hunter** | `/hunt`, `/bughunter` | Security & code quality scanner |
| **loop** | `/loop 5m <prompt>` | Recurring interval execution |
| **schedule** | `/schedule`, `/cron` | Cron-based job scheduling |
| **brain** | `/brain`, `/obsidian`, `/note` | Deep Obsidian vault integration |
| **generator** | (internal) | Create new custom skills |

## Agent Types

| Type | Tools | Use Case |
|------|-------|----------|
| `general` | All (except Agent) | Default, full capability |
| `explore` | Read, Glob, Grep, Bash | Code exploration (read-only) |
| `code` | All | Code writing and editing |
| `review` | Read, Glob, Grep, Bash | Code review (read-only) |
| `test` | All | Write and run tests |

## Built-in Hooks

| Hook | Type | Priority | Function |
|------|------|----------|----------|
| Path Safety | PreToolUse | 5 | Block .env/key writes, normalize paths |
| Secret Scanner | PostToolUse | 10 | Detect API keys/tokens in output |
| Verification Agent | PostToolUse | 40 | Auto-typecheck after Write/Edit on .ts |
| Anti-Laziness | PostToolUse | 80 | Detect TODO/stub/placeholder code |
| Knowledge Hook | OnMessage | 90 | Auto-extract memories to vault |

## Intelligent Features

### Strategic Brain (Pre-Turn)
Classifies task complexity before each model turn:
- **trivial**: No strategy injection (questions, short requests)
- **simple**: Basic tool hints
- **complex**: Planning prompt + agent routing suggestions
- **epic**: Full task breakdown + sub-agent coordination

### Mid-Turn Reflection
Injects self-evaluation prompts every N turns (configurable by complexity).

### Post-Turn Intelligence
Three parallel background agents after each model response:
1. **Prompt Suggestion**: Predicts what user might type next
2. **Speculation**: Pre-analyzes the suggestion
3. **Memory Extraction**: Extracts knowledge-worthy facts

### KAIROS (Time Awareness)
- Tracks session duration and active time
- Away summary after 10min idle
- Break suggestion after 45min deep work
- Session summary at /quit
- Time context injection every 5 turns

### VERIFICATION_AGENT
PostToolUse hook that auto-runs `tsc --noEmit` after Write/Edit on TypeScript files. Injects errors into result so the model auto-corrects.

## File Structure

```
~/.pcc/                     Global Shugu data
  sessions/{id}.json        Conversation sessions
  memory/                   Global memories
  companion.json            Companion data
  shugu.log                 Debug log

.pcc/                       Project-local data
  memory/                   Project memories (loaded at startup)
  workflow/{app}/            Vibe workflow state

SHUGU.md                    Project instructions (read at startup)
```
