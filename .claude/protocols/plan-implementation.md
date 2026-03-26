# Plan Implementation Protocol

**Purpose**: Unified protocol for implementing and auditing multi-step plans. Merges Plan Implementation, Plan Audit, and Pre-Completion protocols.

**When to Read**: When implementing any multi-step plan, before claiming a plan is complete.

---

## ABSOLUTE RULE: 100% COMPLETION OR NOTHING (CR-7)

**Plans are NEVER partially complete. They are either 100% complete or NOT complete.**

| Coverage | Status | Action Required |
|----------|--------|-----------------|
| 100% | COMPLETE | Can claim complete with proof |
| 99% | NOT COMPLETE | Continue working until 100% |
| 80% | NOT COMPLETE | Continue working until 100% |
| Any < 100% | NOT COMPLETE | NEVER stop, NEVER claim complete |

**There is NO valid reason to stop implementing a plan before 100% coverage.**
**"Most items done" = NOT DONE. "Main features work" = NOT DONE.**

---

## Phase 1: Before Starting Implementation

### Step 1: Create TodoWrite Checklist IMMEDIATELY
```
Before writing ANY code, create a todo for EVERY item in the plan.
Do not start implementation until the todo list exists.
```

### Step 2: Read Plan File as Source of Truth
- The plan file is the SPECIFICATION
- Memory/summaries are NOT reliable
- Re-read the plan file before claiming ANY feature is complete

### Step 3: Identify All Deliverables
For EACH item in the plan, categorize:
- [ ] ADD - Component/feature to add
- [ ] REMOVE - Code/component to delete (CRITICAL)
- [ ] SWAP - Replace A with B
- [ ] MODIFY - Change existing behavior
- [ ] VALUE_CHANGE - Constant/path/enum being changed (TRIGGERS BLAST RADIUS)

### Step 4: Blast Radius Analysis (For VALUE_CHANGE Items)

**MANDATORY** when ANY plan item changes a constant value, redirect path, route, enum, or config key.

For EACH value being changed:
```bash
# Grep ENTIRE codebase for the old value
grep -rn '"[OLD_VALUE]"' src/ --include="*.ts" --include="*.tsx" | grep -v node_modules
```

Categorize EVERY match as:
- **CHANGE** - Must be updated (add to plan deliverables)
- **KEEP** - Intentionally stays (document reason)
- **INVESTIGATE** - Unclear (must resolve before implementation)

**Zero INVESTIGATE items allowed before starting implementation.**
**Every CHANGE item must be a plan deliverable with a verification command.**

If the plan does NOT include a blast radius analysis, CREATE ONE before implementing.

---

## Phase 2: During Implementation

### Step 1: Mark In-Progress BEFORE Starting
- Set todo to "in_progress" BEFORE writing code
- Only ONE feature should be in_progress at a time
- This prevents "I thought I did that" errors

### Step 2: Implement One Feature at a Time
- Complete each feature fully before moving to next
- Do not batch or parallelize unless explicitly required

### Step 3: Verify BEFORE Marking Complete
- Test the feature actually works (not just that code exists)
- Check ALL locations mentioned in the plan (not just one file)
- Show proof: grep results, type check output, or explicit verification
- NEVER mark complete based on memory

### Step 4: Update Session State
After each significant step, update `session-state/CURRENT.md`:
- Current position in plan
- Completed items
- Failed attempts (DO NOT RETRY)
- Decisions made + rationale

---

## Phase 3: Plan Audit (Before Claiming Complete)

### Step 1: READ THE PLAN FILE - Not Memory
```
Open the actual plan file.
Do NOT rely on summaries or memory.
The plan file is the ONLY source of truth.
```

### Step 2: Create Verification Checklist
For EACH item in the plan, create explicit verification:

| Plan Item | VR Type | Command | Result |
|-----------|---------|---------|--------|
| ADD component X to Y | VR-GREP | `grep "X" src/.../Y.tsx` | Found |
| REMOVE tab Z | VR-NEGATIVE | `grep "Z" src/app/` | 0 matches |
| SWAP A with B | VR-GREP + VR-NEGATIVE | Both commands | Both pass |
| "Tabs: A \| B \| C" | VR-PLAN-TABS | `grep -c "TabsTrigger" [file]` | Count = 3 |
| "More Menu: X items" | VR-PLAN-ITEMS | `grep -c "DropdownMenuItem" [file]` | Count = X |
| "ViewSwitcher" | VR-GREP | `grep "ViewSwitcher\|DropdownMenuTrigger" [file]` | Found |

### Step 2.5: Verify UI Structure Matches Plan (VR-PLAN-SPEC)

**CRITICAL**: If plan specifies tabs, menus, or UI structure, verify with COUNTS not just existence.

For plans with tab specifications:
```bash
# If plan says "Tabs: All Users | Roles | Permissions | Access Control"
grep -c "TabsTrigger" src/app/admin/users/page.tsx
# Expected: 4 (NOT just "found a tab component")

# Verify EACH tab label
grep "TabsTrigger" src/app/admin/users/page.tsx | grep -c "users\|roles\|permissions\|access"
# Expected: 4
```

**Why This Matters**:
- VR-RENDER passed (component existed)
- VR-GREP passed (found component in page)
- But TABS were NOT implemented
- Items became inaccessible
- User found the bug, not the audit

### Step 3: Check REMOVALS Explicitly
**CRITICAL**: REMOVALS are invisible to positive grep searches.

1. Identify what should NOT exist
2. Grep for the thing that should be GONE
3. Verify grep returns ZERO matches
4. Example: `grep "TabsContent value=\"drawings\"" src/app/` -> must return 0 files

### Step 4: Check EACH Location in Plan
If plan says "Add to pages: A, B, C, D, E":
- [ ] Verify page A (grep proof)
- [ ] Verify page B (grep proof)
- [ ] Verify page C (grep proof)
- [ ] Verify page D (grep proof)
- [ ] Verify page E (grep proof)

**Do NOT stop at 3 and assume the rest are done.**

### Step 5: Run Build and Type Check
```bash
npm run build    # VR-BUILD
npx tsc --noEmit # VR-TYPE
```

### Step 6: Complete Verification Template
Fill out the plan verification template with:
- Every deliverable listed
- Every verification command run
- Every result shown

---

## Phase 4: Completion Claims

### What "Complete" Means
A feature is NOT complete unless:
- [ ] Code exists in ALL files specified in plan
- [ ] Feature has been tested/verified to work
- [ ] Type check passes
- [ ] Proof of completion can be shown
- [ ] **100% of plan items verified complete (not 99%, not "most")**
- [ ] **Production verification passed** (immediate checks PASS; deferred items tracked in `session-state/deferred-verifications.md`)

### NEVER Claim Complete When

| Situation | Why It's Wrong | Correct Action |
|-----------|----------------|----------------|
| "Most items done" | Most != All | Complete remaining items |
| "Main features work" | All features must work | Complete ALL features |
| "Code quality passes" | Coverage may be <100% | Verify ALL plan items |
| "Build passes" | Build doesn't verify plan coverage | Check each plan item |
| "Ready for review" when <100% | Partial = incomplete | Finish first |

### Pre-Completion Checklist (NON-NEGOTIABLE)

1. [ ] Plan file OPEN (not from memory)
2. [ ] Every line of plan READ
3. [ ] Verification entry for EVERY deliverable
4. [ ] Verification command RUN for every entry
5. [ ] Command output SHOWN as proof
6. [ ] All failing items FIXED
7. [ ] Fixed items RE-VERIFIED
8. [ ] Verification template COMPLETED
9. [ ] Checklist PRESENTED to user
10. [ ] User acknowledgment RECEIVED
11. [ ] **Production verification** -- features confirmed working in production (not just deployed)

**Only after ALL 11 steps may "complete" be claimed.**

---

## Red Flags - Stop and Verify

| Red Flag | Required Response |
|----------|-------------------|
| "I already did that" | VERIFY by reading the file |
| "That should be working" | TEST it |
| "The audit shows everything is done" | READ THE PLAN FILE |
| Session was compacted | RE-READ THE PLAN FILE |
| "I did most of them" | VERIFY ALL of them |
| Only ran positive greps | Also run NEGATIVE greps |

---

## User Discovery = Audit Failure

If the USER finds a bug that an audit should have caught:
- The audit FAILED
- Previous "complete" claims were LIES
- Trust has been damaged
- Must rebuild trust with PROOF, not words

---

## Verification Command Templates

```bash
# For ADDITIONS - verify component exists in all required files
grep -l "ComponentName" src/app/path1/page.tsx src/app/path2/page.tsx ...

# For REMOVALS - verify old code is GONE (should return nothing)
grep -rn "OldComponentName" src/app/ | wc -l  # Must be 0

# For SWAPS - verify BOTH old removed AND new added
grep -rn "OldComponent" src/app/  # Should be 0
grep -rn "NewComponent" src/app/  # Should match expected count

# For RENAMES - verify old name gone, new name present
grep -rn 'value="oldname"' src/app/  # Should be 0
grep -rn 'value="newname"' src/app/  # Should match

# Count instances
grep -c "Pattern" file.tsx  # Expected count
```

---

## Multi-Session Plan Implementation

For plans spanning multiple sessions:

1. **Verify current phase status** via todo list, git log, schema state
2. **Re-execute Pre-Phase Protocol** for current phase
3. **Update session state** at each checkpoint
4. **Commit at checkpoints only** - Do NOT commit mid-phase
5. **No push until explicitly told** - User controls when code goes to remote

---

**Document Status**: ACTIVE
**Compliance**: Mandatory for all plan implementations
