---
name: MiniMax M2.7 Integration Project
description: First-class MiniMax provider in Shugu — implementation status, model tier mapping, bugs found, and future work as of 2026-04-05
type: project
---

## Goal
Adapt Shugu (Claude Code fork) to support MiniMax M2.7 as a first-class `APIProvider`, not a generic OpenAI passthrough.

**Why:** MiniMax M2.7 HighSpeed is both the best quality AND fastest variant (100 tps, $0.30/M input). Its quirks (mandatory reasoning, temperature >0, silently ignored params) need dedicated handling.

**How to apply:** When touching the provider layer, always check if MiniMax needs special handling. Don't assume OpenAI defaults apply.

## Implementation Status (2026-04-05)
Branch: `feature/minimax-first-class-provider-20260405` — **10 files changed, ~200 lines**. Build passes clean. NOT yet committed.

### Files Modified
- `src/utils/model/providers.ts` — `'minimax'` in APIProvider union + detection
- `src/utils/model/configs.ts` — All 11 ModelConfig entries + `MINIMAX_MODEL_DEFAULTS`
- `src/utils/model/openaiContextWindows.ts` — 6 models: 204.8K context, 131K output
- `src/utils/context.ts` — MINIMAX env check in context/output lookups
- `src/utils/model/model.ts` — Minimax branches in 4 model resolution functions
- `src/services/api/client.ts` — `CLAUDE_CODE_USE_MINIMAX` in shim routing
- `src/services/api/openaiShim.ts` — `isMiniMaxMode()`, env mapping, temp clamping, `reasoning_split:true`, param stripping, `reasoning_details[].text` fix
- `src/utils/providerProfile.ts` — `'minimax'` profile, `buildMiniMaxProfileEnv()`, launch env
- `bin/shugu` — `SHUGU_MINIMAX_*` aliases, auto-detect when `MINIMAX_API_KEY` set
- `src/tools/WebSearchTool/WebSearchTool.ts` — `MINIMAX_API_KEY` detection + fallback

### Model Tier Mapping (corrected 2026-04-05)
User confirmed: **highspeed = better quality**, not just faster.

| Tier | MiniMax Model | Rationale |
|------|--------------|-----------|
| Opus (best) | `MiniMax-M2.7-highspeed` | Best quality + fastest (100 tps) |
| Sonnet (balanced) | `MiniMax-M2.7` | Same architecture, standard speed (60 tps) |
| Haiku (fast/cheap) | `MiniMax-M2.5-highspeed` | Previous generation, highspeed |

### Bug Found During Live Testing (2026-04-05)
`reasoning_details` streaming field uses `.text` not `.content`. Fixed at openaiShim.ts:489 — `r?.text ?? r?.content ?? r`.

### Live API Test Results (2026-04-05)
All passed: basic chat, reasoning_split separation, tool calling (OpenAI format), streaming SSE with reasoning_details. API key format is `sk-cp-...`.

### Known Issues (pre-existing, not caused by our changes)
- `contextCollapse.applyCollapsesIfNeeded is not a function` — build bug in dist/cli.mjs that blocks `--print` mode

### Not Yet Done
- Setup wizard UI (`src/commands/provider/provider.tsx`) — MiniMax not in wizard
- No dedicated unit tests for MiniMax provider detection
- E2E test via shugu blocked by pre-existing contextCollapse bug

## Future Opportunity: Native Agent Teams
MiniMax M2.7 has native multi-agent collaboration ("Agent Teams") as an internalized capability — not just prompt engineering. The model supports stable role identity, adversarial reasoning, and protocol adherence across turns. Shugu's subagent/team system (AgentTool) could leverage this for more effective multi-agent workflows.
