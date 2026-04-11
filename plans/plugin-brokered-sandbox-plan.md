# Plugin Sandbox Plan — Brokered Process Model

## Goal

Move Shugu from `import()`-based plugin execution inside the main Node process to a brokered child-process model that:

- preserves model-visible functionality
- reduces plugin trust from "full code execution in main runtime" to "capability-mediated extension"
- allows gradual migration without breaking existing plugins

This document is the concrete plan for **Option B reinforced**.

## Hard Requirement

There must be **no visible loss of capability for the model**:

- same tool names
- same tool schemas
- same hook semantics
- same slash command surface
- same result shapes

The model should not need prompt changes to use migrated plugins.

## Current Problem

Current flow:

`loadPlugin() -> import(entryPath) -> top-level JS executes in main process`

That means a plugin can access, during import or `init()`:

- `process.env`
- filesystem
- network
- `child_process`
- in-memory runtime state of the parent process

The current `permissions` gates only filter what the plugin can register through the exposed API. They do **not** sandbox the plugin code itself.

## Target Architecture

### Main Process

The main process remains the authority for:

- plugin discovery
- trust mode selection
- tool registration
- hook registration
- command registration
- workspace boundaries
- permission policy
- network policy
- shell execution policy
- audit logging

### Plugin Process

Each plugin runs in a dedicated child process:

- launched via `child_process.fork()` or `spawn(node, child-entry.js, ...)`
- minimal filtered environment
- plugin-specific working directory
- JSON-RPC over `stdio`
- no direct access to main runtime objects

### Broker

The main process exposes a brokered capability layer. Plugins do not call Node APIs directly through the parent. They request capabilities from the broker.

Examples:

- `read_file`
- `write_file`
- `edit_file`
- `http_fetch`
- `exec`
- `store_get`
- `store_set`
- `log`

Every broker call is checked by the main process before execution.

## What Must Stay Stable

### Tools

For a migrated plugin tool:

- the tool still appears in the registry with the same `name`
- the same `description`
- the same `inputSchema`
- the same `ToolResult` shape

Implementation detail:

- current local `tool.execute()` becomes a wrapper
- wrapper sends `invokeTool` RPC to the plugin process
- plugin returns a normal serialized tool result

### Hooks

For `PreToolUse` and `PostToolUse`:

- same lifecycle points
- same payload semantics
- same ordering rules

Implementation detail:

- main process invokes remote hook via RPC
- response is validated and then applied locally

### Commands

Slash commands remain visible with the same names and usage strings.

Implementation detail:

- command registration metadata is declared by the plugin
- command execution is proxied to the child process

## New Plugin Modes

### 1. `trusted`

Legacy mode.

- current behavior
- plugin code may run locally
- reserved for local development and debugging

### 2. `brokered`

Default target mode.

- plugin runs in a child process
- only brokered capabilities available
- no direct access to parent runtime

### 3. `brokered-read-only`

Restricted profile.

- no write broker calls
- no shell broker
- optional no network

### 4. `brokered-no-network`

Same as `brokered`, but HTTP capability disabled unless explicitly allowed.

## Security Model

### What This Fixes

- no direct `import()` of plugin JS into main process
- no direct access to parent `process.env`
- no direct access to parent memory/runtime objects
- all sensitive operations can be logged and policy-checked centrally

### What This Does Not Fully Solve

Child process isolation is stronger than in-process import, but it is not a complete OS sandbox by itself.

If the child process is allowed unrestricted Node APIs, it can still:

- access its own filesystem view
- open sockets
- spawn child processes

So the reinforced design must combine child process separation with:

- filtered environment
- constrained working directory
- broker-first plugin API
- policy enforcement
- later OS/container sandbox if needed

## Concrete Implementation Plan

### Phase 1 — Protocol

Add:

- `src/plugins/protocol.ts`
- `src/plugins/types.ts`

Define JSON-RPC message types:

- `init`
- `registerTool`
- `registerCommand`
- `registerHook`
- `invokeTool`
- `invokeCommand`
- `invokeHook`
- `capabilityRequest`
- `capabilityResponse`
- `shutdown`
- `health`

Every message must have:

- `id`
- `type`
- `plugin`
- `payload`

## Phase 2 — Plugin Host Process

Add:

- `src/plugins/host.ts`
- `src/plugins/child-entry.ts`
- `src/plugins/child-runtime.ts`

Responsibilities:

- load plugin in child process
- expose a constrained plugin runtime
- translate plugin API calls into RPC messages
- handle lifecycle and crash reporting

Main process no longer does:

- `import(entryPath)` for brokered plugins

Main process instead does:

- spawn plugin host
- handshake
- receive declared components

## Phase 3 — Broker API

Add:

- `src/plugins/capabilities.ts`
- `src/plugins/broker/fs.ts`
- `src/plugins/broker/network.ts`
- `src/plugins/broker/exec.ts`
- `src/plugins/broker/store.ts`

Capability examples:

- `fs.read`
- `fs.write`
- `fs.edit`
- `net.fetch`
- `exec.run`
- `store.get`
- `store.set`

Every capability call must:

- validate input
- enforce workspace/path boundary
- enforce permission mode
- redact secrets in logs
- enforce timeout
- return structured error on deny/fail

## Phase 4 — Registry Wrappers

Update:

- [loader.ts](/F:/Dev/Project/Project_cc/src/plugins/loader.ts)
- [registry.ts](/F:/Dev/Project/Project_cc/src/plugins/registry.ts)
- [hooks.ts](/F:/Dev/Project/Project_cc/src/plugins/hooks.ts)

Behavior:

- register local wrappers in the main process
- wrapper delegates to plugin child over RPC

For tools:

- wrapper owns canonical `ToolDefinition`
- wrapper executes RPC
- wrapper normalizes result

For hooks:

- wrapper calls remote handler
- main process validates returned mutation/block response

For commands:

- wrapper sends `invokeCommand`
- command output is streamed or returned in one payload

## Phase 5 — Manifest and Capability Declaration

Extend plugin manifest with execution mode and capabilities.

Example:

```json
{
  "name": "my-plugin",
  "mode": "brokered",
  "capabilities": {
    "fs": ["read", "write"],
    "net": ["fetch"],
    "exec": []
  }
}
```

Rules:

- missing mode defaults to legacy `trusted` during migration
- missing capabilities means no brokered privileged operations
- `permissions` becomes UX/registration metadata, not a security claim

## Phase 6 — Migration Layer

Support both modes temporarily.

### Legacy Plugins

- still load through current path
- explicitly marked as `trusted`
- noisy warning in UI and logs

### Brokered Plugins

- use new child-process runtime

This avoids breaking the ecosystem while allowing progressive migration.

## Compatibility Rules

To avoid functionality loss for the model:

1. Never rename existing plugin tools during migration.
2. Never change input schemas unless versioned.
3. Keep `ToolResult` identical.
4. Keep existing hook trigger points.
5. Keep slash command names identical.

If a plugin cannot be migrated without changing model-visible behavior, it stays `trusted` temporarily and gets flagged as a migration exception.

## Expected Plugin Limitations

These are intentional and acceptable:

- no monkey-patching of main runtime
- no shared mutable in-memory references
- no implicit parent env access
- no direct unrestricted shell from plugin code
- no direct unrestricted network from plugin code

These should not reduce model capability if wrappers and broker calls are designed correctly.

## Performance Impact

Expected costs:

- plugin startup process cost
- IPC latency on tool/hook/command calls

Expected mitigations:

- keep child process warm while plugin enabled
- use lightweight JSON-RPC framing
- batch or cache low-value repeated requests when safe

Hooks will incur a small round-trip cost. This is acceptable if hooks remain short and policy checks stay in main.

## Failure Handling

If a plugin child:

- crashes
- hangs
- returns malformed data
- exceeds timeout

the main process must:

- fail closed for security-sensitive hooks
- mark the plugin degraded
- emit audit logs
- surface clear operator-visible error

No silent fallback to unrestricted behavior.

## Recommended Order of Work

1. Protocol types
2. Child host bootstrap
3. Tool wrapper path
4. Hook wrapper path
5. Command wrapper path
6. Capability broker
7. Manifest mode/capabilities
8. Legacy/trusted compatibility mode
9. Observability and crash handling
10. Documentation and migration guide

## Acceptance Criteria

The migration is successful when:

- brokered plugins are not loaded with `import()` in the main process
- tool/command/hook behavior is unchanged from the model's point of view
- all privileged plugin operations flow through main-process policy checks
- plugin crashes do not compromise the main runtime
- audit logs show capability requests and denials
- legacy `trusted` plugins remain usable during migration

## Practical Recommendation

Do not spend time on `worker_threads` as a security step. It does not solve the actual trust problem here.

Go directly to:

- `trusted` for legacy compatibility
- `brokered` for the new safe path

Then later, if needed, strengthen the child runtime further with OS-level sandboxing.
