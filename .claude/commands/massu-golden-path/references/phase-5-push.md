# Phase 5: Push Verification & Push

> Reference doc for `/massu-golden-path`. Return to main file for overview.

```
[GOLDEN PATH -- PHASE 5: PUSH VERIFICATION]
```

## 5.1 Pre-Flight

```bash
git log origin/main..HEAD --oneline  # Commits to push
```

## 5.2 Tier 1: Quick Re-Verification

Run in parallel where possible:

| Check | Command |
|-------|---------|
| Pattern Scanner | `./scripts/pattern-scanner.sh` |
| VR-COUPLING | `./scripts/check-coupling.sh` |
| VR-UX | `./scripts/check-ux-quality.sh` |
| TypeScript | `NODE_OPTIONS="--max-old-space-size=8192" npx tsc --noEmit` |
| Build | `npm run build` |
| Prisma | `npx prisma validate` |
| Schema Mismatch | `./scripts/check-schema-mismatches.sh` |

## 5.3 Tier 2: Test Suite (CRITICAL)

### 5.3.0 Regression Detection (MANDATORY FIRST)

```bash
# Establish baseline on main
git stash && git checkout main -q
npm run test:run 2>&1 | tee /tmp/baseline-tests.txt
git checkout - -q && git stash pop -q

# Run on current branch
npm run test:run 2>&1 | tee /tmp/current-tests.txt

# Compare: any test passing on main but failing now = REGRESSION
# Regressions MUST be fixed before push
```

### 5.3.1-5.3.5 Test Execution

Use **parallel Task agents** for independent checks:

```
Agent Group A (parallel):
- Agent 1: npm run test:run (unit tests)
- Agent 2: npm audit --audit-level=high
- Agent 3: npx tsx scripts/detect-secrets.ts

Agent Group B (parallel, after A):
- Agent 1: npm run test:e2e (E2E tests)
- Agent 2: npm run test:visual:run (visual regression)

Sequential:
- ./scripts/validate-router-contracts.sh
- VR-RENDER: verify ALL new components rendered in pages
```

## 5.4 Tier 3: Security & Compliance

| Check | Command |
|-------|---------|
| npm audit | `npm audit --audit-level=high` |
| Secrets scan | `npx tsx scripts/detect-secrets.ts` |
| Accessibility | `./scripts/verify-accessibility.sh` |
| DB sync | Verify schema match across all environments |

### VR-STORED-PROC (If migrations in push)

```sql
SELECT proname, prosrc FROM pg_proc
JOIN pg_namespace n ON n.oid = pronamespace
WHERE n.nspname = 'public' AND prosrc LIKE '%old_table_name%';
-- Run on all environments. Expected: 0 rows.
```

### VR-RLS-AUDIT (CR-33)

```sql
SELECT c.relname FROM pg_class c
JOIN pg_namespace n ON c.relnamespace = n.oid
WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity = false;
-- Run on all environments. Expected: 0 rows.
```

### VR-DATA (Config-Code Alignment)

If push includes config-driven features, verify config keys match code expectations.

### Compliance Audit Trail

Generate: `massu_audit_log`, `massu_audit_report`, `massu_validation_report`.

## 5.5 Tier 4: Final Gate

All tiers must pass:

| Tier | Status |
|------|--------|
| Tier 1: Quick Checks | PASS/FAIL |
| Tier 2: Test Suite + Regression | PASS/FAIL |
| Tier 3: Security & Compliance | PASS/FAIL |

---

## Phase 5 Gate -> APPROVAL POINT #4: PUSH

See `approval-points.md` for the exact format.

After approval: `git push origin [branch]`, then monitor CI with `./scripts/ci-status.sh --wait --max-wait 300`. If CI fails, auto-run `/massu-ci-fix` protocol.
