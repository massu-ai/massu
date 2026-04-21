name: massu-hooks

# Massu Hooks: Profile & Status Dashboard

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
echo "Current MASSU_HOOK_PROFILE: ${MASSU_HOOK_PROFILE:-strict}"
echo "Disabled hooks: ${MASSU_DISABLED_HOOKS:-none}"
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
| post-tool-use.js | Project | CodeGraph | PostToolUse (Edit/Write/Bash) |
| user-prompt.js | Project | CodeGraph | UserPromptSubmit |
| session-start.js | Project | CodeGraph | SessionStart |
| session-end.js | Project | CodeGraph | Stop |
| pre-compact.js | Project | CodeGraph | PreCompact |
| compaction-advisor.sh | Project | Script | PostToolUse (all tools) |
| Pattern scanner on push | Project | Inline | PreToolUse (Bash) |
| CR-25 edit blast radius | Project | Inline | PreToolUse (Edit) |
| Validate features on commit | Project | Inline | PreToolUse (Bash) |
| CR-25 plan blast radius | Project | Inline | UserPromptSubmit |
| Incident detection | Project | Inline | UserPromptSubmit |
| PreCompact git status | Project | Inline | PreCompact |
| Uncommitted changes warning | Project | Inline | Stop |
| memory-enforcement.sh | User | Script | UserPromptSubmit |
| post-commit-memory.sh | User | Script | PostToolUse (Bash) |
| filter-cli-output | User | Inline | PreToolUse (Bash) |
| MEMORY.md injection audit | User | Inline | PostToolUse (Edit/Write) |

#### Advisory Tier (Skipped in minimal AND standard)
| Hook | Source | Type | Trigger |
|------|--------|------|---------|
| post-edit-context.js | Project | CodeGraph | PostToolUse (Edit/Write) |
| auto-ingest-incident.sh | Project | Script | PostToolUse (Edit/Write) |
| validate-deliverables.sh | Project | Script | PostToolUse + Stop |
| mcp-usage-tracker.sh | Project | Script | PostToolUse (MCP) |
| auto-review-on-stop.sh | Project | Script | Stop |
| surface-review-findings.sh | Project | Script | SessionStart + Stop |
| pattern-scanner single-file | Project | Inline | PostToolUse (Edit/Write) |
| CR-32 sentinel rm | Project | Inline | PreToolUse (Bash) |
| pattern-extractor.sh | Project | Script | Stop |
| cost-tracker.sh | Project | Script | StatusLine |
| audit-css-tokens.sh | User | Script | PostToolUse (Edit/Write) |
| backup-hook.sh | User | Script | PostToolUse (Edit/Write) |
| TS file tracker | User | Inline | PostToolUse (Edit/Write) |
| type-check-edited.sh | User | Script | UserPromptSubmit |
| Context size warning | User | Inline | UserPromptSubmit |
| mark-memory-ingested.sh | User | Script | PostToolUse (MCP ingest) |

### Step 3: Profile Comparison

If a specific profile was requested, highlight which hooks are ACTIVE vs SKIPPED under that profile.

### Step 4: Hook Health Check

```bash
# Verify hook-gate.sh exists and is valid
bash -n scripts/hooks/hook-gate.sh && echo "hook-gate.sh: OK" || echo "hook-gate.sh: SYNTAX ERROR"

# Verify key hook scripts exist
for hook in compaction-advisor pattern-extractor pattern-feedback output-secret-filter mcp-rate-limiter; do
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
  standard: 25 hooks (critical + standard)
  strict:   35 hooks (all — current)

[Full hook table as above]

═══════════════════════════════════════════════════════════════════════════════
```
