---
name: massu-checkpoint
description: Execute checkpoint audit for current phase with full 15-step verification
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---
name: massu-checkpoint

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9, CR-35 enforced.

# Massu Checkpoint: Phase Boundary Audit Protocol

Both Code Quality and Plan Coverage gates must pass (see shared preamble). GAPS_DISCOVERED semantics and schema mismatches are also documented there.

---

## MANDATORY LOOP CONTROLLER (EXECUTE THIS - DO NOT SKIP)

### How This Command Works

This command is a **loop controller** for phase boundary verification:
1. Spawn a `massu-plan-auditor` subagent for ONE complete 15-step checkpoint pass
2. Parse the structured result (`GAPS_DISCOVERED: N`)
3. If gaps > 0: fix gaps, then spawn ANOTHER FRESH checkpoint pass
4. Only when a COMPLETE FRESH PASS discovers ZERO gaps does checkpoint pass

### Execution Protocol

```
iteration = 0

WHILE true:
  iteration += 1

  result = Task(subagent_type="massu-plan-auditor", model="opus", prompt="
    Checkpoint iteration {iteration}.
    Execute ONE complete 15-step checkpoint audit.
    Run all verification steps. Fix any gaps you find.

    CRITICAL: GAPS_DISCOVERED = total gaps FOUND during this pass,
    EVEN IF you also fixed them. Finding 5 gaps and fixing all 5 = GAPS_DISCOVERED: 5.
    A clean pass that finds nothing wrong from the start = GAPS_DISCOVERED: 0.

    Return the structured result block with GAPS_DISCOVERED.
  ")

  gaps = parse GAPS_DISCOVERED from result
  Output: "Checkpoint iteration {iteration}: {gaps} gaps discovered"

  IF gaps == 0:
    Output: "CHECKPOINT PASSED - Clean pass with zero gaps in iteration {iteration}"
    BREAK
  ELSE:
    Output: "{gaps} gaps discovered, starting fresh re-check..."
    CONTINUE
END WHILE
```

### Loop Rules

1. NEVER pass checkpoint while gaps > 0 - only a CLEAN zero-gap-from-start iteration allows progression
2. NEVER treat "found and fixed" as zero gaps
3. NEVER ask user "should I continue?" - the loop is mandatory
4. ALWAYS use Task tool for checkpoint passes
5. Maximum 10 iterations - if still failing, report to user

---

## Objective

Execute full 15-step checkpoint audit for current phase. Require ZERO gaps before allowing progression. Update session state with checkpoint result. Commit only after checkpoint passes.

---

## NON-NEGOTIABLE RULES

1. Zero gaps required - cannot proceed until gaps = 0
2. ALL steps executed - no shortcuts (includes Step 0: Plan Coverage)
3. Proof required - show verification output
4. Session state update mandatory - record checkpoint result
5. All applicable environments verified
6. Plan Coverage required - ALL plan items verified at 100%
7. FIX ALL ISSUES ENCOUNTERED (CR-9) - pre-existing or current, "not in scope" is NEVER valid

---

## DOMAIN-SPECIFIC PATTERN LOADING

Based on scope, load relevant pattern files from `.claude/patterns/` as applicable.

---

## CHECKPOINT AUDIT FLOW (Step 0 + 15 Steps)

### Step 0: PLAN COVERAGE GATE (MANDATORY FIRST STEP)

#### 0.1 Extract Plan Items
```markdown
## PLAN ITEM EXTRACTION - Phase [N]
| Item # | Type | Description | Expected Location | Verification Command | Status |
|--------|------|-------------|-------------------|---------------------|--------|
| P[N]-001 | FILE | [component.ts] | packages/core/src/ | ls -la [path] | PENDING |
| P[N]-002 | MODULE | [tool module] | packages/core/src/ | grep "[name]" | PENDING |
| P[N]-003 | REMOVAL | [pattern] | all files | grep -rn = 0 | PENDING |
| P[N]-004 | TEST | [test file] | packages/core/src/__tests__/ | VR-TEST | PENDING |

### Item Type Reference
| Type | Verification | Expected |
|------|--------------|----------|
| FILE | ls -la [path] | Exists, size > 0 |
| MODULE | VR-FILE + VR-TOOL-REG | File exists AND registered in tools.ts |
| TOOL | grep in tools.ts | Tool defined and wired |
| FEATURE | Feature-specific grep | Functionality works |
| REMOVAL | grep -rn "[pattern]" | 0 matches |
| CONFIG | VR-CONFIG | Config key present and valid |
```

#### 0.2 Verify Each Plan Item
For EACH item: run verification command, record VERIFIED/MISSING/PARTIAL, update Status.

#### 0.3 Calculate Coverage
```markdown
| Metric | Value |
|--------|-------|
| Total Items | [N] |
| Verified | [X] |
| Missing | [Y] |
| Coverage | [X/N]% |
**Coverage Gate: PASS (100%) / FAIL (<100%)**
```

#### 0.4 Gate Decision
- Coverage = 100%: Proceed to Step 1
- Coverage < 100%: LIST missing items, FIX them, RESTART from Step 0

---

### Step 1: READ Plan Section
Read plan section for this phase. Extract requirements into checklist.

---

### Step 2: VERIFY Project Structure

For EACH affected module, verify: file exists, exports correct functions, is registered in tools.ts.

```markdown
### Module Verification: [MODULE]
| Check | Exists | Exports | Registered | Status |
|-------|--------|---------|------------|--------|
| [module] | YES | All functions | In tools.ts | PASS |
```

---

### Step 2.5: VERIFY Config Alignment (VR-CONFIG)

If config-driven features exist, validate `massu.config.yaml` values and compare keys to code expectations.

```markdown
### VR-CONFIG Verification
| Check | Result | Status |
|-------|--------|--------|
| Parsed massu.config.yaml | [valid/invalid] | DONE |
| Extracted config keys | [keys] | DONE |
| Compared to code expectations | [match?] | MATCH/MISMATCH |
| Key alignment | 100% | PASS/FAIL |
```

---

### Step 3: GREP Source Files (VR-GREP)

For each module: verify exists, verify exports, verify tool registration.

```markdown
### Module Verification
| Module | File | Exports | Registered | Status |
|--------|------|---------|------------|--------|
| [name] | [file] | YES/NO | YES/NO | PASS/FAIL |
```

---

### Step 4: LS Component Files (VR-FILE)

```markdown
### File Verification
| File | Path | Exists | Size | Status |
|------|------|--------|------|--------|
| [name] | [path] | YES/NO | N bytes | PASS/FAIL |
```

### Step 4.5: VR-TOOL-REG - Tool Registration Verification (CRITICAL)

For EVERY MCP tool created, verify it is REGISTERED in tools.ts:
```bash
grep "getXToolDefinitions\|isXTool\|handleXToolCall" packages/core/src/tools.ts
# If 0 matches: THE TOOL IS NOT CALLABLE
```

```markdown
### VR-TOOL-REG Verification
| Tool Module | Definitions | Handler | Routing | Status |
|-------------|-------------|---------|---------|--------|
| [name] | YES | YES | YES (tools.ts) | PASS |
| [name] | YES | YES | NO (0 matches) | **FAIL** |
```

---

### Step 5: GREP Pattern Violations

```bash
bash scripts/massu-pattern-scanner.sh  # Exit 0 = PASS
```

```markdown
### Pattern Compliance
| Pattern | Count | Status |
|---------|-------|--------|
| Pattern Scanner | Exit 0/N | PASS/FAIL |
```

---

### Step 6: RUN Build Verification (VR-BUILD)

```bash
npm run build
```

### Step 6.5: Additional Verification Gates

```bash
cd packages/core && npx tsc --noEmit   # VR-TYPE: 0 errors
cd packages/core && npm run build:hooks # VR-HOOK-BUILD: Exit 0
npm test                                # VR-TEST: MANDATORY, ALL pass
```

```markdown
### Additional Gates
| Gate | Command | Result | Status |
|------|---------|--------|--------|
| Type Safety | cd packages/core && npx tsc --noEmit | 0 errors | PASS/FAIL |
| Hook Build | cd packages/core && npm run build:hooks | Exit 0 | PASS/FAIL |
| Tests | npm test | ALL Pass | PASS/FAIL |
```

---

### Step 6.6: VR-TOOL-REG - Tool Registration Coupling (CRITICAL)

If new tools were added, verify they are callable:
```bash
# Verify definitions are spread into getToolDefinitions()
grep "getXToolDefinitions" packages/core/src/tools.ts
# Verify handler is wired in handleToolCall()
grep "handleXToolCall\|isXTool" packages/core/src/tools.ts
```

```markdown
### VR-TOOL-REG Verification
| Check | Result |
|-------|--------|
| Tool definitions imported | PASS/FAIL |
| Tool definitions spread | PASS/FAIL |
| Tool handler wired | PASS/FAIL |
| Tool routing correct | PASS/FAIL |
```

---

### Step 6.7: Knowledge Base Health Check

Run staleness audits to verify knowledge base freshness (if applicable):

```markdown
### KB Health Verification
| Check | Result | Status |
|-------|--------|--------|
| Pattern file staleness (30d) | N stale | PASS/WARN |
| Session state freshness (7d) | N days | PASS/WARN |
```

---

### Step 7: Configuration Verification (If Config Changes)

#### 7.1 Config Schema Verification
Verify massu.config.yaml parses correctly and contains required keys.

#### 7.2 Tool Prefix Verification
All tool names use config-driven prefix via `getConfig().toolPrefix`.

#### 7.3 Path Verification
Config paths resolve to existing directories/files.

```markdown
### Config Verification
| Check | Count/Result | Expected | Status |
|-------|--------------|----------|--------|
| Config parses | YES | Valid YAML | PASS/FAIL |
| Tool prefix used | N tools | All tools | PASS/FAIL |
| Paths resolve | N/N | 100% | PASS/FAIL |
```

---

### Step 8: Integration Verification

For each critical integration point:
```markdown
### Integration: [INTEGRATION_NAME]
| Step | Check | Expected | Actual | Status |
|------|-------|----------|--------|--------|
| 1 | Tool definitions | All exported | All exported | PASS |
```

---

### Step 9: API/Tool Verification (If Tool Changes)

Verify tools exist, are registered, have input schemas, and handlers work correctly.

```markdown
### Tool Verification
| Tool | Module | Registered | Input Schema | Handler | Status |
|------|--------|------------|--------------|---------|--------|
```

---

### Step 10: Environment & Security Check

Check for hardcoded secrets, no credentials in code, config validation.

### Step 10.5: Security - Secrets Check (CR-3 CRITICAL)

```bash
git diff --cached --name-only | grep -E '\.(env|pem|key|secret)' && echo "FAIL" || echo "PASS"
ls -la .env* 2>/dev/null | grep -v ".env.example" | wc -l  # Expected: 0 in repo
grep -n "\.env" .gitignore  # Patterns present
```

**If ANY security check fails: HARD STOP.**

---

### Step 11: COUNT Gaps Found

```markdown
### Gap Count
| Category | Gaps | Details |
|----------|------|---------|
| Plan Coverage | N | [items] |
| Requirements | N | [list] |
| Modules | N | [list] |
| Tool Registration | N | [list] |
| Patterns | N | [list] |
| Build | N | [list] |
| Config | N | [list] |
| Tests | N | [list] |
| Environment | N | [list] |

**TOTAL GAPS: N**
**Plan Coverage Gate: [X]/[Y] = [%]% (MUST be 100%)**
```

---

### Step 12: FIX Each Gap (If Gaps > 0)

For each gap: identify fix, apply fix, run VR-* verification, confirm resolved.

### Step 13: Return to Step 1 (If Gaps > 0)

Re-run ENTIRE checkpoint from Step 1. Partial re-checks are NOT valid.

---

### Step 14: CREATE Checkpoint Sign-off (If Gaps = 0)

```markdown
## CHECKPOINT [N] SIGN-OFF

### DUAL VERIFICATION STATUS
| Gate | Status | Evidence |
|------|--------|----------|
| **Plan Coverage** | PASS | [X]/[X] items = 100% |
| **Code Quality** | PASS | All 15 steps passed |

### Requirements Verification
| Req | Description | Verification | Status |
|-----|-------------|--------------|--------|
| R-001 | [desc] | [VR-* proof] | VERIFIED |

### Summary
- Pattern scanner exit 0: PASS
- Build: PASS (Exit 0)
- Type check: 0 errors
- Tests: ALL PASS
- **TOTAL GAPS: 0**
- **Status**: CHECKPOINT PASSED
- **Ready for**: Phase [N+1] / Commit / Complete
```

---

### Step 15: COMMIT (If Gaps = 0)

Update session state, then commit:
```bash
git add [relevant files]
git commit -m "$(cat <<'EOF'
[type]: [description] - Checkpoint [N]

Phase [N] complete with zero gaps.

Verified:
- Pattern scanner: PASS
- Type check: 0 errors
- Build: PASS
- Tests: ALL PASS

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## SESSION STATE UPDATE

After checkpoint, update `session-state/CURRENT.md`:

```markdown
## CHECKPOINT SESSION

### Checkpoint
- **Phase**: [N]
- **Status**: PASSED / FAILED
- **Date**: [timestamp]
- **Audit loops**: [N]
- **Gaps found**: [N] (all resolved)

### Verification Results
| Check | Result |
|-------|--------|
| Pattern scanner | PASS |
| Type check | 0 errors |
| Build | PASS |
| Tests | ALL PASS |

### Files Changed
- [file1.ts]

### Next Phase
- Phase [N+1]: [description]
```

---

## PLAN DOCUMENT COMPLETION TRACKING

When checkpoint passes, update plan document with completion status at TOP:

```markdown
# IMPLEMENTATION STATUS
**Status**: IN_PROGRESS / COMPLETE
**Last Checkpoint**: Phase [N]

| # | Task/Phase | Status | Date |
|---|------------|--------|------|
| 1 | Phase 1 | 100% COMPLETE | 2026-01-20 |
| 2 | Phase 2 | IN PROGRESS | - |
```

VR-PLAN-STATUS: Verify with `grep "IMPLEMENTATION STATUS" [plan_file]` after updating.

---

## QUALITY SCORING GATE

Before declaring complete, spawn `massu-output-scorer` (model="sonnet"):
- Code Clarity, Pattern Compliance, Error Handling, Test Coverage (1-5 each)
- All scores >= 3: PASS | Any < 3: FAIL | Average >= 4: EXCELLENT

---

## ABORT CONDITIONS

Checkpoint MUST abort if: pattern scanner fails, security violation detected, build fails after 3 attempts, or config invalid. Report reason, details, recovery options.

---

## PARALLEL EXECUTION

Independent checks can run simultaneously via Task agents:
- Agent 1: `cd packages/core && npx tsc --noEmit`
- Agent 2: `bash scripts/massu-pattern-scanner.sh`
- Agent 3: `npm run build`
- Agent 4: `npm test`

---

## START NOW

**Step 0: Write AUTHORIZED_COMMAND to session state (CR-35)**

Update `session-state/CURRENT.md` to include:
```
AUTHORIZED_COMMAND: massu-checkpoint
```

**Execute the LOOP CONTROLLER at the top of this file.**

1. Identify current phase number and read the plan section
2. Spawn `massu-plan-auditor` subagent (via Task tool) for checkpoint iteration 1
3. Parse `GAPS_FOUND` from the subagent result
4. If gaps > 0: fix gaps, spawn another iteration
5. If gaps == 0: checkpoint passes - proceed to commit
6. Update session state with checkpoint result

**Zero gaps required. No exceptions. Show all verification output.**

---

## AUTO-LEARNING PROTOCOL (MANDATORY at every checkpoint)

After phase passes:
1. **Record learnings**: Record bugs, patterns, failed approaches in session state
2. **Update pattern scanner**: Add new grep-able bad patterns to `scripts/massu-pattern-scanner.sh`
3. **Codebase-wide search (CR-9)**: For each bug fixed, verify no other instances exist
