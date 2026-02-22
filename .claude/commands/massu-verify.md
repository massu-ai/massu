---
name: massu-verify
description: Run all VR-* verification checks for current work with mandatory proof output
allowed-tools: Bash(*), Read(*), Grep(*), Glob(*)
---

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9 enforced.

# Massu Verify: Comprehensive Verification Protocol

## Objective

Run ALL applicable VR-* verification checks and produce proof output. This command validates current work against CLAUDE.md patterns and produces verifiable evidence.

---

## NON-NEGOTIABLE RULES

- **Proof > Claims** - Show command output, not summaries
- **ALL checks run** - Do not skip any applicable verification
- **Zero tolerance** - Any failure blocks "complete" status
- **No assumptions** - Check actual state, don't guess
- **Plan Coverage** - Verify ALL plan items, not just code quality
- **VR-CONFIG mandatory** - For config-driven features, verify config values match code expectations
- **VR-TEST mandatory (CR-7)** - ALL tests MUST pass, tests are NEVER optional
- **FIX ALL ISSUES ENCOUNTERED (CR-9)** - If ANY issue is discovered during verification - whether from current changes OR pre-existing - fix it immediately. "Not in scope" and "pre-existing" are NEVER valid reasons to skip a fix. When fixing a bug, search entire codebase for same pattern and fix ALL instances.

---

## CR-7: TEST REQUIREMENT (MANDATORY)

**ALL tests MUST pass before verification can be marked complete. Tests are NEVER optional.**

```bash
npm test
# Expected: Exit 0, ALL tests pass
```

| Test State | Action | Verification Complete? |
|------------|--------|------------------------|
| All tests pass | Proceed | YES |
| Any test fails | Fix ALL failures | NO |
| Tests not run | Run tests first | NO |
| "Tests not applicable" | INVALID - tests are ALWAYS applicable | NO |

**Why This Is Mandatory (CR-7):**
- "Tests are optional" escape hatch led to false "complete" claims
- Tests catch regressions other checks miss
- Production-grade means ALL tests pass

---

## ZERO-GAP AUDIT LOOP

**This command does NOT complete until a SINGLE COMPLETE AUDIT finds ZERO issues.**

### The Rule

```
AUDIT LOOP:
  1. Run ALL verification checks
  2. Count total gaps/issues found
  3. IF gaps > 0:
       - Fix ALL gaps
       - Re-run ENTIRE audit from Step 1
  4. IF gaps == 0:
       - CERTIFIED COMPLETE
```

### Completion Requirement

| Scenario | Action |
|----------|--------|
| Audit finds 3 issues | Fix all 3, re-run ENTIRE audit |
| Re-audit finds 1 issue | Fix it, re-run ENTIRE audit |
| Re-audit finds 0 issues | **NOW** complete |

**Partial re-checks are NOT valid. The ENTIRE audit must pass in a SINGLE run.**

---

## DOMAIN-SPECIFIC PATTERN LOADING

Based on verification scope, load relevant pattern files:

| Domain | Pattern File | Load When |
|--------|--------------|-----------|
| Tool modules | `.claude/patterns/tool-patterns.md` | Verifying MCP tools |
| Config | `.claude/patterns/config-patterns.md` | Verifying config changes |
| Hooks | `.claude/patterns/hook-patterns.md` | Verifying hook changes |
| Build | `.claude/patterns/build-patterns.md` | Investigating failures |

---

## VR-* VERIFICATION PROTOCOLS

### VR-FILE: File Existence Verification
```bash
# For each file claimed to be created/modified:
ls -la [file_path]
# Expected: File listed with size > 0
# Failure: File not found or size 0
```

### VR-GREP: Code Presence Verification
```bash
# For each code pattern claimed to be added:
grep -n "[pattern]" [file]
# Expected: Match with line number
# Failure: No matches found
```

### VR-NEGATIVE: Removal Verification (CRITICAL)
```bash
# For each pattern claimed to be removed:
grep -rn "[removed_pattern]" packages/core/src/ | wc -l
# Expected: 0
# Failure: Any matches found
```

### VR-BUILD: Build Integrity Verification
```bash
npm run build
# Expected: Exit 0
# Failure: Exit non-zero or errors
```

### VR-TYPE: Type Safety Verification
```bash
cd packages/core && npx tsc --noEmit
# Expected: 0 errors
# Failure: Any type errors
```

### VR-COUNT: Instance Count Verification
```bash
# For verifying all instances updated:
grep -c "[pattern]" [file]
# Expected: Exact count matching plan
```

### VR-CONFIG: Config-Code Alignment Verification (CRITICAL)

**Config existence does not equal correctness. A config key can exist with completely wrong values.**

```bash
# VR-CONFIG-001: Parse and validate massu.config.yaml
node -e "const yaml = require('yaml'); const fs = require('fs'); yaml.parse(fs.readFileSync('massu.config.yaml', 'utf-8'));"

# VR-CONFIG-002: Extract ALL config keys used in code
grep -rn "getConfig()" packages/core/src/ | grep -oP 'config\.\w+' | sort -u

# VR-CONFIG-003: Verify config values match code expectations
grep -rn "toolPrefix\|config\." packages/core/src/ | head -20
```

**VR-CONFIG Alignment Checklist:**
```markdown
| Config Key | Code Expects | Match? | Status |
|------------|--------------|--------|--------|
| toolPrefix | string | YES/NO | PASS/FAIL |
| paths.source | valid path | YES/NO | PASS/FAIL |
```

| When to Run VR-CONFIG | Situation |
|----------------------|-----------|
| ALWAYS | Feature uses config-driven values |
| ALWAYS | Bug fix for "tool not found" or "wrong prefix" |
| ALWAYS | After config changes |
| ALWAYS | Planning/auditing config-driven features |

### VR-TOOL-REG: Tool Registration Verification (CRITICAL)
```bash
# For EACH MCP tool claimed to be "implemented":

# 1. Verify tool module file exists
ls -la packages/core/src/[module].ts

# 2. Verify definitions are exported
grep "export.*getXToolDefinitions" packages/core/src/[module].ts

# 3. CRITICAL: Verify tool is REGISTERED in tools.ts
grep "getXToolDefinitions\|isXTool\|handleXToolCall" packages/core/src/tools.ts
# Expected: Match found for the tool module
# Failure: 0 matches = tool NOT callable (just created)
```

**Why this matters**: Build/type checks pass when code compiles, but don't verify tools are REGISTERED. A tool module that exists but isn't wired into tools.ts is USELESS to users.

### VR-INTEGRATION: Full Integration Verification
```bash
# Tool is imported AND registered AND build passes
grep "[ModuleName]" packages/core/src/tools.ts && npm run build
# Expected: Both checks pass
```

### VR-HOOK-BUILD: Hook Compilation Verification
```bash
cd packages/core && npm run build:hooks
# Expected: Exit 0
# Failure: Compilation error
```

### VR-REUSE: Component/Code Reuse Verification
```bash
# BEFORE creating new module, search for existing:
grep -rn "[functionality]" packages/core/src/

# Expected: Use existing or document why new needed
```

### VR-STATES: State Completeness Verification
```bash
# For tool handlers, verify all states:
# Success response
grep "content.*text" [file]

# Error handling
grep "try\|catch\|error" [file]

# Expected: All states handled
```

### VR-PROPS: Interface Chain Verification (CRITICAL)

**Trace EVERY interface/type through the module hierarchy to verify it reaches its destination.**

```bash
# Step 1: Find where type is defined
grep "interface\|type.*=" [source_file]

# Step 2: Verify type is exported
grep "export.*TypeName" [source_file]

# Step 3: Verify type is imported where needed
grep "import.*TypeName" [consumer_file]

# Step 4: Verify type is used correctly
grep "TypeName" [consumer_file] | grep -v "import"
```

```markdown
### VR-PROPS Chain Trace
| Type | Source | Consumer 1 | Consumer 2 | Used? | Status |
|------|--------|------------|------------|-------|--------|
| ToolResult | tools.ts | module.ts | handler | YES/NO | PASS/FAIL |
```

### VR-HANDLER: Tool Handler Verification (CRITICAL)

**For EVERY tool, verify the handler exists AND does something.**

```bash
# Step 1: Find all tool definitions
grep -rn "name:.*_tool_" packages/core/src/

# Step 2: For each tool, find the handler
grep "case.*tool_name" packages/core/src/

# Step 3: Verify handler does something (not empty)
grep -A 10 "case.*tool_name" packages/core/src/ | grep "return"
```

```markdown
### VR-HANDLER Verification
| Tool | Handler | Defined? | Does Something? | Status |
|------|---------|----------|-----------------|--------|
| tool_action | handleAction | YES | Returns result | PASS |
| tool_other | undefined | NO | N/A | FAIL |
```

### VR-ENV: Environment Variable Parity
```bash
# Step 1: Find all env var usage
grep -rn "process.env\." packages/core/src/ | grep -oP 'process\.env\.\w+' | sort -u

# Step 2: Verify each env var is documented
```

### VR-DEFAULTS: Default Value Alignment

**Verify default values in code match default values in config.**

```bash
# Find code defaults
grep -rn "default:" packages/core/src/
grep -rn "?? '" packages/core/src/ | grep -v node_modules
```

```markdown
### VR-DEFAULTS Matrix
| Field | Config Default | Code Default | Match? | Status |
|-------|---------------|--------------|--------|--------|
| toolPrefix | 'massu' | 'massu' | YES | PASS |
```

### VR-PLAN-COVERAGE: Plan Item Coverage Verification (CRITICAL)
```markdown
## Plan Coverage Verification

### Step 1: Extract Plan Items
Read the plan document and extract ALL deliverables:

| Item # | Type | Description | Expected Location | Verification | Status |
|--------|------|-------------|-------------------|--------------|--------|
| P-001 | FILE | module.ts | packages/core/src/ | ls -la | PENDING |
| P-002 | TOOL | tool_action | tools.ts | grep | PENDING |
| P-003 | REMOVAL | old_pattern | all files | grep = 0 | PENDING |

### Step 2: Verify EACH Item
For each plan item, run appropriate VR-* check:
- FILE items: VR-FILE (ls -la)
- TOOL items: VR-GREP + VR-TOOL-REG
- MODULE items: VR-GREP
- REMOVAL items: VR-NEGATIVE
- CONFIG items: VR-CONFIG

### Step 3: Calculate Coverage
Coverage = (Verified Items / Total Items) * 100

| Metric | Value |
|--------|-------|
| Total Plan Items | [N] |
| Verified | [X] |
| Coverage | [X/N]% |

### Step 4: Gate Check
- Coverage 100%: PASS
- Coverage < 100%: FAIL (list missing items)
```

**Why this matters**: Code quality verification proves code is CORRECT. Plan coverage verification proves code is COMPLETE. Both are required.

---

## PATTERN COMPLIANCE CHECKS

### Mandatory Pattern Scanner
```bash
bash scripts/massu-pattern-scanner.sh
# Exit 0 = PASS
# Non-zero = FAIL (show violations)
```

---

## SECURITY VERIFICATION

### No Secrets Staged
```bash
git diff --cached --name-only | grep -E '\.(env|pem|key|secret)' && echo "FAIL: Secrets staged" || echo "PASS: No secrets staged"
```

### No Credentials in Code
```bash
grep -rn "sk-\|password.*=.*['\"]" --include="*.ts" packages/core/src/ | grep -v "process.env" | wc -l
# Expected: 0
```

---

## VERIFICATION REPORT FORMAT

```markdown
## MASSU VERIFY REPORT

### Timestamp
[Date/Time]

### Work Being Verified
[Description of work/changes]

---

## VR-FILE Verification
| File | Status | Proof |
|------|--------|-------|
| [path] | PASS/FAIL | [ls -la output] |

---

## VR-GREP Verification
| Pattern | File | Status | Proof |
|---------|------|--------|-------|
| [pattern] | [file] | PASS/FAIL | Line N: [match] |

---

## VR-NEGATIVE Verification
| Removed Pattern | Status | Count | Proof |
|-----------------|--------|-------|-------|
| [pattern] | PASS/FAIL | 0/N | [grep output] |

---

## VR-BUILD Verification
```bash
npm run build
```
**Status**: PASS/FAIL
**Output**: [build output summary]

---

## VR-TYPE Verification
```bash
cd packages/core && npx tsc --noEmit
```
**Status**: PASS/FAIL
**Errors**: 0/N

---

## VR-CONFIG Verification (Config Changes Only)

### Config-Code Alignment Analysis
**Config File**: massu.config.yaml

#### Config Keys (Actual)
**Result**: `[list of keys found]`

#### Code Expected Keys
**Result**: `[list of keys code expects]`

#### Alignment Matrix
| Config Key | Code Expects | Match? | Status |
|------------|--------------|--------|--------|
| [key1] | [expected1] | YES/NO | PASS/FAIL |

**VR-CONFIG Status**: PASS (100% alignment) / FAIL (X mismatches)

---

## Pattern Compliance
| Check | Command | Result | Status |
|-------|---------|--------|--------|
| Pattern Scanner | bash scripts/massu-pattern-scanner.sh | Exit 0/N | PASS/FAIL |

---

## Security Checks
| Check | Status | Proof |
|-------|--------|-------|
| Secrets staged | PASS/FAIL | [output] |
| Credentials in code | PASS/FAIL | 0/N matches |

---

## SUMMARY

### Pass/Fail Counts

**Code Quality Gate:**
- VR-FILE: X/X PASS
- VR-GREP: X/X PASS
- VR-NEGATIVE: X/X PASS
- VR-BUILD: PASS/FAIL
- VR-TYPE: PASS/FAIL
- VR-CONFIG: X/X PASS (config-code alignment verified)
- VR-TOOL-REG: X/X PASS (tools registered in tools.ts)
- Patterns: X/X PASS
- Security: X/X PASS

**Plan Coverage Gate:**
- Total Plan Items: [N]
- Verified: [X]
- Coverage: [X/N]% (MUST be 100%)
- Plan Coverage: PASS/FAIL

### Overall Status
**DUAL VERIFICATION: PASSED / FAILED**

| Gate | Status |
|------|--------|
| Code Quality | PASS/FAIL |
| Plan Coverage | PASS/FAIL ([X]/[N] = [X]%) |

**BOTH gates must PASS for verification to be complete.**

### Gaps Found (If Any)
| # | Type | Issue | Required Fix |
|---|------|-------|--------------|
| 1 | [type] | [description] | [fix needed] |
```

---

## PARALLEL VERIFICATION WITH AGENTS

For faster verification, use **Task agents** to run independent checks simultaneously.

### Agent-Based Parallel Verification (RECOMMENDED)

```markdown
### Launch Parallel Verification Agents (single message, all at once)
- Agent 1: "Run pattern scanner" -> bash scripts/massu-pattern-scanner.sh
- Agent 2: "Run TypeScript check" -> cd packages/core && npx tsc --noEmit
- Agent 3: "Run unit tests" -> npm test
- Agent 4: "Run hook build" -> cd packages/core && npm run build:hooks
```

### Benefits

| Approach | Time | Notes |
|----------|------|-------|
| Sequential | 5-10 min | Each check waits for previous |
| **Agent Parallel** | **2-4 min** | All checks run simultaneously |

---

## QUICK VERIFICATION (Minimal)

For quick checks without full report:

```bash
# Run all critical checks
bash scripts/massu-pattern-scanner.sh && \
cd packages/core && npx tsc --noEmit && \
npm run build && \
echo "QUICK VERIFY: PASS"
```

---

## SESSION STATE UPDATE

After verification, update `session-state/CURRENT.md`:

```markdown
## MASSU VERIFY SESSION

### Verification Run
- **Date**: [timestamp]
- **Work Verified**: [description]
- **Result**: VERIFIED / FAILED

### Verification Summary
| Category | Checks | Passed | Failed |
|----------|--------|--------|--------|
| VR-FILE | N | N | 0 |
| VR-GREP | N | N | 0 |
| VR-NEGATIVE | N | N | 0 |
| VR-BUILD | 1 | 1 | 0 |
| VR-TYPE | 1 | 1 | 0 |
| VR-CONFIG | N | N | 0 |
| Patterns | N | N | 0 |
| Security | N | N | 0 |

### Gaps Found (If Any)
[List of issues requiring fixes]

### Next Action
[What needs to happen next]
```

---

## MANDATORY: PLAN DOCUMENT UPDATE (If Verifying Plan Work)

**If verification was for work from a plan document, the plan MUST be updated.**

### Plan Document Update (Add to TOP of plan)

```markdown
# IMPLEMENTATION STATUS

**Plan**: [Plan Name]
**Status**: VERIFIED COMPLETE / VERIFIED PARTIAL
**Last Updated**: [YYYY-MM-DD HH:MM]
**Verified By**: Claude Code (Massu Verify)

## Verification Summary

| # | Task/Item | Status | VR-* Proof | Date |
|---|-----------|--------|------------|------|
| 1 | [Task] | VERIFIED | VR-BUILD: Pass | [date] |
| 2 | [Task] | VERIFIED | VR-GREP: Found | [date] |

## Verification Evidence

### All VR-* Checks
- VR-FILE: [N] files verified
- VR-GREP: [N] patterns found
- VR-BUILD: Exit 0
- VR-TYPE: 0 errors
- VR-CONFIG: Config-code alignment confirmed
- Pattern Scanner: Exit 0
```

### VR-PLAN-STATUS Verification

```bash
grep "IMPLEMENTATION STATUS" [plan_file]
grep "VERIFIED\|COMPLETE" [plan_file]
# Expected: Matches found
```

---

## VR-PLAN: VERIFICATION PLANNING STEP

**Before executing ANY verification checks, ENUMERATE all applicable VR-* checks first.**

Complete this enumeration before running any commands:

```markdown
### VR-PLAN: Verification Strategy

**Work being verified**: [description]
**Domains touched**: [tools / config / hooks / build / tests]

| # | VR-* Check | Target | Why Applicable | Status |
|---|------------|--------|----------------|--------|
| 1 | VR-BUILD | Full project | Always required | PENDING |
| 2 | VR-TYPE | Full project | Always required | PENDING |
| 3 | VR-TEST | Full project | Always required (CR-7) | PENDING |
| ... | ... | ... | ... | ... |

**Total checks planned**: [N]
```

### Always Include These

| Check | Condition |
|-------|-----------|
| VR-BUILD, VR-TYPE, VR-TEST | ALWAYS |
| VR-FILE, VR-GREP | Files created/modified |
| VR-NEGATIVE | Code removed |
| VR-CONFIG | Config changes |
| VR-TOOL-REG | New MCP tools |
| VR-HOOK-BUILD | Hook changes |
| VR-HANDLER | Tool handlers added |
| VR-PLAN-COVERAGE | Implementing a plan |

---

## AUTO-LEARNING PROTOCOL (MANDATORY after every fix/finding)

**After EVERY fix or finding, the system MUST automatically learn. This is NOT optional.**

### Step 1: Record Correct vs Incorrect Pattern
Update session state with the WRONG vs CORRECT pattern discovered.

### Step 2: Add to Pattern Scanner (if grep-able)
If the bad pattern is detectable by grep, add check to `scripts/massu-pattern-scanner.sh`.

### Step 3: Search Codebase-Wide (CR-9)
`grep -rn "[bad_pattern]" packages/core/src/` - fix ALL instances of the same issue.

---

## START NOW

1. Identify work to verify
2. **Run VR-PLAN: Enumerate ALL applicable VR-* checks with targets**
3. Load relevant domain patterns
4. Run pattern scanner first
5. Execute all VR-* checks **from VR-PLAN enumeration** in dependency order
6. Run security checks
7. Produce verification report
8. Update session state
9. If ANY gaps: list fixes needed
10. If ZERO gaps: report VERIFIED

**Remember: Show the actual command output, not summaries.**
