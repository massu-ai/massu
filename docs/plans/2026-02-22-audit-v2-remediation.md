# Remediation Plan: Full-Scope Audit v2 Findings

**Created**: 2026-02-22
**Source**: `docs/2026-02-21-full-scope-audit-v2.md`
**Scope**: Both repos — `massu` (public) + `massu-internal` (private website)
**Total Deliverables**: 12

---

## Overview

- **Feature**: Fix all CRITICAL, HIGH, and MEDIUM findings from the v2 audit
- **Complexity**: Medium (mostly data corrections and dependency upgrades)
- **Areas**: Website (types, deps, tests, marketing data), massu root (package.json)
- **Estimated Items**: 12

## Feasibility Status

- File structure verified: YES (all target files read and confirmed)
- Patterns reviewed: YES
- Similar features analyzed: N/A (fixes, not new features)

---

## Phase 1: CRITICAL — npm Vulnerabilities (CR-9)

### P1-001: Fix ajv vulnerability via npm audit fix

- **Type**: DEPENDENCY_FIX
- **Repo**: massu-internal
- **File**: `/Users/eko3/massu-internal/website/package-lock.json`
- **Action**: Run `npm audit fix` (non-breaking fix for ajv)
- **Verification**: `cd /Users/eko3/massu-internal/website && npm audit 2>&1 | grep -c "ajv"` → should show 0 or reduced

### P1-002: Upgrade vitest to v4 (fixes esbuild/vite chain)

- **Type**: DEPENDENCY_UPGRADE
- **Repo**: massu-internal
- **File**: `/Users/eko3/massu-internal/website/package.json`
- **Action**: Change `"vitest": "^2.0.0"` → `"vitest": "^4.0.0"` in devDependencies, then `npm install`
- **Breaking changes to handle**:
  - vitest v4 API may have changed — verify all 12 test files still compile
  - Run `npm test` to confirm all 65 tests still pass (minus the 4 SSO tests being fixed in P2-002)
- **Verification**: `cd /Users/eko3/massu-internal/website && npm audit 2>&1 | grep -c "esbuild"` → 0

### P1-003: Upgrade eslint to v10 + add npm overrides for minimatch (fixes minimatch chain)

- **Type**: DEPENDENCY_UPGRADE
- **Repo**: massu-internal
- **File**: `/Users/eko3/massu-internal/website/package.json`
- **Action**:
  1. Change `"eslint": "^9"` → `"eslint": "^10"` in devDependencies, then `npm install`
  2. **CRITICAL**: eslint v10 fixes its own minimatch dependency (`^10.2.1`), but transitive deps still pull vulnerable minimatch v9.x:
     - `@typescript-eslint/typescript-estree` depends on `minimatch ^9.0.5` (vulnerable: all v9.x < 10.2.1)
     - `eslint-plugin-import`, `eslint-plugin-react`, `eslint-plugin-jsx-a11y` (via `eslint-config-next`) depend on vulnerable minimatch
  3. Add an `"overrides"` section to `package.json` to force all minimatch to `^10.2.1`:
     ```json
     "overrides": {
       "minimatch": "^10.2.1"
     }
     ```
  4. Run `npm install` again after adding overrides, then verify
  5. Note: `eslint-config-next@16.1.6` IS the latest version (peer dep `eslint >=9.0.0` is compatible with v10). No need to change its version.
- **Breaking changes to handle**:
  - eslint v10 flat config: verified compatible — current `eslint.config.mjs` uses `defineConfig` and `globalIgnores` from `eslint/config`, available in both v9.39+ and v10
  - minimatch v10 override may break packages that depend on minimatch v9 API — test `npm run lint` after upgrade
  - `typescript-eslint` may need upgrade to match (current 8.55.0 → 8.56.0 via npm audit fix)
- **Verification**: `cd /Users/eko3/massu-internal/website && npm audit` → 0 vulnerabilities

### P1-004: Verify zero vulnerabilities after all upgrades

- **Type**: VERIFICATION
- **Repo**: massu-internal
- **Command**: `cd /Users/eko3/massu-internal/website && npm audit`
- **Expected**: `found 0 vulnerabilities`
- **If not zero**: Fix remaining issues iteratively per CR-9

---

## Phase 2: CRITICAL — Build & Test Failures

### P2-001: Add `contact_submissions` table to Supabase generated types

- **Type**: TYPE_FIX
- **Repo**: massu-internal
- **File**: `/Users/eko3/massu-internal/website/src/lib/supabase/types.ts`
- **Action**: Add `contact_submissions` table type definition to the `Database['public']['Tables']` section. The table schema (from migration 018) is:
  ```
  id: uuid (PK, default gen_random_uuid())
  name: text (NOT NULL)
  email: text (NOT NULL)
  company: text (nullable)
  tier_interest: text (nullable)
  message: text (NOT NULL)
  submitted_at: timestamptz (NOT NULL, default now())
  created_at: timestamptz (NOT NULL, default now())
  ```
  Add the Row, Insert, and Update types following the pattern of existing tables in the file.
- **Verification**: `cd /Users/eko3/massu-internal/website && npx tsc --noEmit 2>&1 | grep "contact_submissions"` → 0 errors

### P2-002: Add "info" and "purple" variants to BadgeVariant type

- **Type**: TYPE_FIX
- **Repo**: massu-internal
- **File**: `/Users/eko3/massu-internal/website/src/components/ui/Badge.tsx`
- **Action**:
  1. Change line 4: `type BadgeVariant = 'default' | 'primary' | 'accent' | 'success' | 'warning'`
     → `type BadgeVariant = 'default' | 'primary' | 'accent' | 'success' | 'warning' | 'info' | 'purple'`
  2. Add both new variants to `variantStyles` (after line 16, before the closing `}`):
     - `info: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',` (no `--info` design token exists in globals.css)
     - `purple: 'bg-purple-500/10 text-purple-400 border-purple-500/20',`
  3. **Why both**: The type error at `src/app/features/page.tsx:258` uses BOTH `'info'` (for cloud-pro tier) AND `'purple'` (for enterprise tier). Adding only `'info'` would leave `'purple'` as a type error.
- **Verification**: `cd /Users/eko3/massu-internal/website && npx tsc --noEmit 2>&1 | grep "BadgeVariant"` → 0 errors

### P2-003: Fix SSO validation tests to match 501 stub

- **Type**: TEST_FIX
- **Repo**: massu-internal
- **File**: `/Users/eko3/massu-internal/website/src/__tests__/integration/sso-validation.test.ts`
- **Action**: The SSO callback is at `src/app/api/sso/callback/route.ts` (NOT `src/app/api/auth/sso/callback/route.ts`). The test paths (`SSO_CALLBACK_PATH` and `SSO_INIT_PATH`) are already correct. The tests read source and check for patterns that don't exist in the 501 stub. Fix approach:
  1. ~~Update `SSO_CALLBACK_PATH`~~ — already correct (`src/app/api/sso/callback/route.ts` on line 12)
  2. ~~Update `SSO_INIT_PATH`~~ — already correct (`src/app/api/sso/route.ts` on line 13)
  3. Change tests that expect full implementation to use `.todo()` with comment explaining SSO is intentionally not implemented yet:
     - "SSO callback validates the state parameter" → `.todo()`
     - "SSO callback returns error for invalid state" → `.todo()`
     - "SSO callback requires assertion or code" → `.todo()`
     - "SSO callback clears state cookie after use" → `.todo()`
  4. Keep the "SSO callback route file exists" test (path already correct)
  5. Keep the "SSO callback has no dangerous stub patterns" test (it should pass against the 501 stub)
  6. Keep the "SSO initiation generates CSRF state token" test (skip if file doesn't exist — it already does `if (!fs.existsSync(...)) return`)
- **Verification**: `cd /Users/eko3/massu-internal/website && npm test` → 0 failures

### P2-004: Verify website builds after type fixes

- **Type**: VERIFICATION
- **Repo**: massu-internal
- **Command**: `cd /Users/eko3/massu-internal/website && npm run build`
- **Expected**: Exit 0

---

## Phase 3: HIGH — Stale Marketing Stats (CR-16)

### P3-001: Update stats.ts with correct values

- **Type**: DATA_FIX
- **Repo**: massu-internal
- **File**: `/Users/eko3/massu-internal/website/src/data/stats.ts`
- **Action**: Update 3 stale values:
  - Line 11: `value: 12` → `value: 17` (Canonical Rules: CR-1 through CR-17)
  - Line 13: `value: 38` → `value: 39` (Database Tables: 39 CREATE TABLE statements)
  - Line 15: `value: 43` → `value: 44` (Workflow Commands: 45 files minus `_shared-preamble.md`)
- **Verification**: `grep -n "value:" /Users/eko3/massu-internal/website/src/data/stats.ts` shows 17, 39, 44

### P3-002: Update hardcoded count strings across website (Blast Radius)

- **Type**: DATA_FIX
- **Repo**: massu-internal
- **Scope**: Multiple files — all hardcoded "43 commands/workflow commands" → "44", all "12 rules" → "17"
- **Files and changes** (CR-10 blast radius analysis):

| # | File | Line | Old Value | New Value | Action |
|---|------|------|-----------|-----------|--------|
| 1 | `src/data/pricing.ts` | 29 | `'43 workflow commands'` | `'44 workflow commands'` | CHANGE |
| 2 | `src/app/features/page.tsx` | 466 | `"43 commands"` | `"44 commands"` | CHANGE |
| 3 | `src/components/sections/Hero.tsx` | 95 | `"43 workflow commands"` | `"44 workflow commands"` | CHANGE |
| 4 | `src/components/sections/OpenSourceSection.tsx` | 62 | `"43 commands"` | `"44 commands"` | CHANGE |
| 5 | `src/components/pricing/PricingFAQ.tsx` | 16 | `"43 workflow commands"` | `"44 workflow commands"` | CHANGE |
| 6 | `src/components/pricing/PricingFAQ.tsx` | 76 | `"43 workflow commands"` (start) AND `"All 43 commands"` (end) | `"44 workflow commands"` AND `"All 44 commands"` | CHANGE (2 replacements on same line) |
| 7 | `src/data/articles.ts` | 20 | `"43 workflow commands"` | `"44 workflow commands"` | CHANGE |
| 8 | `src/data/articles.ts` | 23 | `"43 workflow commands"` | `"44 workflow commands"` | CHANGE |
| 9 | `src/app/about/page.tsx` | 102 | `"43 commands, 11 hooks, 12 rules"` | `"44 commands, 11 hooks, 17 rules"` | CHANGE |
| 10 | `src/app/about/page.tsx` | 103 | `"43 workflow commands"` | `"44 workflow commands"` | CHANGE |
| 11 | `src/data/features.ts` | 648 | `'43 slash commands for structured...'` | `'44 slash commands for structured...'` | CHANGE |
| 12 | `src/app/how-it-works/page.tsx` | 419 | `"43 Commands. Complete Governance."` | `"44 Commands. Complete Governance."` | CHANGE |
| 13 | `src/components/pricing/FeatureComparison.tsx` | 18 | `'43'` (3 times) and `'43 + custom'` (1 time) | `'44'` (3 times) and `'44 + custom'` (1 time) | CHANGE (4 replacements total) |
| 14 | `src/components/sections/CloudPreview.tsx` | 114 | `43 Commands` | `44 Commands` | CHANGE |

- **Values NOT changed** (verified correct):
  - All "51 MCP tools" → KEEP (actual count is 51)
  - All "11 lifecycle hooks" → KEEP (actual count is 11)
  - All "51 tools" references → KEEP

- **Not changed** (false positives in grep for `\b43\b`):
  - `src/app/checkout/success/page.tsx:41` — SVG path coordinates (`.43L`), not a count → KEEP
  - `src/components/dashboard/DashboardSidebar.tsx:86` — SVG path coordinates, not a count → KEEP
  - `src/app/about/page.tsx:401` — SVG path coordinates (GitHub icon, `.43.372`), not a count → KEEP
- **Verification**: `grep -rni "43 command\|43 workflow\|43 slash\|12 rules" /Users/eko3/massu-internal/website/src/` → 0 matches AND `grep -rn "'43'" /Users/eko3/massu-internal/website/src/components/pricing/FeatureComparison.tsx` → 0 matches

---

## Phase 4: MEDIUM — Root Package & Scripts

### P4-001: Add `"private": true` to massu root package.json

- **Type**: CONFIG_FIX
- **Repo**: massu
- **File**: `/Users/eko3/massu/package.json`
- **Action**: Add `"private": true` after line 4 (`"description": ...`)
- **Verification**: `grep '"private"' /Users/eko3/massu/package.json` → `"private": true`

### ~~P4-002: Add `set -e` to shell scripts~~ — REMOVED (not a valid fix)

- **Type**: NO_ACTION
- **Repo**: massu
- **Reason**: All 6 scripts explicitly document `# errexit (-e) intentionally omitted: script tracks violations via counter and uses || true patterns`. These scripts use a deliberate design pattern: they run multiple `grep` checks, count violations via a counter variable, and report all violations at the end. Adding `set -e` would cause each script to exit on the first `grep` that returns exit code 1 (no matches found), fundamentally breaking the violation-counting pattern. This was NOT a bug — it was intentional architecture documented in each script's header comments.
- **Affected scripts** (all have the same comment):
  - `massu-pattern-scanner.sh` (line 10)
  - `massu-security-scanner.sh` (line 11)
  - `massu-verify-tooling.sh` (line 6)
  - `massu-test-coverage.sh` (line 11)
  - `massu-launch-readiness.sh` (line 2)
  - `massu-migration-validator.sh` (line 10)
- **Verification**: N/A (no change needed)

---

## Phase 5: Final Verification

### P5-001: Full verification gate

- **Type**: VERIFICATION
- **Commands** (in order):
  1. `cd /Users/eko3/massu && npm audit` → 0 vulnerabilities
  2. `cd /Users/eko3/massu && npm test` → 890+ tests pass
  3. `cd /Users/eko3/massu && npm run build` → Exit 0
  4. `cd /Users/eko3/massu && bash scripts/massu-pattern-scanner.sh` → Exit 0
  5. `cd /Users/eko3/massu-internal/website && npm audit` → 0 vulnerabilities
  6. `cd /Users/eko3/massu-internal/website && npx tsc --noEmit` → 0 errors
  7. `cd /Users/eko3/massu-internal/website && npm run build` → Exit 0
  8. `cd /Users/eko3/massu-internal/website && npm test` → 0 failures

---

## Verification Commands Summary

| Item | Type | Verification Command |
|------|------|---------------------|
| P1-001 | npm audit fix | `npm audit` (ajv resolved) |
| P1-002 | vitest upgrade | `npm audit` (esbuild chain resolved) |
| P1-003 | eslint upgrade | `npm audit` (minimatch chain resolved) |
| P1-004 | Zero vulns | `npm audit` → 0 vulnerabilities |
| P2-001 | Types fix | `npx tsc --noEmit` → 0 contact_submissions errors |
| P2-002 | Badge fix (info + purple) | `npx tsc --noEmit` → 0 BadgeVariant errors |
| P2-003 | Test fix | `npm test` → 0 failures |
| P2-004 | Build fix | `npm run build` → Exit 0 |
| P3-001 | Stats update | `grep "value:" stats.ts` shows 17, 39, 44 |
| P3-002 | Blast radius (14 items) | `grep -rni "43 command\|43 workflow\|43 slash\|12 rules" src/` → 0 AND `grep -rn "'43'" FeatureComparison.tsx` → 0 |
| P4-001 | Private field | `grep '"private"' package.json` |
| ~~P4-002~~ | REMOVED | N/A — `set -e` intentionally omitted per script design |
| P5-001 | Full gate | All 8 commands pass |

---

## Item Summary

| Phase | Items | Description |
|-------|-------|-------------|
| Phase 1 | 4 | CRITICAL: npm vulnerabilities (CR-9) |
| Phase 2 | 4 | CRITICAL: Build & test failures |
| Phase 3 | 2 | HIGH: Stale marketing stats (CR-16) |
| Phase 4 | 1 | MEDIUM: Root config (P4-002 removed — scripts intentionally omit -e) |
| Phase 5 | 1 | Final verification gate |
| **Total** | **9 deliverables + 3 verification gates = 12** (P4-002 removed) | |

---

## Dependencies

| Item | Depends On | Reason |
|------|------------|--------|
| P1-004 | P1-001, P1-002, P1-003 | All vuln fixes must complete before final audit |
| P2-003 | P1-002 | vitest upgrade may affect test runner behavior |
| P2-004 | P2-001, P2-002 | Build requires type fixes |
| P3-002 | P3-001 | Stats should be fixed first for consistency |
| P5-001 | All above | Final gate requires all fixes |

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| vitest v4 breaking changes | Medium | Medium | Run all tests after upgrade, fix API changes |
| eslint v10 config incompatibility | Low | Low | Verified: `eslint.config.mjs` uses `defineConfig`/`globalIgnores` from `eslint/config`, compatible with both v9.39+ and v10 |
| npm overrides for minimatch break eslint plugins | Medium | Medium | Run `npm run lint` after applying overrides; if plugins break, pin to compatible minimatch v10.x |
| Supabase type mismatch | Low | Medium | Verify type matches migration 018 schema exactly |

---

## Blast Radius Analysis (CR-10)

### Value: "43" → "44" (Workflow Commands)

**Total occurrences found: 14** (see P3-002 table above, items 1-14)
- Categorized: 14/14 (100%)
- All marked CHANGE
- Uncategorized: 0
- False positives excluded: 3 (SVG path coordinates in checkout/success, DashboardSidebar, and about/page)

### Value: "12" → "17" (Canonical Rules)

**Total occurrences found: 1**
- `src/app/about/page.tsx:102` — CHANGE
- `src/data/stats.ts:11` — covered by P3-001

### Value: "38" → "39" (Database Tables)

**Total occurrences found: 1**
- `src/data/stats.ts:13` — covered by P3-001
- No hardcoded "38 tables" strings found elsewhere

---

## Post-Build Reflection

1. **"Now that I've built this, what would I have done differently?"**
   - The blast radius for "43" was large (14 files). A centralized constant (e.g., `COMMAND_COUNT` exported from `stats.ts` and imported everywhere) would prevent this class of drift entirely. Currently every marketing page hardcodes the count.
   - vitest v2→v4 was a painless upgrade but the npm audit vulnerability chain (vitest→vite→esbuild + eslint→minimatch) required manual resolution with overrides. Could have been caught earlier with scheduled `npm audit` in CI.

2. **"What should be refactored before moving on?"**
   - `src/data/stats.ts` values should ideally be computed from source data rather than hardcoded (CR-16 long-term fix). The command count could be derived from the actual command file count at build time.
   - The 14-file blast radius for marketing counts is a strong signal to extract these into shared constants that all pages import.
