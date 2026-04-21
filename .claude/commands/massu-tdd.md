---
name: massu-tdd
description: "When user wants test-driven development, says 'TDD', 'write tests first', 'red green refactor', or needs the RED-GREEN-IMPROVE cycle"
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---
name: massu-tdd

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding.

> **Config lookup (framework-aware)**: This command reads `config.framework.type` and `config.verification.<primary_language>` from `massu.config.yaml` to choose the right verification commands. Hardcoded references below to `packages/core`, `tools.ts`, `vitest`, `VR-TOOL-REG`, and `VR-HOOK-BUILD` are **MCP-project specific** and only apply when `config.framework.type === 'mcp'` (or `languages.typescript.runtime === 'mcp'`). For other projects, substitute: type-check → `config.verification.<primary_language>.type`, tests → `.test`, build → `.build`, lint → `.lint`. See `.claude/reference/vr-verification-reference.md` for the config-driven VR-* catalog.

# Massu TDD: Test-Driven Development Cycle

## Objective

Implement features or fix bugs using strict test-first development. Write the test BEFORE the implementation. The test defines the contract; the code fulfills it.

**This is NOT `/massu-test`** (which audits existing coverage). `/massu-tdd` is for writing NEW code test-first.

---

## NON-NEGOTIABLE RULES

- **Tests BEFORE implementation** - writing code first violates TDD
- **Minimal implementation** - in GREEN phase, write ONLY enough to pass the test
- **Refactor ONLY when green** - never refactor with failing tests
- **VR-proof at every step** - show test output proving RED/GREEN status
- **Pattern compliance** - IMPROVE phase must apply project patterns
- **FIX ALL ISSUES ENCOUNTERED (CR-9)** - if tests reveal other bugs, fix them

---

## COMMAND DISTINCTION

| Command | Purpose | When to Use |
|---------|---------|-------------|
| `/massu-tdd` | Write NEW code test-first | New features, bug fixes |
| `/massu-test` | Audit EXISTING test coverage | Coverage analysis, gap detection |

---

## TDD CYCLE

### Step 0: SCOPE

User provides feature description or bug report. Identify:
- **Test file location**: Follow convention:
  - Unit: `tests/unit/[domain]/[name].test.ts`
  - Integration: `tests/integration/[domain]/[name].test.ts`
  - Prevention: `scripts/tests/prevention/[name].test.ts`
- **Target source file**: The file that will be implemented/modified
- **Vitest config**: `vitest.config.ts` (main) or `vitest.config.prevention.ts` (prevention)

### Step 1: RED (Write Failing Test)

Write the test file FIRST. The test defines expected behavior.

```bash
# Write test with assertions for expected behavior
# Then run it — it MUST FAIL
npx vitest run [test-file] --reporter=verbose
```

**Verification**:
- Test output shows FAIL status
- Failure is for the RIGHT reason (missing function/feature, not syntax error)
- If test PASSES: the test is wrong (testing nothing) or the feature already exists

**VR-proof**: Show test output with FAIL status.

### Step 2: GREEN (Minimal Implementation)

Write ONLY the minimum code to make the failing test pass.

Rules:
- No refactoring
- No extra features
- No cleanup
- No pattern compliance yet
- Just make the test pass

```bash
# Run the test again — it MUST PASS
npx vitest run [test-file] --reporter=verbose
```

**VR-proof**: Show test output with PASS status.

### Step 3: IMPROVE (Refactor)

Now improve code quality while keeping tests green:
- Apply project patterns (database access, auth, etc.)
- Improve naming, readability, structure
- Add error handling
- Extract reusable functions

```bash
# Run test after refactoring — MUST STILL PASS
npx vitest run [test-file] --reporter=verbose
```

**VR-proof**: Show test output with PASS status.

### Step 4: REPEAT or COMPLETE

If more scenarios needed (edge cases, error handling, additional features):
- Return to Step 1 with the next test case
- Each cycle adds one scenario

If complete:
```bash
# Run full test suite to confirm no regressions
npm test
```

**VR-TEST proof**: Full suite passes.

---

## TDD CYCLE DIAGRAM

```
     +-------------------------+
     |   Step 0: SCOPE         |
     |   Define test + target   |
     +--------+----------------+
              |
     +--------v----------------+
     |   Step 1: RED            |
     |   Write failing test     |<----+
     |   VR: test FAILS         |     |
     +--------+----------------+     |
              |                       |
     +--------v----------------+     |
     |   Step 2: GREEN          |     |
     |   Minimal implementation |     | More
     |   VR: test PASSES        |     | scenarios?
     +--------+----------------+     |
              |                       |
     +--------v----------------+     |
     |   Step 3: IMPROVE        |     |
     |   Refactor + patterns    |-----+
     |   VR: test STILL PASSES  |
     +--------+----------------+
              |
     +--------v----------------+
     |   Step 4: COMPLETE       |
     |   Full suite passes      |
     |   VR-TEST: npm test      |
     +-------------------------+
```

---

## HELPER SCRIPT

Use the TDD runner for cleaner output:

```bash
./scripts/tdd-runner.sh [test-file]
```

---

## TEST PATTERNS

### Unit Test Template
```typescript
import { describe, it, expect, vi } from 'vitest';

describe('[Feature]', () => {
  describe('[Scenario]', () => {
    it('should [expected behavior] when [condition]', () => {
      // Arrange
      // Act
      // Assert
      expect(result).toBe(expected);
    });
  });
});
```

### Integration Test Template (tRPC Router)
```typescript
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db', () => ({
  db: {
    tableName: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation((data) => ({ id: 'test-id', ...data.data })),
    },
  },
}));

describe('[Router]', () => {
  it('should [expected behavior]', async () => {
    // Test router procedure
  });
});
```

---

## SESSION STATE UPDATE

After TDD cycle, update `session-state/CURRENT.md`:

```markdown
## TDD SESSION
- **Feature**: [description]
- **Test file**: [path]
- **Cycles**: [N]
- **Status**: COMPLETE / IN_PROGRESS
```

---

**Remember: The test is the specification. Write it first, then make it pass.**
