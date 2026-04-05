---
name: massu-golden-path
description: "When user wants full autonomous implementation: 'build this', 'implement this feature', 'golden path', or provides a plan file to execute end-to-end"
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*), Task(*), mcp__plugin_playwright_playwright__*, mcp__playwright__*
---
name: massu-golden-path

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9 enforced.

# Massu Golden Path: Requirements to Production Push

## Objective

Execute the COMPLETE development workflow in one continuous run:
**Requirements -> Plan Creation -> Plan Audit -> Implementation -> Gap Analysis -> Simplification -> Commit -> Push**

This command has FULL FEATURE PARITY with the individual commands it replaces:
`/massu-create-plan` -> `/massu-plan` -> `/massu-loop` -> `/massu-loop-playwright` -> `/massu-simplify` -> `/massu-commit` -> `/massu-push`

---

## NON-NEGOTIABLE RULES

- **Complete workflow (CR-11)** -- ALL phases must execute, no skipping. 100% plan coverage required
- **Zero failures** -- Each phase gate must pass before proceeding
- **Proof required (CR-1)** -- VR-* output pasted, not summarized. "I verified" without output = invalid
- **FIX ALL ISSUES AT ALL SEVERITY LEVELS (CR-9 + CR-45)** -- Whether from current changes or pre-existing. CRITICAL, HIGH, MEDIUM, LOW — ALL get fixed. No severity is exempt. This applies to security findings, gap analysis, enhancement analysis, code review, simplification, and every other review phase
- **MEMORY IS MANDATORY (CR-38)** -- Persist ALL learnings before session ends
- **Stagnation bail-out (CR-37)** -- If same item fails 3+ times, replan instead of grinding

---

## APPROVAL POINTS (Max 4 Pauses, 5 with --competitive)

```
+-----------------------------------------------------------------------------+
|   THIS COMMAND RUNS STRAIGHT THROUGH THE ENTIRE GOLDEN PATH.                |
|   IT ONLY PAUSES FOR THESE APPROVAL POINTS:                                 |
|                                                                              |
|   1. PLAN APPROVAL - After plan creation + audit (user reviews plan)         |
|   2. NEW PATTERN APPROVAL - If a new pattern is needed (during any phase)    |
|   3. COMMIT APPROVAL - Before creating the commit                            |
|   4. PUSH APPROVAL - Before pushing to remote                                |
|   5. WINNER SELECTION - After competitive scoring (--competitive only)       |
|                                                                              |
|   EVERYTHING ELSE RUNS AUTOMATICALLY WITHOUT STOPPING.                      |
+-----------------------------------------------------------------------------+
```

Read `references/approval-points.md` for the exact format and options for each approval point.

After receiving approval, immediately continue. Do NOT ask "shall I continue?" -- just proceed.

---

## INPUT MODES

| Mode | Input | Behavior |
|------|-------|----------|
| **Task Description** | `/massu-golden-path "Implement feature X"` | Full flow from Phase 0 |
| **Plan File** | `/massu-golden-path /path/to/plan.md` | Skip to Phase 1C (audit) |
| **Continue** | `/massu-golden-path "Continue [feature]"` | Resume from session state |
| **Competitive** | `/massu-golden-path --competitive "task"` | Spawn 2-3 competing implementations with bias presets, score, select winner |
| **Competitive (3 agents)** | `/massu-golden-path --competitive --agents 3 "task"` | 3 agents with quality/ux/robust biases (default: 2 agents = quality + robust) |

---

## PHASE OVERVIEW

| Phase | Name | Key Actions | Approval Gate |
|-------|------|-------------|---------------|
| 0 | Requirements & Context | Session context, ambiguity detection, interview loop | -- |
| 1 | Plan Creation & Audit | Research, plan generation, audit loop | PLAN APPROVAL |
| 2 | Implementation | Item loop, multi-perspective review, verification audit, browser testing | NEW PATTERN (if needed) |
| 2-COMP | Competitive Implementation | Spawn N agents with bias presets, score, select winner (`--competitive` only) | WINNER SELECTION |
| 2.5 | Gap & Enhancement Analysis | Find+fix gaps, UX issues, security, pattern compliance; loop until zero | -- |
| 3 | Simplification | Pattern scanner, parallel semantic review, apply findings | -- |
| 4 | Pre-Commit Verification | Verification gates, quality scoring | COMMIT APPROVAL |
| 5 | Push Verification | Push verification checks, CI monitoring | PUSH APPROVAL |
| 6 | Completion | Final report, plan update, auto-learning | -- |

---

## PHASE 0: REQUIREMENTS & CONTEXT LOADING

Read `references/phase-0-requirements.md` for full details.

**Summary**: Load session context via memory files. Build a 10-dimension requirements coverage map (D1-D10). Run ambiguity detection (7 signals). If ambiguity score >= 2, enter interview loop. Fast-track to Phase 1 when D1, D2, D5 covered or user says "skip" / "just do it".

---

## PHASE 1: PLAN CREATION & AUDIT

Read `references/phase-1-plan-creation.md` for full details.

**Summary**: Three sub-phases:
- **1A: Research & Reality Check** -- Feature understanding, config/schema reality check, config-code alignment, codebase check, blast radius analysis (CR-25), pattern compliance, tool registration check, question filtering, security pre-screen (5 dimensions).
- **1B: Plan Generation** -- Write plan to `docs/plans/[YYYY-MM-DD]-[feature-name].md` with P-XXX numbered items across 5 phases.
- **1C: Plan Audit Loop** -- Subagent architecture. Iterate until GAPS_DISCOVERED = 0. Max 10 iterations.

**Gate**: APPROVAL POINT #1: PLAN

---

## PHASE 2: IMPLEMENTATION

Read `references/phase-2-implementation.md` for full details.

**Summary**: Seven sub-phases:
- **2A**: Extract plan items into tracking table, initialize session state
- **2B**: Implementation loop (pre-check, execute, guardrail, verify, update per item)
- **2C**: Multi-perspective review (3 parallel agents: security, architecture, quality)
- **2D**: Verification audit loop (subagent, circuit breaker CR-37, max 10 iterations)
- **2E**: Post-build reflection + memory persist (CR-38)
- **2F**: Documentation sync (if user-facing features)
- **2G**: Browser verification & fix loop (auto-triggers if UI files changed, Playwright MCP)

**Gate**: APPROVAL POINT #2: NEW PATTERN (if needed, any sub-phase)

---

## PHASE 2.5: GAP & ENHANCEMENT ANALYSIS

Read `references/phase-2.5-gap-analyzer.md` for full details.

**Summary**: After implementation completes, run a continuous gap and enhancement analysis loop. A subagent analyzes all changed files across 6 categories (functional gaps, UX gaps, data integrity, security, pattern compliance, enhancements). Every gap/enhancement found is fixed immediately. The loop re-runs until a full pass discovers ZERO gaps. Max 10 iterations. Skippable only for documentation-only changes or explicit user request.

---

## PHASE 3: SIMPLIFICATION

Read `references/phase-3-simplify.md` for full details.

**Summary**: Fast gate (pattern scanner), then 3 parallel semantic review agents (efficiency, reuse, pattern compliance). Apply ALL findings sorted by severity. Re-run pattern scanner.

---

## PHASE 4: PRE-COMMIT VERIFICATION

Read `references/phase-4-commit.md` for full details.

**Summary**: Auto-verification gates (pattern scanner, tsc, build, tests, hooks, generalization, security, secrets, tool registration, plan coverage, plan status, dep security). Quality scoring gate. Auto-fix on failure.

**Gate**: APPROVAL POINT #3: COMMIT

---

## PHASE 5: PUSH VERIFICATION & PUSH

Read `references/phase-5-push.md` for full details.

**Summary**: Pre-flight (commits to push). Tier 1: quick re-verification. Tier 2: test suite with mandatory regression detection. Tier 3: security & compliance. Tier 4: final gate.

**Gate**: APPROVAL POINT #4: PUSH

---

## PHASE 6: COMPLETION

Read `references/phase-6-completion.md` for full details.

**Summary**: Final report with phase-by-phase status. Plan document update (IMPLEMENTATION STATUS at top). Auto-learning protocol (memory updates for all fixes/patterns). Session state update.

---

## Skill Contents

This skill is a folder. The following files are available for reference:

| File | Purpose | Read When |
|------|---------|-----------|
| `references/phase-0-requirements.md` | Requirements interview, ambiguity detection, 10-dimension coverage map | Starting a new implementation from a task description |
| `references/phase-1-plan-creation.md` | Config/schema reality check, blast radius analysis, plan generation, audit loop | Writing or auditing a plan |
| `references/phase-2-implementation.md` | Item loop, multi-perspective review, verification audit, browser testing | Executing implementation; any Phase 2 sub-phase |
| `references/phase-2.5-gap-analyzer.md` | Gap/enhancement analysis loop, 6 categories, fix-and-repass until zero | After implementation, before simplification |
| `references/phase-3-simplify.md` | Pattern scanner fast gate, dead code detection, parallel semantic review agents | Running simplification after implementation |
| `references/phase-4-commit.md` | Auto-verification gates, quality scoring, commit format | Preparing a commit |
| `references/phase-5-push.md` | Pre-flight, 4-tier push verification, regression detection | Preparing to push to remote |
| `references/phase-6-completion.md` | Final report, plan status update, auto-learning | After push; completing the golden path |
| `references/approval-points.md` | Exact format and options for all 4 approval points (5 with --competitive: Plan, New Pattern, Winner Selection, Commit, Push) | Presenting any approval gate to the user |
| `references/competitive-mode.md` | Competitive mode protocol: agent spawning, scoring, winner selection | Using --competitive flag |
| `references/error-handling.md` | Abort handling, non-recoverable errors, post-compaction re-verification, competitive mode errors | On user abort, blocker error, or after context compaction |

---

## Gotchas

- **Compaction mid-loop loses plan state** -- if context compaction occurs during implementation, the plan file path and current item must be recoverable from session-state/CURRENT.md
- **UI items need browser verification** -- any plan item touching UI files must be verified with Playwright before claiming done
- **Approval points must not be skipped** -- there are 4 approval gates (5 with --competitive: Plan, New Pattern, Winner Selection, Commit, Push). Skipping any gate is a violation
- **Plan file must be re-read from disk, not memory (CR-5)** -- after compaction, always re-read the plan file. Memory of plan contents drifts from reality
- **100% coverage required (CR-11)** -- never stop early. "Most items done" is not "all items done"
- **--competitive increases token cost ~2-3x for Phase 2** -- use for high-stakes features only
- **Competing agents do NOT run database migrations** -- DB changes must be applied separately before competitive mode
- **Worktree branches must be mergeable** -- competing agents edit different files from the same plan, but shared files may conflict
- **Bias presets are suggestions, not constraints** -- agents may deviate if the plan requires a specific approach

---

## Quality Scoring Criteria

| Dimension | Weight | Measured By |
|-----------|--------|-------------|
| Code Clarity | 1-5 | Naming, structure, comments |
| Pattern Compliance | 1-5 | CLAUDE.md patterns followed |
| Error Handling | 1-5 | Edge cases, validation, fallbacks |
| Test Coverage | 1-5 | Test files exist for new code |
| Config-Driven Design | 1-5 | No hardcoded project-specific values |

All >= 3: PASS. Any < 3: FAIL.

---

## START NOW

**Step 0: Write AUTHORIZED_COMMAND to session state (CR-35)**

Update `session-state/CURRENT.md`:
```
AUTHORIZED_COMMAND: massu-golden-path
```

1. **Determine input**: Task description, plan file, or continue
2. **Phase 0**: Requirements & context (if task description)
3. **Phase 1**: Plan creation & audit -> **PAUSE: Plan Approval**
4. **Phase 2**: Implementation with verification loops + browser verification (UI changes)
4a. **Phase 2-COMP**: Competitive implementation (if --competitive) -> **PAUSE: Winner Selection**
5. **Phase 2.5**: Gap & enhancement analysis loop (until zero gaps)
6. **Phase 3**: Simplification (efficiency, reuse, patterns)
7. **Phase 4**: Pre-commit verification -> **PAUSE: Commit Approval**
8. **Phase 5**: Push verification -> **PAUSE: Push Approval**
9. **Phase 6**: Completion, learning, quality metrics

**This command does NOT stop to ask "should I continue?" -- it runs straight through.**
