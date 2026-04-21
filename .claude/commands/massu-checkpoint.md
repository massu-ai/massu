---
name: massu-checkpoint
description: "When user wants mid-implementation verification, says 'checkpoint', 'check progress', or needs a quality gate during a multi-phase plan"
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*), mcp__supabase__DEV__*, mcp__supabase__NEW_PROD__*, mcp__supabase__OLD_PROD__*
---
name: massu-checkpoint

# Massu Checkpoint: Phase Boundary Audit Protocol

**Shared rules**: Read `.claude/commands/_shared-preamble.md` for POST-COMPACTION (CR-12), ENTERPRISE-GRADE (CR-14), AWS SECRETS (CR-5) rules.

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
5. All 3 DB environments verified (DEV, OLD PROD, NEW PROD)
6. UI/UX verification required for UI changes
7. Schema verification required - verify column names against real schema
8. Plan Coverage required - ALL plan items verified at 100%
9. FIX ALL ISSUES ENCOUNTERED (CR-9) - pre-existing or current, "not in scope" is NEVER valid

---

## DOMAIN-SPECIFIC PATTERN LOADING

Based on scope, load: `patterns/database-patterns.md`, `patterns/auth-patterns.md`, `patterns/ui-patterns.md`, `patterns/realtime-patterns.md`, `patterns/build-patterns.md` as relevant.

---

## CHECKPOINT AUDIT FLOW (Step 0 + 15 Steps)

### Step 0: PLAN COVERAGE GATE (MANDATORY FIRST STEP)

#### 0.1 Extract Plan Items
```markdown
## PLAN ITEM EXTRACTION - Phase [N]
| Item # | Type | Description | Expected Location | Verification Command | Status |
|--------|------|-------------|-------------------|---------------------|--------|
| P[N]-001 | FILE | [component.tsx] | src/components/ | ls -la [path] | PENDING |
| P[N]-002 | PROCEDURE | [api.method] | routers/[file].ts | grep "[name]:" | PENDING |
| P[N]-003 | REMOVAL | [pattern] | all files | grep -rn = 0 | PENDING |
| P[N]-004 | FEATURE | [UI feature] | src/app/ | VR-RENDER | PENDING |

### Item Type Reference
| Type | Verification | Expected |
|------|--------------|----------|
| FILE | ls -la [path] | Exists, size > 0 |
| COMPONENT | VR-FILE + VR-RENDER | File exists AND rendered in page |
| PROCEDURE | grep "[name]:" [router] | Procedure defined |
| FEATURE | Feature-specific grep | Functionality works |
| REMOVAL | grep -rn "[pattern]" | 0 matches |
| MIGRATION | VR-SCHEMA | Column/table exists in ALL 3 envs |
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

### Step 2: QUERY Database (All 3 Environments)

| Environment | Project ID | MCP Tool Prefix |
|-------------|------------|-----------------|
| DEV | `gwqkbjymbarkufwvdmar` | `mcp__supabase__DEV__` |
| OLD PROD | `hwaxogapihsqleyzpqtj` | `mcp__supabase__OLD_PROD__` |
| NEW PROD | `cnfxxvrhhvjefyvpoqlq` | `mcp__supabase__NEW_PROD__` |

For EACH affected table, verify: table exists, columns match, RLS policies exist, grants present.

```markdown
### DB Verification: [TABLE]
| Env | Exists | Columns | RLS | Grants | Status |
|-----|--------|---------|-----|--------|--------|
| DEV | YES | X/X | X policies | YES | PASS |
| OLD PROD | YES | X/X | X policies | YES | PASS |
| NEW PROD | YES | X/X | X policies | YES | PASS |
```

---

### Step 2.5: VERIFY Config-Code Alignment (VR-DATA)

If config-driven features exist, query actual config JSONB values and compare keys to code expectations. Config schema existing does NOT mean data is correct (Incident #12).

```markdown
### VR-DATA Verification: [CONFIG_TABLE]
| Check | Result | Status |
|-------|--------|--------|
| Queried actual config values | [values] | DONE |
| Extracted config keys | [keys] | DONE |
| Compared to code expectations | [match?] | MATCH/MISMATCH |
| Key alignment | 100% | PASS/FAIL |
```

---

### Step 3: GREP Router Files (VR-GREP)

For each procedure: verify exists, verify input schema, verify protectedProcedure for mutations.

```markdown
### Router Verification
| Procedure | Router | Line | Protected | Status |
|-----------|--------|------|-----------|--------|
| [name] | [file] | N | YES/NO | PASS/FAIL |
```

---

### Step 4: LS Component Files (VR-FILE)

```markdown
### Component Verification
| Component | Path | Exists | Size | Status |
|-----------|------|--------|------|--------|
| [name] | [path] | YES/NO | N bytes | PASS/FAIL |
```

### Step 4.5: VR-RENDER - Component Render Verification (CRITICAL)

For EVERY UI component created, verify it is RENDERED in a page:
```bash
grep "<ComponentName" src/app/**/page.tsx
# If 0 matches: THE FEATURE IS NOT IMPLEMENTED
```

```markdown
### VR-RENDER Verification
| Component | File Exists | Exported | RENDERED in Page | Status |
|-----------|-------------|----------|------------------|--------|
| [name] | YES | YES | YES (page.tsx:L42) | PASS |
| [name] | YES | YES | NO (0 matches) | **FAIL** |
```

---

### Step 5: GREP Pattern Violations

```bash
./scripts/pattern-scanner.sh  # Exit 0 = PASS
```

Then manual checks (all expect 0):
- P-001: `grep -rn "ctx.prisma" src/server/`
- P-002: `grep -rn "include:" src/server/api/routers/ | grep -v "//"`
- P-003: `grep -rn "ctx.db.users" src/`
- P-004: `grep -rn "publicProcedure.mutation" src/`
- P-005: `grep -rn "prototype:" src/ | grep -v "Object.prototype"`
- P-006: `grep -rn "from 'jsdom'" src/ | grep -v "await import"`
- P-007: `grep -rn "BigInt(" src/server/ | grep -i "create\|insert"`
- P-008: `grep -rn 'value=""' src/ | grep -i "select"`
- P-009: `grep -rn "updateMany(" src/server/`
- P-010: `grep -rn "deleteMany(" src/server/`

```markdown
### Pattern Compliance
| Pattern | Count | Status |
|---------|-------|--------|
| Pattern Scanner | Exit 0/N | PASS/FAIL |
| P-001 through P-010 | 0 each | PASS/FAIL |
```

---

### Step 6: RUN Build Verification (VR-BUILD)

```bash
npm run build
```

### Step 6.5: Additional Verification Gates

```bash
npx tsc --noEmit        # VR-TYPE: 0 errors
npm run lint             # VR-LINT: Exit 0
npx prisma validate     # VR-SCHEMA-VALIDATE: Exit 0
npm test                # VR-TEST: MANDATORY, ALL pass
./scripts/pre-deploy-check.sh 2>/dev/null || echo "No pre-deploy script"
```

```markdown
### Additional Gates
| Gate | Command | Result | Status |
|------|---------|--------|--------|
| Type Safety | npx tsc --noEmit | 0 errors | PASS/FAIL |
| Lint | npm run lint | Exit 0 | PASS/FAIL |
| Prisma Validate | npx prisma validate | Valid | PASS/FAIL |
| Tests | npm test | ALL Pass | PASS/FAIL |
| Pre-deploy | pre-deploy-check.sh | Pass/N/A | PASS/FAIL/N/A |
```

---

### Step 6.6: VR-COUPLING - Backend-Frontend Coupling (CRITICAL)

If backend changes exist, verify UI exposes them:
```bash
./scripts/check-coupling.sh  # Exit 0
```

```markdown
### VR-COUPLING Verification
| Check | Result |
|-------|--------|
| Enum parity (scraperType) | PASS/FAIL |
| Enum parity (sourceType) | PASS/FAIL |
| Form field completeness | PASS/FAIL |
| Component reuse | N warnings |
```

---

### Step 6.7: Knowledge Base Health Check

Run the staleness audit to verify knowledge base freshness:
```bash
bash scripts/kb-staleness-audit.sh --verbose
```

- **WARN results**: Report in checkpoint summary as informational
- **FAIL results**: Include as action items in the checkpoint report
- **Does NOT block**: Staleness warnings don't prevent checkpoint completion, but failures should be addressed

```markdown
### KB Health Verification
| Check | Result | Status |
|-------|--------|--------|
| Pattern file staleness (30d) | N stale | PASS/WARN |
| Reference file staleness (90d) | N stale | PASS/WARN |
| Incident count match | N == N | PASS/FAIL |
| Agent-command cross-ref | N unreferenced | PASS/WARN |
| db.ts table count delta | delta N | PASS/WARN |
| SHAME-RECORDS freshness | up-to-date | PASS/WARN |
| Session state freshness (7d) | N days | PASS/WARN |
```

---

### Step 7: UI/UX Verification (If UI Changes)

#### 7.1 Page & Route Verification
Verify pages exist, nav links valid, auth guards correct.

#### 7.2 Button & Action Verification
All buttons have handlers, all forms have onSubmit.

#### 7.3 State Verification
Loading, empty, error, success states exist.

#### 7.4 Mobile & Accessibility
No `sm:page-container`, images have alt text.

#### 7.5 Elegance Check (non-trivial changes only)
- [ ] No unnecessary abstractions or indirection
- [ ] No "clever" code that's hard to follow
- [ ] Could this be simpler while remaining correct?
- [ ] Would a staff engineer approve this approach?

```markdown
### UI/UX Verification
| Check | Count/Result | Expected | Status |
|-------|--------------|----------|--------|
| Pages exist | N pages | All render | PASS/FAIL |
| Buttons with handlers | N/N | 100% | PASS/FAIL |
| Forms with onSubmit | N/N | 100% | PASS/FAIL |
| Loading states | N | > 0 | PASS/FAIL |
| Empty states | N | > 0 | PASS/FAIL |
| Error states | N | > 0 | PASS/FAIL |
| Mobile containers | 0 violations | 0 | PASS/FAIL |
| Image alt text | 0 missing | 0 | PASS/FAIL |
```

---

### Step 8: User Flow Verification (If UI Changes)

For each critical user flow:
```markdown
### User Flow: [FLOW_NAME]
| Step | Action | Element | Handler/API | Expected | Actual | Status |
|------|--------|---------|-------------|----------|--------|--------|
| 1 | Navigate | Link | href | Page loads | Page loads | PASS |
```

---

### Step 9: API/Router Verification (If API Changes)

Verify procedures exist, are protected, have input validation, and client calls match server.

```markdown
### API Verification
| Procedure | Router | Protected | Input Schema | Client Calls | Status |
|-----------|--------|-----------|--------------|--------------|--------|
```

---

### Step 10: Environment & Console Check

Check env vars, no hardcoded secrets, console.log audit.

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
| Database | N | [list] |
| Routers | N | [list] |
| Components | N | [list] |
| VR-RENDER | N | [list] |
| Patterns | N | [list] |
| Build | N | [list] |
| UI/UX | N | [list] |
| User Flows | N | [list] |
| API Contracts | N | [list] |
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
- Database: DEV/OLD PROD/NEW PROD verified: PASS
- Pattern scanner exit 0: PASS
- Build: PASS (Exit 0)
- UI/UX: All checks passed
- API: All procedures verified
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
- DB: DEV/OLD PROD/NEW PROD verified

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
| DB (DEV/OLD PROD/NEW PROD) | PASS |

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
- Code Clarity, Pattern Compliance, Error Handling, UX Quality, Test Coverage (1-5 each)
- All scores >= 3: PASS | Any < 3: FAIL | Average >= 4: EXCELLENT

---

## ABORT CONDITIONS

Checkpoint MUST abort if: pattern scanner fails, security violation detected, build fails after 3 attempts, or DB drift between environments. Report reason, details, recovery options.

---

## PARALLEL EXECUTION

Independent checks can run simultaneously via Task agents:
- Agent 1: `npx tsc --noEmit`
- Agent 2: `./scripts/pattern-scanner.sh`
- Agent 3: `npm run build`
- Agent 4: `npm run test:run`

---

## START NOW

**Step 0: Write AUTHORIZED_COMMAND to session state (CR-12)**

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
1. **Ingest learnings**: `massu_memory_ingest` with type="checkpoint" for bugs, patterns, failed approaches
2. **Update MEMORY.md**: Record wrong vs correct patterns discovered
3. **Update pattern scanner**: Add new grep-able bad patterns to `scripts/pattern-scanner.sh`
4. **Codebase-wide search (CR-9)**: For each bug fixed, verify no other instances exist
