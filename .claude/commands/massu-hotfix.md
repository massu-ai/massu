---
name: massu-hotfix
description: Quick scoped fix workflow with branch, test, commit, push, and PR creation
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9 enforced.

# CS Hotfix: Quick Scoped Fix Workflow

## Objective

Apply a targeted fix with minimal ceremony. Creates a branch, applies the fix, runs tests, commits, and optionally creates a PR. Designed for small, well-understood fixes.

**Usage**: `/massu-hotfix [description of the fix]`

---

## SCOPE GUARD (MANDATORY)

**This command is for SMALL fixes only. If ANY of these are true, ABORT and suggest `/massu-create-plan` instead:**

| Condition | Why It's Too Big |
|-----------|-----------------|
| Fix touches > 5 files | Needs a plan |
| Fix adds new MCP tools | Needs tool registration verification |
| Fix changes database schema | Needs migration plan |
| Fix changes config interface | Needs blast radius analysis |
| Fix requires new dependencies | Needs dependency review |
| Fix is unclear or ambiguous | Needs requirements clarification |

```
IF scope_check_fails:
  OUTPUT: "This fix is too large for /massu-hotfix. Use /massu-create-plan instead."
  ABORT
```

---

## STEP 1: BRANCH CREATION

```bash
# Ensure clean working tree
git status --short

# Create hotfix branch
git checkout -b hotfix/[short-description]
```

**If working tree is dirty:**
1. Ask user if changes should be stashed
2. Do NOT proceed with dirty working tree

---

## STEP 2: APPLY FIX

1. **Read** the file(s) to be modified
2. **Understand** the current code before changing it
3. **Apply** the minimal correct fix
4. **Verify** the fix addresses the issue

### Fix Constraints
- Smallest correct change only
- Follow CLAUDE.md patterns
- No "while I'm here" improvements
- No refactoring alongside the fix

---

## STEP 3: VERIFICATION

```bash
# Type check
cd packages/core && npx tsc --noEmit

# Run tests
npm test

# Pattern scanner
bash scripts/massu-pattern-scanner.sh

# Hook build (if hooks modified)
cd packages/core && npm run build:hooks
```

**If ANY check fails:**
1. Fix the issue
2. Re-run ALL checks
3. Repeat until clean

---

## STEP 4: COMMIT

```bash
git add [specific files]

git commit -m "$(cat <<'EOF'
fix([scope]): [description]

[What was wrong and why this fix is correct]

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## STEP 5: PUSH & PR (Optional)

Ask user before pushing:

```bash
# Push
git push -u origin hotfix/[short-description]

# Create PR
gh pr create --title "fix([scope]): [description]" --body "$(cat <<'EOF'
## Summary
- [What was wrong]
- [What this PR fixes]

## Test plan
- [ ] All existing tests pass
- [ ] Fix verified with [specific test/verification]

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## ABORT CONDITIONS

If at ANY point during the hotfix:

| Condition | Action |
|-----------|--------|
| Fix is more complex than expected | Abort, suggest /massu-create-plan |
| Tests fail in unrelated areas | Abort, investigate first |
| Fix would break other functionality | Abort, needs broader analysis |
| Merge conflicts with main | Abort, rebase first |

```bash
# Abort protocol
git checkout main
git branch -D hotfix/[short-description]
echo "Hotfix aborted. Reason: [reason]"
```

---

## START NOW

**Step 0: Write AUTHORIZED_COMMAND to session state**

Update `session-state/CURRENT.md` to include `AUTHORIZED_COMMAND: massu-hotfix`.

Then proceed with the hotfix workflow.

---

## COMPLETION REPORT

```markdown
## CS HOTFIX COMPLETE

### Fix Details
- **Branch**: hotfix/[description]
- **Files changed**: [N]
- **Commit**: [hash]

### Verification
| Check | Status |
|-------|--------|
| Type Safety | PASS |
| Tests | PASS ([N] passed) |
| Pattern Scanner | PASS |

### PR (if created)
- **URL**: [PR URL]
- **Status**: Open

### Next Steps
- Review and merge PR
- Delete hotfix branch after merge
```
