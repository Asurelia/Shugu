# Project CC (Shugu) — Code Review

**Date:** 2026-04-06  
**Reviewer:** Shugu Agent  
**Version:** 0.1.0

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Strengths](#strengths)
3. [Issues & Risks](#issues--risks)
4. [Security Considerations](#security-considerations)
5. [Testing Gaps](#testing-gaps)
6. [Performance Concerns](#performance-concerns)
7. [Recommendations](#recommendations)
8. [Priority Matrix](#priority-matrix)

---

## Architecture Overview

### 14-Layer System Design

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

**No circular dependencies.** Each layer can be tested in isolation.

---

## Strengths

### 1. Clean Architecture with Strict Layering

The 14-layer architecture is well-designed with unidirectional dependencies. Each layer has a single responsibility.

```typescript
// Example: Layer boundaries are enforced
// src/engine/loop.ts only imports from lower layers
import { MiniMaxClient } from '../transport/client.js';
import { BudgetTracker } from './budget.js';
import { InterruptController } from './interrupts.js';
// NOT the other way around
```

### 2. Comprehensive Tool System

14 tools with smart parallelization:

```typescript
// src/tools/executor.ts — Parallel read-only, sequential mutating
export function partitionToolCalls(calls: ToolCall[], registry: ToolRegistryImpl) {
  const batches: Array<{ calls: Array<{ call: ToolCall; tool: Tool | null }>; parallel: boolean }> = [];
  let currentReadBatch: Array<{ call: ToolCall; tool: Tool | null }> = [];

  for (const call of calls) {
    const tool = registry.get(call.name);

    if (tool?.definition.concurrencySafe) {
      // Read-only tools: batch together for parallel execution
      currentReadBatch.push({ call, tool });
    } else {
      // Flush read batch
      if (currentReadBatch.length > 0) {
        batches.push({ calls: currentReadBatch, parallel: true });
        currentReadBatch = [];
      }
      // Mutating tools: run alone
      batches.push({ calls: [{ call, tool: tool ?? null }], parallel: false });
    }
  }
  // ...
}
```

### 3. MiniMax-Specific Handling Done Right

The transport layer correctly handles M2.7 quirks:

```typescript
// src/transport/client.ts
private buildRequestBody(): MessagesRequest {
  return {
    reasoning_split: this.config.thinkingConfig.showThinking,  // MANDATORY for M2.7
    temperature: Math.max(0.01, ...),                          // Must be > 0
    stream: true,
  };
}
```

### 4. Robust Error Handling with Retry Logic

```typescript
// src/transport/errors.ts — Exponential backoff with jitter
async function withRetry(fn, config, onRetry?): Promise<T> {
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (!error.retryable) throw error;
      
      // Model fallback after consecutive 529s
      if (error.statusCode === 529) {
        consecutive529s++;
        if (consecutive529s >= MAX_529_RETRIES) {
          throw new ModelFallbackError(...);
        }
      }
      
      const delay = calculateBackoff(attempt, config, error);
      await sleep(delay);
    }
  }
}
```

### 5. Credential Vault Security

AES-256-GCM encryption with PBKDF2 key derivation:

```typescript
// src/credentials/vault.ts
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;              // 256 bits
const PBKDF2_ITERATIONS = 100_000;  // High iteration count
const PBKDF2_DIGEST = 'sha512';
```

### 6. Multi-Agent Orchestration

```typescript
// src/agents/orchestrator.ts — Role-based sub-agents
const BUILTIN_AGENTS = {
  general: { rolePrompt: '...', maxTurns: 15 },
  explore: { rolePrompt: '...', allowedTools: ['Read', 'Glob', 'Grep', 'Bash'], maxTurns: 10 },
  code: { rolePrompt: '...', maxTurns: 20 },
  review: { rolePrompt: '...', allowedTools: ['Read', 'Glob', 'Grep', 'Bash'], maxTurns: 10 },
  test: { rolePrompt: '...', maxTurns: 15 },
};
```

### 7. Skills System Extensibility

```typescript
// src/skills/loader.ts — Trigger-based skill activation
export interface SkillTrigger {
  type: 'command' | 'keyword' | 'pattern' | 'always';
  command?: string;
  keywords?: string[];
  regex?: RegExp;
}
```

### 8. Comprehensive 6-Bundled Skills

| Skill | Category | Purpose |
|-------|----------|---------|
| `/vibe` | workflow | 6-stage project generation pipeline |
| `/dream` | analysis | Read-only codebase exploration |
| `/hunt` | analysis | Bug/security scanner |
| `/loop` | utility | Interval-based recurring tasks |
| `/schedule` | automation | Cron-based job scheduling |
| `/brain` | knowledge | Obsidian vault integration |

---

## Issues & Risks

### Critical Issues

#### 1. BashTool Security: Hardened (2026-04-10)

**File:** `src/tools/bash/BashTool.ts`

**Mitigations applied:**
- `process.env` is **stripped of sensitive variables** before passing to child shell (MINIMAX_API_KEY, tokens, passwords, secrets — both explicit blocklist and regex sweep)
- `env`, `printenv`, `node`, `python` **removed from SAFE_COMMANDS** in classifier.ts — these now require permission prompt in fullAuto mode
- SSRF protection in WebFetchTool blocks localhost/RFC1918/metadata endpoints

**Remaining risk:** BashTool still executes arbitrary commands with user-level privileges. The classifier reduces attack surface but does not eliminate it. Full OS-level sandboxing (Docker/bubblewrap) is only applied to plugin code, not to the main Bash tool.

#### 1a. Plugin Sandbox

Plugins that declare `"isolation": "brokered"` in their `plugin.json` manifest run in a separate process with enforced capability limits. The implementation has two modes:

- **Docker mode** — the plugin runs in a container launched with `--net=none --read-only --cap-drop=ALL`. Network access is fully blocked at the OS level. Filesystem writes are restricted to the container's writable `.data/` volume mount.
- **Node fallback mode** — when Docker is not available, Shugu spawns a Node child process with `--permission` flags that restrict filesystem writes and block child process spawning.

Host-child communication uses JSON-RPC over stdio (NDJSON). The `CapabilityBroker` in the host process gates every `fs.read`, `fs.write`, `fs.list`, and `http.fetch` request that the plugin makes, with path validation against an allowlist and SSRF blocking via `isBlockedUrl()`.

**Important scope clarification:** This isolation applies to _plugin code_ only, not to the main `Bash` tool. The main agentic loop still executes arbitrary shell commands with user-level privileges. The sandbox prevents malicious plugins from exfiltrating credentials or reaching private network endpoints, but it does not constrain the model's use of BashTool.

**Configuration:** Per-plugin policy lives in `.pcc/plugin-policy.json` and is loaded by `resolvePluginConfig()` at plugin load time.

#### 2. Vitest Type-Checking Disabled

**File:** `vitest.config.ts`

```typescript
// Current (DANGEROUS)
export default defineConfig({
  test: {
    typecheck: {
      enabled: false,  // Type errors won't fail tests!
    },
  },
});
```

**Impact:** Tests can pass even with type errors, creating false confidence.

**Recommendation:**
```typescript
// Should be
export default defineConfig({
  test: {
    typecheck: {
      enabled: true,
    },
  },
});
```

#### 3. TaskTools In-Memory State Not Persistent

**File:** `src/tools/tasks/TaskTools.ts`

Tasks are stored in a module-level `Map`, which is lost on process restart:

```typescript
// src/tools/tasks/TaskTools.ts
const tasks = new Map<string, Task>();
// ^ Lost on process restart
```

**Impact:** Task tracking doesn't persist across sessions.

**Recommendation:** Persist to `~/.pcc/tasks.json` or similar.

---

### High Priority Issues

#### 4. No Integration Tests for Transport Layer

The entire network layer is untested. Any regression in:
- Retry logic
- SSE parsing
- Error handling
- Authentication

...will go unnoticed until production.

**Recommendation:** Add integration tests with a mock HTTP server.

#### 5. Voice Capture Not Wired to CLI

**File:** `src/voice/capture.ts`

The voice module is fully implemented but never called from the CLI:

```typescript
// src/voice/capture.ts
export async function recordAudio(durationSeconds: number = 30): Promise<Recording> {
  // Implementation exists...
}

// But no command or UI handler invokes this!
```

**Impact:** Dead code that adds complexity without value.

**Recommendation:** Either wire it up or remove it.

#### 6. Companion System Adds Complexity

**Files:** `src/ui/companion/*.ts`, `src/ui/companion/*.tsx`

The companion (Spore mushroom) system is 7 files + component with:
- Deterministic generation algorithm
- Sprite animation system
- Speech bubble reactions
- Speech synthesis

```typescript
// Complexity example: sprites.ts
const BODIES: Record<Species, string[][]> = {
  mushroom: [
    ['            ', ' .-o-OO-o-. ', '(__________)', '   |{E}  {E}|   ', '   |____|   '],
    ['            ', ' .-O-oo-O-. ', '(__________)', '   |{E}  {E}|   ', '   |____|   '],
    ['   . o  .   ', ' .-o-OO-o-. ', '(__________)', '   |{E}  {E}|   ', '   |____|   '],
  ],
};
```

**Impact:** 500+ lines of UI code for a cosmetic feature.

**Recommendation:** Consider if this is core functionality or can be optional.

#### 7. Risk Classifier Has Gaps

**File:** `src/policy/classifier.ts`

The classifier doesn't catch all dangerous patterns:

```typescript
// Missing patterns:
- `eval()` in any language
- Python: `exec()`, `compile()`
- Node.js: `eval()`, `new Function()`
- `base64 -d` with shell commands
- `nc -e` / `ncat -e` (reverse shells)
- `wget` / `curl` with `| sh` (remote execution)
```

---

### Medium Priority Issues

#### 8. Circular Dependency Risk in Engine Loop

**File:** `src/engine/loop.ts`

The loop imports from `tools/executor.ts`, which may eventually import back into engine:

```typescript
// Current: engine/loop → tools/executor → (could grow to import engine)
```

While currently clean, the pattern of tools needing engine context creates coupling risk.

#### 9. No Session Expiration

**File:** `src/context/session/persistence.ts`

Sessions accumulate forever in `~/.pcc/sessions/`:

```typescript
// sessions are saved but never cleaned up
// Storage grows indefinitely
```

**Recommendation:** Add a cleanup job or max session count.

#### 10. Partial Win32 Support

**File:** `src/tools/bash/BashTool.ts`

```typescript
const shell = process.platform === 'win32' ? 'bash' : '/bin/bash';
// ^ Assumes bash is available on Windows
```

Many Windows systems don't have bash installed (WSL not guaranteed).

---

## Security Considerations

### Current Mitigations

| Threat | Mitigation | Location |
|--------|------------|----------|
| Credential theft | AES-256-GCM vault, atomic write, 0o600 file permissions | `credentials/vault.ts` |
| API key exposure | No keys in context; env stripping before child shell | `transport/auth.ts`, `tools/bash/BashTool.ts` |
| Command injection | Risk classifier; `env`/`printenv`/`node`/`python` removed from safe list | `policy/classifier.ts` |
| Secret scanning | Behavior hook; `redactSensitive()` for traces and memory | `plugins/builtin/behavior-hooks.ts` |
| Path traversal | Path normalization hook; workspace boundary enforcement | `plugins/builtin/behavior-hooks.ts`, `policy/workspace.ts` |
| SSRF | `isBlockedUrl()` in WebFetch and CapabilityBroker; RFC1918 + metadata endpoint blocking | `utils/network.ts`, `tools/web/WebFetchTool.ts`, `plugins/broker.ts` |
| Plugin code isolation | Docker sandbox (`--net=none --read-only --cap-drop=ALL`) or Node `--permission` flags | `plugins/host.ts`, `plugins/broker.ts` |
| Malformed webhook input | TriggerServer returns 400 on JSON parse error (no silent accept) | `automation/triggers.ts` |
| Hook crash safety | PreToolUse hooks fail closed on unhandled exception | `plugins/hooks.ts` |
| Scheduler runaway | AbortSignal propagated to job executors | `automation/scheduler.ts` |

### Remaining Vulnerabilities

#### 1. BashTool Command Injection

Despite the risk classifier, sophisticated attacks can bypass:

```bash
# Example bypass attempt
echo "$(whoami)"  # Uses subshell
${HOME}/.ssh/id_rsa  # Variable expansion
$(cat /etc/passwd | grep root)  # Piped commands
```

**Recommendation:** Use shell-safe argument passing, not string interpolation.

#### 2. No Rate Limiting on Tools

A malicious session could flood the system:

```typescript
// No throttling on tool calls
// Agent could spawn infinite loops
for await (const event of runLoop(messages, config)) {
  // No limit on iteration speed
}
```

**Recommendation:** Add rate limiting per session.

#### 3. Secret Detection Regex Gaps

**File:** `src/plugins/builtin/behavior-hooks.ts`

```typescript
// Current patterns miss many secret formats
const SECRET_PATTERNS = [
  /api_key\s*[:=]\s*['"]?([a-zA-Z0-9_\-]{20,})/i,
  /gh[pousr]_[a-zA-Z0-9]{36,}/,
  /AKIA[0-9A-Z]{16}/,
  // Missing: JWT tokens, OAuth tokens, etc.
];
```

#### 4. No Input Sanitization for File Paths

**File:** `src/tools/files/FileEditTool.ts`

```typescript
// No sanitization of paths
const absPath = resolve(context.cwd, filePath);
// Could potentially write outside cwd with ../../../etc/passwd
```

**Recommendation:** Validate resolved path stays within allowed boundaries.

---

## Testing Gaps

### Test Coverage Matrix

| Module | Test File | Coverage |
|--------|-----------|----------|
| `engine/budget.ts` | ✅ budget.test.ts | Good |
| `commands/` | ✅ commands.test.ts | Good |
| `plugins/hooks.ts` | ✅ hooks.test.ts | Excellent |
| `engine/interrupts.ts` | ✅ interrupts.test.ts | Excellent |
| `policy/` | ✅ permissions.test.ts, permission-gating.test.ts, classifier-evasion.test.ts | Good |
| `protocol/` | ✅ protocol.test.ts | Moderate |
| `automation/scheduler.ts` | ✅ scheduler.test.ts | Good |
| `skills/` | ✅ skills.test.ts | Good |
| `tools/registry.ts` | ✅ tools-registry.test.ts, tool-router.test.ts | Moderate |
| `transport/` | ✅ transport-errors.test.ts, minimax-reasoning.test.ts, model-routing.test.ts | Good |
| `credentials/` | ✅ vault.test.ts, credential-domain.test.ts | Good |
| `agents/` | ✅ agent-depth.test.ts, agent-teams.test.ts, worktree-integration.test.ts | Moderate |
| `plugins/` (brokered) | ✅ plugin-protocol.test.ts, plugin-broker.test.ts, plugin-host.test.ts, plugin-brokered-e2e.test.ts, plugin-sandbox-os.test.ts, plugin-policy.test.ts, plugin-integration.test.ts, plugin-trust.test.ts | Excellent |
| `automation/triggers.ts` | ✅ security-audit-gaps.test.ts (partial) | Partial |
| `context/` | ✅ workspace.test.ts, project-context.test.ts, session-features.test.ts, compaction-failure.test.ts, vault-discovery.test.ts | Moderate |
| `engine/loop.ts` | ❌ NONE | **Critical Gap** |
| `engine/turns.ts` | ✅ tool-result-pairing.test.ts | Partial |
| `tools/*` (execution) | ✅ search-boundary.test.ts, obsidian-boundary.test.ts | Partial |
| `ui/` | ✅ markdown.test.ts, parsers.test.ts, highlight.test.ts | Partial |
| `remote/` | ❌ NONE | High Gap |

**Coverage: 51 test files, 599 passing tests. Most modules now have dedicated tests; the primary remaining gap is `engine/loop.ts` (the core agentic loop) and the `remote/` SSH layer.**

### Critical Missing Tests

#### 1. Transport Layer Tests

```typescript
// Should test:
// - Successful streaming response
// - Retry on 429 rate limit
// - Retry on 529 server error
// - Model fallback after 3x 529
// - Non-retryable errors (400, 401, 403)
// - SSE parsing edge cases
// - Empty responses
// - Timeout handling
```

#### 2. Tool Execution Tests

```typescript
// Should test:
// - FileReadTool with various file types
// - FileWriteTool creates parent dirs
// - FileEditTool exact string matching
// - BashTool timeout/kill behavior
// - GlobTool with complex patterns
// - GrepTool with various regexes
// - WebFetchTool credential injection
```

#### 3. Agent Orchestrator Tests

```typescript
// Should test:
// - Spawn sub-agent with role
// - Restricted tool filtering
// - Event forwarding
// - Budget tracking across agents
// - Worktree creation/cleanup
```

---

## Performance Concerns

### 1. Polling Instead of Events

**File:** `src/ui/FullApp.tsx`

```typescript
// Current: Polling every 80ms
const syncMessages = useCallback(() => {
  const ext = stateRef.current;
  // ...
}, [stateRef]);

useEffect(() => {
  const interval = setInterval(syncMessages, 80);
  return () => clearInterval(interval);
}, [syncMessages]);
```

**Impact:** Unnecessary CPU usage, potential UI lag.

**Recommendation:** Use event-based updates via `AppHandle`.

### 2. No Lazy Loading for Tools

All 14 tools are loaded even if unused:

```typescript
// src/tools/index.ts
export function createDefaultRegistry(credentialProvider?: CredentialProvider) {
  const registry = new ToolRegistryImpl();
  
  registry.register(new BashTool());        // Always loaded
  registry.register(new FileReadTool());     // Always loaded
  registry.register(new FileWriteTool());    // Always loaded
  // ... 11 more
}
```

**Recommendation:** Implement `deferLoading` for rarely-used tools.

### 3. Memory Agent Runs LLM Extraction on Every Turn

**File:** `src/context/memory/agent.ts`

```typescript
// Every turn triggers potential LLM extraction
async saveLLMExtracted(memories) {
  // This could be expensive
}
```

**Recommendation:** Batch extractions or run on idle.

### 4. No Connection Pooling

**File:** `src/transport/client.ts`

Each request creates a new connection:

```typescript
// No connection reuse
const response = await fetch(url, { ... });
```

**Recommendation:** Implement keep-alive connections.

---

## Recommendations

### Priority 1 (Critical)

#### 1. Enable Vitest Type-Checking

```typescript
// vitest.config.ts — Change from:
export default defineConfig({
  test: {
    typecheck: { enabled: false },
  },
});

// To:
export default defineConfig({
  test: {
    typecheck: { enabled: true },
  },
});
```

#### 2. Add Transport Layer Tests

```typescript
// tests/transport.test.ts
describe('MiniMaxClient', () => {
  it('retries on 429 rate limit', async () => {
    // Mock fetch to return 429, then 200
    // Verify retry count
  });
  
  it('falls back model after 3x 529', async () => {
    // Mock 3 consecutive 529s
    // Verify ModelFallbackError thrown
  });
  
  it('parses SSE stream correctly', async () => {
    // Mock SSE response
    // Verify message reconstruction
  });
});
```

#### 3. Improve BashTool Security

```typescript
// Option A: Whitelist allowed commands
const ALLOWED_COMMANDS = new Set([
  'ls', 'cat', 'grep', 'rg', 'find', 'git', 'node', 'npm',
  // ... only safe commands
]);

// Option B: Use shell-safe argument passing
spawn('git', ['status']);  // Not: spawn('bash', ['-c', 'git status'])

// Option C: Add sandboxing (docker, bubblewrap)
```

#### 4. Add Critical Path Integration Tests

```typescript
// tests/integration/loop.test.ts
describe('Agent Loop Integration', () => {
  it('completes a simple task', async () => {
    // Mock MiniMaxClient
    // Provide tools
    // Run loop
    // Verify result
  });
  
  it('handles tool execution correctly', async () => {
    // ...
  });
});
```

### Priority 2 (High)

#### 5. Add Task Persistence

```typescript
// src/tools/tasks/TaskTools.ts — Add persistence
const TASKS_FILE = path.join(os.homedir(), '.pcc', 'tasks.json');

async function loadTasks(): Promise<Map<string, Task>> {
  try {
    const data = await readFile(TASKS_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}

async function saveTasks(tasks: Map<string, Task>): Promise<void> {
  await mkdir(dirname(TASKS_FILE), { recursive: true });
  const obj = Object.fromEntries(tasks);
  await writeFile(TASKS_FILE, JSON.stringify(obj, null, 2));
}
```

#### 6. Add Credential Provider Tests

```typescript
// tests/credentials.test.ts
describe('CredentialVault', () => {
  it('encrypts and decrypts correctly', async () => {
    const vault = new CredentialVault();
    await vault.init('master-password');
    
    vault.unlock('master-password');
    vault.store('github', { token: 'ghs_xxx' });
    
    const cred = vault.get('github');
    expect(cred?.token).toBe('ghs_xxx');
  });
  
  it('rejects wrong password', async () => {
    // ...
  });
});
```

#### 7. Implement Session Expiration

```typescript
// src/context/session/persistence.ts — Add cleanup
const MAX_SESSIONS = 50;
const SESSION_TTL_DAYS = 30;

async function cleanupOldSessions(sessionDir: string): Promise<void> {
  const files = await readdir(sessionDir);
  const sessions = await Promise.all(
    files.map(async (f) => ({
      file: f,
      mtime: (await stat(path.join(sessionDir, f))).mtime,
    }))
  );
  
  // Sort by mtime, delete oldest if over limit
  sessions.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  
  const toDelete = sessions.slice(MAX_SESSIONS);
  for (const { file } of toDelete) {
    await unlink(path.join(sessionDir, file));
  }
}
```

#### 8. Add Rate Limiting

```typescript
// src/tools/executor.ts — Add rate limiting
const RATE_LIMIT = 10; // calls per second
const callTimestamps: number[] = [];

function checkRateLimit(): boolean {
  const now = Date.now();
  const windowStart = now - 1000;
  
  // Remove old timestamps
  while (callTimestamps.length && callTimestamps[0]! < windowStart) {
    callTimestamps.shift();
  }
  
  if (callTimestamps.length >= RATE_LIMIT) {
    return false;
  }
  
  callTimestamps.push(now);
  return true;
}
```

### Priority 3 (Medium)

#### 9. Improve Risk Classifier

```typescript
// src/policy/classifier.ts — Add more patterns
const HIGH_RISK_PATTERNS = [
  // ... existing patterns
  /\beval\s*\(/i,                    // Code execution
  /\bexec\s*\(/i,                    // PHP code execution
  /\bcompile\s*\(/i,                 // Python code execution
  /base64\s+-d\s+/i,                 // Base64 decode
  /\|\s*sh\b/i,                      // Pipe to shell
  /\bnc\s+-[eE]\b/,                  // Netcat reverse shell
  /\bwget\s+.*\|\s*sh/i,             // Remote script execution
  /\bcurl\s+.*\|\s*sh/i,             // Remote script execution
];
```

#### 10. Wire Up or Remove Voice

```typescript
// Option A: Wire it up (src/commands/builtins.ts)
export function createDefaultCommands() {
  const commands = new CommandRegistry();
  
  commands.register({
    name: 'voice',
    description: 'Record voice input',
    execute: async (args, ctx) => {
      const duration = parseInt(args) || 30;
      const recording = await recordAudio(duration);
      const text = await transcribe(recording);
      return { type: 'prompt', prompt: text };
    },
  });
  // ...
}

// Option B: Remove dead code
// Delete src/voice/ entirely
```

#### 11. Add GitHub Actions CI

```yaml
# .github/workflows/test.yml
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
```

#### 12. Consider Optional Companion

```typescript
// src/ui/FullApp.tsx — Make companion optional
interface FullAppConfig {
  showCompanion?: boolean;  // Default: true for first 10 sessions, then false
}

// Or completely separate:
export function launchFullAppWithoutCompanion(...) { ... }
```

---

## Priority Matrix

| Priority | Issue | Effort | Impact |
|----------|-------|--------|--------|
| P1 | Enable Vitest typecheck | 1 line | High |
| P1 | Add transport tests | High | Critical |
| P1 | BashTool security | Medium | Critical |
| P1 | Add loop integration tests | High | Critical |
| P2 | Task persistence | Medium | High |
| P2 | Credential vault tests | Medium | High |
| P2 | Session expiration | Low | Medium |
| P2 | Rate limiting | Low | Medium |
| P3 | Improve risk classifier | Low | Medium |
| P3 | Wire/remove voice | Low | Low |
| P3 | Add GitHub Actions CI | Low | High |
| P3 | Optional companion | Low | Low |

---

## Files Analyzed

- **Core Engine:** `src/engine/*.ts` (loop, turns, budget, interrupts, intelligence, reflection, strategy)
- **Transport:** `src/transport/*.ts` (client, stream, auth, errors)
- **Tools:** `src/tools/**/*.ts` (all 14 tools)
- **UI:** `src/ui/**/*.ts`, `src/ui/**/*.tsx` (FullApp, App, components, companion)
- **Context:** `src/context/**/*.ts` (memory, session, workspace, compactor)
- **Credentials:** `src/credentials/*.ts` (vault, provider, types)
- **Policy:** `src/policy/*.ts` (modes, permissions, classifier, rules)
- **Plugins:** `src/plugins/**/*.ts` (hooks, loader, builtin)
- **Skills:** `src/skills/**/*.ts` (loader, bundled skills)
- **Agents:** `src/agents/*.ts` (orchestrator, delegation, worktree)
- **Automation:** `src/automation/*.ts` (scheduler, proactive, daemon, triggers)
- **Commands:** `src/commands/**/*.ts` (registry, builtins)
- **Integrations:** `src/integrations/*.ts` (adapter, discovery)
- **Remote:** `src/remote/*.ts` (gateway, ssh)
- **Build:** `scripts/build.ts`, `vitest.config.ts`, `package.json`, `tsconfig.json`
- **Tests:** `tests/*.test.ts` (all 51 test files)
- **Plugin Sandbox:** `src/plugins/protocol.ts`, `src/plugins/host.ts`, `src/plugins/child-entry.ts`, `src/plugins/broker.ts`, `src/plugins/policy.ts`
- **Security Utilities:** `src/utils/network.ts`

---

## Conclusion

Project CC (Shugu) is a well-architected, ambitious reimplementation of Claude Code with MiniMax M2.7 as the primary model. The 14-layer architecture demonstrates careful thinking about separation of concerns. Key strengths include:

1. **Clean layering** with no circular dependencies
2. **Comprehensive tool system** with smart parallelization
3. **Robust error handling** with exponential backoff
4. **Strong security** with AES-256-GCM vault, env stripping, SSRF protection, and hook fail-closed behavior
5. **Extensible skills system** with 7 bundled skills
6. **Multi-agent orchestration** with role-based sub-agents
7. **Brokered plugin isolation** via Docker sandbox or Node `--permission` flags

Current state:

1. **Test suite: 599 passing tests across 51 files** — transport, credentials, agents, and the plugin sandbox system all have dedicated tests
2. **Vitest type-checking disabled** — still creates false confidence; enabling it remains a 1-line change
3. **BashTool security** — mitigations applied (env stripping, classifier tightening, SSRF in WebFetch), but full OS-level sandboxing is not applied to the main Bash tool
4. **Engine loop untested** — `engine/loop.ts` (the core agentic loop) and the `remote/` SSH layer have no test coverage

The most important remaining next steps are:
1. Enable type-checking in Vitest
2. Add integration tests for the core agentic loop
3. Add coverage for the remote/SSH layer
4. Evaluate full OS-level sandboxing for BashTool (Docker/bubblewrap) for high-trust deployments

Overall, this is a mature foundation with solid test coverage across most modules. The remaining gaps are well-understood and documented.
