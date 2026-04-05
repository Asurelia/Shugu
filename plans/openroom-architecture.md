---
name: MiniMax OpenRoom Architecture
description: Analysis of github.com/MiniMax-AI/OpenRoom — portable patterns for Shugu (action protocol, dynamic tool discovery, vibe workflow)
type: reference
---

## What Is OpenRoom
Browser-based AI-native desktop environment built by MiniMax, largely written by M2.7 itself. MIT license. Live at openroom.ai.

## Portable Patterns for Shugu

### 1. Vibe Workflow (`.claude/` directory)
- 10-stage pipeline as Claude Code slash-commands: Analysis → Architecture → Planning → Codegen → Assets → Integration
- State persisted in `workflow.json` — supports resume and rollback
- Entry: `.claude/commands/vibe.md`; stages in `.claude/workflow/stages/`
- **Directly droppable** into Shugu's `.claude/` system

### 2. Action Protocol (`action.ts`)
- Typed bidirectional agent↔tool messages via `CharacterAppAction` / `CharacterOsEvent`
- `ActionTriggerBy` enum: User=1, Agent=2, System=3
- `reportAction()` dispatches, `useAgentActionListener()` receives
- More structured than raw tool_use — tracks who triggered what

### 3. Dynamic Tool Discovery (`appRegistry.ts`)
- Agent reads `meta.yaml` manifests at runtime to discover tools
- No hardcoded tool list — add a file, agent discovers the capability
- `loadActionsFromMeta()` → `getAppActionToolDefinition()` → LLM tool schema
- Could be adapted for project-specific tool discovery in Shugu

### 4. LLM Client (`llmClient.ts`)
- Unified `chat()` across 8 providers: openai, anthropic, minimax, deepseek, llama.cpp, z.ai, kimi, openrouter
- MiniMax routed via Anthropic-compatible message format
- Simple interface: `chat(messages, tools?, config?)`

### 5. Character/Memory System
- `characterManager.ts` — persistent agent personas with emotion/state
- `memoryManager.ts` — cross-session memory persistence

## Key Files in Repo
- `apps/webuiapps/src/lib/` — 28 core TypeScript modules
- `.claude/commands/vibe.md` — workflow orchestrator entry
- `.claude/workflow/stages/` — 10 stage definitions
- `packages/vibe-container/` — IPC SDK (mock ships open-source)

## What OpenRoom Does NOT Contain
Agent Teams adversarial reasoning and Skills system are M2.7 model-level capabilities, not code patterns in the repo. They manifest through the model's behavior with structured role prompts.

## Source
https://github.com/MiniMax-AI/OpenRoom (MIT license)
