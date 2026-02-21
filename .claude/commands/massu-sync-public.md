name: massu-sync-public

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9, CR-35 enforced.

# Sync Public Repo

## Objective

Run quality gates on massu-internal, then sync public files to the massu public repo.

---

## STEP 1: Quality Gates (massu-internal)

Run all quality checks before syncing:

```bash
# Pattern scanner
bash scripts/massu-pattern-scanner.sh
# MUST exit 0

# Type check
cd packages/core && npx tsc --noEmit
# MUST show 0 errors

# Tests
npm test
# MUST pass all tests

# Hook build
cd packages/core && npm run build:hooks
# MUST exit 0
```

**If ANY gate fails, DO NOT sync. Fix the issue first.**

---

## STEP 2: Run Sync Script

```bash
bash scripts/sync-public.sh [PUBLIC_REPO_PATH]
```

Default public repo path: `../massu`

To auto-push after sync:
```bash
bash scripts/sync-public.sh [PUBLIC_REPO_PATH] --push
```

---

## STEP 3: Verify Public Repo

After sync, verify the public repo is functional:

```bash
cd [PUBLIC_REPO_PATH]

# Install deps
npm install

# Quality gates
bash scripts/massu-pattern-scanner.sh        # Exit 0
cd packages/core && npx tsc --noEmit         # 0 errors
npm test                                      # All pass
cd packages/core && npm run build:hooks       # Exit 0
```

---

## STEP 4: Audit for Leaks

Quick leak check:

```bash
cd [PUBLIC_REPO_PATH]

# No private docs
ls docs/strategy/ docs/security/ docs/plans/ 2>&1 | grep -c "No such"  # Should be 3

# No website directory
test ! -d website/ && echo "PASS" || echo "FAIL: website/ found"

# Command count
ls .claude/commands/massu-*.md | wc -l  # Should be 15

# No sync script leaked
test ! -f scripts/sync-public.sh && echo "PASS" || echo "FAIL: sync-public.sh found"

# No trade secrets
grep -rl "trade.secret\|TRADE-SECRET" . --include="*.md" | grep -v node_modules | wc -l  # Should be 0
```

---

## STEP 5: Review and Push

```bash
cd [PUBLIC_REPO_PATH]

# Show what changed
git log --oneline -1
git diff HEAD~1 --stat

# Push if satisfied
git push origin main
```

---

## Completion Report

```markdown
### Sync Complete
- **Source**: massu-internal ([commit hash])
- **Target**: massu (public)
- **Quality Gates**: PASS
- **Leak Audit**: PASS
- **Pushed**: YES/NO
```
