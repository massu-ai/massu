---
name: massu-plan-audit
description: "When user wants to create a plan AND audit it to zero gaps in one flow, says 'plan audit', 'create and audit plan', or needs the combined create-then-audit workflow"
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*), Task(*)
---

# Massu Plan-Audit: Autonomous Plan Creation + Zero-Gap Audit

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding.

## Workflow Position
This command COMBINES /massu-create-plan + /massu-plan into ONE uninterrupted flow.
**DISTINCT FROM**: `/massu-plan` (audit-only loop) and `/massu-create-plan` (plan creation only). This command is the autonomous combination of both.

## What This Command Does
1. Phase A: Create the plan (follows massu-create-plan protocol)
2. Phase B: IMMEDIATELY transition to audit loop (follows massu-plan protocol)
3. Phase C: Loop until zero gaps (no user intervention needed)
4. Phase D: Present zero-gap plan to user and STOP

## CRITICAL: NO MODE CONFUSION
- Do NOT enter plan mode. Work in normal mode throughout.
- Do NOT ask user "should I audit now?" — just do it.
- Do NOT exit early after plan creation — audit is MANDATORY.
- The ONLY stopping point is after a clean zero-gap audit pass.

## Execution Protocol

### Phase A: Plan Creation
1. Parse $ARGUMENTS as task description
2. Follow massu-create-plan Phase 1-6 (requirements, DB check, codebase check, patterns, security, generation)
3. Write plan document to `docs/plans/[date]-[name].md`
4. Do NOT present plan to user yet — proceed directly to Phase B

### Phase B: Audit Loop (IMMEDIATE — no pause)
5. Spawn massu-plan-auditor subagent for audit iteration 1
6. Parse GAPS_DISCOVERED from result
7. If gaps > 0: fix plan document, spawn another iteration
8. If gaps == 0: proceed to Phase C
9. Maximum 10 iterations

### Phase C: Present to User
10. Output plan summary with zero-gap certification
11. STOP and WAIT for user to run /massu-loop

## Rules
| Rule | Meaning |
|------|---------|
| No plan mode | Stay in normal mode throughout |
| No pauses between phases | A→B transition is automatic |
| Audit is mandatory | Creating plan without auditing = INCOMPLETE |
| Zero gaps required | Only zero-gap plan is presentable |
| Max 10 audit iterations | Bail and report if not converging |
| **VR-SPEC-MATCH** | For EVERY plan item with specific CSS classes, component names, layout instructions, or visual specs — the plan MUST include those EXACT strings as verifiable specs. If a plan item says "add a sidebar" without specifying classes/structure, that is a specificity gap. |

## Literal Spec Verification (Auditor Instruction)

**MANDATORY during every audit pass**: For EVERY plan item that contains specific CSS classes, component names, layout instructions, or visual specifications:

1. **Extract** the literal strings from the plan item (e.g., `ml-6`, `border-l-2`, `grid-cols-3`, `<Badge variant="outline">`)
2. **If auditing a plan document (pre-implementation)**: Verify each item has enough literal spec detail to enable VR-SPEC-MATCH during implementation. If an item says "add a card" but doesn't specify classes → **SPECIFICITY GAP**
3. **If auditing implementation (post-implementation)**: Grep the implementation files for those EXACT strings. Missing string = **VR-SPEC-MATCH failure = gap**

This prevents the failure mode where plans specify visual requirements loosely and implementations diverge from intent.
