---
name: massu-hooks
description: "When user asks about hook status, profile configuration, or wants to see which hooks are active — 'hooks', 'hook status', 'what hooks are running'"
allowed-tools: Bash(*), Read(*)
---
name: massu-hooks

# Massu Hooks: Profile & Status Dashboard

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding.

## Objective

Display hook infrastructure status, profile configuration, and per-hook gating information.

---

## USAGE

```
/massu-hooks              # Show current profile and all hooks
/massu-hooks status       # Same as above
/massu-hooks minimal      # Show what runs under minimal profile
/massu-hooks standard     # Show what runs under standard profile
/massu-hooks strict       # Show what runs under strict profile
```

---

## EXECUTION

### Step 1: Read Current Profile

```bash
echo "Current LIMN_HOOK_PROFILE: ${LIMN_HOOK_PROFILE:-strict}"
echo "Disabled hooks: ${LIMN_DISABLED_HOOKS:-none}"
```

### Step 2: Display Hook Inventory

Show ALL hooks grouped by tier with their source (project vs user settings):

#### Critical Tier (Always Run)
| Hook | Source | Type | Trigger |
|------|--------|------|---------|
| output-secret-filter.sh | Project | Script | PostToolUse (Bash/Read/MCP) |
| mcp-rate-limiter.sh | Project | Script | PreToolUse (MCP) |
| memory-integrity-check.sh | Project | Script | SessionStart |
| Secret file detector | User | Inline | PreToolUse (Bash) |
| Staged secrets blocker | User | Inline | PreToolUse (Bash) |
| Auto-approve Read/Glob/Grep | User | Inline | PreToolUse |
| Auto-approve safe Bash | User | Inline | PreToolUse |

#### Standard Tier (Skipped in minimal)
| Hook | Source | Type | Trigger |
|------|--------|------|---------|
| pattern-feedback.sh | Project | Script | PostToolUse (Edit/Write) |
| Pattern scanner on push | Project | Inline | PreToolUse (Bash) |
| Validate features on commit | Project | Inline | PreToolUse (Bash) |
| Incident detection | Project | Inline | UserPromptSubmit |
| Uncommitted changes warning | Project | Inline | Stop |
| memory-enforcement.sh | User | Script | UserPromptSubmit |
| post-commit-memory.sh | User | Script | PostToolUse (Bash) |

#### Advisory Tier (Skipped in minimal AND standard)
| Hook | Source | Type | Trigger |
|------|--------|------|---------|
| auto-review-on-stop.sh | Project | Script | Stop |
| pattern-scanner single-file | Project | Inline | PostToolUse (Edit/Write) |
| pattern-extractor.sh | Project | Script | Stop |
| audit-css-tokens.sh | User | Script | PostToolUse (Edit/Write) |
| Context size warning | User | Inline | UserPromptSubmit |

### Step 3: Profile Comparison

If a specific profile was requested, highlight which hooks are ACTIVE vs SKIPPED under that profile.

### Step 4: Hook Health Check

```bash
# Verify hook-gate.sh exists and is valid
bash -n scripts/hooks/hook-gate.sh && echo "hook-gate.sh: OK" || echo "hook-gate.sh: SYNTAX ERROR"

# Verify key hook scripts exist
for hook in pattern-feedback output-secret-filter mcp-rate-limiter; do
  [ -f "scripts/hooks/${hook}.sh" ] && echo "${hook}.sh: EXISTS" || echo "${hook}.sh: MISSING"
done
```

---

## OUTPUT FORMAT

```
═══════════════════════════════════════════════════════════════════════════════
MASSU HOOK INFRASTRUCTURE
═══════════════════════════════════════════════════════════════════════════════

Profile: strict (default)
Disabled hooks: none
Hook gate: scripts/hooks/hook-gate.sh (OK)

HOOK COUNTS BY PROFILE:
  minimal:  7 hooks (critical only)
  standard: 14 hooks (critical + standard)
  strict:   19 hooks (all — current)

[Full hook table as above]

═══════════════════════════════════════════════════════════════════════════════
```
