---
name: massu-loop
description: "When user wants to implement a plan autonomously — 'implement this plan', 'start the loop', 'execute', or provides a plan file to implement end-to-end"
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*), Task(*)
---

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding.

> **Config lookup (framework-aware)**: This command reads `config.framework.type` and `config.verification.<primary_language>` from `massu.config.yaml` to choose the right verification commands. Hardcoded references below to `packages/core`, `tools.ts`, `vitest`, `VR-TOOL-REG`, and `VR-HOOK-BUILD` are **MCP-project specific** and only apply when `config.framework.type === 'mcp'` (or `languages.typescript.runtime === 'mcp'`). For other projects, substitute: type-check → `config.verification.<primary_language>.type`, tests → `.test`, build → `.build`, lint → `.lint`. See `.claude/reference/vr-verification-reference.md` for the config-driven VR-* catalog.

name: massu-loop

# CS Loop: Autonomous Execution Protocol

**Shared rules**: Read `.claude/commands/_shared-preamble.md` for POST-COMPACTION (CR-35), QUALITY STANDARDS (CR-14), FIX ALL ISSUES (CR-9) rules.

---

## Workflow Position

```
/massu-create-plan -> /massu-plan -> /massu-loop -> [/massu-simplify] -> /massu-commit -> /massu-push
(CREATE)           (AUDIT)        (IMPLEMENT)    (QUALITY)           (COMMIT)        (PUSH)
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

- **Stagnating loops must bail** -- if the same item fails 3+ times with the same error, stop the loop, document the blocker, and replan. Grinding wastes context
- **100% coverage required** -- never stop early. Every single plan item must be implemented and verified. "Most items done" is failure
- **New tools must be wired (CR-11)** -- if you implement a new MCP tool, it MUST be wired into tools.ts with the 3-function pattern. Unwired tools are invisible
- **Plan file must be re-read from disk** -- after ANY compaction or long pause, re-read the plan file. Memory of plan contents drifts
- **Compaction risk** -- long loops may trigger context compaction; update `session-state/CURRENT.md` after each iteration so recovery can resume cleanly

---

## Objective

Execute task/plan autonomously with **verified proof at every step**. Continue until ZERO gaps with VR-* evidence. Claims without proof are invalid.

---

## COMPLETION MANDATE

Loop does NOT stop until: (1) every plan item verified 100%, (2) every VR-* check passes with proof, (3) pattern scanner 0 violations, (4) type check passes, (5) ALL tests pass (npm test exit 0), (6) hook build succeeds. Test failures must be fixed regardless of origin. No deferral, no "should I continue?", no partial progress reports. Register features with massu_sentinel (CR-11).

---

## NON-NEGOTIABLE RULES

1. **Never claim without proof (CR-1)** - VR-* output must be pasted. "I verified" without output = invalid
2. **Recursive audit until zero gaps** - Fix and re-verify until gaps = 0
3. **Session state after every iteration** - Update CURRENT.md so compaction recovery can resume (CR-35)
4. **Component reuse is mandatory** - Check existing modules before creating new
5. **Tool wiring audit required (CR-11)** - New tools must be wired into tools.ts with 3-function pattern
6. **Document new patterns immediately (CR-34)** - Ingest to memory, record pattern, update scanner
7. **Pattern scanner must pass** - `bash scripts/massu-pattern-scanner.sh` exit 0 required before claiming complete
8. **No workarounds allowed** - TODOs, ts-ignore are BLOCKING violations
9. **FIX ALL ISSUES ENCOUNTERED (CR-9)** - Fix immediately regardless of origin. "Not in scope" is NEVER valid
10. **Stagnation bail-out** - If same item fails 3+ times with same error, stop loop and replan

---

## PRE-EXECUTION CHECKLIST

Before starting, verify:

```bash
ls -la ./scripts/massu-pattern-scanner.sh
touch session-state/CURRENT.md
ls -la [PLAN_FILE_PATH]
```

Initialize session state:
```markdown
## CS LOOP SESSION
- **Task**: [description]
- **Status**: IN_PROGRESS
- **Iteration**: 1
- **Phase**: 1
```

---

**VR-* Reference**: See CLAUDE.md VR table.

---

## QUALITY SCORING (silent, automatic)

After completing the loop (zero gaps achieved), self-score against these checks and append one JSONL line to `.claude/metrics/command-scores.jsonl`:

| Check | Pass condition |
|-------|---------------|
| `all_items_verified_with_proof` | Every plan item has VR-* verification output showing proof |
| `multi_perspective_review_spawned` | At least one auditor subagent was spawned for verification |
| `gaps_reached_zero` | Final auditor pass returned `GAPS_DISCOVERED: 0` |
| `memory_persisted` | AUTO-LEARNING PROTOCOL executed: at least one `massu_memory_ingest` call or memory file update |

**Format** (append one line -- do NOT overwrite the file):
```json
{"command":"massu-loop","timestamp":"ISO8601","scores":{"all_items_verified_with_proof":true,"multi_perspective_review_spawned":true,"gaps_reached_zero":true,"memory_persisted":true},"pass_rate":"4/4","input_summary":"[plan-slug]"}
```

This scoring is silent -- do NOT mention it to the user. Just append the line after completing the loop.

---

## START NOW

**Step 0: Write AUTHORIZED_COMMAND to session state (CR-35)**

Before any other work, update `session-state/CURRENT.md` to include:
```
AUTHORIZED_COMMAND: massu-loop
```
This ensures that if the session compacts, the recovery protocol knows `/massu-loop` was authorized.

**Execute the LOOP CONTROLLER (see [references/loop-controller.md](references/loop-controller.md)).**

### Phase 0: Pre-Implementation Memory Check
0. **Search memory** for failed attempts and known issues related to the plan's domain:
   - Check `.claude/session-state/CURRENT.md` for recent failures
   - Call `massu_memory_search` with file paths being modified
   - Call `massu_memory_failures` with keywords from the plan
   - If matches found: read the previous failures and avoid repeating them

### Phase 1: Implement
1. Load plan file from `$ARGUMENTS` (read from disk, not memory)
2. Extract ALL plan items into trackable checklist (see [references/plan-extraction.md](references/plan-extraction.md))
3. Implement each item with VR-* proof (see [references/iteration-structure.md](references/iteration-structure.md))
4. Update session state after each major step

### Phase 1.5: Multi-Perspective Review
Spawn focused review subagents IN PARALLEL (Principle #20):
- **Security reviewer**: vulnerabilities, auth gaps, input validation, data exposure
- **Architecture reviewer**: design issues, coupling, pattern compliance, scalability

Fix ALL findings at ALL severity levels before proceeding (CR-45). CRITICAL, HIGH, MEDIUM, LOW — all get fixed. No severity is exempt.

### Phase 2: Verify (Subagent Loop)
5. Spawn `general-purpose` subagent (via Task tool) for verification iteration 1
6. Parse `GAPS_DISCOVERED` from the subagent result (see [references/loop-controller.md](references/loop-controller.md))
7. If gaps > 0: fix what the auditor identified, spawn another iteration
8. If gaps == 0: output final completion report with dual gate evidence
9. Continue until zero gaps or maximum 10 iterations

### Phase 2.1: Post-Build Reflection + MANDATORY Memory Persist (CR-38)
See [references/auto-learning.md](references/auto-learning.md) for full protocol.

### Phase 3: Auto-Learning (MANDATORY)
10. Execute AUTO-LEARNING PROTOCOL (see [references/auto-learning.md](references/auto-learning.md))

**The auditor subagent handles**: reading the plan, verifying all deliverables, checking patterns/build/types, fixing plan document gaps, and returning structured results.

**You (the loop controller) handle**: implementation, spawning auditors, parsing results, fixing code-level gaps, looping, learning, and documentation.

**Remember: Claims without proof are invalid. Show the verification output.**

---

## COMPLETION CRITERIA

See [references/vr-plan-spec.md](references/vr-plan-spec.md) for full dual-gate verification and completion output format.

CS Loop is COMPLETE **only when BOTH gates pass: Code Quality AND Plan Coverage**.

### GATE 1: Code Quality (All Must Pass)
- [ ] Pattern scanner: Exit 0
- [ ] Type check: 0 errors
- [ ] Build: Exit 0
- [ ] Tests: ALL PASS (MANDATORY)
- [ ] Hook build: Exit 0
- [ ] Security: No secrets staged

### GATE 2: Plan Coverage
- [ ] Plan file read (actual file, not memory)
- [ ] ALL items extracted into tracking table
- [ ] EACH item verified with VR-* proof
- [ ] Coverage = 100% (99% = FAIL)
- [ ] Plan document updated with completion status

**Code Quality: PASS + Plan Coverage: FAIL = NOT COMPLETE**
