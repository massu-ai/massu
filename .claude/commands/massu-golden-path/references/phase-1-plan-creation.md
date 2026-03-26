# Phase 1: Plan Creation & Audit

> Reference doc for `/massu-golden-path`. Return to main file for overview.

## Phase 1A: Research & Reality Check

```
[GOLDEN PATH -- PHASE 1A: RESEARCH & REALITY CHECK]
```

**If plan file was provided**: Skip to Phase 1C.

### 1A.1 Feature Understanding

- Call `massu_knowledge_search`, `massu_knowledge_pattern`, `massu_knowledge_schema_check` with feature name
- Document: exact user request, feature type, affected domains
- Search codebase for similar features, routers, pages

### 1A.2 Database Reality Check (VR-SCHEMA-PRE)

For EACH table the feature might use, query via MCP:

```sql
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns WHERE table_name = '[TABLE]' ORDER BY ordinal_position;

SELECT polname, polcmd FROM pg_policies WHERE tablename = '[TABLE]';

SELECT grantee, privilege_type FROM information_schema.table_privileges WHERE table_name = '[TABLE]';
```

Run `./scripts/check-bad-columns.sh`. Call `massu_schema` for Prisma cross-reference.
Document: existing tables, required new tables/columns, migration SQL previews.

### 1A.3 Config-Code Alignment (VR-DATA)

If feature uses DB-stored configs:

```sql
SELECT DISTINCT jsonb_object_keys(config_column) as keys FROM config_table;
```

Compare to code: `grep -rn "config\." src/lib/[feature]/ | grep -oP 'config\.\w+' | sort -u`

### 1A.4 Codebase Reality Check

- Verify target directories/files exist
- Read similar routers and components
- Load relevant pattern files (database/auth/ui/realtime/build)

### 1A.5 Blast Radius Analysis (CR-25)

**MANDATORY when plan changes any constant, path, route, enum, or config key.**

1. Identify ALL changed values (old -> new)
2. Codebase-wide grep for EACH value
3. Call `massu_impact` for indirect impact through import chains
4. If plan deletes files: call `massu_sentinel_impact` -- zero orphaned features allowed
5. Categorize EVERY occurrence: CHANGE / KEEP (with reason) / INVESTIGATE
6. Resolve ALL INVESTIGATE to 0. Add ALL CHANGE items as plan deliverables.

### 1A.6 Pattern Compliance Check

Check applicable patterns: ctx.db, user_profiles, 3-step query, BigInt/Decimal, RLS+Grants, Suspense, Select.Item, protectedProcedure, Zod validation. Read most similar router/component for patterns used.

### 1A.7 Backend-Frontend Coupling Check (CR-12)

For EVERY backend z.enum, type, or procedure planned -- verify a corresponding frontend item exists. If NOT, ADD IT.

### 1A.8 Question Filtering

1. List all open questions
2. Self-answer anything answerable by reading code or querying DB
3. Surface only business logic / UX / scope / priority questions to user via AskUserQuestion
4. If all self-answerable, skip user prompt

### 1A.9 Security Pre-Screen (6 Dimensions)

| Dim | Check | If Triggered |
|-----|-------|-------------|
| S1 | PII / Sensitive Data | Add RLS + column-level access |
| S2 | Authentication | Verify protectedProcedure |
| S3 | Authorization | Add RBAC checks, RLS policies |
| S4 | Injection Surfaces | Add Zod validation, parameterized queries |
| S5 | Secrets Management (CR-5) | Add AWS Secrets Manager items |
| S6 | Rate Limiting | Add rate limiting middleware |

**BLOCKS_REMAINING must = 0 before proceeding.**

### 1A.10 ADR Generation (Optional)

For architectural decisions: `massu_adr_list` -> `massu_adr_generate`.

Mark all coverage dimensions as `done` or `n/a`.

---

## Phase 1B: Plan Generation

```
[GOLDEN PATH -- PHASE 1B: PLAN GENERATION]
```

Write plan to: `plans/[YYYY-MM-DD]-[feature-name].md`

**Plan structure** (P-XXX numbered items):
- Overview (feature, complexity, domains, item count)
- Requirements Coverage Map (D1-D10 all resolved)
- Phase 0: Credentials & Secrets (CR-5)
- Phase 1: Database Changes (migrations with exact SQL)
- Phase 2: Backend Implementation (routers, procedures, input schemas)
- Phase 3: Frontend Implementation (components, pages, renders-in)
- Phase 4: Testing & Verification
- Phase 5: Documentation (help site pages, changelog)
- Verification Commands table
- Item Summary table
- Risk Assessment
- Dependencies

**Item numbering**: P0-XXX (secrets), P1-XXX (database), P2-XXX (backend), P3-XXX (frontend), P4-XXX (testing), P5-XXX (docs).

**Implementation Specificity Check**: Every item MUST have exact file path, exact content/SQL, insertion point, format matches target, verification command.

**Documentation Impact Assessment**: If ANY user-facing features, Phase 5 deliverables are MANDATORY.

---

## Phase 1C: Plan Audit Loop

```
[GOLDEN PATH -- PHASE 1C: PLAN AUDIT LOOP]
```

Run audit loop using subagent architecture (prevents early termination):

```
iteration = 0
WHILE true:
  iteration += 1

  result = Task(subagent_type="massu-plan-auditor", model="opus", prompt="
    Audit iteration {iteration} for plan: {PLAN_PATH}
    Execute ONE complete audit pass. Verify ALL deliverables.
    Check: VR-PLAN-FEASIBILITY, VR-PLAN-SPECIFICITY, Pattern Alignment, Schema Reality.
    Fix any plan document gaps you find.

    CRITICAL: Report GAPS_DISCOVERED as total gaps FOUND, EVEN IF you fixed them.
    Finding N gaps and fixing all N = GAPS_DISCOVERED: N.
    A clean pass finding nothing = GAPS_DISCOVERED: 0.
  ")

  gaps = parse GAPS_DISCOVERED from result
  IF gaps == 0: BREAK (clean pass)
  ELSE: CONTINUE (re-audit)

  IF iteration >= 10: Report to user, ask how to proceed
END WHILE
```

**VR-PLAN-FEASIBILITY**: DB schema exists, files exist, dependencies available, patterns documented, credentials planned.
**VR-PLAN-SPECIFICITY**: Every item has exact path, exact content, insertion point, verification command.
**Pattern Alignment**: Cross-reference ALL applicable patterns from CLAUDE.md and patterns/*.md.

---

## Phase 1 Complete -> APPROVAL POINT #1: PLAN

See `approval-points.md` for the exact format.
