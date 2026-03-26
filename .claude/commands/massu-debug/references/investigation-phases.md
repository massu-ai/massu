# Investigation Phases (0-7)

Full detail for each investigation phase in the massu-debug protocol.

---

## PHASE 0: REPRODUCE THE FAILURE (MANDATORY)

Before investigating root cause, CONFIRM you can trigger the exact error.

1. Identify the exact reproduction steps from user report
2. Execute those steps (or equivalent verification commands)
3. Capture the actual error output
4. If you CANNOT reproduce: document that and investigate why

WHY: Debugging without reproduction is guessing. Fixes without
reproduction cannot be verified.

### 0.1 Check Memory for Related Failures

Before investigating, check if this error has been seen before:

Use `mcp__massu-codegraph__massu_memory_failures` with keywords from
the error message.
Use `mcp__massu-codegraph__massu_memory_search` with the affected
file/feature name.

If a match is found:
- The previous root cause and fix are documented
- Check if the previous fix regressed
- Do NOT retry previously failed approaches (check recurrence_count)

---

## PHASE 1: SYMPTOM CAPTURE

### 1.1 Document the Issue
```markdown
## Bug Report

### Symptom
- **What happens**: [exact behavior observed]
- **Expected**: [what should happen]
- **Environment**: DEV / PROD
- **Reproducible**: Always / Sometimes / Once

### Error Messages
- **Console errors**: [exact text]
- **Network errors**: [status codes, responses]
- **Server logs**: [relevant log entries]

### Reproduction Steps
1. [Step 1]
2. [Step 2]
3. [Bug occurs]
```

### 1.2 Collect Initial Evidence
```bash
# Recent changes that might be related
git log --oneline -10

# Check for recent file changes in affected area
git diff HEAD~5 --name-only | grep -E "(component|router|page)"

# Check build status
npm run build 2>&1 | tail -20

# Check for type errors
npx tsc --noEmit 2>&1 | head -30
```

---

## PHASE 2: CATEGORIZE & LOAD PATTERNS

### 2.1 Error Category Matrix

| Error Type | Likely Cause | Pattern File | First Check |
|------------|--------------|--------------|-------------|
| 500 Internal | DB/API error | database-patterns.md | Server logs |
| 403 Forbidden | RLS/Auth | auth-patterns.md | RLS policies |
| 401 Unauthorized | Session | auth-patterns.md | Token validity |
| TypeError | Null/undefined | ui-patterns.md | Null guards |
| React crash | Component error | ui-patterns.md | Error boundary |
| Build fail | Import/config | build-patterns.md | tsc output |
| Network timeout | API/DB slow | database-patterns.md | Query performance |

### 2.2 Load Relevant Patterns
Based on error category, read the appropriate pattern file and extract:
- Common causes for this error type
- Required verification checks
- Known gotchas from CLAUDE.md

---

## PHASE 3: TRACE THE PATH

### 3.1 UI Layer Investigation
```bash
# Find the component
grep -rn "[ComponentName]" src/components/ src/app/

# Check for event handlers
grep -A 10 "onClick\|onSubmit\|onChange" [component_file]

# Check for API calls
grep -n "api\.\|useMutation\|useQuery" [component_file]

# Check for null guards (CLAUDE.md rule)
grep -n "?\.\||| \"\"\|?? " [component_file]
```

### 3.2 API Layer Investigation
```bash
# Find the router/procedure
grep -rn "[procedureName]" src/server/api/routers/

# Check procedure protection
grep -B 5 "[procedureName]" src/server/api/routers/ | grep "protected\|public"

# Check input validation
grep -A 15 "[procedureName]:" src/server/api/routers/ | grep -A 10 "input"

# Check for CLAUDE.md violations
grep -n "ctx.prisma\|include:\|ctx.db.users" [router_file]
```

### 3.3 Database Layer Investigation
```sql
-- Check table exists
SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = '[TABLE]';

-- Check column types
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = '[TABLE]';

-- Check RLS policies
SELECT polname, polcmd, polroles::text
FROM pg_policies
WHERE tablename = '[TABLE]';

-- Check grants
SELECT grantee, privilege_type
FROM information_schema.table_privileges
WHERE table_name = '[TABLE]';

-- Test query directly
SELECT * FROM [TABLE] WHERE [condition] LIMIT 5;
```

---

## PHASE 4: HYPOTHESIS TESTING

### 4.1 Hypothesis Template
```markdown
### Hypothesis [N]

**Theory**: [What you think is wrong]
**Evidence Supporting**: [Why you think this]
**Test**: [How to verify]
**Result**: [What happened]
**Verdict**: CONFIRMED / REJECTED
```

### 4.2 Common Hypothesis Checklist

#### Database Issues
- [ ] Table exists in all environments?
- [ ] Column types match Prisma schema?
- [ ] RLS policies allow this operation?
- [ ] service_role grants exist?
- [ ] Using `ctx.db` not `ctx.prisma`?
- [ ] Using `user_profiles` not `users`?
- [ ] No `include:` statements (3-step pattern)?

#### Auth Issues
- [ ] Session valid and not expired?
- [ ] User has required role/permissions?
- [ ] protectedProcedure used for mutations?
- [ ] Middleware routing correct?

#### UI Issues
- [ ] Null guards present (`?.` or `|| ""`)?
- [ ] Loading state handled?
- [ ] Error state handled?
- [ ] Mobile responsive (`sm:page-container`)?
- [ ] No `value=""` in Select.Item?

#### Build Issues
- [ ] All imports resolve?
- [ ] No circular dependencies?
- [ ] jsdom dynamically imported?
- [ ] No client/server boundary violations?

---

## PHASE 5: ROOT CAUSE IDENTIFICATION

### 5.1 Document Root Cause
```markdown
## Root Cause Analysis

### The Problem
[Exact technical cause]

### Why It Happened
[How this bug was introduced]

### CLAUDE.md Violation (If Any)
- Rule violated: [CR-X or pattern]
- Correct pattern: [from CLAUDE.md]

### Files Affected
- [file1:line]
- [file2:line]
```

### 5.2 Verify Root Cause
```bash
# Prove the root cause with VR-* protocol
# VR-GREP: Show the problematic code
grep -n "[problematic pattern]" [file]

# VR-NEGATIVE: Confirm violation exists
grep -rn "[violation]" src/ | wc -l
# Should be > 0 if this is the cause
```

---

## PHASE 6: FIX & VERIFY

### 6.1 Apply Fix
Follow CLAUDE.md patterns exactly:
- Read relevant pattern file
- Apply minimal correct fix
- Do NOT over-engineer

### 6.2 Verify Fix (MANDATORY)

```bash
# VR-NEGATIVE: Violation removed
grep -rn "[old_violation]" src/ | wc -l
# Expected: 0

# VR-GREP: Correct pattern present
grep -n "[correct_pattern]" [file]
# Expected: Match found

# VR-BUILD: Build passes
npm run build

# VR-TYPE: Types pass
npx tsc --noEmit

# Pattern scanner
./scripts/pattern-scanner.sh

# VR-COUPLING: Backend-frontend sync (CRITICAL - Added Jan 2026)
./scripts/check-coupling.sh
# Expected: Exit 0 - all backend features exposed in UI
```

### 6.3 Environment Verification
If DB-related, verify fix in all environments:
```sql
-- Run same query that was failing
-- Verify it now succeeds
```

---

## PHASE 7: REGRESSION CHECK

### 7.1 Related Functionality
```bash
# Find all uses of modified code
grep -rn "[modified_function]" src/

# Check for other places with same pattern
grep -rn "[similar_pattern]" src/
```

### 7.2 Test User Flow
Verify the original user flow now works:
```markdown
| Step | Action | Expected | Actual | Status |
|------|--------|----------|--------|--------|
| 1 | [action] | [expected] | [actual] | PASS |
| 2 | [action] | [expected] | [actual] | PASS |
```
