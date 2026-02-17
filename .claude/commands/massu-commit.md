---
name: massu-commit
description: Pre-commit verification audit with zero-fail release gate
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---
name: massu-commit

# CS Commit: Pre-Commit Verification Gate

## POST-COMPACTION SAFETY CHECK (MANDATORY)

**If this session was continued from a previous conversation (compaction/continuation), you MUST:**

1. **Verify the user explicitly invoked `/massu-commit`** - Check the user's LAST ACTUAL message.
2. **Verify no plan is awaiting approval** - If a `/massu-create-plan` was the last user action and no explicit approval was given, this commit is UNAUTHORIZED.
3. **Verify there are actual code changes to commit** - If `git diff --stat` shows no staged/unstaged source changes, question whether this commit was actually requested.

---

## Objective

Run a continuous AUDIT -> FIX -> VERIFY -> RE-AUDIT loop that proves (with evidence, not assumptions) that the implementation is correct and complete.

---

## RELATIONSHIP WITH /massu-push AND /massu-loop

| Command | Purpose | Speed | Runs Full Tests |
|---------|---------|-------|-----------------|
| `/massu-commit` | Fast quality gates for committing | ~1-2 min | YES (vitest is fast) |
| `/massu-push` | Full verification + security before pushing | ~5 min | YES + regression |
| `/massu-loop` | Autonomous execution with FULL verification | Varies | YES - MANDATORY |

**Philosophy**: Commit often (quality checks), push verified (full checks + security).

---

## NON-NEGOTIABLE RULES

- Do NOT stop early
- Do NOT skip checks
- Do NOT downgrade failures to warnings
- Do NOT commit unless ALL gates pass
- Do NOT push unless user explicitly instructs
- **Proof > reasoning. Commands > assumptions.**
- **FIX ALL ISSUES ENCOUNTERED (CR-9)** - If ANY issue is discovered during verification - whether from current changes OR pre-existing - fix it immediately.

---

## ZERO-GAP AUDIT LOOP

**This commit does NOT proceed until a SINGLE COMPLETE AUDIT finds ZERO issues.**

```
COMMIT AUDIT LOOP:
  1. Run ALL pre-commit checks (Gates 1-7)
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

## CRITICAL: DUAL VERIFICATION REQUIREMENT

**Commits verify BOTH code quality AND plan coverage.**

| Verification | What It Checks | Required for Commit |
|--------------|----------------|---------------------|
| **Code Quality** | Is the code correct? | YES |
| **Plan Coverage** | Did we build everything? (if from plan) | YES |

**Code Quality: PASS + Plan Coverage: FAIL = COMMIT BLOCKED**

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

---

## FIX PROTOCOL

### Fix Queue (by severity)

| Priority | Definition |
|----------|------------|
| **P0** | Broken tools, data loss, security gaps, secrets exposed |
| **P1** | Incorrect behavior, missing requirements, build failures |
| **P2** | Consistency issues, pattern violations, test failures |

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

### Gate 5: Security - No Secrets Staged
```bash
git diff --cached --name-only | grep -E '\.(env|pem|key|secret)' && echo "FAIL: Secrets staged" && exit 1
echo "PASS: No secrets staged"
```

### Gate 6: Security - No Credentials in Code
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

### Gate 7: Plan Coverage (if from plan)
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

---

## GATE SUMMARY

```markdown
### PRE-COMMIT GATE SUMMARY

| Gate | Command | Result | Status |
|------|---------|--------|--------|
| 1. Pattern Scanner | massu-pattern-scanner.sh | Exit [X] | PASS/FAIL |
| 2. Type Safety | tsc --noEmit | [X] errors | PASS/FAIL |
| 3. Tests | npm test | [X] pass, [X] fail | PASS/FAIL |
| 4. Hook Build | build:hooks | Exit [X] | PASS/FAIL |
| 5. No Secrets Staged | git diff --cached check | [result] | PASS/FAIL |
| 6. No Credentials | grep check | [X] found | PASS/FAIL |
| 7. Plan Coverage | item-by-item | [X]/[X] = [X]% | PASS/FAIL |

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
| All in `website/supabase/` | `supabase` |
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

## AUTO-LEARNING PROTOCOL

After committing, if any issues were fixed during this audit:

1. **Record the pattern** - What went wrong and how it was fixed
2. **Check if pattern scanner should be updated** - Can the check be automated?
3. **Update session state** - Record in `.claude/session-state/CURRENT.md`

---

## COMPLETION REPORT

```markdown
## CS COMMIT COMPLETE

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
| No Secrets | PASS |
| No Credentials | PASS |
| Plan Coverage | PASS (X/X = 100%) |

### Next Steps
- Run `/massu-push` to push with full verification
```
