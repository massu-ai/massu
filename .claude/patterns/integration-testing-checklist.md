# Integration Testing Checklist

**Purpose**: Router contract verification, pre-test writing steps, test templates, common anti-patterns, prevention system.

**When to Read**: Before writing integration tests.

---

## CRITICAL: Router Contract Verification Required

**Why**: Writing tests for non-existent router methods wastes time and resources. Tests will always fail with "No procedure found" errors.

**Prevention**: Always verify router methods exist BEFORE writing integration tests.

---

## Pre-Test Writing Checklist

### [x] Step 1: Read the Actual Router File

**DO NOT SKIP THIS STEP**

```bash
# Example: Verify workflow engine router methods
cat src/server/api/routers/workflow-engine.ts | grep -A2 "export const"

# Look for the router definition:
# export const workflowEngineRouter = createTRPCRouter({
#   methodName: protectedProcedure...
# })
```

**Common Mistake**: Assuming methods exist based on naming conventions
**Correct Approach**: Read the actual file to see what's implemented

---

### [x] Step 2: List Available Methods in Test Header

Document the router's API contract at the top of your test file:

```typescript
/**
 * Integration Tests: Workflow Engine Router
 *
 * ========================================
 * ROUTER METHODS VERIFIED ({Date})
 * ========================================
 * Source: src/server/api/routers/workflow-engine.ts
 *
 * Available Methods:
 * - executeWorkflow(workflowId, context?) - Execute a workflow with optional context
 * - getExecutionStatus(executionId) - Get the status of a workflow execution
 * - pauseExecution(executionId) - Pause a running workflow
 * - resumeExecution(executionId) - Resume a paused workflow
 *
 * Methods NOT Available:
 * - create() - Does NOT exist (use workflows.create() instead)
 * - update() - Does NOT exist (workflows are immutable)
 * - delete() - Does NOT exist (workflows are immutable)
 *
 * Input Schemas:
 * - executeWorkflow: { workflowId: string (UUID), context?: Record<string, any> }
 * - getExecutionStatus: { executionId: string (UUID) }
 * - pauseExecution: { executionId: string (UUID) }
 * - resumeExecution: { executionId: string (UUID) }
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createCaller } from '../helpers/trpc';
```

**Why**: This documentation serves as a contract. When the router changes, you can immediately see what needs updating in tests.

---

### [x] Step 3: Verify Input Schemas

Check the Zod schema for each method you'll be testing:

```typescript
// From router file:
executeWorkflow: protectedProcedure
  .input(z.object({
    workflowId: z.string().uuid(),           // <- Required, must be UUID
    context: z.record(z.any()).optional(),   // <- Optional, any object
  }))
  .mutation(async ({ ctx, input }) => {
    // Implementation...
  }),
```

**Document in Test**:
```typescript
// Test using correct input structure
const result = await caller.workflowEngine.executeWorkflow({
  workflowId: testWorkflowId,  // [x] Matches schema: string UUID
  context: { userId: 'test' }  // [x] Matches schema: optional Record
});
```

**Common Mistakes**:
- [X] Passing `{ name, trigger_type, workflow_definition }` to `executeWorkflow` (wrong schema)
- [X] Calling `create()` when only `executeWorkflow()` exists (method doesn't exist)
- [X] Missing required fields (Zod will error at runtime)

---

### [x] Step 4: Run Router Contract Validation

**BEFORE COMMITTING**, run the validation script:

```bash
npm run validate:router-contracts
```

**Expected Output (Success)**:
```
=== API Contract Validation ===
 Scanning integration test files...
   Found 21 test files

 Extracting router method calls...
   Found 125 router method calls

 Building router contract map...
   Found 174 routers with 1497 total procedures

[x] SUCCESS: All 125 router method calls are valid!
   No API contract violations found.
```

**If Failures Found**:
```
[X] FAILURE: Found 5 invalid router method calls

Router: workflowEngine
  [x] Router exists
     Available methods: executeWorkflow, getExecutionStatus, pauseExecution, resumeExecution

  [X] create()
     File: tests/integration/critical-flows/workflow-lifecycle.test.ts:165
     Code: const workflow = await caller.workflowEngine.create({
     Method 'create' does not exist in workflowEngine router
```

**Action**: Fix the test BEFORE committing. Update method calls to use actual router methods.

---

### [x] Step 5: Commit Tests Immediately

**DO NOT** leave integration tests as untracked files.

```bash
# Stage your test files
git add tests/integration/critical-flows/my-new-test.test.ts

# Commit immediately
git commit -m "test(integration): add workflow engine lifecycle tests"

# Push to trigger CI/CD
git push
```

**Why**: Uncommitted tests don't run in CI/CD. Issues won't be caught until you commit them, wasting time.

---

## Test Writing Pattern

### Template for New Integration Tests

```typescript
/**
 * Integration Tests: {Router Name} Router
 *
 * ========================================
 * ROUTER METHODS VERIFIED ({Date})
 * ========================================
 * Source: src/server/api/routers/{router-file}.ts
 *
 * Available Methods:
 * - method1(params) - Description
 * - method2(params) - Description
 *
 * Methods NOT Available:
 * - methodX() - Does NOT exist (reason/alternative)
 *
 * Input Schemas:
 * - method1: { field: type, ... }
 * - method2: { field: type, ... }
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createCaller } from '../helpers/trpc';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

describe('Integration: {Router Name} Router', () => {
  let caller: ReturnType<typeof createCaller>;

  beforeAll(async () => {
    // Setup test data
    caller = createCaller({ userId: 'test-user-id' });
  });

  afterAll(async () => {
    // Cleanup test data
    await prisma.$disconnect();
  });

  describe('method1', () => {
    it('should do X when Y', async () => {
      // Test using VERIFIED router method
      const result = await caller.routerName.method1({
        field1: 'value',  // [x] Matches input schema
        field2: 123       // [x] Matches input schema
      });

      expect(result).toBeDefined();
      expect(result.field).toBe('expected-value');
    });
  });
});
```

---

## Common Anti-Patterns to Avoid

### [X] Anti-Pattern 1: Assuming Method Names

```typescript
// [X] WRONG: Assuming create() exists because it's common
const workflow = await caller.workflowEngine.create({
  name: 'Test Workflow',
  trigger_type: 'manual'
});
```

**Why Wrong**: Method doesn't exist. Should check router first.

**Correct Approach**:
```typescript
// [x] CORRECT: Verified executeWorkflow() exists
const execution = await caller.workflowEngine.executeWorkflow({
  workflowId: existingWorkflowId,
  context: { trigger: 'manual' }
});
```

---

### [X] Anti-Pattern 2: Testing Non-Existent Features

```typescript
// [X] WRONG: Writing tests for features that don't exist yet
describe('Workflow Templates', () => {
  it('should clone template', async () => {
    await caller.workflowEngine.cloneTemplate({ templateId: 'test' });
    //                         ^^^^^^^^^^^^^^^ Method doesn't exist
  });
});
```

**Why Wrong**: Test will always fail. Wastes time debugging "missing method" instead of actual bugs.

**Correct Approach**:
```typescript
// [x] CORRECT: Only test methods that exist
describe('Workflow Execution', () => {
  it('should execute workflow', async () => {
    // [x] executeWorkflow() verified to exist
    await caller.workflowEngine.executeWorkflow({
      workflowId: 'test-id'
    });
  });
});

// [x] OR: Skip test until feature implemented
describe.skip('Workflow Templates (NOT IMPLEMENTED)', () => {
  it('should clone template - PENDING IMPLEMENTATION', async () => {
    // TODO: Implement cloneTemplate() method first
  });
});
```

---

### [X] Anti-Pattern 3: Wrong Input Schema

```typescript
// [X] WRONG: Passing data that doesn't match Zod schema
const result = await caller.workflowEngine.executeWorkflow({
  name: 'Test',              // [X] Not in schema
  trigger_type: 'manual',    // [X] Not in schema
  workflow_definition: {}    // [X] Not in schema
});
```

**Why Wrong**: Zod validation will fail at runtime with confusing error messages.

**Correct Approach**:
```typescript
// [x] CORRECT: Match the actual input schema
const result = await caller.workflowEngine.executeWorkflow({
  workflowId: 'uuid-here',   // [x] Required field in schema
  context: {                 // [x] Optional field in schema
    userId: 'test',
    trigger: 'manual'
  }
});
```

---

## Troubleshooting

### Error: "No procedure found on path 'router,method'"

**Cause**: Test calls a router method that doesn't exist

**Solution**:
1. Run `npm run validate:router-contracts` to see all violations
2. Read the actual router file to see available methods
3. Update test to use correct method name
4. Re-run validation to confirm fix

### Error: Zod validation error with input schema

**Cause**: Test passes data that doesn't match the router's Zod input schema

**Solution**:
1. Open router file and find the method's `.input()` definition
2. Read the Zod schema to understand required/optional fields
3. Update test data to match schema exactly
4. Document input schema in test file header

### Error: Test files not running in CI/CD

**Cause**: Tests are uncommitted (untracked files)

**Solution**:
1. Check `git status` - are test files listed as "Untracked"?
2. Add files: `git add tests/integration/`
3. Commit: `git commit -m "test: add integration tests"`
4. Push: `git push`
5. Verify CI/CD runs: Check GitHub Actions

---

## Prevention System

### Layer 1: Local Pre-Commit Hook

Automatically blocks commits with router contract violations:

```bash
# Triggered automatically on git commit
[6/6] Router Contract Validation...
[X] Router contract violations detected
   Tests call router methods that don't exist
   Run: npm run validate:router-contracts
```

**How to Fix**: Run validation script, fix violations, then retry commit.

---

### Layer 2: GitHub Actions CI/CD

Fails CI if router contract violations detected:

```yaml
- name: Validate Router Contracts
  run: npm run validate:router-contracts
```

**Impact**: Pull requests cannot be merged if tests call non-existent methods.

---

### Layer 3: Documentation

This checklist enforces router verification as part of the test writing process.

**Required Reading**: Before writing integration tests, review this checklist.

---

## Success Metrics

You're following the checklist correctly when:

- [x] Test file header lists all router methods being tested
- [x] `npm run validate:router-contracts` returns SUCCESS
- [x] Tests are committed immediately after writing
- [x] CI/CD passes without router contract violations
- [x] No "No procedure found" errors in test output

---

## Real-World Example

**Problem**: 17/18 tests failed with "No procedure found on path 'workflowEngine,create'". Tests called `create()` but router only had `executeWorkflow()`. Wasted 2+ hours debugging test failures. Root cause: Tests written without verifying router methods.

**Solution Applied**:
1. Created router contract validation script
2. Added pre-commit hooks to block violations
3. Added CI/CD validation step
4. Created this checklist
5. Documented required process

**Result**: API contract mismatches now caught in <2 seconds, not 2+ hours.

---

## Quick Reference

**Before writing tests**:
```bash
# 1. Read router file
cat src/server/api/routers/my-router.ts

# 2. List methods in test header (see template above)

# 3. Write tests using VERIFIED methods

# 4. Validate contracts
npm run validate:router-contracts

# 5. Commit immediately
git add tests/integration/
git commit -m "test: add integration tests"
```

**Prevention is imperative**: These steps prevent wasting time on tests that will always fail.

---

**Document Status**: ACTIVE
**Enforcement**: Pre-commit hooks + GitHub Actions
**Compliance**: Mandatory for all integration tests
