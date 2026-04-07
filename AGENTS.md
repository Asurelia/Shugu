# AGENTS.md

## Review guidelines

- Treat silent failures as high severity unless clearly non-critical.
- Flag empty catch blocks.
- Flag fallback behavior that hides failures in security, sandbox, auth, config loading, and process execution.
- Prefer explicit propagation with context over silent recovery.
- Distinguish verified issues from suspicions.
- For each finding, include file path, function name, impact, and suggested fix.
- Call out blind spots and unverified code paths.