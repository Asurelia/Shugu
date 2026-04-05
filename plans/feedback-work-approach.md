---
name: Work approach - understand before modifying
description: Critical feedback about how to approach changes to the Shugu codebase - understand the existing system before adding anything
type: feedback
---

Do NOT pile changes on top of a working codebase without understanding how it works first. Do NOT add hacks/workarounds/stubs when something breaks — diagnose the root cause.

**Why:** User had a working Shugu installation. I added MiniMax provider support by layering code on top without understanding the existing launcher, env var flow, trust system, plugin loading, or how the build pipeline works. This broke the app completely. Instead of diagnosing, I kept adding more hacks (env var overrides, trust bypasses, delete statements) making it worse.

**How to apply:**
1. Before modifying ANY file, read it fully and understand its role in the system
2. When something breaks after a change, REVERT and investigate — don't pile more changes
3. Test IMMEDIATELY after each small change, not after a batch of 10 files
4. If the user says "it worked before", compare with the working version first
5. Respect the existing architecture — integrate INTO it, don't override it
6. Never hardcode API keys in source code without explicit user request
7. Clean up test files and artifacts after testing
