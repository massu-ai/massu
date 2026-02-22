# Launch Blockers Remediation Plan

## Overview
- **Feature**: Fix all customer-facing blockers from audit v2 (excluding npm publish and GitHub URL)
- **Complexity**: Medium
- **Areas**: MCP Core (packages/core), Website (massu-internal/website), Stripe Events, API Routes, Auth, SEO
- **Estimated Items**: 17 deliverables across 5 phases

## Scope

Fixes ALL issues from the audit v2 health check **EXCEPT**:
- Issue #1 (npm publish to registry) — user will do after everything else works
- Issue #3 (GitHub repo URL 404) — user will fix after everything else works

---

## Phase 1: Critical Security & Billing (Canceled Customers Keep Access)

### P1-001: Fix `requirePlan()` to reject canceled subscriptions
- **Type**: MODULE_MODIFY
- **File**: `/Users/eko3/massu-internal/website/src/lib/auth.ts`
- **Line**: 84-99
- **Action**: Add `plan_status` check to `requirePlan()`. After getting `orgData`, check that `organization.plan_status` is `'active'` or `'trialing'`. If canceled/past_due, redirect to `/pricing`.
- **Current code** (line 84-99):
  ```typescript
  export async function requirePlan(minimumPlan: Plan) {
    const orgData = await getCurrentOrg();
    if (!orgData || !orgData.organization) { redirect('/pricing'); }
    const currentPlan = orgData.organization.plan as Plan;
    const currentLevel = PLAN_HIERARCHY[currentPlan] ?? 0;
    const requiredLevel = PLAN_HIERARCHY[minimumPlan] ?? 0;
    if (currentLevel < requiredLevel) { redirect('/pricing'); }
    return orgData;
  }
  ```
- **New code**: After the `!orgData` check, add:
  ```typescript
  const planStatus = orgData.organization.plan_status;
  if (planStatus !== 'active' && planStatus !== 'trialing') {
    redirect('/pricing');
  }
  ```
- **Verification**: `grep -n 'plan_status' /Users/eko3/massu-internal/website/src/lib/auth.ts` — should find the new check

### P1-002: Fix `handleSubscriptionDeleted` to reset plan to `free`
- **Type**: MODULE_MODIFY
- **File**: `/Users/eko3/massu-internal/website/src/lib/stripe-events.ts`
- **Line**: 171-174
- **Action**: Change the update to also set `plan: 'free'` alongside `plan_status: 'canceled'`
- **Current code** (line 171-174):
  ```typescript
  await supabase
    .from('organizations')
    .update({ plan_status: 'canceled' as PlanStatus })
    .eq('id', org.id)
  ```
- **New code**:
  ```typescript
  await supabase
    .from('organizations')
    .update({ plan: 'free', plan_status: 'canceled' as PlanStatus })
    .eq('id', org.id)
  ```
- **Verification**: `grep -n "plan: 'free'" /Users/eko3/massu-internal/website/src/lib/stripe-events.ts` — should match

---

## Phase 2: API Security — Replace `select('*')` with Explicit Fields (CR-17)

### P2-001: Fix `getCurrentOrg()` in auth.ts
- **Type**: MODULE_MODIFY
- **File**: `/Users/eko3/massu-internal/website/src/lib/auth.ts`
- **Lines**: 40, 50
- **Action**: Replace both `select('*')` calls with explicit field lists
- **Change 1** (line 40): `.select('*')` → `.select('id, user_id, org_id, role, display_name, email')`
- **Change 2** (line 50): `.select('*')` → `.select('id, name, slug, plan, plan_status, stripe_customer_id, trial_ends_at, mfa_required, encryption_enabled, created_at')`
  - NOTE: Do NOT include `stripe_subscription_id` — it is a billing secret. Include `mfa_required` and `encryption_enabled` because dashboard settings pages read them from `orgData.organization`. `stripe_customer_id` is needed by `security-actions.ts` for Stripe cancellation (server-side only).
- **Verification**: `grep "select('*')" /Users/eko3/massu-internal/website/src/lib/auth.ts | wc -l` — should be 0

### P2-002: Fix sessions API route
- **Type**: MODULE_MODIFY
- **File**: `/Users/eko3/massu-internal/website/src/app/api/v1/sessions/[id]/route.ts`
- **Lines**: 20, 33
- **Action**:
  - Line 20: `.select('*')` → `.select('id, local_session_id, org_id, project_name, started_at, ended_at, estimated_cost, tokens_used, turns, tools_used, summary, user_id, created_at')`
    - NOTE: The column is `project_name` (not `project`). There is no `quality_score` column in the schema. There is no `security_metadata` column either.
  - Line 33: `.select('*')` → `.select('id, local_observation_id, org_id, session_id, type, content, file_path, importance, created_at')`
    - NOTE: This is the complete column list for `synced_observations`. No sensitive columns exist in this table.
- **Verification**: `grep "select('*')" /Users/eko3/massu-internal/website/src/app/api/v1/sessions/\\[id\\]/route.ts | wc -l` — should be 0

### P2-003: Fix audit report API route
- **Type**: MODULE_MODIFY
- **File**: `/Users/eko3/massu-internal/website/src/app/api/v1/audit/report/route.ts`
- **Lines**: 21, 40
- **Action**:
  - Line 21: `.select('*')` → `.select('id, org_id, report_type, title, period_start, period_end, summary, status, download_url, created_at')`
    - NOTE: Do NOT include `report_data` — it is a large Json blob. `generated_by` is excluded to avoid leaking user IDs.
  - Line 40: `.select('*')` → `.select('id, org_id, action, resource, user_id, details, created_at')`
    - NOTE: Do NOT include `ip_address` — it is PII. Column `resource_id` does not exist; the column is just `resource`.
- **Verification**: `grep "select('*')" /Users/eko3/massu-internal/website/src/app/api/v1/audit/report/route.ts | wc -l` — should be 0

### P2-004: Fix risk API route
- **Type**: MODULE_MODIFY
- **File**: `/Users/eko3/massu-internal/website/src/app/api/v1/risk/route.ts`
- **Line**: 19
- **Action**: `.select('*')` → `.select('id, org_id, repo, pr_number, pr_title, files_changed, risk_score, impact_score, regression_score, security_score, coupling_score, details, created_at')`
- **Verification**: `grep "select('*')" /Users/eko3/massu-internal/website/src/app/api/v1/risk/route.ts | wc -l` — should be 0

### P2-005: Fix evidence download API route
- **Type**: MODULE_MODIFY
- **File**: `/Users/eko3/massu-internal/website/src/app/api/evidence/[id]/download/route.ts`
- **Line**: 66
- **Action**: `.select('*')` → `.select('id, org_id, title, report_type, period_start, period_end, status, file_size_bytes, created_at')`
- **Verification**: `grep "select('*')" /Users/eko3/massu-internal/website/src/app/api/evidence/\\[id\\]/download/route.ts | wc -l` — should be 0

### P2-006: Fix evidence list API route
- **Type**: MODULE_MODIFY
- **File**: `/Users/eko3/massu-internal/website/src/app/api/evidence/route.ts`
- **Line**: 126
- **Action**: `.select('*')` → `.select('id, org_id, title, report_type, period_start, period_end, status, file_size_bytes, created_at')`
  - NOTE: The GET handler at line 204 already uses explicit `.select(...)`. Only the POST handler's pending-package query at line 126 needs fixing.
- **Verification**: `grep "select('*')" /Users/eko3/massu-internal/website/src/app/api/evidence/route.ts | wc -l` — should be 0

### P2-007: Fix invitations accept API route
- **Type**: MODULE_MODIFY
- **File**: `/Users/eko3/massu-internal/website/src/app/api/invitations/accept/route.ts`
- **Line**: 37
- **Action**: `.select('*')` → `.select('id, org_id, email, role, status, expires_at, created_at')`
- **Verification**: `grep "select('*')" /Users/eko3/massu-internal/website/src/app/api/invitations/accept/route.ts | wc -l` — should be 0

---

## Phase 3: MCP Core Fixes (massu repo)

### P3-001: Fix massu.dev → massu.ai URLs
- **Type**: MODULE_MODIFY
- **Files**:
  - `/Users/eko3/massu/packages/core/src/cli.ts` line 89
  - `/Users/eko3/massu/packages/core/src/commands/init.ts` lines 130, 373
- **Action**: Replace all 3 occurrences of `massu.dev` with `massu.ai`
- **Verification**: `grep -rn 'massu\.dev' /Users/eko3/massu/packages/core/src/ | wc -l` — should be 0

### P3-002: Fix `__dirname` ESM bug in init.ts
- **Type**: MODULE_MODIFY
- **File**: `/Users/eko3/massu/packages/core/src/commands/init.ts`
- **Line**: 203
- **Action**: `init.ts` uses `__dirname` (line 203) but never imports `fileURLToPath`/`dirname` or defines the `__dirname` polyfill. Add ESM-compatible `__dirname` definition:
  - **Change 1** (line 15): `import { resolve, basename } from 'path';` → `import { resolve, basename, dirname } from 'path';`
  - **Change 2**: Add new import after line 16: `import { fileURLToPath } from 'url';`
  - **Change 3**: Add after the new import:
    ```typescript
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    ```
- **Verification**: `grep -n 'fileURLToPath' /Users/eko3/massu/packages/core/src/commands/init.ts` — should find the import

### P3-003: Fix `files` field in packages/core/package.json
- **Type**: CONFIG
- **File**: `/Users/eko3/massu/packages/core/package.json`
- **Lines**: 38-41
- **Action**: Remove `"src/**/*"` from the `files` array. This ships source code and test files in the npm package, bloating it. Only `dist/**/*` should be shipped.
- **Current**:
  ```json
  "files": [
    "src/**/*",
    "dist/**/*"
  ]
  ```
- **New**:
  ```json
  "files": [
    "dist/**/*"
  ]
  ```
- **Verification**: `grep -A2 '"files"' /Users/eko3/massu/packages/core/package.json` — should show only `dist/**/*`

### P3-004: Add README.md for npm package page
- **Type**: FILE_CREATE
- **File**: `/Users/eko3/massu/packages/core/README.md`
- **Action**: Create a concise README for the npm package page. Should include:
  - One-line description
  - Quick install (`npx massu init`)
  - What it is (MCP server for AI engineering governance)
  - Key features bullet list (51 tools, 11 hooks, 3 databases)
  - Link to https://massu.ai for full docs
  - License note (BSL 1.1)
- **Verification**: `ls -la /Users/eko3/massu/packages/core/README.md` — should exist

---

## Phase 4: Website SEO & Metadata Fixes

### P4-001: Fix Privacy page title duplication
- **Type**: MODULE_MODIFY
- **File**: `/Users/eko3/massu-internal/website/src/app/privacy/page.tsx`
- **Lines**: 5, 9
- **Action**: The layout template appends ` | Massu AI` via `template: '%s | Massu AI'`, so page-level titles should NOT include ` | Massu AI`.
  - Line 5: `title: 'Privacy Policy | Massu AI'` → `title: 'Privacy Policy'`
  - Line 9: `title: 'Privacy Policy | Massu AI'` → `title: 'Privacy Policy'`
- **Verification**: `grep "| Massu AI" /Users/eko3/massu-internal/website/src/app/privacy/page.tsx | wc -l` — should be 0

### P4-002: Fix Terms page title duplication
- **Type**: MODULE_MODIFY
- **File**: `/Users/eko3/massu-internal/website/src/app/terms/page.tsx`
- **Lines**: 5, 9
- **Action**: Same as Privacy — remove ` | Massu AI` suffix from title fields.
  - Line 5: `title: 'Terms of Service | Massu AI'` → `title: 'Terms of Service'`
  - Line 9: `title: 'Terms of Service | Massu AI'` → `title: 'Terms of Service'`
- **Verification**: `grep "| Massu AI" /Users/eko3/massu-internal/website/src/app/terms/page.tsx | wc -l` — should be 0

### P4-003: Add metadata to Pricing page
- **Type**: MODULE_MODIFY
- **File**: `/Users/eko3/massu-internal/website/src/app/pricing/page.tsx`
- **Action**: The pricing page is `'use client'` so it can't export `metadata` directly. Create a separate `layout.tsx` in the pricing directory to export metadata.
- **New file**: `/Users/eko3/massu-internal/website/src/app/pricing/layout.tsx`
  ```typescript
  import type { Metadata } from 'next'

  export const metadata: Metadata = {
    title: 'Pricing',
    description: 'Massu AI pricing plans. Open source core free forever. Cloud plans for teams and enterprises starting at $49/month.',
    openGraph: {
      title: 'Pricing',
      description: 'Massu AI pricing plans. Open source core free forever. Cloud plans for teams and enterprises.',
    },
  }

  export default function PricingLayout({ children }: { children: React.ReactNode }) {
    return <>{children}</>
  }
  ```
- **Verification**: `ls -la /Users/eko3/massu-internal/website/src/app/pricing/layout.tsx` — should exist

---

## Phase 5: CHANGELOG

### P5-001: Update CHANGELOG.md with launch-blocker fixes
- **Type**: MODULE_MODIFY
- **File**: `/Users/eko3/massu/CHANGELOG.md`
- **Action**: CHANGELOG.md already exists with an [Unreleased] section. Append entries for the fixes in this plan under the existing [Unreleased] section's ### Fixed heading: select('*') replacements (CR-17), requirePlan() canceled subscription fix, handleSubscriptionDeleted plan reset, massu.dev URL fix, __dirname ESM fix, npm files cleanup, SEO title deduplication.
- **Verification**: `grep 'select.*CR-17\|requirePlan\|canceled' /Users/eko3/massu/CHANGELOG.md` — should find the new entries

---

## Verification Commands

| Item | Type | Verification Command |
|------|------|---------------------|
| P1-001 | AUTH_FIX | `grep 'plan_status' /Users/eko3/massu-internal/website/src/lib/auth.ts` |
| P1-002 | STRIPE_FIX | `grep "plan: 'free'" /Users/eko3/massu-internal/website/src/lib/stripe-events.ts` |
| P2-001–P2-007 | CR-17 | `grep -rn "select('*')" /Users/eko3/massu-internal/website/src/app/api/ /Users/eko3/massu-internal/website/src/lib/auth.ts \| wc -l` → 0 |
| P3-001 | URL_FIX | `grep -rn 'massu\.dev' /Users/eko3/massu/packages/core/src/ \| wc -l` → 0 |
| P3-002 | ESM_FIX | `grep 'fileURLToPath' /Users/eko3/massu/packages/core/src/commands/init.ts` |
| P3-003 | NPM_FIX | `grep -A2 '"files"' /Users/eko3/massu/packages/core/package.json` |
| P3-004 | README | `ls -la /Users/eko3/massu/packages/core/README.md` |
| P4-001 | SEO | `grep "\| Massu AI" /Users/eko3/massu-internal/website/src/app/privacy/page.tsx \| wc -l` → 0 |
| P4-002 | SEO | `grep "\| Massu AI" /Users/eko3/massu-internal/website/src/app/terms/page.tsx \| wc -l` → 0 |
| P4-003 | SEO | `ls -la /Users/eko3/massu-internal/website/src/app/pricing/layout.tsx` |
| P5-001 | DOCS | `grep 'select.*CR-17\|requirePlan\|canceled' /Users/eko3/massu/CHANGELOG.md` |
| ALL | BUILD | `cd /Users/eko3/massu && npm run build` |
| ALL | TEST | `cd /Users/eko3/massu && npm test` |
| ALL | WEBSITE_BUILD | `cd /Users/eko3/massu-internal/website && npx tsc --noEmit` |

---

## Item Summary

| Phase | Items | Description |
|-------|-------|-------------|
| Phase 1 | 2 | Critical: Billing security (canceled customers, subscription reset) |
| Phase 2 | 7 | API security: Replace all select('*') with explicit fields |
| Phase 3 | 4 | MCP core: URLs, ESM bug, npm package, README |
| Phase 4 | 3 | Website SEO: Page titles, pricing metadata |
| Phase 5 | 1 | Documentation: CHANGELOG |
| **Total** | **17** | All deliverables |

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| select() field list missing a needed column | Medium | Medium | Cross-reference with table schema + test after |
| requirePlan() change breaks active subscriptions | Low | High | Only rejects canceled/past_due, not active/trialing |
| Pricing layout.tsx conflicts with existing layout chain | Low | Medium | It's a passthrough layout — no styling, just metadata |
| Title duplication on dashboard/contact/about pages | Medium | Low | Same `| Massu AI` duplication exists on ~45 dashboard pages + contact + about. Not customer-facing (dashboard is behind auth), but should be a follow-up task. |

---

## Dependencies

| Item | Depends On | Reason |
|------|------------|--------|
| P1-001 | None | Standalone auth fix |
| P1-002 | None | Standalone Stripe fix |
| P2-001 | None | Auth.ts fix independent of P1-001 |
| P2-002–P2-007 | None | Each API route is independent |
| P3-001–P3-004 | None | All massu repo changes are independent |
| P4-001–P4-003 | None | All SEO fixes are independent |
| P5-001 | None | Standalone doc |

---

## Excluded Items (Per User Instruction)

| # | Issue | Reason |
|---|-------|--------|
| 1 | npm publish @massu/core to registry | User: "will only fix once everything else is 100% working" |
| 3 | GitHub repo URL 404 (massu-ai/massu) | User: "will only fix once everything else is 100% working" |

---

## Post-Build Reflection

*(To be completed by implementing agent after verification passes)*

1. **"Now that I've built this, what would I have done differently?"**
2. **"What should be refactored before moving on?"**
