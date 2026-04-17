```
   @@@@@@   @@@  @@@   @@@  @@@    @@@@@@@@   @@@  @@@
  @@@@@@@   @@@  @@@   @@@  @@@   @@@@@@@@@   @@@  @@@
  !@@       @@!  @@@   @@!  @@@   !@@         @@!  @@@
  !@!       !@!  @!@   !@!  @!@   !@!         !@!  @!@
  !!@@!!    @!@!@!@!   @!@  !@!   !@! @!@!@   @!@  !@!
   !!@!!!   !!!@!!!!   !@!  !!!   !!! !!@!!   !@!  !!!
       !:!  !!:  !!!   !!:  !!!   :!!   !!:   !!:  !!!
      !:!   :!:  !:!   :!:  !:!   :!:   !::   :!:  !:!
  :::: ::   ::   :::   ::::: ::   ::: ::::    ::::: ::
  :: : :     :   : :    : :  :    :: :: :      : :  :
```

**Project CC — Shugu**

*Claude Code, reimagined from scratch. MiniMax M2.7-first. Mono-provider. All capabilities unlocked.*

---

## What Is This?

Shugu (`pcc`) is a complete ground-up reimplementation of Claude Code as a **MiniMax M2.7-native** CLI agent. It was not ported or adapted — it was rebuilt with the same goals and a cleaner architecture: 185 TypeScript source files, ~37,400 lines, zero unnecessary dependencies.

Where Claude Code is Anthropic-first and ships MCP as its extension mechanism, Shugu is MiniMax-first and CLI-first. Every capability — tools, memory, credentials, multi-agent orchestration — is implemented directly in TypeScript, with no protocol layer in between.

| | Claude Code | Shugu |
|---|---|---|
| Provider | Anthropic (Claude 3.x) | MiniMax M2.7 |
| Architecture | Feature-gated monolith | 14-layer modular system |
| Extension model | MCP servers | CLI adapters + `pcc-tools.yaml` + plugin system |
| Memory | CLAUDE.md only | CLAUDE.md + Obsidian vault |
| Credential storage | None built-in | AES-256-GCM encrypted vault |
| Multi-agent | Limited | Native orchestrator |
| Plugin isolation | None | Docker sandbox or Node `--permission` |
| Context window | 200K | 200K (M2.7-highspeed) |
| Reasoning | Optional | Always-on (mandatory in M2.7) |
| Binary | `claude` | `pcc` |

---

## Quick Start

### Prerequisites

- Node.js 20 or later
- A MiniMax API key — get one at [minimax.io](https://minimax.io)

### Install

```bash
# Clone and build
git clone https://github.com/your-org/project-cc
cd project-cc
npm install
npm run build

# Link the binary globally
npm link
```

### Set Your API Key

```bash
export MINIMAX_API_KEY="sk-cp-..."
```

Or create a `.env` file in your project directory:

```
MINIMAX_API_KEY=sk-cp-...
```

### Run

```bash
# Interactive REPL (default mode)
pcc

# Single-shot prompt
pcc "refactor this module to use async/await"

# Full-auto mode — no permission prompts
pcc --mode=auto "run tests and fix all failures"

# Plan mode — every action requires approval
pcc --mode=plan
```

---

## The Model: MiniMax M2.7

Shugu targets MiniMax M2.7, not as an OpenAI-compatible drop-in, but with full awareness of its specific capabilities and quirks.

### Available Models

| Alias | Model ID | Context | Notes |
|---|---|---|---|
| `best` (default) | `MiniMax-M2.7-highspeed` | 200K | Better quality AND faster (100 tps) |
| `balanced` | `MiniMax-M2.7` | 200K | Standard speed (60 tps) |
| `fast` | `MiniMax-M2.5-highspeed` | — | Previous generation |

The `highspeed` variants deliver higher quality output, not just higher throughput. Shugu defaults to `MiniMax-M2.7-highspeed`.

### MiniMax-Specific Behavior

M2.7 has two quirks that the transport layer handles transparently:

- **Reasoning is mandatory.** M2.7 always reasons before responding. The `reasoning_split: true` flag exposes this as a separate thinking block so the UI can render it distinctly.
- **Temperature must be greater than zero.** The valid range is `(0.0, 1.0]`. Shugu enforces a floor of `0.01` on all requests.

These are not workarounds — they are first-class behaviors. M2.7's always-on reasoning is why it performs well on multi-step agentic tasks.

### API Endpoint

```
POST https://api.minimax.io/anthropic/v1/messages
```

Shugu uses the Anthropic-compatible endpoint, which accepts the standard Messages API format with the `reasoning_split` extension. No custom SDK is needed.

---

## Architecture

Shugu is organized into 14 independent layers, each with a single responsibility. Dependencies only flow downward. The test suite currently has 901 passing tests across 62 test files.

```
Layer 1   transport/      MiniMax HTTP client, SSE streaming, retry logic
Layer 2   engine/         Agentic loop, turn management, budget, interrupts
Layer 3   tools/          14 tools: bash, files, search, web, agent, task, REPL
Layer 4   policy/         Permission modes, tool category classification
Layer 5   context/        Token budget, compaction, session persistence, memory
Layer 6   integrations/   CLI discovery, pcc-tools.yaml, adapter hints
Layer 7   commands/       Slash command registry and builtin commands
Layer 8   agents/         Sub-agent orchestrator, role definitions
Layer 9   credentials/    AES-256-GCM encrypted vault, service templates
Layer 10  protocol/       Shared types: messages, tools, events, thinking
Layer 11  ui/             Terminal renderer, banner, streaming output
Layer 12  entrypoints/    CLI wiring (REPL + single-shot)
Layer 13  context/memory/ Obsidian vault integration, note extraction
Layer 14  context/workspace/ Git context, project context, CLAUDE.md loading
```

### Dependency Graph

```
entrypoints (12)
    ├── engine/loop (2)
    │       ├── transport/client (1)
    │       └── engine/turns, budget, interrupts
    ├── tools/* (3)
    │       └── protocol/* (10)
    ├── policy/permissions (4)
    ├── context/* (5, 13, 14)
    ├── integrations/* (6)
    ├── commands/* (7)
    ├── agents/orchestrator (8)
    │       └── engine/loop (2)
    ├── credentials/* (9)
    └── ui/* (11)
```

No circular dependencies. Each layer can be tested in isolation.

---

## Plugin System

Shugu includes a plugin system (Layer 14) that lets external code extend the agent with additional tools, commands, skills, and lifecycle hooks. Plugins load from `~/.pcc/plugins/` (global) or `.pcc/plugins/` (project-local).

### Isolation Modes

Every plugin declares an isolation mode in its `plugin.json` manifest:

| Mode | Mechanism | Network | Filesystem |
|------|-----------|---------|-----------|
| `trusted` (default) | In-process `import()` | Full | Full |
| `brokered` | Docker container or Node `--permission` | Blocked or brokered | Write-restricted |

`trusted` plugins are loaded like any Node module — fast, with full system access. Use this for internal or audited plugins.

`brokered` plugins run in a separate process with enforced capability limits. When Docker is available, the process runs inside a container launched with `--net=none --read-only --cap-drop=ALL`. When Docker is not available, Shugu falls back to a Node child process with `--permission` flags that restrict filesystem writes to the plugin's `.data/` directory and block child process spawning.

### Host-Child Communication

Host and plugin communicate over JSON-RPC via stdio. The plugin declares its tools, hooks, commands, and skills during an initialization handshake; the host creates in-process proxy objects that forward invocations to the child and relay capability requests back through the `CapabilityBroker`.

### Capability Broker

All filesystem and network access from a brokered plugin passes through the `CapabilityBroker`:

- `fs.read` — allowed for paths inside the plugin root or explicitly whitelisted directories
- `fs.write` — restricted to the plugin's `.data/` directory
- `fs.list` — same path rules as `fs.read`
- `http.fetch` — blocked for localhost, RFC1918 addresses, and cloud metadata endpoints (SSRF protection)

### Writing a Brokered Plugin

Create a directory with a `plugin.json` manifest and a JS/TS entry file:

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Example brokered plugin",
  "entry": "index.js",
  "isolation": "brokered",
  "capabilities": ["fs.read"],
  "allowedPaths": ["./data"]
}
```

```typescript
// index.js — runs inside the isolated child process
export async function init(api) {
  api.registerTool({
    name: 'MyTool',
    description: 'A tool that reads a file via the capability broker',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    execute: async (call, ctx) => {
      const content = await api.capabilities.readFile(call.input.path);
      return { type: 'tool_result', content: [{ type: 'text', text: content }] };
    },
  });
}
```

The plugin can also register hooks:

```typescript
api.registerHook('PreToolUse', async (payload) => {
  // Inspect or block tool calls before they execute
  return { status: 'allow' };
});
```

### Policy File

Per-plugin policy is configured in `.pcc/plugin-policy.json`:

```json
{
  "plugins": {
    "my-plugin": {
      "isolation": "brokered",
      "capabilities": ["fs.read", "http.fetch"],
      "allowedPaths": ["./src", "./docs"],
      "maxAgentTurns": 5
    }
  }
}
```

The `maxAgentTurns` field limits how many agentic turns a plugin can consume per `runAgent` invocation, preventing runaway sub-agents.

### Hook Types

All 7 hook types work in both trusted and brokered mode:

| Hook | Fires | Can block? |
|------|-------|-----------|
| `PreToolUse` | Before any tool executes | Yes — return `{ status: 'block' }` |
| `PostToolUse` | After any tool executes | No — observe only |
| `PreCommand` | Before a slash command runs | Yes |
| `PostCommand` | After a slash command runs | No |
| `OnMessage` | On each assistant message | No |
| `OnStart` | Session startup | No |
| `OnExit` | Session teardown | No |

---

## Tools

Shugu ships 14 tools organized into five categories. Every tool goes through the permission resolver before execution.

### Core File Tools

| Tool | Name | Description |
|---|---|---|
| `Bash` | Shell | Execute shell commands with timeout and kill support |
| `Read` | FileReadTool | Read files with line numbers and optional range |
| `Write` | FileWriteTool | Create or overwrite files completely |
| `Edit` | FileEditTool | Exact string replacement in existing files |

### Search Tools

| Tool | Name | Description |
|---|---|---|
| `Glob` | GlobTool | Find files by pattern — `**/*.ts`, `src/**/*.json` |
| `Grep` | GrepTool | Search file contents with regex, with context lines |

### Web Tools

| Tool | Name | Description |
|---|---|---|
| `WebFetch` | WebFetchTool | Fetch a URL and return its content (credential-aware) |
| `WebSearch` | WebSearchTool | Search via MiniMax's coding search API |

### Agent and Task Tools

| Tool | Name | Description |
|---|---|---|
| `Agent` | AgentTool | Spawn a sub-agent with a role prompt and restricted toolset |
| `TaskCreate` | TaskCreateTool | Create a tracked task with priority and description |
| `TaskUpdate` | TaskUpdateTool | Update task status (todo / in-progress / done / blocked) |
| `TaskList` | TaskListTool | List all tasks filtered by status |

### Utility

| Tool | Name | Description |
|---|---|---|
| `REPL` | REPLTool | Persistent JavaScript/TypeScript evaluation environment |
| `Sleep` | SleepTool | Pause execution for N milliseconds |

---

## Permission Modes

Five modes control how aggressively the agent acts without asking for confirmation. Modes are per-session and can be changed at runtime with `/mode`.

| Mode | Flag | Read | Write | Execute | Network | Agent |
|---|---|---|---|---|---|---|
| `plan` | `--mode=plan` | ask | ask | ask | ask | ask |
| `default` | _(default)_ | allow | ask | ask | allow | ask |
| `acceptEdits` | `--mode=accept-edits` | allow | allow | ask | allow | ask |
| `fullAuto` | `--mode=auto` | allow | allow | classifier | allow | allow |
| `bypass` | `--bypass` | allow | allow | allow | allow | allow |

**plan** — The safest mode. Every tool call surfaces a prompt before execution. Use this for unfamiliar codebases or when you want to review each step.

**default** — Reads and network requests happen automatically. File writes and shell commands require confirmation. Good for exploratory sessions.

**acceptEdits** — File edits are auto-approved. Shell commands still prompt. The balance point for most coding sessions.

**fullAuto** — Almost everything runs without confirmation. Bash commands are passed through a risk classifier; high-risk patterns (destructive git operations, system-wide deletes) still prompt.

**bypass** — All prompts suppressed. Everything executes immediately. Intended for scripted or fully trusted environments.

Change the mode during a session:

```
/mode plan
/mode auto
/mode accept-edits
```

---

## Slash Commands

All commands are prefixed with `/`. Type `/help` at the prompt for the current list.

| Command | Description |
|---|---|
| `/help` | List all available commands |
| `/quit`, `/exit` | Exit the session |
| `/clear` | Clear conversation history (start fresh) |
| `/compact` | Summarize old turns and compress context |
| `/mode <mode>` | Change permission mode |
| `/commit [msg]` | Generate a conventional commit message and commit |
| `/status` | Show git status and project info |
| `/review` | Review recent changes — runs a code-review sub-agent |
| `/memory [query]` | Search Obsidian vault and agent memories |
| `/memory save` | Save a note to the vault |
| `/cost` | Show token usage and estimated cost |
| `/context` | Show context window status and compaction threshold |

### `/commit`

With no argument, the agent reads `git diff --staged`, writes a conventional commit message, and runs the commit. Pass a message to skip generation:

```
/commit fix: handle empty input in parser
```

### `/compact`

When your conversation approaches 75% of the 200K context window, `/compact` summarizes all previous turns into a compact summary and replaces the history. The active context is preserved. Compaction also triggers automatically.

### `/memory`

Search your Obsidian vault from inside a session:

```
/memory authentication flow
/memory #architecture
/memory save
```

The last form opens a note-creation flow that saves directly to your vault's `Agent/` folder.

---

## Multi-Agent Orchestration

The `Agent` tool lets the model spawn sub-agents — isolated nested loops with their own conversation, budget, and restricted toolset. This is not prompt engineering or a separate process; it is the same agentic loop running recursively.

### Built-in Agent Roles

| Role | Allowed Tools | Max Turns | Purpose |
|---|---|---|---|
| `general` | all | 15 | General-purpose sub-task execution |
| `explore` | Read, Glob, Grep, Bash | 10 | Codebase exploration, no writes |
| `code` | all | 20 | Focused code changes |
| `review` | Read, Glob, Grep, Bash | 10 | Code review, read-only analysis |

### How It Works

```
pcc (main agent)
  └── Agent("explore the auth module") → explore sub-agent
        ├── Glob("src/auth/**")
        ├── Read("src/auth/session.ts")
        └── returns: structured summary

  └── Agent("refactor session.ts") → code sub-agent
        ├── Read("src/auth/session.ts")
        ├── Edit(...)
        └── returns: what changed
```

M2.7 has native multi-agent capabilities — stable role identity and adversarial reasoning across turns — that Shugu exploits via role prompts rather than custom protocols.

---

## Obsidian Memory Integration

Shugu treats an Obsidian vault as a persistent knowledge graph accessible from every session. This is not a plugin and requires no Obsidian to be running — it reads `.md` files directly from the filesystem.

### What the Integration Provides

- **Agent memories** — Notes saved by the agent are written to `vault/Agent/` with full frontmatter (title, date, tags, type, wikilinks)
- **Prompt injection** — Recent agent memories and query-relevant notes are injected into the system prompt at session start
- **Search** — Full-text and tag-based search across the entire vault
- **Wikilink resolution** — `[[note-name]]` links are traversed to fetch related notes

### Vault Structure

```
vault/
  Projects/       organized by initiative
  Meetings/       dated entries
  Research/       by topic
  Ideas/          tagged concepts
  Agent/          PCC agent memories (auto-created)
  Templates/      reusable structures
```

### Configuration

Vault discovery runs in priority order:

1. `PCC_OBSIDIAN_VAULT` environment variable
2. `.pcc/vault.path` file in the project directory
3. `pcc-vault.path` file in the project directory
4. Current directory (if it contains `.obsidian/`)
5. Common locations: `~/Obsidian`, `~/Documents/Obsidian`, `~/Documents/Obsidian Vault`

```bash
# Explicit path
export PCC_OBSIDIAN_VAULT="/path/to/your/vault"

# Or per-project
echo "/path/to/your/vault" > .pcc/vault.path
```

---

## Credential Vault

Shugu ships an encrypted credential store for authenticated tool calls. Credentials are stored at `~/.pcc/credentials.enc` using AES-256-GCM with PBKDF2 key derivation (100,000 iterations, SHA-512). The master key never leaves memory and credentials are never sent to the model context.

### Supported Services

| Category | Services |
|---|---|
| Code hosting | GitHub, GitLab, Bitbucket |
| Cloud | AWS, GCP, Azure, Vercel, Supabase, Netlify, Railway, Fly.io |
| Communication | Gmail, Slack, Discord, Notion |
| Infrastructure | Cloudflare, VPS (SSH) |
| Generic | Custom API key/token |

### Usage

The `WebFetch` tool automatically injects credentials when a request domain matches a stored credential. For example, if you have a GitHub token stored, any `WebFetch` call to `api.github.com` will include the `Authorization: Bearer` header automatically.

VPS credentials store the SSH key path for remote Bash execution.

---

## CLI Discovery and `pcc-tools.yaml`

On startup, Shugu scans `PATH` for known CLIs and injects usage hints into the system prompt. This gives the model accurate, tool-specific guidance without hallucinating flag names.

### Auto-detected CLIs

`git`, `node`, `npm`, `gh` (GitHub CLI), `docker`, `kubectl`, `terraform`, `aws`, `gcloud`, `vercel`, `fly`, `cargo`, `python`, `pip`, `uv`

### Custom Tools via `pcc-tools.yaml`

Add project-specific tool hints by creating a `pcc-tools.yaml` in your project root:

```yaml
tools:
  - name: make
    description: Project build system
    hint: |
      Use Bash for make commands:
        - make build — compile the project
        - make test  — run tests
        - make clean — remove build artifacts

  - name: my-deploy-script
    description: Internal deployment script
    hint: |
      ./scripts/deploy.sh <env> where env is staging or production.
      Always run with --dry-run first.
```

These hints are injected alongside the built-in CLI hints on every session start.

---

## VPS and Remote Capabilities

The credential vault's `vps` service type stores SSH access details for remote hosts. When configured, the `Bash` tool can be directed to run commands on remote machines via SSH.

### VPS Credential Fields

| Field | Description |
|---|---|
| `host` | IP address or domain name |
| `user` | SSH username |
| `key_path` | Path to SSH private key (e.g., `~/.ssh/id_ed25519`) |
| `port` | SSH port (default: 22) |

---

## Configuration Reference

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `MINIMAX_API_KEY` | MiniMax API key (required) | — |
| `MINIMAX_BASE_URL` | API base URL | `https://api.minimax.io/anthropic/v1` |
| `MINIMAX_MODEL` | Model override | `MiniMax-M2.7-highspeed` |
| `PCC_OBSIDIAN_VAULT` | Path to Obsidian vault | auto-discover |
| `PCC_MODE` | Default permission mode | `default` |
| `PCC_MAX_TOKENS` | Max tokens per response | `16384` |
| `PCC_TIMEOUT_MS` | Request timeout in ms | `600000` (10 min) |

### CLI Flags

| Flag | Description |
|---|---|
| `--mode=<mode>` | Set permission mode for the session |
| `--bypass` | Shorthand for `--mode=bypass` |
| `--model=<id>` | Override model for this session |
| `--max-turns=<n>` | Maximum agentic turns before stopping |
| `--no-banner` | Skip the startup banner |
| `--session=<id>` | Resume a saved session by ID |

### Project Instructions

Shugu loads custom instructions from these files in order, if they exist:

1. `CLAUDE.md` — primary instructions file (same as Claude Code)
2. `PCC.md` — Shugu-specific instructions
3. `.pcc/instructions.md` — project-level instructions

All three are merged and injected into the system prompt before every session.

---

## Session Persistence

Sessions are automatically saved to `~/.pcc/sessions/{sessionId}.json`. Each session stores:

- Full conversation history (messages)
- Model and token usage totals
- Turn count
- Project directory
- Created and updated timestamps

Resume a previous session:

```bash
pcc --session=<sessionId>
```

Sessions accumulate until you clear them. The session directory can be safely deleted to free disk space.

---

## Context Management

The token budget tracker monitors usage against M2.7's 200K context window. At 75% capacity (~153K tokens), Shugu warns you and offers to compact.

```
/context
```

This shows:
- Current input token count
- Context window size
- Percentage used
- Whether compaction has been triggered

Compaction summarizes older conversation turns into a compact block, preserving recent context and the system prompt. The model continues seamlessly.

---

## Why No MCP?

Claude Code uses the Model Context Protocol as its extension mechanism: external servers expose tools over a JSON-RPC socket, and Claude connects to them at runtime. Shugu takes a different position.

MCP is useful when you need to connect to existing infrastructure that already speaks MCP. For new capabilities, it adds:

- A separate process to manage
- A protocol to implement on both sides
- Network round-trips for every tool call
- A runtime dependency on the MCP server being alive

Shugu's answer is `pcc-tools.yaml` and the `CliAdapter` interface. New tools are CLI hints — the agent uses `Bash` to invoke them. If your team has a custom deploy script, a database migration tool, or a linter with unusual flags, you describe it in 10 lines of YAML and the agent uses it correctly on the next run. No server, no protocol, no process lifecycle to manage.

The tradeoff: tools that genuinely require a persistent process or a non-CLI interface (an IDE extension, a browser automation driver, a database cursor) are better served by MCP. Shugu does not prevent you from running MCP servers alongside it — it simply does not depend on them.

---

## Development

### Build

```bash
npm run build      # compile TypeScript → dist/
npm run dev        # run from source with tsx (no build step)
npm run typecheck  # type-check without emitting
npm test           # run tests with vitest
npm run test:watch # tests in watch mode
```

### Project Structure

```
src/
  agents/          orchestrator, agent definitions
  commands/        slash command registry, builtins
  context/
    memory/        obsidian vault, note extraction, memory store
    session/       session persistence
    workspace/     git context, project context
    compactor.ts   conversation compaction
    tokenBudget.ts token tracking
  credentials/     vault, provider, service types/templates
  engine/          loop, turns, budget, interrupts
  entrypoints/     cli.ts — main entry point
  integrations/    CLI discovery, adapter, pcc-tools.yaml
  policy/          permission modes, permission resolver
  protocol/        shared types: messages, tools, events, thinking
  tools/
    agents/        AgentTool
    bash/          BashTool
    files/         FileReadTool, FileWriteTool, FileEditTool
    repl/          REPLTool
    search/        GlobTool, GrepTool
    tasks/         TaskCreateTool, TaskUpdateTool, TaskListTool
    utility/       SleepTool
    web/           WebFetchTool, WebSearchTool
    executor.ts    parallel tool execution
    registry.ts    ToolRegistryImpl
    index.ts       createDefaultRegistry
  transport/       client, stream, auth, errors
  ui/              banner, renderer
```

### Adding a Tool

1. Create `src/tools/<category>/<Name>Tool.ts` implementing the `Tool` interface from `protocol/tools.ts`
2. Register it in `src/tools/index.ts` inside `createDefaultRegistry`
3. Add it to `src/policy/modes.ts` `getToolCategory` if it has non-default permissions

---

## Comparison with Claude Code

This table covers intentional design differences, not deficiencies.

| Feature | Claude Code | Shugu |
|---|---|---|
| Primary model | Claude 3.5/3.7 Sonnet | MiniMax M2.7-highspeed |
| Thinking/reasoning | Optional, toggleable | Always-on (M2.7 behavior) |
| Extension model | MCP servers | `pcc-tools.yaml` + CLI adapters |
| Memory | CLAUDE.md per project | CLAUDE.md + Obsidian vault graph |
| Credential storage | None | AES-256-GCM vault with service templates |
| Sub-agents | Limited tool delegation | Full orchestrator with role definitions |
| Session persistence | Per-session context | Named sessions saved to `~/.pcc/sessions/` |
| Context compaction | Automatic | Automatic + manual `/compact` |
| Task tracking | None | Built-in TaskCreate/Update/List tools |
| REPL | None | Persistent JS/TS REPL tool |
| Startup UI | Minimal | Full-width banner with vault status, tips panel |
| Binary name | `claude` | `pcc` |
| License | Proprietary | MIT |

---

## License

MIT — see `LICENSE` for the full text.

---

*Shugu is an independent project and is not affiliated with Anthropic or MiniMax.*
