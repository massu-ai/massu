---
name: massu-debug
description: "When user reports a bug, error, 500, crash, unexpected behavior, broken feature, or pastes error logs/stack traces"
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---
name: massu-debug

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9, CR-35 enforced.

# Massu Debug: Systematic Debugging Protocol

## Objective

Systematically debug issues using **evidence-based investigation**, not guessing. Follow the trace from symptom to root cause with VR-* verification at each step.

---

## NON-NEGOTIABLE RULES

- **Evidence over assumptions (CR-1)** - Every hypothesis must be tested with VR-* proof
- **Trace the full path** - From tool call to handler to output and back
- **Auto-learn every fix (CR-34)** - Ingest bugfix to memory, add wrong->correct pattern, scan codebase-wide (CR-9)
- **No blind changes (CR-2)** - Read the code path end-to-end before proposing a fix

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
| Tool issues | `.claude/patterns/tool-patterns.md` | Tool registration, handler bugs |
| Config issues | `.claude/patterns/config-patterns.md` | YAML, config.ts problems |
| Build failures | `.claude/patterns/build-patterns.md` | Compilation, bundling errors |
| Website issues | `.claude/patterns/website-patterns.md` | Next.js, Supabase errors |
| Hook issues | `.claude/patterns/hook-patterns.md` | esbuild, hook compilation |

---

## MANDATORY VERIFICATION COMMANDS

```bash
# Type check
cd packages/core && npx tsc --noEmit

# Tests
npm test

# Pattern scanner
bash scripts/massu-pattern-scanner.sh

# Hook build
cd packages/core && npm run build:hooks
```

---

## Gotchas

- **Don't fix without understanding** -- read the code path end-to-end before proposing a fix. Surface-level patches create new bugs
- **Check tool wiring** -- a tool may exist in its module but not be wired into tools.ts (3-function pattern)
- **Hook compilation** -- hooks use esbuild; a TypeScript error in a hook source may not show in `tsc --noEmit` but will fail in `npm run build:hooks`
- **Config interface drift** -- config.ts interface and massu.config.yaml may not match; always check both

---

## INVESTIGATION PHASES

Read `references/investigation-phases.md` for full detail on all 8 phases:

0. **Reproduce the failure** -- confirm you can trigger the exact error; check memory for related failures
1. **Symptom capture** -- document the issue, collect initial evidence
2. **Categorize & load patterns** -- match error type to pattern file
3. **Trace the path** -- tool call, handler, output layer investigation
4. **Hypothesis testing** -- form and test each hypothesis with evidence
5. **Root cause identification** -- document and verify the root cause
6. **Fix & verify** -- apply minimal fix, run VR-* protocols
7. **Regression check** -- verify related functionality, run full test suite

---

## CODEGRAPH-ENHANCED TRACING

Read `references/codegraph-tracing.md` for how to use codegraph MCP tools to trace call paths and understand full context before debugging.

---

## AUTO-LEARNING PROTOCOL (MANDATORY after every fix)

Read `references/auto-learning.md` for the 4-step learning pipeline. **This is NOT optional.**

---

## QUALITY SCORING (silent, automatic)

After completing the debug session, self-score and append one JSONL line to `.claude/metrics/command-scores.jsonl`:

| Check | Pass condition |
|-------|---------------|
| `root_cause_identified` | Debug report includes a specific root cause with evidence (not "probably" or "might be") |
| `fix_verified_with_proof` | At least one VR-* verification was run showing the fix works |
| `incident_logged` | Session state or incident log updated with the finding |
| `regression_test_added` | Either a test was added, pattern scanner updated, or codebase-wide grep run for same pattern |

**Format** (append one line -- do NOT overwrite the file):
```json
{"command":"massu-debug","timestamp":"ISO8601","scores":{"root_cause_identified":true,"fix_verified_with_proof":true,"incident_logged":true,"regression_test_added":true},"pass_rate":"4/4","input_summary":"[bug-slug]"}
```

This scoring is silent -- do NOT mention it to the user. Just append the line after completing the debug session.

---

## START NOW

1. Capture the symptom with exact error messages
2. Categorize the error type
3. Load relevant pattern file
4. **Search massu_memory_failures for this error** (check if we've seen it before)
5. Trace the path: tool call -> handler -> output
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
