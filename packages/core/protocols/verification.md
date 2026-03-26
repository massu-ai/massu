# Verification Protocol - Unified

**Purpose**: Single source of truth for all verification requirements. Referenced by CR-1 (Canonical Rule 1).

**When to Read**: Before claiming ANY task is complete, before any database operation, before any commit.

---

## Verification Types (VR)

| Type | Command | Expected Result | Use When |
|------|---------|-----------------|----------|
| VR-FILE | `ls -la [path]` | File exists | Claiming file created |
| VR-GREP | `grep "[pattern]" [file]` | Match found | Claiming code added |
| VR-NEGATIVE | `grep -rn "[old]" src/` | 0 matches | Claiming removal |
| VR-BUILD | `npm run build` | Exit 0 | Claiming production ready |
| VR-TYPE | `npx tsc --noEmit` | 0 errors | Claiming type safety |
| VR-TEST | `npm test` | All pass | Claiming tested |
| VR-DEPLOY | `./scripts/pre-deploy-check.sh` | All pass | Claiming deployable |
| VR-SCHEMA | `SELECT ... FROM information_schema` | Matches expectation | Before DB operations |
| VR-COUNT | `grep -c "[pattern]" [file]` | Expected count | Verifying all instances |
| VR-PLAN-TABS | `grep -c "TabsTrigger" [file]` | Tab count matches plan | Plan specifies tabs |
| VR-PLAN-ITEMS | `grep -c "DropdownMenuItem" [file]` | Item count matches plan | Plan specifies menu items |
| VR-PLAN-SPEC | Multiple greps per spec | All UI elements exist | Plan specifies UI structure |

---

## Plan Specification Verification (VR-PLAN-SPEC)

**Purpose**: Verify that UI implementation matches plan specification exactly.

**When Plan Says "Tabs: A | B | C"**:
```bash
# Verify exact tab count
grep -c "TabsTrigger" src/app/[path]/page.tsx
# Expected: 3

# Verify each tab label exists
grep "TabsTrigger.*A" src/app/[path]/page.tsx
grep "TabsTrigger.*B" src/app/[path]/page.tsx
grep "TabsTrigger.*C" src/app/[path]/page.tsx
```

**When Plan Says "More Menu: X items"**:
```bash
# Verify menu item count
grep -c "DropdownMenuItem" src/components/[path]/[Menu].tsx
# Expected: X items
```

**When Plan Says "View Switcher: A | B"**:
```bash
# Verify view switcher exists and has correct options
grep -c "DropdownMenuItem\|SelectItem" src/components/[path]/ViewSwitcher.tsx
# Expected: 2+
```

---

## Literal Spec Verification (VR-SPEC-MATCH)

**Purpose**: Verify that EVERY plan item with specific CSS classes, component names, layout instructions, or visual specs is implemented with those EXACT strings.

**When**: During verification of ANY UI plan item that specifies concrete CSS classes, structure, or layout.

**Protocol**:

For EVERY plan item that specifies CSS classes or structure (e.g., `ml-6 border-l-2 pl-4`, `grid grid-cols-3 gap-4`, `<Badge variant="outline">`):

1. Extract ALL specific CSS classes / component attributes from the plan item
2. Grep the implementation file for each EXACT string
3. If ANY specified string is missing: **VR-SPEC-MATCH FAILURE = gap**

```bash
# Example: Plan says "indented with ml-6 border-l-2 border-muted pl-4"
grep "ml-6" src/components/feature/Component.tsx        # Must match
grep "border-l-2" src/components/feature/Component.tsx  # Must match
grep "border-muted" src/components/feature/Component.tsx # Must match
grep "pl-4" src/components/feature/Component.tsx        # Must match
```

**VR-SPEC-MATCH Failure = Plan NOT Complete.** The implementation must contain the plan's exact specifications.

---

## Data Pipeline Verification (VR-PIPELINE)

**Purpose**: For features that generate or process data (AI, cron, generation, ETL), verify the pipeline produces non-empty output end-to-end.

**When**: After implementing any feature with a data pipeline -- AI processing, cron jobs, report generation, data sync, document indexing, etc.

**Protocol**:

1. Identify the entry point procedure (tRPC procedure, cron handler, edge function)
2. Trigger it manually (call the procedure directly or via test)
3. Verify the output contains non-empty data
4. If output is empty: investigate root cause and fix before marking complete

```bash
# Example: AI pipeline
# 1. Call the procedure
npx tsx -e "import { ... } from './src/server/api/routers/feature'; ..."
# 2. Check output
# Expected: Non-empty result with actual data

# Example: Cron job
# 1. Call the handler
curl -X POST http://localhost:3000/api/cron/digest -H "Authorization: Bearer $CRON_SECRET"
# 2. Verify response contains data, not empty arrays/objects
```

**VR-PIPELINE Failure**: Empty output from a data pipeline = gap. Investigate and fix before claiming complete.

---

### VR-PLAN-SPEC Failure = Plan NOT Complete

If ANY VR-PLAN-SPEC check fails:
- The plan is NOT complete
- The feature is NOT implemented
- Claiming "complete" is a LIE
- Fix the implementation, then re-verify

---

## Pre-Completion Protocol (Before Saying "Complete")

**This protocol is NON-NEGOTIABLE. Violation = incident logged.**

1. **OPEN the plan file** (not from memory)
2. **READ every line** of the plan document
3. **CREATE a verification entry** for EVERY deliverable
4. **RUN a verification command** for EVERY entry
5. **SHOW the command output** as PROOF for EVERY entry
6. **FIX any failing items** before proceeding
7. **RE-VERIFY fixed items** until ALL pass
8. **COMPLETE the verification template**
9. **PRESENT the completed checklist** to the user
10. **WAIT for user acknowledgment** before claiming complete

### What Counts as Verification

| Deliverable Type | Required VR Type |
|-----------------|------------------|
| File creation | VR-FILE |
| Function/procedure added | VR-GREP |
| Feature implementation | VR-GREP + VR-COUNT |
| Code removal | VR-NEGATIVE |
| Router procedure | VR-GREP showing procedureName |
| Build success | VR-BUILD |
| Type safety | VR-TYPE |

### What Does NOT Count as Verification

- "I created that file" (MUST show VR-FILE output)
- "I added that procedure" (MUST show VR-GREP output)
- "The feature is there" (MUST show proof)
- "I checked and it's done" (MUST show verification commands)
- Memory or assumptions of ANY kind

---

## Database Verification Protocol

**ABSOLUTE RULE: NEVER ASSUME, ALWAYS VERIFY**

Before writing ANY code that touches the database:

1. **VERIFY the table exists** - Query or check `prisma/schema.prisma`
2. **VERIFY column names exactly** - Typos cause silent failures
3. **VERIFY column types** - String vs Int vs Decimal vs BigInt vs JSON vs enum
4. **VERIFY nullable vs required** - Determines if field can be omitted
5. **VERIFY constraints** - Unique, foreign keys, check constraints
6. **VERIFY RLS policies** - What operations allowed for which roles
7. **VERIFY grants** - Does service_role have permission?

### Schema Verification Commands

```sql
-- Check table structure
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'your_table_name'
ORDER BY ordinal_position;

-- Check RLS policies
SELECT polname, polcmd, polroles, polqual
FROM pg_policies
WHERE tablename = 'your_table_name';

-- Check constraints
SELECT conname, contype, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'your_table_name'::regclass;

-- Check grants
SELECT grantee, privilege_type
FROM information_schema.table_privileges
WHERE table_name = 'your_table_name';
```

### Schema Migration Compatibility Check

**MANDATORY BEFORE any data migration plan:**

```sql
-- Find columns in SOURCE missing from TARGET
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'source_table'
EXCEPT
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'target_table';

-- Find columns in TARGET missing from SOURCE
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'target_table'
EXCEPT
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'source_table';
```

---

## Audit Protocol (For Plan Verification)

### Step 1: READ THE PLAN FILE - Not Memory
- Open the actual plan file
- Do NOT rely on summaries or memory
- The plan file is the ONLY source of truth

### Step 2: Create Checklist of ALL Requirements
For EACH item in the plan, create explicit checklist entries:
- [ ] ADD component X to page Y
- [ ] REMOVE component Z from page Y (CRITICAL: Include removals!)
- [ ] SWAP component A with component B
- [ ] MODIFY behavior of component C

### Step 3: Check REMOVALS Explicitly
REMOVALS are invisible to positive grep searches. You MUST:
1. Identify what should NOT exist
2. Grep for the thing that should be GONE
3. Verify grep returns ZERO matches

### Step 4: Check EACH Page Mentioned in Plan
If plan says "Add to pages: A, B, C, D, E":
- [ ] Verify page A has component
- [ ] Verify page B has component
- [ ] Verify page C has component
- [ ] Verify page D has component
- [ ] Verify page E has component

Do NOT assume "I did most of them so they're all done"

### Step 5: Verify with NEGATIVE Searches
For every SWAP or REMOVE:
1. What was the OLD component/tab/code?
2. Search for that OLD thing
3. It should return ZERO matches

### Audit Completion Criteria
- [ ] Plan file was RE-READ during audit (not from memory)
- [ ] Every ADD verified with VR-GREP showing file exists
- [ ] Every REMOVE verified with VR-NEGATIVE showing ZERO matches
- [ ] Every SWAP verified BOTH old removed AND new added
- [ ] Type check passes (VR-TYPE)
- [ ] Explicit proof shown for each verification

---

## Red Flags - Stop and Verify

| Red Flag | Response |
|----------|----------|
| "I already did that" | VERIFY by reading the file |
| "That should be working" | TEST it |
| "The audit shows everything is done" | READ THE PLAN FILE |
| "I think the column is called..." | QUERY the database |
| "This should have a policy..." | CHECK the policy |
| "I'll just use the same pattern as..." | VERIFY BOTH match |
| Session was compacted | RE-READ THE PLAN FILE |

---

## Failure Consequences

If verification protocol is violated:
1. The claim of "complete" is automatically FALSE
2. User trust is damaged
3. Incident is logged
4. Session termination may be requested

**"I assumed the schema" is NEVER acceptable.**
**"I verified via SQL query" IS acceptable.**

---

## Enterprise-Grade Solutions Only

**NEVER suggest, propose, or implement any solution that is not:**
- **Enterprise-grade**: Production-ready from day one, scalable, maintainable
- **Permanent**: No temporary fixes, workarounds, or "quick fixes"
- **Professional**: Industry best practices, proper architecture

**What this means in practice:**
- Do NOT say "here's a quick fix" - only offer the proper solution
- Do NOT suggest workarounds that need to be replaced later
- Do NOT implement partial solutions when complete solutions are possible
- If a proper solution requires more work, do that work - no shortcuts

**If you cannot implement an enterprise-grade solution:**
1. Explain what the proper solution would require
2. Ask if the user wants to proceed with the full implementation
3. NEVER default to a lesser solution

---

## Fix ALL Issues Encountered (CR-9)

**ALL issues encountered MUST be fixed with enterprise-grade, permanent solutions - pre-existing or not.**

**The Law:**
- NEVER skip issues because they are "pre-existing" or "out of scope"
- NEVER defer issues to "later" or "another session"
- NEVER use workarounds when proper fixes are possible
- ALL issues in the codebase are our responsibility

**Enterprise-Grade Standard:**
- Every fix must be permanent, not a workaround
- Every fix must be production-ready
- Every fix must follow established patterns
- Every fix must include proper verification

**Verification (VR-FIX):**
After any verification run, if issues found:
1. Fix ALL issues
2. Re-run verification
3. Repeat until 0 issues

---

## ALL Tests MUST Pass Before Claiming Complete

**ALL tests MUST pass before ANY work can be marked as complete. There are NO exceptions.**

**The Rule:**
| Test State | Action | Can Claim Complete? |
|------------|--------|---------------------|
| All tests pass | Proceed | YES |
| Any test fails | Fix ALL failures | NO |
| Tests not run | Run tests first | NO |
| "Tests not applicable" | INVALID - tests are ALWAYS applicable | NO |

**Verification (VR-TEST):**
```bash
npm test
# Expected: Exit 0, ALL tests pass
# If ANY test fails, work is NOT complete
```

**Banned Phrases:**
- "Tests are not applicable" - INVALID
- "Tests were already failing" - FIX THEM
- "Tests are out of scope" - INVALID
- "Tests are optional" - NEVER

---

## Database Configs MUST Match Code Expectations

**When code reads configuration from the database, the config values MUST match what the code expects.**

**The Rule:**
| Check Type | What It Verifies | Catches These Issues |
|------------|------------------|---------------------|
| VR-SCHEMA | Column exists | Missing columns |
| VR-DATA | Config values match code | Field name mismatches, wrong keys |

**VR-SCHEMA alone is NOT sufficient. VR-DATA is MANDATORY for config-driven features.**

**VR-DATA Protocol:**
```sql
-- Step 1: Query ACTUAL config values
SELECT id, config_column FROM config_table LIMIT 3;

-- Step 2: Extract keys from JSONB
SELECT DISTINCT jsonb_object_keys(config_column) as keys FROM config_table;
```

**Then verify code uses correct keys:**
```bash
grep -rn "config\." src/lib/[feature]/ | sort -u
```

**The Lesson:**
Schema existence (VR-SCHEMA) != Data correctness (VR-DATA). A column can exist with completely wrong values inside. ALWAYS verify BOTH.

---

**Document Status**: ACTIVE
**Compliance**: Mandatory for all verification and completion claims
