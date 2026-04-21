---
name: massu-production-verify
description: "When user says 'verify production', 'is it working', 'production check', or after a deploy to verify features are actually working in production — not just deployed"
allowed-tools: Bash(*), Read(*), Grep(*), Glob(*), mcp__supabase__NEW_PROD__*, mcp__supabase__DEV__*, mcp__plugin_playwright_playwright__*, mcp__claude_ai_Vercel__get_deployment, mcp__claude_ai_Vercel__get_runtime_logs, mcp__claude_ai_Vercel__list_deployments, mcp__claude_ai_Vercel__web_fetch_vercel_url
---
name: massu-production-verify

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-14, CR-5, CR-12 enforced.

# Massu Production Verify: Confirm Features Work in Production

## Core Principle

**"Deployed" is NOT "Working." A feature is only complete when real users can use it in production and it produces real results.**

Code existing, builds passing, and deploys succeeding prove NOTHING about whether the feature actually works for users. This command verifies operational correctness — the last mile that all other verification misses.

---

## NON-NEGOTIABLE RULES

- **Proof from production, not dev** — queries must hit NEW PROD database, URLs must hit production deployment
- **Data, not structure** — verifying a table exists is NOT the same as verifying data flows through it
- **End-to-end, not component** — verify the full chain: trigger -> process -> store -> display
- **Every feature, every deploy** — no exceptions for "simple" changes
- **Deferred items tracked** — async verifications get a checklist with deadlines, picked up by `/massu-bearings`

---

## INPUT MODES

| Mode | Input | Behavior |
|------|-------|----------|
| **Auto-detect** | `/massu-production-verify` | Reads recent commits + plan to determine what to verify |
| **Specific feature** | `/massu-production-verify "calendar sync"` | Verify specific feature |
| **From plan** | `/massu-production-verify /path/to/plan.md` | Verify all items from a plan |
| **Deferred check** | `/massu-production-verify --deferred` | Re-check pending deferred verifications only |

---

## PHASE 1: DETERMINE WHAT TO VERIFY

### 1.1 Identify Recent Changes

```bash
# What was just deployed?
git log origin/main~5..origin/main --oneline --no-merges
git diff origin/main~5..origin/main --stat
```

### 1.2 Categorize Changes

For each changed file/feature, categorize the verification type:

| Change Type | Verification Method | Timing |
|------------|--------------------| -------|
| **UI page/component** | Playwright: navigate, snapshot, interact | Immediate |
| **API endpoint** | HTTP request to production URL | Immediate |
| **Database schema** | Query NEW PROD for table/column existence + sample data | Immediate |
| **tRPC procedure** | Verify via API or UI that calls it | Immediate |
| **Cron job** | Query DB for evidence of cron execution | Deferred (wait for next cycle) |
| **Webhook handler** | Trigger event, verify handler processed it | Deferred (trigger + wait) |
| **External API integration** | Verify data from external source appears in DB | Deferred (wait for sync) |
| **Email/notification** | Verify delivery log or recipient confirmation | Deferred (wait for send) |
| **Background job** | Verify queue processed and results stored | Deferred (wait for processing) |
| **Feature flag** | Verify flag exists AND feature behaves differently when toggled | Immediate |
| **Environment variable** | Verify var exists on Vercel AND code reads it | Immediate |

### 1.3 Build Verification Matrix

```markdown
## Production Verification Matrix

| # | Feature/Change | Type | Method | Timing | Status |
|---|----------------|------|--------|--------|--------|
| PV-001 | [description] | UI | Playwright snapshot | Immediate | PENDING |
| PV-002 | [description] | Cron | DB query for last_run | Deferred (15min) | PENDING |
| PV-003 | [description] | API | HTTP GET /api/... | Immediate | PENDING |
```

---

## PHASE 2: IMMEDIATE VERIFICATIONS

Run all immediate verifications now. Each must produce PROOF.

### 2.1 Deployment Health

```bash
# Verify deployment is live
# Use Vercel MCP to check deployment status
```

Check via Vercel MCP tools:
- `list_deployments` — confirm latest deployment is READY
- `get_runtime_logs` — check for startup errors or crashes
- `web_fetch_vercel_url` — hit the production URL and verify 200 response

### 2.2 UI Verification (Playwright)

For each UI change, use Playwright MCP:

```
1. browser_navigate to production URL
2. browser_snapshot — verify page renders without errors
3. browser_console_messages — check for JS errors
4. browser_click / browser_fill_form — test interactive elements
5. browser_snapshot — verify result of interaction
```

**Verification criteria:**
- Page loads without errors
- Key UI elements are visible (not just existing in DOM)
- Interactive elements respond to user actions
- Data displays correctly (not empty, not placeholder, not "undefined")

### 2.3 API/Endpoint Verification

For each API endpoint or tRPC procedure:

```bash
# Direct API test (if public endpoint)
curl -s -o /dev/null -w "%{http_code}" https://[production-url]/api/[endpoint]
# Expected: 200

# For tRPC procedures: verify via UI that calls them
# Navigate to the page that uses the procedure, verify data loads
```

### 2.4 Database Verification

Query NEW PROD to verify data exists and flows correctly:

```sql
-- Verify table has recent data (not just that it exists)
SELECT COUNT(*), MAX(created_at), MIN(created_at)
FROM [table_name]
WHERE created_at > NOW() - INTERVAL '24 hours';

-- Verify specific feature data
-- Example: calendar sync should have recent events
SELECT COUNT(*) FROM calendar_events
WHERE synced_at > NOW() - INTERVAL '1 hour';

-- Verify cron execution log
SELECT * FROM cron_execution_log
WHERE job_name = '[cron_name]'
ORDER BY executed_at DESC LIMIT 3;
```

### 2.5 Environment & Config Verification

```bash
# Verify feature flags are set correctly on production
# Query the feature_flags table on NEW PROD
```

```sql
-- Feature flags
SELECT key, enabled, description
FROM feature_flags
WHERE key IN ('[relevant_flags]');

-- Verify config values match what code expects (VR-DATA)
SELECT id, [config_column]
FROM [config_table]
WHERE [relevant_filter]
LIMIT 5;
```

### 2.6 Integration Chain Verification

For features involving multiple systems, verify the FULL chain:

```markdown
### Integration Chain: [Feature Name]

| Step | System | Verification | Proof | Status |
|------|--------|-------------|-------|--------|
| 1 | Trigger | [how triggered] | [proof] | PASS/FAIL |
| 2 | Process | [how processed] | [proof] | PASS/FAIL |
| 3 | Store | [where stored] | [proof] | PASS/FAIL |
| 4 | Display | [where displayed] | [proof] | PASS/FAIL |
```

---

## PHASE 3: DEFERRED VERIFICATIONS

For items that can't be verified immediately (crons, webhooks, async jobs):

### 3.1 Generate Deferred Checklist

Write to `session-state/deferred-verifications.md`:

```markdown
# Deferred Production Verifications

**Generated**: [YYYY-MM-DD HH:MM PST]
**Deploy Commit**: [hash]
**Feature**: [name]

## Pending Verifications

### DV-001: [Description]
- **Type**: Cron / Webhook / External API / Background Job
- **Expected By**: [YYYY-MM-DD HH:MM PST] (e.g., next cron cycle)
- **Verification Query**:
  ```sql
  SELECT COUNT(*) FROM [table]
  WHERE [condition] AND created_at > '[deploy_timestamp]';
  ```
- **Expected Result**: Count > 0 (or specific condition)
- **Status**: PENDING
- **Checked**: (not yet)

### DV-002: [Description]
...

## Verification History

| # | Description | Expected By | Checked At | Result | Status |
|---|-------------|-------------|------------|--------|--------|
```

### 3.2 Set Expectations

For each deferred item, calculate when it should be verifiable:

| Trigger Type | Typical Wait Time | Check After |
|-------------|-------------------|-------------|
| Cron (every 15 min) | 15-20 minutes | Next cron cycle + buffer |
| Cron (hourly) | 1-2 hours | Next scheduled run |
| Cron (daily) | Up to 24 hours | Next scheduled run |
| Webhook | Minutes (after trigger) | Trigger + 5 min |
| External API sync | Varies (check sync interval) | Next sync cycle |
| Email delivery | 1-5 minutes | Send + 5 min |
| Background job | Varies (check queue config) | Submit + processing time |

---

## PHASE 4: RESULTS & REPORT

### 4.1 Production Verification Report

```
===============================================================================
PRODUCTION VERIFICATION REPORT
===============================================================================

Deploy: [commit hash] — [commit message]
Verified: [YYYY-MM-DD HH:MM PST]

IMMEDIATE VERIFICATIONS:
--------------------------------------------------------------------------
| # | Feature | Method | Result | Proof |
|---|---------|--------|--------|-------|
| PV-001 | [desc] | Playwright | PASS | Page loads, data visible |
| PV-002 | [desc] | DB Query | PASS | 47 rows, latest 2min ago |
| PV-003 | [desc] | API Call | PASS | 200 OK, valid response |
--------------------------------------------------------------------------
Immediate: [X]/[Y] PASSED

DEFERRED VERIFICATIONS:
--------------------------------------------------------------------------
| # | Feature | Type | Check After | Status |
|---|---------|------|-------------|--------|
| DV-001 | [desc] | Cron (15min) | [time] | PENDING |
| DV-002 | [desc] | Webhook | [time] | PENDING |
--------------------------------------------------------------------------
Deferred: [N] items pending (saved to session-state/deferred-verifications.md)

OVERALL STATUS: [VERIFIED / PARTIALLY VERIFIED / FAILED]
- Immediate checks: [X]/[Y] PASSED
- Deferred checks: [N] PENDING (will be surfaced in /massu-bearings)
===============================================================================
```

### 4.2 Status Definitions

| Status | Meaning |
|--------|---------|
| **VERIFIED** | All immediate checks PASS, no deferred items |
| **VERIFIED + DEFERRED** | All immediate checks PASS, deferred items pending |
| **PARTIALLY VERIFIED** | Some immediate checks PASS, others FAIL or pending |
| **FAILED** | Any immediate check FAILED |

### 4.3 Update Plan Status (if from plan)

If verifying a plan, update the plan document:

```markdown
# PRODUCTION VERIFICATION

**Status**: VERIFIED / VERIFIED + DEFERRED / FAILED
**Verified At**: [timestamp]
**Deploy Commit**: [hash]

| # | Feature | Production Status | Proof |
|---|---------|-------------------|-------|
| 1 | [feature] | WORKING | [query result] |
| 2 | [feature] | PENDING (cron) | Check after [time] |
```

---

## PHASE 5: FOLLOW-UP

### 5.1 If ANY Immediate Check Fails

1. Diagnose the failure
2. Fix the root cause
3. Commit and push the fix
4. Re-run production verification
5. Do NOT mark feature as complete until production verification passes

### 5.2 Deferred Item Follow-Up

Deferred items are picked up by `/massu-bearings` in the next session:
- Bearings reads `session-state/deferred-verifications.md`
- Surfaces pending items with their verification queries
- User can run `/massu-production-verify --deferred` to check them

When checking deferred items:
1. Run each verification query
2. Update status in `deferred-verifications.md`
3. If PASS: mark VERIFIED with timestamp
4. If FAIL: investigate, fix, and re-verify
5. When ALL items verified: update plan status to COMPLETE -- PRODUCTION VERIFIED

---

## COMMON VERIFICATION PATTERNS

### Cron Job Verification

```sql
-- 1. Check if cron ran since deploy
SELECT job_name, last_run, status
FROM cron_execution_log
WHERE job_name = '[name]'
AND last_run > '[deploy_timestamp]';

-- 2. Check if cron produced data
SELECT COUNT(*) FROM [target_table]
WHERE created_at > '[deploy_timestamp]';

-- 3. Check Vercel cron logs
-- Use get_runtime_logs MCP tool filtered to cron route
```

### Gmail/Calendar Sync Verification

```sql
-- Check sync status per user
SELECT u.email, gs.last_sync_at, gs.status, gs.error_message
FROM gmail_sync_status gs
JOIN user_profiles u ON u.id = gs.user_id
ORDER BY gs.last_sync_at DESC;

-- Check if new emails were synced
SELECT COUNT(*) FROM gmail_messages
WHERE synced_at > '[deploy_timestamp]';

-- Check calendar events
SELECT COUNT(*) FROM calendar_events
WHERE synced_at > '[deploy_timestamp]';
```

### Webhook Verification

```sql
-- Check webhook delivery log
SELECT webhook_type, status, created_at, error_message
FROM webhook_delivery_log
WHERE created_at > '[deploy_timestamp]'
ORDER BY created_at DESC LIMIT 10;
```

### Feature Flag Verification

```sql
-- Verify flag state
SELECT key, enabled, metadata
FROM feature_flags
WHERE key = '[flag_name]';
```

Then use Playwright to:
1. Navigate to the feature page
2. Verify behavior matches flag state (enabled = visible, disabled = hidden)

---

## QUALITY SCORING (silent)

After verification completes, append one JSONL line to `.claude/metrics/command-scores.jsonl`:

| Check | Pass condition |
|-------|---------------|
| `deployment_verified` | Production deployment is READY |
| `immediate_checks_passed` | All immediate PV-* items PASS |
| `deferred_items_tracked` | All deferred items saved with queries + deadlines |
| `db_data_verified` | At least one production DB query confirmed real data |
| `full_chain_verified` | At least one end-to-end chain verified |

```json
{"command":"massu-production-verify","timestamp":"ISO8601","scores":{"deployment_verified":true,"immediate_checks_passed":true,"deferred_items_tracked":true,"db_data_verified":true,"full_chain_verified":true},"pass_rate":"5/5","input_summary":"[feature]"}
```

---

## GOTCHAS

- **Never verify against DEV** — production verification means NEW PROD database and production URL
- **Don't confuse schema with data** — a table existing is meaningless if no data flows through it
- **Cron timing** — crons run on Vercel's schedule, not instantly. Check `vercel.json` for the schedule
- **Auth-gated pages** — some pages require login. Use Playwright to handle auth flow or verify via API
- **Rate limits** — don't hammer production endpoints. One verification request per endpoint is enough
- **Read-only on production** — NEVER write/modify production data during verification. Query only.
- **Time zones** — all timestamps in PST (user's timezone). Database may store UTC — convert in queries.

---

## START NOW

1. **Determine scope**: Auto-detect from git log, or use provided feature/plan
2. **Build verification matrix**: Categorize all changes into immediate/deferred
3. **Run immediate verifications**: Playwright, DB queries, API checks
4. **Generate deferred checklist**: Save to `session-state/deferred-verifications.md`
5. **Produce report**: Show all results with proof
6. **Update plan status**: If verifying plan work
7. **Surface failures**: If anything fails, diagnose and fix immediately
