---
name: massu-scaffold-hook
description: "When user wants to create a new Claude Code hook — scaffolds the hook script, adds to settings.json, sets up profile gating"
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---

# Scaffold New Hook

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding.

Creates a complete Claude Code hook following the 3-tier profile system.

## What Gets Created

| File | Purpose |
|------|---------|
| `scripts/hooks/[hook-name].sh` | Hook script |
| Entry in `.claude/settings.json` | Hook registration under lifecycle event |

## Hook Lifecycle Events

| Event | Fires When | Use For |
|-------|-----------|---------|
| `PreToolUse` | Before a tool runs | Blocking destructive ops, validation, logging |
| `PostToolUse` | After a tool runs | Auditing, pattern scanning, metrics |
| `SessionStart` | Session starts/resumes/compacts | Context injection, state loading |

## Template — Hook Script

```bash
#!/usr/bin/env bash
# [Hook Name] — [brief description]
# Profile: [minimal|standard|strict]
source "$(dirname "$0")/hook-gate.sh" [tier] [hook-name] 2>/dev/null || true
set -euo pipefail

# Read tool input from stdin
TOOL_INPUT=$(cat)

# Extract relevant fields (adapt per event type)
# For PreToolUse: tool_input contains the tool's parameters
# For PostToolUse: tool_input contains tool output + parameters

# Your hook logic here

# Output options:
# - Exit 0 silently (no feedback)
# - Echo JSON for structured feedback:
#   echo '{"decision":"block","reason":"..."}'  (PreToolUse only)
#   echo '{"message":"..."}' (advisory feedback)

exit 0
```

## Template — settings.json Entry

```json
{
  "matcher": "ToolName|OtherTool",
  "hooks": [
    {
      "type": "command",
      "command": "PROFILE=${LIMN_HOOK_PROFILE:-strict}; [ \"$PROFILE\" = \"minimal\" ] && exit 0; bash \"$CLAUDE_PROJECT_DIR/scripts/hooks/hook-name.sh\""
    }
  ]
}
```

## Profile Tiers

| Tier | When to Use | Gate Pattern |
|------|------------|--------------|
| `critical` | Security, secrets, rate limiting | NO gate — always runs |
| `standard` | Pattern feedback, session lifecycle | `source hook-gate.sh standard hook-name` |
| `strict` | Advisory, CSS audit, auto-review | `source hook-gate.sh strict hook-name` |

## Gotchas

- **stdin piping**: Hook receives tool input via stdin — `TOOL_INPUT=$(cat)` must be first
- **Exit codes**: Exit 0 = success/allow, non-zero = hook failure (not tool blocking)
- **hook-gate.sh sourcing**: MUST use `2>/dev/null || true` suffix (hook-gate may not exist in CI)
- **Inline PROFILE check**: settings.json entry needs `PROFILE=${LIMN_HOOK_PROFILE:-strict}` prefix for minimal profile bypass
- **jq dependency**: Use `jq` for JSON parsing (installed on dev machine), never grep for JSON fields
- **Performance**: Hooks run on every tool invocation — keep under 10ms for standard tier

## Process

1. Ask user: What event? What tool? What should the hook do?
2. Determine profile tier (critical/standard/strict)
3. Create hook script in `scripts/hooks/`
4. Add entry to `.claude/settings.json` under appropriate event
5. Test by invoking the relevant tool

## START NOW

Ask the user what the hook should do, which lifecycle event it fires on, and which tool it should match.
