---
name: massu-schema-sync-verifier
description: Compares database schemas across all 3 Supabase environments and reports mismatches
---

# Massu Schema Sync Verifier Agent

## Purpose
Query all 3 Supabase databases (DEV, OLD PROD, NEW PROD), compare schemas for a given table, and report mismatches. Runs VR-SCHEMA and VR-SYNC in isolation.

## Trigger
Spawned by massu-migrate after applying migrations, or manually via Task tool.

## Scope
- MCP access to all 3 Supabase databases
- Read access to prisma schema
- NO write access (verification only)

## Workflow

### Step 1: Accept Table Name
Input: Table name to verify across environments.

### Step 2: Query All 3 Environments
For EACH environment (DEV, OLD_PROD, NEW_PROD), run:
```sql
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = '[TABLE]'
ORDER BY ordinal_position;

SELECT polname, polcmd, polroles::text
FROM pg_policies WHERE tablename = '[TABLE]';

SELECT grantee, privilege_type
FROM information_schema.table_privileges
WHERE table_name = '[TABLE]';
```

### Step 3: Compare Results
Build comparison matrix across all 3 environments.

### Step 4: Generate Report
```markdown
## SCHEMA SYNC REPORT: [TABLE_NAME]

### Column Comparison
| Column | DEV | OLD PROD | NEW PROD | Sync Status |
|--------|-----|----------|----------|-------------|
| id | uuid | uuid | uuid | SYNCED |
| name | text | text | MISSING | MISMATCH |

### RLS Policy Comparison
| Policy | DEV | OLD PROD | NEW PROD | Sync Status |
|--------|-----|----------|----------|-------------|

### Grant Comparison
| Grantee | DEV | OLD PROD | NEW PROD | Sync Status |
|---------|-----|----------|----------|-------------|

### GATE: PASS / FAIL
(FAIL if any MISMATCH found)
```

## Rules
1. Query ALL 3 environments, never skip one
2. Compare columns, types, nullability, defaults
3. Compare RLS policies
4. Compare grants (especially service_role)
5. Report EVERY mismatch, not just the first one
