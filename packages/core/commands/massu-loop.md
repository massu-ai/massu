---
name: massu-loop
description: "When user wants to implement a plan autonomously -- 'implement this plan', 'start the loop', 'execute', or provides a plan file to implement end-to-end"
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---
name: massu-loop

# Massu Loop: Autonomous Execution Protocol

**Shared rules**: Read `.claude/commands/_shared-preamble.md` before proceeding.

---

## Workflow Position

```
/massu-create-plan -> /massu-plan -> /massu-loop -> [/massu-simplify] -> /massu-commit -> /massu-push
(CREATE)           (AUDIT)        (IMPLEMENT)    (QUALITY)         (COMMIT)        (PUSH)
```

**This command is step 3 of 5 in the standard workflow. /massu-simplify is an optional quality step after implementation.**

---

## Skill Contents

This skill is a folder. The following files are available for reference:

| File | Purpose | Read When |
|------|---------|-----------|
| `references/loop-controller.md` | Mandatory loop controller spec | Understanding loop mechanics |
| `references/plan-extraction.md` | Plan item extraction rules | Parsing plan documents |
| `references/iteration-structure.md` | Per-item implementation flow | During each iteration |
| `references/guardrails.md` | 10 accountability safeguards | Ensuring quality |
| `references/checkpoint-audit.md` | Checkpoint audit protocol | At checkpoints |
| `references/vr-plan-spec.md` | VR-PLAN verification details | Verifying plan items |
| `references/auto-learning.md` | Post-loop learning pipeline | After loop completion |

---

## Gotchas

- **Stagnating loops must bail (CR-37)** -- if the same item fails 3+ times with the same error, stop the loop, document the blocker, and replan. Grinding wastes context
- **100% coverage required (CR-11)** -- never stop early. Every single plan item must be implemented and verified. "Most items done" is failure
- **Backend without UI violates CR-12** -- if you implement a backend procedure, it MUST be called from the UI. Orphan procedures are invisible features
- **Plan file must be re-read from disk (CR-5)** -- after ANY compaction or long pause, re-read the plan file. Memory of plan contents drifts
- **Compaction risk** -- long loops may trigger context compaction; update `session-state/CURRENT.md` after each iteration so recovery can resume cleanly

---

## External Loop Mode

For large plans or sessions at risk of context exhaustion, use the **external bash loop** to spawn fresh Claude CLI sessions per plan item:

```bash
bash scripts/loop-external.sh --plan /path/to/plan.md [--max-iterations N] [--dry-run]
```

Each iteration gets a clean 200K context window. The bash outer loop handles:
- Plan item extraction and sequencing
- State tracking in `.claude/loop-state/external-loop.json`
- Inter-iteration quality gate (`pattern-scanner.sh`)
- Hook profile propagation via `MASSU_HOOK_PROFILE`

**When to use**: Plans with 15+ items, sessions already at high context usage, or when compaction risk is high.

**Safety**: Does NOT use `--dangerously-skip-permissions`. Safety model is fully preserved.

---

## Objective

Execute task/plan autonomously with **verified proof at every step**. Continue until ZERO gaps with VR-* evidence. Claims without proof are invalid.

---

## COMPLETION MANDATE (CR-11, CR-21)

Loop does NOT stop until: (1) every plan item verified 100%, (2) every VR-* check passes with proof, (3) pattern scanner 0 violations, (4) build passes, (5) tsc --noEmit 0 errors, (6) ALL tests pass (npm test exit 0), (7) lint passes. Test failures must be fixed regardless of origin. No deferral, no "should I continue?", no partial progress reports.

---

## NON-NEGOTIABLE RULES

1. **Never claim without proof (CR-1)** - VR-* output must be pasted. "I verified" without output = invalid
2. **Recursive audit until zero gaps** - Fix and re-verify until gaps = 0
3. **Schema verification required (CR-2)** - ALWAYS query database before using column names. See CLAUDE.md "Known Schema Mismatches"
4. **Session state after every iteration** - Update CURRENT.md so compaction recovery can resume (CR-12)
5. **Component reuse is mandatory** - Check existing before creating new
6. **User flow audit required (CR-12)** - Backend without UI = invisible feature. Technical audits alone are NOT sufficient
7. **Document new patterns immediately (CR-34)** - Ingest to memory, record pattern, update scanner
8. **Pattern scanner must pass** - `./scripts/pattern-scanner.sh` exit 0 required before claiming complete
9. **No workarounds allowed** - TODOs, ts-ignore are BLOCKING violations
10. **NO HARDCODED TAILWIND COLORS** - Use semantic CSS classes from globals.css (VR-TOKEN)
11. **FIX ALL ISSUES ENCOUNTERED (CR-9)** - Fix immediately regardless of origin. "Not in scope" is NEVER valid
12. **Stagnation bail-out (CR-37)** - If same item fails 3+ times with same error, stop loop and replan

---

## PRE-EXECUTION CHECKLIST

Before starting, verify:

```bash
ls -la ./scripts/pattern-scanner.sh
touch session-state/CURRENT.md
ls -la [PLAN_FILE_PATH]
```

Initialize session state:
```markdown
## MASSU LOOP SESSION
- **Task**: [description]
- **Status**: IN_PROGRESS
- **Iteration**: 1
- **Phase**: 1
```

---

**VR-* Reference**: See CLAUDE.md VR table and `.claude/reference/vr-verification-reference.md`.

---

## QUALITY SCORING (silent, automatic)

After completing the loop (zero gaps achieved), self-score against these checks and append one JSONL line to `.claude/metrics/command-scores.jsonl`:

| Check | Pass condition |
|-------|---------------|
| `all_items_verified_with_proof` | Every plan item has VR-* verification output showing proof |
| `multi_perspective_review_spawned` | At least one auditor subagent was spawned for verification |
| `gaps_reached_zero` | Final auditor pass returned `GAPS_DISCOVERED: 0` |
| `memory_persisted` | AUTO-LEARNING PROTOCOL executed: at least one memory file update |

**Format** (append one line -- do NOT overwrite the file):
```json
{"command":"massu-loop","timestamp":"ISO8601","scores":{"all_items_verified_with_proof":true,"multi_perspective_review_spawned":true,"gaps_reached_zero":true,"memory_persisted":true},"pass_rate":"4/4","input_summary":"[plan-slug]"}
```

This scoring is silent -- do NOT mention it to the user. Just append the line after completing the loop.

---

## START NOW

**Step 0: Write AUTHORIZED_COMMAND to session state (CR-12)**

Before any other work, update `session-state/CURRENT.md` to include:
```
AUTHORIZED_COMMAND: massu-loop
```
This ensures that if the session compacts, the recovery protocol knows `/massu-loop` was authorized.

**Execute the LOOP CONTROLLER (see [references/loop-controller.md](references/loop-controller.md)).**

### Phase 0: Pre-Implementation Memory Check
0. **Search memory** for failed attempts and known issues related to the plan's domain:
   - Search memory for keywords from the plan
   - Search memory for file paths being modified
   - If matches found: read the previous failures and avoid repeating them

### Phase 1: Implement
1. Load plan file from `$ARGUMENTS` (read from disk, not memory)
2. Extract ALL plan items into trackable checklist (see [references/plan-extraction.md](references/plan-extraction.md))
3. Implement each item with VR-* proof (see [references/iteration-structure.md](references/iteration-structure.md))
4. Update session state after each major step

### Phase 1.5: Multi-Perspective Review
Spawn 3 focused review subagents IN PARALLEL (Principle #20):
- **Security reviewer**: vulnerabilities, auth gaps, input validation, data exposure
- **Architecture reviewer**: design issues, coupling, pattern compliance, scalability
- **UX reviewer**: user experience, accessibility, loading/error/empty states, consistency

Fix CRITICAL/HIGH findings before proceeding. WARN findings: document and proceed.

### Phase 2: Verify (Subagent Loop)
5. Spawn `plan-auditor` subagent (via Task tool) for verification iteration 1
6. Parse `GAPS_DISCOVERED` from the subagent result (see [references/loop-controller.md](references/loop-controller.md))
7. If gaps > 0: fix what the auditor identified, spawn another iteration
8. If gaps == 0: output final completion report with dual gate evidence
9. Continue until zero gaps or maximum 10 iterations

### Phase 2.1: Post-Build Reflection + MANDATORY Memory Persist (CR-38)
See [references/auto-learning.md](references/auto-learning.md) for full protocol.

### Phase 3: Auto-Learning (MANDATORY)
10. Execute AUTO-LEARNING PROTOCOL (see [references/auto-learning.md](references/auto-learning.md))

**The auditor subagent handles**: reading the plan, verifying all deliverables, checking patterns/build/types, fixing plan document gaps, and returning structured results.

**You (the loop controller) handle**: implementation, spawning auditors, parsing results, fixing code-level gaps, looping, learning.

**Remember: Claims without proof are invalid. Show the verification output.**

---

## COMPLETION CRITERIA

See [references/vr-plan-spec.md](references/vr-plan-spec.md) for full dual-gate verification and completion output format.

Massu Loop is COMPLETE **only when BOTH gates pass: Code Quality AND Plan Coverage**.

### GATE 1: Code Quality (All Must Pass)
- [ ] Pattern scanner: Exit 0
- [ ] Type check: 0 errors
- [ ] Build: Exit 0
- [ ] Lint: Exit 0
- [ ] Tests: ALL PASS (MANDATORY)
- [ ] Security: No secrets staged
- [ ] VR-RENDER: All UI components rendered in pages

### GATE 2: Plan Coverage
- [ ] Plan file read (actual file, not memory)
- [ ] ALL items extracted into tracking table
- [ ] EACH item verified with VR-* proof
- [ ] Coverage = 100% (99% = FAIL)
- [ ] Plan document updated with completion status

**Code Quality: PASS + Plan Coverage: FAIL = NOT COMPLETE**
