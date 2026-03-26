# VR-* Verification Reference

**Purpose**: Master reference for ALL verification types used across massu commands. Every verification prevents a specific class of bugs from reaching production.

**When to Read**: Before claiming ANY work is complete. During massu command execution. After any audit failure.

---

## Sections
| Section | Description |
|---------|-------------|
| Quick Reference Matrix | All VR-* types: command, expected output, use case, what it catches |
| Core Verification Types | VR-FILE, VR-GREP, VR-NEGATIVE, VR-BUILD, VR-TYPE, VR-TEST, VR-DEPLOY, VR-SCHEMA |
| UI-Specific Verification Types | VR-RENDER, VR-ROUTE, VR-LINK, VR-HANDLER, VR-PROPS, VR-STATE, VR-FORM |
| Security Verification Types | VR-AUTH, VR-RLS, VR-SECRETS, VR-PATTERN, VR-SCAN |
| Quality Verification Types | VR-A11Y, VR-MOBILE, VR-PERF, VR-LINT, VR-COUPLING |
| End-to-End Verification Types | VR-E2E, VR-VISUAL, VR-FLOW, VR-REGRESSION |
| Database Verification Types | VR-SCHEMA-PRE, VR-DATA, VR-MIGRATION, VR-BLAST-RADIUS, VR-SCHEMA-SYNC |
| Plan Verification Types | VR-PLAN-STATUS, VR-PLAN-TABS, VR-PLAN-SPEC, VR-PLAN-COVERAGE, VR-COUNT, VR-FEATURE-REG, VR-SPEC-MATCH, VR-PIPELINE |
| Verification Checklists by Task Type | Per-task checklists: new feature, bug fix, refactor, migration, security |
| Verification Output Format | Standard format for reporting verification results |

## Quick Reference Matrix

| Type | Command | Expected | Use When | Catches |
|------|---------|----------|----------|---------|
| VR-FILE | `ls -la [path]` | File exists | Claiming file created | Missing files |
| VR-GREP | `grep "[pattern]" [file]` | Match found | Claiming code added | Missing code |
| VR-NEGATIVE | `grep -rn "[old]" src/` | 0 matches | Claiming removal | Leftover code |
| VR-BUILD | `npm run build` | Exit 0 | Claiming production ready | Build failures |
| VR-TYPE | `npx tsc --noEmit` | 0 errors | Claiming type safety | Type errors |
| VR-TEST | `npm test` | All pass | Claiming tested | Test failures |
| VR-DEPLOY | `./scripts/pre-deploy-check.sh` | All pass | Claiming deployable | Deploy blockers |
| VR-SCHEMA | `SELECT ... FROM information_schema` | Matches | Before DB operations | Schema mismatches |
| VR-SCHEMA-PRE | `SELECT column_name...` | Columns exist | BEFORE writing ANY query | Wrong column names |
| VR-COUNT | `grep -c "[pattern]" [file]` | Expected count | Verifying all instances | Missed instances |
| VR-RENDER | `grep "<Component" src/app/**/page.tsx` | Match in page | Claiming UI integrated | Orphan components |
| VR-INTEGRATION | grep + build | Component used AND builds | Claiming feature complete | Unused features |
| VR-ROUTE | `grep "path:" src/app/` | Route defined | Claiming route works | Broken routes |
| VR-LINK | `grep "href=" [file]` + route check | Link target exists | Claiming navigation | Dead links |
| VR-HANDLER | `grep "onClick\|onSubmit" [file]` | Handler exists | Claiming interactivity | Dead buttons |
| VR-PROPS | TypeScript + grep | Props passed correctly | Claiming component works | Missing props |
| VR-STATE | grep + useEffect check | State managed correctly | Claiming data flows | State bugs |
| VR-FORM | grep for validation + submit | Form validates/submits | Claiming form works | Broken forms |
| VR-A11Y | Accessibility check | WCAG compliance | Claiming accessible | A11y violations |
| VR-MOBILE | Viewport + touch check | Mobile responsive | Claiming mobile support | Mobile breakage |
| VR-AUTH | Role/permission check | Auth enforced | Claiming protected | Auth bypass |
| VR-E2E | `npm run test:e2e` | All pass | Claiming user flow works | Flow breakage |
| VR-RLS | Policy + grant check | RLS configured | Claiming DB secure | Data exposure |
| VR-PATTERN | `./scripts/pattern-scanner.sh` | Exit 0 | Claiming pattern compliance | Pattern violations |
| VR-PLAN-STATUS | `grep "IMPLEMENTATION STATUS" [plan]` | Completion table exists | After checkpoint/commit | Missing completion tracking |
| VR-PLAN-TABS | `grep -c "<TabsTrigger" [file]` | Count matches plan | Plan specifies tabs | Wrong tab count |
| VR-PLAN-SPEC | Multiple greps per spec | All UI elements exist | Plan specifies UI structure | Missing UI elements |
| VR-FEATURE-REG | Feature registry validation | 0 orphaned features | After any feature implementation | Lost features |
| VR-SPEC-MATCH | Grep for EXACT CSS classes/structure from plan | All specified strings found | UI plan items with specific specs | Spec drift from plan |
| VR-PIPELINE | Trigger pipeline, verify non-empty output | Data returned | Data pipeline features | Empty/broken pipelines |

---

## Core Verification Types

### VR-FILE: File Existence

**Purpose**: Verify a file was actually created where claimed.

```bash
# Basic file check
ls -la src/components/feature/MyComponent.tsx

# Multiple files
ls -la src/components/feature/{MyComponent,MyForm,MyList}.tsx

# Directory exists
ls -la src/components/feature/
```

**Expected Output**: File listed with permissions, size, date
**Failure Mode**: "No such file or directory"

---

### VR-GREP: Code Presence

**Purpose**: Verify specific code was added to a file.

```bash
# Function exists
grep -n "export function myFunction" src/lib/utils.ts

# Import present
grep -n "import.*MyComponent" src/app/feature/page.tsx

# Pattern in multiple files
grep -rn "useMyHook" src/components/
```

**Expected Output**: Line number and matching content
**Failure Mode**: No output (empty result)

---

### VR-NEGATIVE: Removal Verification

**Purpose**: Verify code was COMPLETELY removed. **CRITICAL for refactoring.**

```bash
# Verify old pattern removed
grep -rn "oldFunction" src/
# Expected: 0 matches

# Verify deprecated import gone
grep -rn "from 'deprecated-lib'" src/
# Expected: 0 matches

# Count remaining (should be 0)
grep -rn "legacyPattern" src/ | wc -l
# Expected: 0
```

**Expected Output**: Empty (no matches)
**Failure Mode**: Any output means removal incomplete

---

### VR-BUILD: Production Build

**Purpose**: Verify code compiles for production deployment.

```bash
npm run build
# Expected: Exit 0, "Compiled successfully"
```

**Expected Output**: Build completes without errors
**Failure Mode**: Non-zero exit code, error messages

**Note**: Build passing does NOT mean feature works - components must also be RENDERED.

---

### VR-TYPE: TypeScript Check

**Purpose**: Verify zero TypeScript errors.

```bash
NODE_OPTIONS="--max-old-space-size=8192" npx tsc --noEmit
# Expected: 0 errors (no output)
```

**Expected Output**: No output (clean)
**Failure Mode**: TypeScript error messages

---

### VR-TEST: Test Suite

**Purpose**: Verify tests pass.

```bash
# Unit tests
npm run test:run

# E2E tests
npm run test:e2e

# Specific test file
npm test -- src/components/feature/__tests__/MyComponent.test.tsx
```

**Expected Output**: All tests pass
**Failure Mode**: Test failures reported

---

### VR-DEPLOY: Pre-Deploy Check

**Purpose**: Full deployment readiness verification.

```bash
./scripts/pre-deploy-check.sh
# Runs: pattern scanner, type check, build, lint, security
```

**Expected Output**: Exit 0, all checks pass
**Failure Mode**: Any check failure

---

### VR-SCHEMA: Database Schema

**Purpose**: Verify database schema matches expectations.

```sql
-- Check table structure
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'my_table';

-- Check specific column
SELECT column_name FROM information_schema.columns
WHERE table_name = 'my_table' AND column_name = 'my_column';
```

**Expected Output**: Column definitions returned
**Failure Mode**: Empty result or wrong columns

---

### VR-SCHEMA-PRE: Pre-Query Schema Check

**Purpose**: Verify column names BEFORE writing ANY query. **MANDATORY before database operations.**

```sql
-- BEFORE using ANY column, verify it exists
SELECT column_name FROM information_schema.columns
WHERE table_name = 'documents' AND column_name IN ('design_project_id', 'entity_type');
-- Expected: Only columns that actually exist are returned
```

**Expected Output**: Only valid columns returned
**Failure Mode**: Missing expected columns = wrong assumption

---

### VR-COUNT: Instance Count

**Purpose**: Verify expected number of occurrences.

```bash
# Verify pattern appears in all expected locations
grep -c "MyComponent" src/app/*/page.tsx

# Should match expected count (e.g., 5 pages)
grep -rn "useMyHook" src/components/ | wc -l
```

**Expected Output**: Count matches expected number
**Failure Mode**: Count mismatch

---

## UI-Specific Verification Types

### VR-RENDER: Component Render (CRITICAL)

**Purpose**: Verify UI components are actually RENDERED in pages, not just created.

**Why This Exists**: Build passing + Type check passing does NOT mean a component is used. Components must be imported AND rendered in a page to be visible to users.

```bash
# Step 1: Verify component file exists
ls -la src/components/feature/MyComponent.tsx

# Step 2: Verify component is exported
grep "export.*MyComponent" src/components/feature/index.ts

# Step 3: CRITICAL - Verify component is RENDERED in a page
grep "<MyComponent" src/app/**/page.tsx

# If Step 3 returns 0 matches, THE FEATURE IS NOT IMPLEMENTED
```

**Expected Output**: Match found in at least one page.tsx file
**Failure Mode**: 0 matches = component created but NOT implemented

**Verification Matrix for UI Components**:
| Check | Command | Expected |
|-------|---------|----------|
| File exists | `ls -la [component].tsx` | File listed |
| Exported | `grep "export" index.ts` | Match found |
| **RENDERED** | `grep "<Name" src/app/**/page.tsx` | **Match found** |

---

### VR-INTEGRATION: Full Feature Integration

**Purpose**: Verify component is imported, rendered, AND the build still passes.

```bash
# Combined check
grep "<MyComponent" src/app/feature/page.tsx && npm run build

# Full integration verification
grep "import.*MyComponent" src/app/feature/page.tsx && \
grep "<MyComponent" src/app/feature/page.tsx && \
npm run build
```

**Expected Output**: All checks pass
**Failure Mode**: Missing import, missing render, or build failure

---

### VR-ROUTE: Route Definition

**Purpose**: Verify routes are properly defined and accessible.

```bash
# App Router - verify page.tsx exists
ls -la src/app/feature/page.tsx

# Verify dynamic routes
ls -la src/app/feature/[id]/page.tsx

# Check route in navigation
grep "href=\"/feature\"" src/components/nav/
```

**Expected Output**: Route files exist, navigation points to them
**Failure Mode**: Missing route file, broken navigation

---

### VR-LINK: Link Verification

**Purpose**: Verify links point to existing routes.

```bash
# Find all links in component
grep -n "href=" src/components/feature/MyComponent.tsx

# For EACH href, verify target exists
# href="/feature" -> verify src/app/feature/page.tsx exists
```

**Expected Output**: All link targets exist
**Failure Mode**: Link to non-existent route

---

### VR-HANDLER: Event Handler Verification

**Purpose**: Verify interactive elements have working handlers.

```bash
# Find buttons/forms
grep -n "onClick\|onSubmit\|onPress" src/components/feature/MyComponent.tsx

# Verify handler functions exist
grep -n "const handleClick\|function handleSubmit" src/components/feature/MyComponent.tsx

# Verify handlers do something (not empty)
grep -A5 "const handleClick" src/components/feature/MyComponent.tsx
```

**Expected Output**: Handlers defined and have implementation
**Failure Mode**: Missing handler, empty handler, undefined handler

---

### VR-PROPS: Props Verification

**Purpose**: Verify components receive required props.

```bash
# Check component interface
grep -A10 "interface.*Props" src/components/feature/MyComponent.tsx

# Check prop usage where component is rendered
grep -B2 -A5 "<MyComponent" src/app/feature/page.tsx

# Verify required props are passed
grep "<MyComponent.*requiredProp=" src/app/feature/page.tsx
```

**Expected Output**: All required props passed
**Failure Mode**: TypeScript errors or runtime errors from missing props

---

### VR-STATE: State Management Verification

**Purpose**: Verify state flows correctly through the application.

```bash
# Find state declarations
grep -n "useState\|useReducer\|useContext" src/components/feature/MyComponent.tsx

# Verify state is used
grep -n "setMyState\|dispatch" src/components/feature/MyComponent.tsx

# Check for proper useEffect dependencies
grep -A5 "useEffect" src/components/feature/MyComponent.tsx
```

**Expected Output**: State declared, modified, and properly synchronized
**Failure Mode**: Unused state, missing updates, stale closures

---

### VR-FORM: Form Verification

**Purpose**: Verify forms validate and submit correctly.

```bash
# Check form structure
grep -n "<form\|<Form" src/components/feature/MyForm.tsx

# Verify validation
grep -n "zodResolver\|yupResolver\|validate" src/components/feature/MyForm.tsx

# Verify submit handler
grep -n "onSubmit\|handleSubmit" src/components/feature/MyForm.tsx

# Verify form fields
grep -n "register\|Controller\|Field" src/components/feature/MyForm.tsx
```

**Expected Output**: Form has validation, submit handler, proper fields
**Failure Mode**: Missing validation, broken submission, uncontrolled fields

---

## Security Verification Types

### VR-AUTH: Authentication/Authorization

**Purpose**: Verify protected routes and mutations are properly secured.

```bash
# Verify protected procedure usage
grep "protectedProcedure" src/server/api/routers/feature.ts

# Check for publicProcedure on mutations (BAD)
grep "publicProcedure.mutation" src/server/api/routers/
# Expected: 0 matches

# Verify role checks
grep "ctx.user.role\|hasPermission" src/server/api/routers/feature.ts
```

**Expected Output**: All mutations use protectedProcedure, role checks where needed
**Failure Mode**: Unprotected mutations, missing role checks

---

### VR-RLS: Row Level Security

**Purpose**: Verify database tables have proper RLS configuration.

```sql
-- Check RLS enabled
SELECT tablename, rowsecurity FROM pg_tables
WHERE schemaname = 'public' AND tablename = 'my_table';

-- Check policies exist
SELECT policyname FROM pg_policies WHERE tablename = 'my_table';

-- Check grants exist (often forgotten!)
SELECT grantee, privilege_type FROM information_schema.table_privileges
WHERE table_name = 'my_table';
```

**Expected Output**: RLS enabled, policies defined, grants exist
**Failure Mode**: RLS disabled, missing policies, missing grants

---

### VR-SECRETS: Secret Detection

**Purpose**: Verify no secrets in code.

```bash
# Check staged files for secrets
git diff --cached --name-only | grep -E '\.(env|pem|key|secret)'
# Expected: 0 matches

# Manual check for common patterns
grep -rn "sk-\|api_key\|password\|secret" src/ --include="*.ts" --include="*.tsx"
```

**Expected Output**: No secrets found
**Failure Mode**: Secrets detected

---

## Quality Verification Types

### VR-TOKEN: Design Token Compliance

**Purpose**: Verify CSS files use design tokens (CSS variables) instead of hardcoded colors.

```bash
# Full scan
bash scripts/audit-design-tokens.sh
# Expected: Exit 0 (zero errors)

# Single file (fast, for hooks)
bash scripts/audit-design-tokens.sh --single-file src/styles/component.css

# CI mode (JSON output)
bash scripts/audit-design-tokens.sh --ci
```

**Expected Output**: Exit 0, zero hardcoded hex/rgb/rgba colors outside variable definitions
**Failure Mode**: Hardcoded color values found

---

### VR-A11Y: Accessibility

**Purpose**: Verify WCAG compliance.

```bash
# Check for aria labels
grep -n "aria-label\|aria-labelledby" src/components/feature/MyComponent.tsx

# Check for alt text on images
grep -n "<img" src/components/ | grep -v "alt="
# Expected: 0 matches (all images have alt)

# Check for proper heading hierarchy
grep -n "<h1\|<h2\|<h3" src/app/feature/page.tsx
```

**Expected Output**: Proper ARIA attributes, alt text, heading hierarchy
**Failure Mode**: Missing accessibility attributes

---

### VR-MOBILE: Mobile Responsiveness

**Purpose**: Verify mobile/tablet compatibility.

```bash
# Check for responsive classes
grep -n "sm:\|md:\|lg:" src/components/feature/MyComponent.tsx

# Check for touch handlers
grep -n "onTouchStart\|onPointerDown" src/components/feature/MyComponent.tsx
```

**Expected Output**: Responsive design patterns present
**Failure Mode**: Fixed widths, no mobile breakpoints

---

### VR-PATTERN: Pattern Compliance

**Purpose**: Verify code follows established patterns.

```bash
./scripts/pattern-scanner.sh
# Expected: Exit 0

# Specific pattern checks
grep -rn "ctx.prisma" src/
# Expected: 0 matches (use ctx.db)

grep -rn "include:" src/server/
# Expected: 0 matches (use 3-step pattern)
```

**Expected Output**: Pattern scanner passes
**Failure Mode**: Pattern violations detected

---

## End-to-End Verification Types

### VR-ROUNDTRIP: Full Write->Store->Read->Display Verification

**Purpose**: Verify a feature works end-to-end: data can be written, persists in the database, can be read back, and displays correctly in UI. Catches "half-built" features where code compiles but doesn't function in production.

**When to use**: ANY plan item that creates or modifies a data flow.

```
For each data flow in the feature, prove ALL 4 steps:

STEP 1: WRITE -- Trigger the action (UI button, cron, API call)
  Proof: Show the tRPC mutation/API call exists AND is reachable from UI or cron
  Command: grep -n "useMutation\|mutateAsync\|useQuery" src/app/**/[feature-page].tsx
  Also:    grep -n "[procedureName]" src/server/api/routers/[router].ts

STEP 2: STORE -- Verify data persists in database
  Proof: The service function writes to a real table with real columns
  Command: VR-SCHEMA-PRE on the target table (columns exist)
  Also:    grep -n "ctx.db\.[table]\.(create\|update\|upsert)" src/lib/services/[service].ts

STEP 3: READ -- Verify data can be queried back
  Proof: A tRPC query or server component reads from the same table
  Command: grep -n "ctx.db\.[table]\.(findMany\|findFirst\|findUnique)" src/server/api/routers/[router].ts
  Also:    Verify query is called from UI: grep -n "useQuery\|useSuspenseQuery" src/app/**/[page].tsx

STEP 4: DISPLAY -- Verify data renders in UI
  Proof: Component renders query data (not hardcoded/mock)
  Command: VR-RENDER -- grep for component in page
  Also:    VR-BROWSER -- Playwright navigate + snapshot shows real data
```

**Compact format for plan item verification:**
```
VR-ROUNDTRIP: [feature-name]
  WRITE:   [mutation/action] in [file:line] -- PASS
  STORE:   [table.column] -- columns exist (VR-SCHEMA-PRE) -- PASS
  READ:    [query] in [router:line] -- PASS
  DISPLAY: [component] in [page:line] -- PASS
```

**Expected Output**: All 4 steps verified with file:line proof
**Failure Mode**: Any step missing = feature is not functional.

**Exceptions**:
- Background-only features (cron jobs, webhooks) may skip DISPLAY if there's no user-facing output. Must still prove WRITE+STORE+READ.
- Query-only features (read-only dashboards) may skip WRITE+STORE if they read existing data.

---

### VR-E2E: End-to-End Tests

**Purpose**: Verify complete user flows work.

```bash
# Run all E2E tests
npm run test:e2e

# Run specific test
npx playwright test tests/e2e/feature.spec.ts
```

**Expected Output**: All E2E tests pass
**Failure Mode**: Test failures

---

### VR-VISUAL: LLM-as-Judge Visual Quality Review

**Purpose**: Automated visual quality assessment using screenshot + LLM vision evaluation. Scores UI quality across 4 weighted dimensions with calibrated criteria.

```bash
# Run visual review for a specific route
bash scripts/ui-review.sh /dashboard/contacts

# Run with a component spec for targeted evaluation
bash scripts/ui-review.sh /dashboard/contacts specs/components/data-table.md

# Run with spec drift audit
bash scripts/ui-review.sh /dashboard/contacts --drift
```

**Scoring Dimensions** (weighted average, threshold >= 3.0 = PASS):

| Dimension | Weight | What It Measures |
|-----------|--------|------------------|
| Design Quality (DQ) | 2x | Coherent visual identity, deliberate design choices |
| Functionality (FN) | 2x | Usable hierarchy, findable actions, clear navigation |
| Craft (CR) | 1x | Spacing, typography, color consistency |
| Completeness (CO) | 1x | All states handled, no broken elements |

**Formula**: `weighted_score = (DQ*2 + FN*2 + CR*1 + CO*1) / 6`

**Expected Output**:
```
VR_VISUAL_STATUS: PASS
VR_VISUAL_ROUTE: /dashboard/contacts
VR_VISUAL_WEIGHTED_SCORE: 4.2/5.0
VR_VISUAL_SCORES: DQ=4 FN=5 CR=4 CO=3
```

**Failure Mode**: `VR_VISUAL_STATUS: FAIL` (weighted score < 3.0) with per-dimension findings

**When to use**: After ANY UI change. Complements VR-BROWSER (functional) with quality assessment.
**NOT a replacement for**: VR-BROWSER (functional testing), VR-TOKEN (CSS variable audit), VR-SPEC-MATCH (exact class verification)

---

## Database Verification Types

### VR-SYNC / VR-SCHEMA-SYNC: Multi-Database Schema Sync

**Purpose**: Verify all database environments have identical schema for affected tables. **MANDATORY after ANY database migration.**

```sql
-- For EACH table affected by migration, run on ALL environments:

-- Step 1: Column count comparison (quick check)
SELECT COUNT(*) FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = '[TABLE]';

-- Step 2: Detailed column comparison (if counts differ)
SELECT column_name, data_type, is_nullable FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = '[TABLE]' ORDER BY ordinal_position;
```

**Expected Output**: Column counts AND names match across all environments
**Failure Mode**: Schema drift - columns exist in one environment but not others
**Blocking**: YES - migration is NOT complete until all environments match

**Migration Application Protocol**:
1. Apply to each environment -> verify
2. Run VR-SCHEMA-SYNC on all environments -> column counts MUST match

---

### VR-MIGRATION: Migration Verification

**Purpose**: Verify migrations applied successfully.

```sql
-- Check specific migration effect
SELECT * FROM information_schema.columns WHERE table_name = 'new_table';
```

**Expected Output**: Migration applied, expected schema changes present
**Failure Mode**: Migration not applied or failed

---

## Plan Verification Types

### VR-PLAN-STATUS: Plan Completion Tracking

**Purpose**: Verify plan documents are updated with completion status after checkpoints/commits.

```bash
# Check plan has completion table
grep "IMPLEMENTATION STATUS" [plan_file]
# Expected: Match found

# Check phases are marked
grep "100% COMPLETE\|DONE\|\*\*DONE\*\*" [plan_file] | wc -l
# Expected: Count matches completed phases
```

**Expected Output**: Plan has completion section, completed phases marked
**Failure Mode**: Missing completion table, phases completed but not marked

**When to Run**: After EVERY checkpoint, BEFORE claiming phase complete

---

### VR-PLAN-TABS: Tab Count Verification

**Purpose**: Verify tab implementations match plan specifications.

```bash
# Count tabs in page
grep -c "<TabsTrigger" src/app/[path]/page.tsx
# Expected: Matches plan specification
```

**Expected Output**: Count equals plan specification
**Failure Mode**: Wrong number of tabs implemented

---

### VR-PLAN-SPEC: UI Specification Verification

**Purpose**: Verify UI structure matches plan specifications.

```bash
# For each UI element specified in plan:
grep "<ComponentName" [file]           # Component exists
grep "TabsTrigger.*\"tab-name\"" [file] # Specific tab exists
grep "MoreMenu\|DropdownMenu" [file]   # Menu exists
grep "ViewSwitcher\|Select" [file]     # Switcher exists
```

**Expected Output**: All specified UI elements found
**Failure Mode**: Missing UI elements from plan

---

### VR-SPEC-MATCH: Literal Spec Match

**Purpose**: Verify that EVERY CSS class, component attribute, or layout instruction specified in a plan item exists EXACTLY in the implementation. Prevents spec drift.

```bash
# For each plan item with specific CSS classes/structure:
# Example: Plan says "indented with ml-6 border-l-2 border-muted pl-4"
grep "ml-6" src/components/feature/Component.tsx        # Must match
grep "border-l-2" src/components/feature/Component.tsx  # Must match
grep "border-muted" src/components/feature/Component.tsx # Must match
grep "pl-4" src/components/feature/Component.tsx        # Must match
```

**Expected Output**: ALL plan-specified literal strings found in implementation
**Failure Mode**: Plan says `ml-6 border-l-2` but implementation uses `ml-4 border-l` -- spec drift

---

### VR-PIPELINE: Data Pipeline End-to-End

**Purpose**: For features that generate or process data (AI, cron, generation, ETL), verify the pipeline produces non-empty output when triggered.

```bash
# Example: AI pipeline
# Trigger the procedure and check output
# Expected: Non-empty response with actual data

# Example: Cron job
curl -X POST http://localhost:3000/api/cron/digest -H "Authorization: Bearer $CRON_SECRET"
# Expected: Response body contains data, not empty arrays
```

**Expected Output**: Pipeline produces non-empty, meaningful data
**Failure Mode**: Pipeline runs without error but returns empty results -- silent failure

---

## Verification Checklists by Task Type

### New Feature Checklist
- [ ] VR-FILE: All component files exist
- [ ] VR-RENDER: Components rendered in pages
- [ ] VR-ROUTE: Routes defined
- [ ] VR-LINK: Navigation works
- [ ] VR-HANDLER: Events handled
- [ ] VR-PROPS: Props passed correctly
- [ ] VR-AUTH: Protected appropriately
- [ ] VR-SPEC-MATCH: Plan CSS classes/structure exist in implementation
- [ ] VR-PIPELINE: Data pipelines produce non-empty output (if applicable)
- [ ] VR-TYPE: Zero type errors
- [ ] VR-BUILD: Build passes
- [ ] VR-PATTERN: Pattern compliant

### Refactoring Checklist
- [ ] VR-NEGATIVE: Old code removed
- [ ] VR-COUNT: All instances updated
- [ ] VR-TEST: Tests pass
- [ ] VR-TYPE: Zero type errors
- [ ] VR-BUILD: Build passes
- [ ] VR-E2E: User flows work

### Database Change Checklist
- [ ] VR-SCHEMA-PRE: Column names verified
- [ ] VR-SCHEMA: Schema correct
- [ ] VR-RLS: RLS + grants configured
- [ ] VR-SYNC: All environments in sync
- [ ] VR-MIGRATION: Migration applied

### Security Change Checklist
- [ ] VR-AUTH: Protected procedures
- [ ] VR-RLS: Row level security
- [ ] VR-SECRETS: No exposed secrets
- [ ] VR-PATTERN: Security patterns followed

---

## Verification Output Format

When running verifications, document results in this format:

```markdown
### Verification Results

| VR Type | Command | Expected | Actual | Status |
|---------|---------|----------|--------|--------|
| VR-FILE | `ls -la component.tsx` | File exists | File exists | PASS |
| VR-RENDER | `grep "<Component" page.tsx` | Match found | Match line 42 | PASS |
| VR-BUILD | `npm run build` | Exit 0 | Exit 0 | PASS |
| VR-NEGATIVE | `grep "oldCode" src/` | 0 matches | 3 matches | **FAIL** |

**Overall Status**: FAIL (VR-NEGATIVE failed)
```

---

## Related Files

- [CLAUDE.md](../CLAUDE.md) - Prime directive with VR-* summary table
- [protocols/verification.md](../protocols/verification.md) - Full verification protocol
- [patterns-quickref.md](patterns-quickref.md) - Pattern quick reference

---

**Document Status**: VR-* Verification Master Reference
**Authority**: Used by ALL massu commands
