# Phase 5.5: Production Verification

> Reference doc for `/massu-golden-path`. Return to main file for overview.

```
[GOLDEN PATH -- PHASE 5.5: PRODUCTION VERIFICATION]
```

**Core Principle**: A feature is NOT complete until it is verified working in production with real data. "Deployed" and "working" are two completely different things.

---

## 5.5.1 Wait for Deployment

After push and CI success, verify the deployment landed:

```bash
# Check Vercel deployment status via MCP
# list_deployments — confirm latest is READY state
# get_runtime_logs — check for startup errors
```

If deployment failed or errored: diagnose, fix, and re-push (loop back to Phase 5).

---

## 5.5.2 Auto-Detect Changed Routes

Before categorizing, auto-detect which production routes were affected:

```bash
# Extract changed app routes from git diff
git diff origin/main --name-only -- 'src/app/' | grep -E 'page\.tsx|route\.ts' | \
  sed 's|src/app/||; s|/page\.tsx||; s|/route\.ts||; s|\[([^]]*)\]|:$1|g'

# Extract changed routers (for API verification)
git diff origin/main --name-only -- 'src/server/api/routers/' | \
  sed 's|src/server/api/routers/||; s|\.ts||'

# Extract changed cron jobs
git diff origin/main --name-only -- 'src/app/api/cron/'
```

Each detected route becomes a verification target. UI routes get Playwright checks, API routers get data-flow checks, crons get deferred verification entries.

---

## 5.5.3 Categorize Verifications

Review ALL plan items and changed files. Categorize each into:

| Category | Timing | Examples |
|----------|--------|---------|
| **Immediate** | Verify now | UI pages, API endpoints, DB schema+data, feature flags, env vars |
| **Deferred** | Verify later | Cron jobs (wait for cycle), webhooks (wait for trigger), external API syncs, email delivery |

Build a verification matrix:

```markdown
| # | Feature/Change | Category | Method | Expected Result | Status |
|---|----------------|----------|--------|-----------------|--------|
| PV-001 | [desc] | Immediate | Playwright | Page loads, data visible | PENDING |
| PV-002 | [desc] | Immediate | DB query (PROD) | Row count > 0 | PENDING |
| DV-001 | [desc] | Deferred | DB query after cron | New rows after deploy | PENDING |
```

---

## 5.5.4 Run Immediate Verifications

For each immediate item, verify with proof:

### UI Changes
Use Playwright MCP against production URL:
1. `browser_navigate` to production page
2. `browser_snapshot` — verify renders correctly
3. `browser_console_messages` — check for JS errors
4. `browser_click` / `browser_fill_form` — test interactions
5. Verify data displays (not empty, not placeholder, not "undefined")

### API/tRPC Changes
- Hit production endpoints or navigate to pages that use them
- Verify data loads and mutations work

### Database Changes
Query PROD (`mcp__supabase__PROD__execute_sql`):
```sql
-- Verify data flows, not just schema
SELECT COUNT(*), MAX(created_at) FROM [table]
WHERE created_at > '[deploy_timestamp]';
```

### Feature Flags / Config
```sql
-- Verify flags are set correctly
SELECT key, enabled FROM feature_flags WHERE key IN ('[flags]');
```

### Integration Chains
Trace the full chain: trigger -> process -> store -> display

```markdown
| Step | System | Verification | Status |
|------|--------|-------------|--------|
| Trigger | [source] | [how verified] | PASS/FAIL |
| Process | [handler] | [how verified] | PASS/FAIL |
| Store | [database] | [query result] | PASS/FAIL |
| Display | [UI page] | [screenshot] | PASS/FAIL |
```

---

## 5.5.5 Generate Deferred Checklist

For items that can't be verified immediately, write to `session-state/deferred-verifications.md`:

```markdown
# Deferred Production Verifications

**Generated**: [YYYY-MM-DD HH:MM PST]
**Deploy Commit**: [hash]
**Feature**: [name]

## Pending

### DV-001: [Description]
- **Type**: Cron / Webhook / External API / Background Job
- **Expected By**: [YYYY-MM-DD HH:MM PST]
- **Query**:
  ```sql
  SELECT COUNT(*) FROM [table] WHERE [condition] AND created_at > '[deploy_time]';
  ```
- **Expected Result**: [specific condition]
- **Status**: PENDING
```

These are surfaced by `/massu-bearings` in the next session and verified by `/massu-production-verify --deferred`.

---

## 5.5.6 Phase 5.5 Gate

| Condition | Result |
|-----------|--------|
| All immediate verifications PASS, no deferred items | **PRODUCTION VERIFIED** — proceed to Phase 6 |
| All immediate verifications PASS, deferred items exist | **VERIFIED + DEFERRED** — proceed to Phase 6, deferred items tracked |
| Any immediate verification FAILS | **BLOCKED** — diagnose, fix, re-push, re-verify |

**If BLOCKED**: Loop back. Fix the issue, commit, push (Phase 5 again), then re-run Phase 5.5.

---

## 5.5.7 Report Format

```
PHASE 5.5: PRODUCTION VERIFICATION
--------------------------------------------------------------------------
Deploy: [hash] — READY on Vercel
Production URL: [url]

Immediate Verifications: [X]/[Y] PASSED
  PV-001: [feature] — PASS (proof: [detail])
  PV-002: [feature] — PASS (proof: [detail])

Deferred Verifications: [N] pending
  DV-001: [feature] — check after [time] (saved to deferred-verifications.md)

Status: VERIFIED / VERIFIED + DEFERRED / BLOCKED
--------------------------------------------------------------------------
```
