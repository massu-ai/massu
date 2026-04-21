---
name: massu-commit
description: "When user says 'commit', 'ready to commit', 'save my work', or has completed implementation and wants to commit changes"
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---
name: massu-commit

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9, CR-12 enforced.

> **Config lookup (framework-aware)**: This command reads `config.framework.type` and `config.verification.<primary_language>` from `massu.config.yaml` to choose the right verification commands. Hardcoded references below to `packages/core`, `tools.ts`, `vitest`, `VR-TOOL-REG`, and `VR-HOOK-BUILD` are **MCP-project specific** and only apply when `config.framework.type === 'mcp'` (or `languages.typescript.runtime === 'mcp'`). For other projects, substitute: type-check → `config.verification.<primary_language>.type`, tests → `.test`, build → `.build`, lint → `.lint`. See `.claude/reference/vr-verification-reference.md` for the config-driven VR-* catalog.

# Massu Commit: Continuous Verification Audit with Zero-Fail Release Gate

## Objective

Run a continuous AUDIT -> FIX -> VERIFY -> RE-AUDIT loop that proves (with evidence) that the implementation exactly matches:

1. **The Plan** (source of truth for requirements)
2. **CLAUDE.md** (source of truth for patterns, constraints, architecture)

The loop MUST continue until a full audit produces ZERO gaps, ZERO failures, and ZERO verification errors.

---

## Workflow Position

```
/massu-create-plan -> /massu-plan -> /massu-loop -> /massu-commit -> /massu-push
(CREATE)           (AUDIT)        (IMPLEMENT)   (COMMIT)        (PUSH)
```

**This command is step 4 of 5 in the standard workflow.**

---

## RELATIONSHIP WITH /massu-push AND /massu-loop

| Command | Purpose | Speed | Runs Tests |
|---------|---------|-------|------------|
| `/massu-simplify` | Efficiency + reuse + semantic pattern analysis | ~1-2 min | NO |
| `/massu-commit` | Fast quality gates for committing | ~1-2 min | YES (vitest is fast) |
| `/massu-push` | Full verification + security before pushing | ~5 min | YES + regression |
| `/massu-loop` | Autonomous execution with full verification | Varies | YES - MANDATORY |

**Philosophy**: Commit often (fast checks), push verified (full checks + security).

---

## Workflow State Tracking

Write a transition entry to `.massu/workflow-log.md`:
```
| [timestamp] | IMPLEMENT | VERIFY | /massu-commit | [session-id] |
```

---

## PRIME DIRECTIVE: NO ASSUMPTIONS

**NEVER assume module interfaces or config structure. ALWAYS verify against real code.**

Before committing any tool or config changes, verify ALL references exist:
```bash
# Verify tool definitions match handler cases
grep -n "name:" packages/core/src/[module]-tools.ts
grep -n "case " packages/core/src/[module]-tools.ts

# Verify config keys match getConfig() usage
grep -rn "getConfig()" packages/core/src/ | head -20
```

---

## PATTERN DISCOVERY VERIFICATION

Before committing, verify ALL new code follows existing patterns by searching for existing implementations of the same thing and confirming the new code uses the SAME approach.

If new code uses a DIFFERENT approach than existing working code, the commit MUST NOT proceed unless the existing pattern is documented as deprecated or a new pattern is documented with justification.

---

## DUAL VERIFICATION REQUIREMENT

Both Code Quality and Plan Coverage gates must pass. Code Quality: PASS + Plan Coverage: FAIL = COMMIT BLOCKED.

---

## NON-NEGOTIABLE RULES

1. Do NOT commit unless ALL gates pass -- no downgrading failures to warnings
2. Do NOT push unless user explicitly instructs (`/massu-push` for full verification)
3. Plan Coverage verification required -- 100% item-by-item proof (VR-PLAN-COVERAGE)
4. FIX ALL ISSUES ENCOUNTERED (CR-9) -- whether current or pre-existing, all severities
5. Auto-learn every fix -- record pattern, update scanner
6. **Proof > reasoning. Commands > assumptions.**

---

## ZERO-GAP AUDIT LOOP

**This commit does NOT proceed until a SINGLE COMPLETE AUDIT finds ZERO issues.**

```
COMMIT AUDIT LOOP:
  1. Run ALL pre-commit checks (Gates 1-10)
  2. Count total gaps/failures found
  3. IF gaps > 0:
       - Fix ALL gaps
       - Re-run ENTIRE audit from Step 1
  4. IF gaps == 0:
       - COMMIT ALLOWED
```

| Scenario | Action |
|----------|--------|
| Pre-commit finds 3 issues | Fix all 3, re-run ENTIRE check |
| Re-check finds 1 issue | Fix it, re-run ENTIRE check |
| Re-check finds 0 issues | **NOW** commit can proceed |

**Partial re-checks are NOT valid. ALL gates must pass in a SINGLE run before commit.**

---

## DOMAIN-SPECIFIC PATTERN LOADING

Based on work being committed, load relevant pattern sections from CLAUDE.md:

| Domain | Section to Load | Load When |
|--------|----------------|-----------|
| Tool modules | Tool Registration Pattern | Adding/modifying MCP tools |
| Config | Config Access Pattern | Config changes |
| Hooks | Hook stdin/stdout Pattern | Adding/modifying hooks |
| Build | Build & Test Commands | Build-related changes |

---

## INPUTS (Read First, In Order)

### Input 1: The Plan (if applicable)
- Read the entire Plan line-by-line
- Extract every requirement into a numbered checklist
- Store as: `REQUIREMENTS_CHECKLIST`

### Input 2: CLAUDE.md
- Read fully: `.claude/CLAUDE.md`
- This IS the canonical source for all patterns and constraints
- Extract every rule/pattern into a checklist

---

## AUDIT MODE (TWO-PASS)

### PASS A: Inventory & Mapping (NO FIXES)

#### A1. Plan -> Implementation Matrix (if from plan)

```markdown
| Req ID | Requirement | Status | Evidence (file:line) | Verified |
|--------|-------------|--------|---------------------|----------|
| R-001 | [text] | Implemented/Partial/Missing | [paths] | YES/NO |
```

#### A2. CLAUDE.md Compliance Matrix

Run pattern scanner first:
```bash
bash scripts/massu-pattern-scanner.sh
# Exit 0 = PASS, non-zero = violations found
```

Document each rule:
```markdown
| Rule | Verification | Result | Status |
|------|--------------|--------|--------|
| ESM imports only | grep "require(" src/ | 0 | PASS |
| Config via getConfig() | grep "yaml.parse" src/ (excl. config.ts) | 0 | PASS |
| No process.exit() in lib | grep "process.exit" src/ (excl. server.ts) | 0 | PASS |
```

#### A3. Tool Registration Audit (if new tools)

```markdown
| Tool Name | Definition | Handler | Test | Status |
|-----------|------------|---------|------|--------|
| [name] | [file:line] | [file:line] | [test file] | PASS/FAIL |
```

#### A4. User Flow Map

| Flow | Entry | Actions | API Calls | Data Ops | Status |
|------|-------|---------|-----------|----------|--------|

---

### PASS B: Verification & Breakage Hunting

#### B1. Type Integrity
- Types match between modules
- No `as any` workarounds for real type issues
- Config interfaces match YAML structure

#### B2. Data Layer Integrity
- SQLite schema matches code expectations
- Database module functions work correctly

#### B3. MCP Tool Registration Completeness (CRITICAL)
For every new tool in this commit:

```bash
# Verify tool definition exists
grep "name:.*[tool_name]" packages/core/src/[module]-tools.ts

# Verify handler exists
grep "case.*[tool_name]" packages/core/src/[module]-tools.ts

# Verify wired into tools.ts
grep "[module]" packages/core/src/tools.ts
```

#### B4. Hook Compilation
```bash
cd packages/core && npm run build:hooks
# MUST exit 0
```

#### B5. Regression Risk
- Review changes for side effects
- Check for incomplete refactors
- Verify no silent failures introduced

#### B6. Pattern Consistency
- Verify against CLAUDE.md rules
- Check new code matches established patterns

#### B7. Import/Export Integrity
- All exports have consumers
- No circular imports
- ESM-only patterns preserved

---

## FIX PROTOCOL

### Fix Queue (by severity)

| Priority | Definition |
|----------|------------|
| **P0** | Broken tools, data loss, security gaps, secrets exposed |
| **P1** | Incorrect behavior, missing requirements, build failures |
| **P2** | Consistency issues, pattern violations, test failures |

### Technical Debt (discovered during audit)

| Debt Type | Action |
|-----------|--------|
| Pre-existing pattern violation | Fix immediately (CR-9) |
| TODO/FIXME in changed files | Resolve or document with issue |
| Deprecated API usage | Update to current pattern |

### For Each Fix
1. Apply smallest correct fix matching CLAUDE.md patterns
2. Run verification for that specific fix
3. Update session-state/CURRENT.md with fix details

---

## AUTO-VERIFICATION COMMAND GATE (MANDATORY)

**After EVERY fix cycle and BEFORE any commit, run ALL of these.**

You may NOT proceed if ANY command fails.

### Gate 1: Pattern Compliance
```bash
bash scripts/massu-pattern-scanner.sh
# MUST exit 0
```

### Gate 2: Type Safety (VR-TYPE)
```bash
cd packages/core && npx tsc --noEmit
# MUST show 0 errors
```

### Gate 3: All Tests Pass (VR-TEST)
```bash
npm test
# MUST exit 0, all vitest tests pass
```

### Gate 4: Hook Compilation (VR-HOOK-BUILD)
```bash
cd packages/core && npm run build:hooks
# MUST exit 0
```

### Gate 5: Generalization Compliance (VR-GENERIC)
```bash
bash scripts/massu-generalization-scanner.sh
# MUST exit 0
```

### Gate 6: Security - No Secrets Staged
```bash
git diff --cached --name-only | grep -E '\.(env|pem|key|secret)' && echo "FAIL: Secrets staged" && exit 1
echo "PASS: No secrets staged"
```

### Gate 7: Security - No Credentials in Code
```bash
# Check packages/core/src/ for hardcoded credentials
grep -rn 'sk-[a-zA-Z0-9]\{20,\}\|password.*=.*["\x27][^"\x27]\{8,\}' --include="*.ts" --include="*.tsx" \
  packages/core/src/ 2>/dev/null \
  | grep -v "process.env" \
  | grep -v 'RegExp\|regex\|REDACT\|redact\|sanitize\|mask' \
  | grep -v '\.test\.ts:' \
  | wc -l
# MUST be 0
```

**Known false positive exclusions** (regex/redaction patterns, test fixtures):
- `security-utils.ts` - credential redaction regex
- `*.test.ts` - test fixtures with mock data

### Gate 8: Plan Coverage (if from plan)

```markdown
### PLAN COVERAGE GATE

| Item # | Description | Status | Proof |
|--------|-------------|--------|-------|
| P1-001 | [desc] | DONE | [evidence] |
| P1-002 | [desc] | DONE | [evidence] |
| ... | ... | ... | ... |

**Coverage: X/X items = 100%**
**PLAN COVERAGE GATE: PASS / FAIL**
```

### Gate 9: VR-PLAN-STATUS (if from plan)
```bash
grep "IMPLEMENTATION STATUS" [plan_file]  # Expected: Match found
grep -c "100% COMPLETE\|DONE\|\*\*DONE\*\*" [plan_file]  # Expected: count matches completed phases
```
If FAIL: add completion table to plan, mark phases DONE, record commit hash.

### Gate 10: Dependency Security
```bash
npm audit --audit-level=high  # 0 high/critical vulnerabilities
```

### Gate Summary Format
```markdown
### PRE-COMMIT GATE SUMMARY

| Gate | Command | Result | Status |
|------|---------|--------|--------|
| 1. Pattern Scanner | massu-pattern-scanner.sh | Exit [X] | PASS/FAIL |
| 2. Type Safety | tsc --noEmit | [X] errors | PASS/FAIL |
| 3. Tests | npm test | [X] pass, [X] fail | PASS/FAIL |
| 4. Hook Build | build:hooks | Exit [X] | PASS/FAIL |
| 5. Generalization | massu-generalization-scanner.sh | Exit [X] | PASS/FAIL |
| 6. No Secrets Staged | git diff --cached check | [result] | PASS/FAIL |
| 7. No Credentials | grep check | [X] found | PASS/FAIL |
| 8. Plan Coverage | item-by-item | [X]/[X] = [X]% | PASS/FAIL |
| 9. Plan Status | plan doc updated | Match | PASS/FAIL |
| 10. Security | npm audit | 0 high/crit | PASS/FAIL |

BLOCKING GATES: 1-10
**OVERALL: PASS / FAIL**
```

### If ALL Gates Pass

```bash
# Stage changes
git add [specific files]

# Commit with HEREDOC
git commit -m "$(cat <<'EOF'
[type]([scope]): [description]

[body - what changed and why]

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"

# Verify commit succeeded
git log -1 --oneline
```

### If ANY Gate Fails

1. **Document ALL failures**
2. **Fix EACH failure** following CLAUDE.md patterns
3. **Re-run ENTIRE gate sequence** (not just failed gates)
4. **Repeat until ALL gates pass in a SINGLE run**

---

## SESSION STATE UPDATE (REQUIRED)

Before committing, update `session-state/CURRENT.md`:

```markdown
## PRE-COMMIT STATE
### Work Completed
- [List all work with file paths]
### Files Changed
- Created: [list] | Modified: [list] | Deleted: [list]
### Verification Summary
- Pattern scanner: PASS | Type check: PASS | Tests: PASS
- Hook build: PASS | Generalization: PASS | Security: PASS
### Commit Ready
- All gates passed: YES | Commit message drafted: YES
```

---

## AUDIT LOOP (Repeat Until Zero Issues)

```
ITERATION N:
  1. Run PASS A (Inventory & Mapping)
  2. Run PASS B (Verification & Breakage Hunting)
  3. IF gaps: Build Fix Queue (P0->P1->P2), apply, run ALL gates, return to Step 1
  4. IF zero gaps AND all gates pass: Update session state, proceed to COMMIT
```

### Stop Conditions (ALL must be true)
- Plan items: 100% verified with VR-* proof
- CLAUDE.md patterns: 0 violations
- All code quality gates (1-10): PASS
- Security gate: 0 high/critical vulnerabilities
- Tool registration: All tools wired and tested
- Hook compilation: Exit 0

---

## COMMIT MESSAGE INTELLIGENCE

### CONVENTIONAL COMMIT ENFORCEMENT

Commit message MUST follow: `type(scope): description`

**Valid types**:

| Type | When |
|------|------|
| `feat` | New feature or capability |
| `fix` | Bug fix |
| `perf` | Performance improvement |
| `refactor` | Code restructuring (no behavior change) |
| `test` | Adding or modifying tests |
| `docs` | Documentation only |
| `chore` | Maintenance, dependencies, config |
| `style` | Formatting, whitespace (no logic change) |
| `ci` | CI/CD pipeline changes |
| `build` | Build system or tooling changes |

**If the commit message doesn't match the `type(scope): description` pattern, reformat it before committing.**

### SCOPE AUTO-SUGGESTION

Analyze `git diff --cached --name-only` to determine scope:

| Changed Files Location | Suggested Scope |
|------------------------|-----------------|
| All in `packages/core/src/` | `core` |
| All in `website/` | `website` |
| All in `.claude/commands/` | `commands` |
| All in `scripts/` | `tooling` |
| Mixed across areas | Most dominant area, or omit scope |

### BREAKING CHANGE DETECTION

Check `git diff --cached` for breaking changes:

| Change Type | Indicator |
|-------------|-----------|
| Exported function signature changed | Parameters added/removed/retyped |
| Tool name pattern changed | `name:` value in tool definitions |
| Config interface fields changed | Fields in `Config` interface added/removed/renamed |
| Database schema changed | CREATE TABLE, ALTER TABLE, DROP in migrations |

**If breaking change detected:**
1. Add `BREAKING CHANGE:` footer to commit message
2. Warn user about the breaking change before committing

### RELATED ISSUE LINKING

```bash
# If branch name contains issue number (e.g., fix/123-bug, feature/456-new-tool)
branch=$(git branch --show-current)
issue_num=$(echo "$branch" | grep -oE '[0-9]+' | head -1)
# If found, suggest: "Closes #[issue_num]" in commit body
```

### COMMIT SPLITTING SUGGESTION

```bash
# Check if staged changes span 3+ unrelated areas
git diff --cached --stat
```

If changes span 3+ unrelated areas (e.g., `packages/core/` + `website/` + `scripts/`):
- Present: "Consider splitting this into N commits for cleaner history"
- List the suggested splits by area

---

## COMMIT PROTOCOL (Final Step Only)

### Pre-Commit Checklist
- [ ] All audit gates passed
- [ ] Session state updated
- [ ] No .env or credential files staged
- [ ] Commit message drafted

### Check Staged Files
```bash
git status  # Review ALL staged files, verify NO .env* or credential files
```

---

## POST-COMMIT (Do NOT Auto-Push)

```bash
git status  # Verify commit succeeded, show hash
```

**DO NOT PUSH** unless user explicitly says "push" or "push to remote".

---

## MANDATORY: PLAN DOCUMENT UPDATE (After Commit)

If commit is from a plan, update the plan document TOP with:
- IMPLEMENTATION STATUS table (status, last updated, commit hash)
- Task completion summary with verification evidence

Verify: `grep "IMPLEMENTATION STATUS" [plan_file]` returns match.

---

## Gotchas

- **Pattern scanner must pass** -- `scripts/massu-pattern-scanner.sh` runs automatically and MUST exit 0. Never bypass with `--no-verify`
- **Never skip pre-commit hooks** -- `--no-verify` is forbidden. If a hook fails, fix the underlying issue
- **Check for .env files in staged changes** -- `git status` must show ZERO `.env*` files staged. Secrets leaked to git history cannot be un-leaked
- **Commit message must match changes** -- "fix" means bug fix, "add" means new feature, "update" means enhancement. Mismatched messages cause confusion in changelog
- **Never amend after hook failure** -- when a pre-commit hook fails, the commit did NOT happen. Create a NEW commit after fixing; `--amend` would modify the PREVIOUS commit

---

## START NOW

**Step 0: Write AUTHORIZED_COMMAND to session state (CR-12)**

Update `session-state/CURRENT.md` to include `AUTHORIZED_COMMAND: massu-commit`.

1. Check work to commit: `git status && git diff --stat`
2. If Plan exists, begin PASS A
3. If no Plan, audit against CLAUDE.md patterns only
4. Run full audit loop until ZERO gaps
5. Run ALL verification gates
6. Execute AUTO-LEARNING PROTOCOL
7. Commit only when ALL conditions met
8. Report completion, await push instruction

---

## AUTO-LEARNING PROTOCOL

After committing, if any issues were fixed during this audit:

1. **Record the pattern** - What went wrong and how it was fixed
2. **Check if pattern scanner should be updated** - Can the check be automated?
3. **Update session state** - Record in `.claude/session-state/CURRENT.md`
4. **Search codebase-wide** - Verify no other instances of same bad pattern (CR-9)

If a NEW pattern or utility was created during the commit:
1. Record in session-state/CURRENT.md with file path and purpose

---

## COMPLETION REPORT

```markdown
## MASSU COMMIT COMPLETE

| Gate Category | Status | Evidence |
|---------------|--------|----------|
| Code Quality (1-7) | PASS | All gates passed |
| Plan Coverage (8) | PASS | [X]/[X] = 100% |
| Plan Status (9) | PASS | Plan doc updated |
| Security (10) | PASS | 0 high/critical |

### Commit Details
- **Hash**: [hash]
- **Message**: [message]
- **Files**: [count] files changed

### Gates Passed
| Gate | Status |
|------|--------|
| Pattern Scanner | PASS |
| Type Safety | PASS |
| Tests | PASS ([X] passed) |
| Hook Build | PASS |
| Generalization | PASS |
| No Secrets | PASS |
| No Credentials | PASS |
| Plan Coverage | PASS (X/X = 100%) |
| Plan Status | PASS |
| Security | PASS |

### Push Status
- Pushed: NO (awaiting user instruction)

**DUAL VERIFICATION PASSED - READY FOR PUSH ON USER COMMAND**

### Next Steps
- Run `/massu-push` to push with full verification
```

---

## QUALITY SCORING (silent)

After committing, append one JSONL line to `.claude/metrics/command-scores.jsonl`:

| Check | Pass condition |
|-------|---------------|
| `all_gates_passed` | All 10 gates exit 0 |
| `plan_coverage_100` | Plan coverage gate = 100% (or N/A if no plan) |
| `zero_gap_single_run` | Final audit run found 0 gaps |
| `conventional_commit` | Commit message matches type(scope): description |

```json
{"command":"massu-commit","timestamp":"ISO8601","scores":{"all_gates_passed":true,"plan_coverage_100":true,"zero_gap_single_run":true,"conventional_commit":true},"pass_rate":"4/4","input_summary":"[commit-hash]:[message-summary]"}
```
