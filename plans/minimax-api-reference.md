---
name: MiniMax API Reference
description: Quick reference for MiniMax API endpoints, model IDs, quirks, streaming format, and SDK compatibility
type: reference
---

## Endpoints
- OpenAI-compat: `https://api.minimax.io/v1`
- Anthropic-compat: `https://api.minimax.io/anthropic/v1/messages`
- Search API: `https://api.minimax.io/v1/coding_plan/search` (integrated in WebSearchTool)

## Model IDs (direct API)
- `MiniMax-M2.7-highspeed` — BEST quality + fastest (100 tps), 200K context
- `MiniMax-M2.7` — same architecture, standard speed (60 tps)
- `MiniMax-M2.5-highspeed` / `MiniMax-M2.5` — previous gen
- `MiniMax-M2.1-highspeed` / `MiniMax-M2.1` — older gen

**User confirmed 2026-04-05: highspeed = better quality, not just faster.**

## Model IDs (via routers)
- OpenRouter: `minimax/minimax-m2.7-highspeed`
- Vercel AI Gateway: `minimax/minimax-m2.7-highspeed`
- LiteLLM: `minimax/MiniMax-M2.7-highspeed`

## Auth
- Bearer token in Authorization header (same as OpenAI)
- Key format: `sk-cp-...` (not JWT)

## Critical Quirks
1. Temperature MUST be > 0 (range `(0.0, 1.0]`, recommended 1.0)
2. Reasoning is MANDATORY — always runs, cannot disable
3. `reasoning_split: true` in request body exposes thinking separately
4. presence_penalty, frequency_penalty, logit_bias silently ignored
5. Only n=1 supported
6. Tool call history must include FULL model response (including tool_calls array)
7. Self-hosted raw output wraps tool calls in `<tool_calls>` XML (API handles parsing)

## Streaming Format (verified 2026-04-05)
- Standard SSE, `data:` prefix, terminated by `data: [DONE]`
- Reasoning comes as `reasoning_details` array in delta (NOT `reasoning_content`)
- Each detail: `{"type":"reasoning.text", "id":"...", "text":"..."}`
- Text field is `.text`, NOT `.content` — critical for parsing

## Native Agent Teams
MiniMax M2.7 has internalized multi-agent collaboration — stable role identity, adversarial reasoning, protocol adherence across turns. Not just prompt engineering.

## SDK Compatibility
- OpenAI Python/Node.js SDK: Full compat (override base_url + api_key)
- Anthropic SDK: Via anthropic-compat endpoint
- No official MiniMax SDK needed
