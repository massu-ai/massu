# Hook Execution Order Reference

**Purpose**: Authoritative reference for hook execution ordering across all event types in `.claude/settings.json`.

**Scope**: Project hooks only (`.claude/settings.json`). User hooks (`~/.claude/settings.json`) run in a separate pipeline and are not covered here.

**Enforcement**: Run `scripts/hooks/validate-hook-order.sh` to verify ordering constraints. Exit 0 = valid.

---

## Ordering Principles

1. **Security-critical hooks run first** -- secret filters, rate limiters, integrity checks
2. **Blocking hooks before advisory** -- hooks that can reject/block run before informational ones
3. **Data-writing hooks before data-reading hooks** -- producers before consumers
4. **Observability hooks run last** -- trackers, advisors, and audit logs

---

## SessionStart (4 hooks)

Context initialization -> CR-12 enforcement -> advisories -> security scan.

| position: 1 | `session-start.js` | standard | Context initialization, memory injection |
|---|---|---|---|
| position: 2 | AUTHORIZED_COMMAND display | critical (inline) | CR-12 enforcement -- must display before any work |
| position: 3 | `surface-review-findings.sh` | advisory/strict | Surface findings from previous session's auto-review |
| position: 4 | `memory-integrity-check.sh` | critical (no gate) | Security scan of memory files for anti-patterns |

**Dependencies**:
- `session-start.js` MUST be position 1 -- writes DB state other hooks may read
- `memory-integrity-check.sh` runs last -- safety net that catches issues regardless of prior hooks

---

## PreToolUse (6 hooks)

Security blocking -> advisory warnings -> matcher-specific -> observability.

| position: 1 | `pattern-scanner.sh --quick` | standard | Bash(git push) -- block pushes with pattern violations |
|---|---|---|---|
| position: 2 | CR-24 blast radius advisory | standard | Edit -- warn on path/route changes |
| position: 3 | `validate-features.sh` | standard | Bash(git commit) -- validate feature registry before commit |
| position: 4 | CR-30 deletion sentinel | strict | Bash(rm) -- warn on src/ file deletions |
| position: 5 | `mcp-rate-limiter.sh` | critical | MCP tools -- rate-limit database queries |
| position: 6 | `command-invocation-tracker.sh` | standard | Skill -- observability, no blocking |

**Dependencies**:
- `pattern-scanner.sh` should run early -- gates bad pushes before other hooks fire
- `mcp-rate-limiter.sh` is matcher-specific (MCP only) -- position among Bash hooks is irrelevant
- `command-invocation-tracker.sh` MUST be last -- pure observability, no blocking

---

## PostToolUse (14 hooks)

Security scan -> immediate feedback -> context tracking -> fix detection -> incident capture -> pipeline triggers -> memory sync -> observability.

| position: 1 | CI monitor | standard | Bash(git push) -- immediate push feedback |
|---|---|---|---|
| position: 2 | `output-secret-filter.sh` | critical | Bash\|Read\|mcp -- scan output for leaked secrets |
| position: 3 | `pattern-feedback.sh` | standard | Edit\|Write -- immediate pattern violation feedback |
| position: 4 | `post-edit-context.js` | strict | Edit\|Write -- detailed semantic analysis |
| position: 5 | `post-tool-use.js` | standard | Edit\|Write\|Bash -- structured context tracking |
| position: 6 | `fix-detector.js` | standard | Edit\|Write -- detect bug fixes via git diff heuristics |
| position: 7 | `auto-ingest-incident.sh` | strict | Edit\|Write -- auto-capture incident patterns |
| position: 8 | `incident-pipeline.js` | standard | Write -- trigger rule derivation on incident report writes |
| position: 9 | `rule-enforcement-pipeline.js` | standard | Write -- trigger enforcement on prevention rule writes |
| position: 10 | `memory-auto-ingest.sh` | standard | Write -- auto-sync memory files to codegraph SQLite DB |
| position: 11 | `validate-deliverables.sh` | strict | Bash\|Edit\|Write -- deliverable validation |
| position: 12 | `pattern-scanner.sh --single-file` | strict | Edit\|Write -- per-file pattern scan |
| position: 13 | `mcp-usage-tracker.sh` | strict | MCP tools -- append-only MCP audit log |
| position: 14 | `compaction-advisor.sh` | standard | Bash\|Edit\|Write\|Read\|Grep\|Glob -- context tracking, widest matcher |

**Dependencies**:
- `output-secret-filter.sh` MUST run before any feedback hooks -- security first
- `pattern-feedback.sh` before `post-tool-use.js` -- immediate feedback before tracking
- `fix-detector.js` after `post-tool-use.js` -- needs structured tracking context
- `incident-pipeline.js` after `auto-ingest-incident.sh` -- incident must be captured first
- `rule-enforcement-pipeline.js` after `incident-pipeline.js` -- rule derivation before enforcement
- `memory-auto-ingest.sh` runs after pipeline hooks -- memory sync is data-writing, before validation
- `compaction-advisor.sh` MUST be last -- widest matcher, just counts tool calls

---

## UserPromptSubmit (3 hooks)

Prompt tracking -> advisory reminders -> incident detection.

| position: 1 | `user-prompt.js` | standard | Prompt tracking and observation capture |
|---|---|---|---|
| position: 2 | CR-24 blast radius reminder | standard | Warn on plan commands that may change values |
| position: 3 | Incident detection | standard | Detect user frustration signals |

**Dependencies**:
- `user-prompt.js` MUST be first -- captures prompt before advisory hooks may modify context

---

## PreCompact (2 hooks)

Quick state capture -> full DB snapshot.

| position: 1 | Git status + session state | standard (inline) | Quick state capture to stdout |
|---|---|---|---|
| position: 2 | `pre-compact.js` | standard | Full session snapshot to memory DB |

**Dependencies**:
- Inline capture runs first (fast) -- provides immediate context
- `pre-compact.js` runs second -- more thorough but slower DB write

---

## Stop (8 hooks)

Session summary -> auto-learning check -> warnings -> memory extraction -> review -> validation.

| position: 1 | `session-end.js` | standard | Write session summary to memory DB |
|---|---|---|---|
| position: 2 | `auto-learning-pipeline.js` | standard | Enforce fix→incident→rule→enforcement pipeline completion |
| position: 3 | Uncommitted changes warning | standard (inline) | Alert user about unstaged work |
| position: 4 | `memory-auto-extract.sh` | standard | Auto-extract memories from DB observations |
| position: 5 | `auto-review-on-stop.sh` | strict | Automated code review of session changes |
| position: 6 | `surface-review-findings.sh` | strict | Display review findings to user |
| position: 7 | `validate-deliverables.sh` | strict | Final deliverable validation |
| position: 8 | `pattern-extractor.sh` | advisory | Extract new patterns from session |

**Dependencies**:
- `session-end.js` MUST be position 1 -- writes DB data that `memory-auto-extract.sh` reads
- `auto-learning-pipeline.js` MUST run early -- needs to output mandatory instructions before session ends
- `memory-auto-extract.sh` MUST come after `session-end.js` -- depends on DB observations
- `surface-review-findings.sh` MUST come after `auto-review-on-stop.sh` -- displays its output
- `pattern-extractor.sh` runs last -- advisory tier (skipped in minimal/standard profiles)

---

## Ordering Constraints (machine-readable)

These constraints are validated by `scripts/hooks/validate-hook-order.sh`:

```
# Format: EVENT:HOOK_A must_precede HOOK_B [reason]
SessionStart:session-start.js must_precede memory-integrity-check.sh [writes DB state]
PostToolUse:output-secret-filter.sh must_precede pattern-feedback.sh [security before feedback]
PostToolUse:output-secret-filter.sh must_precede post-tool-use.js [security before tracking]
PostToolUse:pattern-feedback.sh must_precede compaction-advisor.sh [feedback before counting]
Stop:session-end.js must_precede memory-auto-extract.sh [DB write before memory extraction]
Stop:memory-auto-extract.sh must_precede auto-review-on-stop.sh [memory extraction before code review]
Stop:auto-review-on-stop.sh must_precede surface-review-findings.sh [generate before display]
Stop:session-end.js must_precede pattern-extractor.sh [DB write before pattern extraction]
PreCompact:git_status_inline must_precede pre-compact.js [fast capture before DB write]
```

---

*Validates against: `.claude/settings.json` hook arrays*
