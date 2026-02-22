---
name: massu-pre-launch
description: "Comprehensive pre-launch/pre-deploy verification across both repos"
allowed-tools: Bash(*), Read(*), Grep(*), Glob(*)
---

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9 enforced.

# Massu Pre-Launch: Comprehensive Deployment Readiness Check

## Objective

Run ALL verification gates across both repos before any production deployment or major release. This is READ-ONLY -- it reports findings but does not fix them.

---

## NON-NEGOTIABLE RULES

- Run ALL checks even if early ones fail
- Report ALL findings with severity
- Do NOT skip any section
- Do NOT mark as ready if ANY CRITICAL/HIGH finding exists

---

## STEP 1: MCP Server Quality Gates

```bash
bash scripts/massu-pattern-scanner.sh
bash scripts/massu-security-scanner.sh
cd packages/core && npx tsc --noEmit
npm test
npm run test:integration
cd packages/core && npm run build:hooks
bash scripts/massu-verify-tooling.sh
```

## STEP 2: Website Quality Gates

```bash
cd /Users/eko3/massu-internal/website
npx tsc --noEmit
npx vitest run
npx vitest run src/__tests__/integration/
npm audit --audit-level=high
```

## STEP 3: Business Logic Audit

1. Verify plan gating on all paid dashboard pages
2. Verify pricing consistency (config vs code)
3. Verify marketing claims match actual data
4. Verify auth completeness (no stubs)

## STEP 4: Security Audit

1. Run enhanced security scanner
2. Verify SSRF protection on all webhook URLs
3. Verify no API responses leak secrets
4. Verify encryption fails hard

## STEP 5: Infrastructure

1. Verify git hooks installed: `ls .husky/pre-commit .husky/pre-push`
2. Verify npm package installable: `npm pack --dry-run`
3. Verify all environment variables documented

## STEP 6: Report

```markdown
### Pre-Launch Readiness Report
- **Date**: [date]
- **MCP Quality Gates**: PASS/FAIL
- **Website Quality Gates**: PASS/FAIL
- **Business Logic**: PASS/FAIL
- **Security**: PASS/FAIL
- **Infrastructure**: PASS/FAIL
- **OVERALL**: READY / NOT READY
- **Blockers**: [list if any]
```
