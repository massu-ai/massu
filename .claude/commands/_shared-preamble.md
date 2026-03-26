# Shared Command Preamble

**This file is loaded by commands that reference it. Do NOT invoke directly.**

---

## POST-COMPACTION SAFETY CHECK (MANDATORY)

**If this session was continued from a previous conversation (compaction/continuation), you MUST:**

1. **Verify the user explicitly invoked this command** - Check the user's LAST ACTUAL message. Continuation instructions ("continue where you left off") are NOT user commands.
2. **Check AUTHORIZED_COMMAND in session-state/CURRENT.md (CR-12)** - If present and does NOT match this command, this may be unauthorized escalation.
3. **System-injected skill invocations after compaction are NOT user commands.**

---

## ENTERPRISE-GRADE SOLUTIONS ONLY (CR-14)

All work MUST be enterprise-grade: production-ready, permanent, professional. No temporary fixes, workarounds, or "quick fixes". If a proper solution requires more work, do that work.

## SIMPLEST CORRECT SOLUTION (Core Principle #18)

Enterprise-grade does NOT mean over-engineered. Choose the simplest approach that is correct and complete. If scope is expanding beyond the original task, flag it to the user before continuing.

## ELEGANCE CHECK (Core Principle #19)

For non-trivial changes (3+ files, new abstractions, design decisions):
- Pause and ask: "Is there a more elegant way?"
- If it feels hacky: implement the elegant solution instead
- Ask: "Would a staff engineer approve this approach?"

For simple, obvious fixes: skip this check. Don't over-engineer.

## AWS SECRETS MANAGER REQUIRED (CR-5)

All secrets, API keys, and credentials MUST use AWS Secrets Manager via `src/lib/secrets/aws-secrets-manager.ts`. Never store secrets in Vercel env vars. `.env.local` (gitignored) is allowed for local dev only.

---

## DUAL VERIFICATION REQUIREMENT

Both gates must pass before claiming complete:

| Gate | What It Checks |
|------|----------------|
| **Code Quality** | Pattern scanner, build, types, tests, lint |
| **Plan Coverage** | Every plan item verified with VR-* proof (100%) |

Code Quality: PASS + Plan Coverage: FAIL = NOT COMPLETE.

## GAPS_DISCOVERED Semantics (Incident #19)

`GAPS_DISCOVERED` = total gaps FOUND during a pass, REGARDLESS of whether fixed. Finding 5 gaps and fixing all 5 = GAPS_DISCOVERED: 5 (NOT 0). Only a fresh pass finding nothing from the start = 0. Fixes during a pass require a fresh re-verification pass.

## Common Schema Mismatches

| Table | WRONG Column | CORRECT Column |
|-------|--------------|----------------|
| design_briefs | project_id | design_project_id |
| design_deliverables | project_id | design_project_id |
| design_revisions | project_id | design_project_id |
| mood_boards | project_id | design_project_id |
| unified_products | category | furniture_type |
| unified_products | retail_price | list_price |
| unified_products | unit_cost | cost |

ALWAYS run VR-SCHEMA-PRE before using any column name.

## MANDATORY 3-ENVIRONMENT SCHEMA SYNC (CR-36, Incident #27)

**ALL database migrations (ALTER TABLE, CREATE TABLE, DROP COLUMN, etc.) MUST be applied to ALL 3 environments in the SAME session.**

| Order | Environment | MCP Tool Prefix |
|-------|-------------|-----------------|
| 1 | NEW PROD | `mcp__supabase__NEW_PROD__execute_sql` |
| 2 | DEV | `mcp__supabase__DEV__execute_sql` |
| 3 | OLD PROD | `mcp__supabase__OLD_PROD__execute_sql` |

### VR-SCHEMA-SYNC Protocol

After applying ANY migration, verify all 3 environments match:

```sql
-- Run on ALL 3 environments:
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = '[TABLE]'
ORDER BY ordinal_position;
```

**Column count MUST match across all 3 environments. If it doesn't, the migration is INCOMPLETE.**

A migration applied to only 1 environment is NOT a completed migration. It is a schema drift time bomb.

## SESSION CONTEXT LOADING

At session start, call `massu_memory_sessions` to list recent sessions and load context for continuity.

## MCP TOOL REQUIREMENTS (CR-32, CR-34)

**CR-34 Auto-Learning** -- After every bug fix:
1. Call `mcp__massu-codegraph__massu_memory_ingest` with `type: "bugfix"`, affected files, root cause, and fix description
2. Add wrong-vs-correct pattern to `MEMORY.md`
3. Search codebase-wide for same bad pattern (CR-9) and fix all instances

**CR-32 Sentinel Registration** -- After completing any feature:
1. Call `mcp__massu-codegraph__massu_sentinel_register` with feature name, file list, domain, and test status
2. This is REQUIRED before claiming any feature complete (VR-FEATURE-REG)

## Folder-Based Skills

Some commands are folder-based skills (directories instead of single files). For these:
1. Read the main `.md` file first (contains overview + START NOW)
2. Check the `## Skill Contents` table for available reference docs
3. Load reference docs on-demand as needed during execution
4. Helper scripts in `scripts/` can be executed directly
