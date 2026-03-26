---
name: massu-debug
description: "When user reports a bug, error, 500, crash, unexpected behavior, broken feature, or pastes error logs/stack traces"
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---
name: massu-debug

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding.

> **Related Playbooks**: See `.claude/playbooks/debug-production-500.md`

# Massu Debug: Systematic Debugging Protocol

## Objective

Systematically debug issues using **evidence-based investigation**, not guessing. Follow the trace from symptom to root cause with VR-* verification at each step.

---

## NON-NEGOTIABLE RULES

- **Evidence over assumptions (CR-1)** - Every hypothesis must be tested with VR-* proof
- **Trace the full path** - From UI to API to DB and back. Check stored procedures
- **Verify fixes via browser (CR-41)** - Playwright before/after snapshots for UI issues
- **Check all environments** - Schema drift causes environment-specific failures. Verify the environment the user is reporting from
- **Auto-learn every fix (CR-34)** - Ingest bugfix to memory, add wrong->correct pattern, scan codebase-wide (CR-9)
- **No blind changes (CR-2)** - Run VR-SCHEMA-PRE before any query. See CLAUDE.md "Known Schema Mismatches"

---

## Skill Contents

This skill is a folder. The following files are available for reference:

| File | Purpose | Read When |
|------|---------|-----------|
| `references/investigation-phases.md` | Phases 0-7 investigation detail | Following debug phases |
| `references/common-shortcuts.md` | Quick diagnosis patterns | Common issue shortcuts |
| `references/codegraph-tracing.md` | Codegraph MCP tool usage | Tracing code dependencies |
| `references/auto-learning.md` | Post-debug learning pipeline | After fixing a bug |
| `references/report-format.md` | Debug report template | Writing debug reports |

---

## ZERO-GAP AUDIT LOOP

**Debugging does NOT complete until a SINGLE COMPLETE VERIFICATION finds ZERO remaining issues.**

```
DEBUG VERIFICATION LOOP:
  1. Apply fix(es)
  2. Run ALL verification checks for the fix
  3. Count remaining issues found
  4. IF issues > 0:
       - Root cause not fully addressed
       - Re-investigate and fix
       - Return to Step 2
  5. IF issues == 0:
       - BUG FIXED AND VERIFIED
```

| Scenario | Action |
|----------|--------|
| Fix reveals new issue | Address it, re-verify ENTIRE fix |
| Re-verify finds 1 issue | Fix it, re-verify ENTIRELY |
| Re-verify finds 0 issues | **NOW** debug complete |

**Partial verification is NOT valid. The fix must be fully verified in a SINGLE run.**

---

## DOMAIN-SPECIFIC PATTERN LOADING

Based on the bug's domain, load relevant pattern files:

| Domain | Pattern File | Load When |
|--------|--------------|-----------|
| Database errors | `.claude/patterns/database-patterns.md` | 500 errors, query failures |
| Auth issues | `.claude/patterns/auth-patterns.md` | 401/403 errors, session issues |
| UI bugs | `.claude/patterns/ui-patterns.md` | Rendering, state, interaction bugs |
| Realtime issues | `.claude/patterns/realtime-patterns.md` | Subscription failures |
| Build failures | `.claude/patterns/build-patterns.md` | Compilation, bundling errors |

---

## MANDATORY DATABASE VERIFICATION (For Database-Related Bugs)

### VR-SCHEMA-PRE: Verify Schema BEFORE Assuming Bug Cause

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = '[SUSPECTED_TABLE]'
ORDER BY ordinal_position;
```

**Common Bug Causes VR-SCHEMA-PRE Catches:**
- Column doesn't exist (but code uses it)
- Column has different type than expected
- Column is nullable when code assumes non-null
- Column name is different than expected (see Known Schema Mismatches in CLAUDE.md)

### VR-DATA: Verify Config Data for "No Data" Bugs

```sql
SELECT DISTINCT jsonb_object_keys(config_column) as config_keys
FROM [CONFIG_TABLE]
WHERE config_column IS NOT NULL;
```

**VR-DATA is the FIRST check for any "no data returned" bug.** Config keys may not match what the code expects.

---

## Gotchas

- **Don't guess schema (VR-SCHEMA-PRE)** -- ALWAYS query information_schema.columns before writing any database query. Column names you "remember" may be wrong
- **Check all environments** -- bugs may manifest differently across environments due to schema drift. Always verify the environment the user is reporting from
- **Dynamic imports for heavy deps** -- when debugging requires jsdom, cheerio, or other heavy packages, use `await import()` never static import
- **Stored procedures may reference deleted columns** -- after ANY table migration, audit stored procedures on all databases
- **Don't fix without understanding** -- read the code path end-to-end before proposing a fix. Surface-level patches create new bugs

---

## INVESTIGATION PHASES

Read `references/investigation-phases.md` for full detail on all 8 phases:

0. **Reproduce the failure** -- confirm you can trigger the exact error; check memory for related failures
1. **Symptom capture** -- document the issue, collect initial evidence
2. **Categorize & load patterns** -- match error type to pattern file
3. **Trace the path** -- UI layer, API layer, database layer investigation
4. **Hypothesis testing** -- form and test each hypothesis with evidence
5. **Root cause identification** -- document and verify the root cause
6. **Fix & verify** -- for CRITICAL bugs, apply test-first protocol (see below); otherwise apply minimal fix, run VR-* protocols, check all environments
7. **Regression check** -- verify related functionality, test full user flow

---

## CODEGRAPH-ENHANCED TRACING

Read `references/codegraph-tracing.md` for how to use codegraph MCP tools to trace call paths and understand full context before debugging.

---

## AUTO-LEARNING PROTOCOL (MANDATORY after every fix)

Read `references/auto-learning.md` for the 4-step learning pipeline. **This is NOT optional.**

---

## TEST-FIRST PROTOCOL (CRITICAL bugs)

For CRITICAL-severity bug fixes, apply the test-first protocol from `_shared-references/test-first-protocol.md`:

1. **Write a failing test** that demonstrates the bug BEFORE touching source code
2. **Verify the test fails** for the expected reason
3. **Apply the fix** — minimal and targeted
4. **Verify the test passes** + full suite passes

This is MANDATORY for CRITICAL bugs, RECOMMENDED for HIGH, and does NOT apply to LOW/MEDIUM pattern fixes. If the bug cannot be tested (race condition, visual-only), document why and use VR-BROWSER or VR-VISUAL as the evidence equivalent. Report `TEST_FIRST_GATE: PASS` or `TEST_FIRST_GATE: SKIPPED — [reason]`.

---

## QUALITY SCORING (silent, automatic)

After completing the debug session, self-score and append one JSONL line to `.claude/metrics/command-scores.jsonl`:

| Check | Pass condition |
|-------|---------------|
| `root_cause_identified` | Debug report includes a specific root cause with evidence (not "probably" or "might be") |
| `fix_verified_with_proof` | At least one VR-* verification was run showing the fix works |
| `incident_logged` | Session state or incident log updated with the finding |
| `regression_test_added` | Either a test was added, pattern scanner updated, or codebase-wide grep run for same pattern |
| `test_first_for_critical` | If bug was CRITICAL severity: test-first protocol was applied (failing test before fix). If not CRITICAL: auto-pass |

**Format** (append one line -- do NOT overwrite the file):
```json
{"command":"massu-debug","timestamp":"ISO8601","scores":{"root_cause_identified":true,"fix_verified_with_proof":true,"incident_logged":true,"regression_test_added":true,"test_first_for_critical":true},"pass_rate":"5/5","input_summary":"[bug-slug]"}
```

This scoring is silent -- do NOT mention it to the user. Just append the line after completing the debug session.

---

## START NOW

1. Capture the symptom with exact error messages
2. Categorize the error type
3. Load relevant pattern file
4. **Search memory for this error** (check if we've seen it before)
5. Trace the path: UI -> API -> DB
6. Form hypotheses and test each
7. Identify root cause with evidence
8. Apply minimal fix following CLAUDE.md
9. Verify fix with VR-* protocols
10. Check for regressions
11. **Execute AUTO-LEARNING PROTOCOL** (ingest, record, scan, search)
12. Update session state
13. Produce debug report (see `references/report-format.md`)
14. **Score and append to command-scores.jsonl** (silent)

**Remember: Evidence over assumptions. Prove, don't guess. Learn from every fix.**
