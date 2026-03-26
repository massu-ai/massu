# Test-First Protocol for Critical Findings

> Shared reference for /massu-loop and /massu-debug.
> Inspired by Hurlicane's "evidence before assertions" pattern.

## When This Applies

This protocol is MANDATORY when:
- A review agent or debug investigation identifies a CRITICAL severity finding
- The finding involves a bug (not a style/pattern violation)
- The fix touches logic that can be unit-tested or integration-tested

This protocol is OPTIONAL (but recommended) for:
- HIGH severity findings
- Findings that involve data flow, state management, or business logic

This protocol does NOT apply to:
- LOW/MEDIUM pattern compliance fixes (CSS, naming, import order)
- Documentation-only changes
- Config/command infrastructure changes

## The Protocol (4 Steps)

### Step 1: Write the Failing Test

Before touching ANY source code, write a test that demonstrates the bug:

```typescript
// Example: proving a serialization bug exists
it('should serialize BigInt fields to Number', () => {
  const result = serializeRecord({ id: BigInt(123) });
  expect(typeof result.id).toBe('number'); // This will FAIL
});
```

### Step 2: Verify Test Fails

Run the test and confirm it fails for the expected reason:

```bash
npm test -- -t "should serialize BigInt"
# Expected: FAIL with the specific assertion error
# Note: This project uses Vitest. Use -t (--testNamePattern) for filtering, NOT --grep.
```

If the test PASSES (the bug doesn't reproduce in test):
- The finding may be a false positive — investigate further
- Or the test doesn't exercise the right code path — fix the test
- Do NOT proceed to fix until you have a failing test

### Step 3: Apply the Fix

Now fix the source code. The fix should be minimal and targeted.

### Step 4: Verify Test Passes

```bash
npm test -- -t "should serialize BigInt"
# Expected: PASS
```

Run the full test suite to check for regressions:

```bash
npm test
# Expected: ALL pass
```

## Output Format

When using this protocol, report:

```
TEST-FIRST PROTOCOL for: [finding description]
  Step 1: Test written → [file:line]
  Step 2: Test fails → [error message confirming the bug]
  Step 3: Fix applied → [file:line, description]
  Step 4: Test passes → [npm test output showing pass]
  TEST_FIRST_GATE: PASS
```

## Exceptions

If the finding CANNOT be tested (e.g., race condition only in production, visual rendering issue):
- Document WHY it can't be tested
- Use VR-BROWSER or VR-VISUAL as the evidence-before-assertion equivalent
- Report: `TEST_FIRST_GATE: SKIPPED — [reason]`
