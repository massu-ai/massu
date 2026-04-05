# Phase 1: Plan Creation & Audit

> Reference doc for `/massu-golden-path`. Return to main file for overview.

## Phase 1A: Research & Reality Check

```
[GOLDEN PATH -- PHASE 1A: RESEARCH & REALITY CHECK]
```

**If plan file was provided**: Skip to Phase 1C.

### 1A.1 Feature Understanding

- Document: exact user request, feature type, affected domains
- Search codebase for similar features, tool modules, existing patterns
- Read `massu.config.yaml` for relevant config sections

### 1A.2 Config & Schema Reality Check

For features touching config or databases:

- Parse `massu.config.yaml` and verify all referenced config keys exist
- Check SQLite schema for affected tables (`getCodeGraphDb`, `getDataDb`, `getMemoryDb`)
- Verify tool definitions in `tools.ts` for any tools being modified

Document: existing config keys, required new keys, required schema changes.

### 1A.3 Config-Code Alignment (VR-CONFIG)

If feature uses config-driven values:

```bash
# Check config keys used in code
grep -rn "getConfig()" packages/core/src/ | grep -o 'config\.\w\+' | sort -u
# Compare to massu.config.yaml structure
```

### 1A.4 Codebase Reality Check

- Verify target directories/files exist
- Read similar tool modules and handlers
- Load relevant pattern files (build/testing/security/database/mcp)

### 1A.5 Blast Radius Analysis (CR-25)

**MANDATORY when plan changes any constant, export name, config key, or tool name.**

1. Identify ALL changed values (old -> new)
2. Codebase-wide grep for EACH value
3. If plan deletes files: verify no remaining imports or references
4. Categorize EVERY occurrence: CHANGE / KEEP (with reason) / INVESTIGATE
5. Resolve ALL INVESTIGATE to 0. Add ALL CHANGE items as plan deliverables.

### 1A.6 Pattern Compliance Check

Check applicable patterns: ESM imports (.ts extensions), config access (getConfig()), tool registration (3-function pattern), hook compilation (esbuild), SQLite DB access (getCodeGraphDb/getDataDb/getMemoryDb), memDb lifecycle (try/finally close).

Read most similar tool module for patterns used.

### 1A.7 Tool Registration Check

For EVERY new MCP tool planned -- verify a corresponding registration item exists in the plan (definitions + routing + handler in `tools.ts`). If NOT, ADD IT.

### 1A.8 Question Filtering

1. List all open questions
2. Self-answer anything answerable by reading code or config
3. Surface only business logic / UX / scope / priority questions to user via AskUserQuestion
4. If all self-answerable, skip user prompt

### 1A.9 Security Pre-Screen (5 Dimensions)

| Dim | Check | If Triggered |
|-----|-------|-------------|
| S1 | PII / Sensitive Data | Add access controls |
| S2 | Authentication | Verify auth checks |
| S3 | Authorization | Add permission checks |
| S4 | Injection Surfaces | Add input validation, parameterized queries |
| S5 | Rate Limiting | Add rate limiting considerations |

**BLOCKS_REMAINING must = 0 before proceeding.**

Mark all coverage dimensions as `done` or `n/a`.

---

## Phase 1B: Plan Generation

```
[GOLDEN PATH -- PHASE 1B: PLAN GENERATION]
```

Write plan to: `docs/plans/[YYYY-MM-DD]-[feature-name].md`

**Plan structure** (P-XXX numbered items):
- Overview (feature, complexity, domains, item count)
- Requirements Coverage Map (D1-D10 all resolved)
- Phase 1: Configuration Changes (massu.config.yaml)
- Phase 2: Backend Implementation (tool modules, handlers, SQLite schema)
- Phase 3: Frontend/Hook Implementation (hooks, plugin code)
- Phase 4: Testing & Verification
- Phase 5: Documentation
- Verification Commands table
- Item Summary table
- Risk Assessment
- Dependencies

**Item numbering**: P1-XXX (config), P2-XXX (backend), P3-XXX (frontend/hooks), P4-XXX (testing), P5-XXX (docs).

**Implementation Specificity Check**: Every item MUST have exact file path, exact content, insertion point, format matches target, verification command.

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
    Check: VR-PLAN-FEASIBILITY, VR-PLAN-SPECIFICITY, Pattern Alignment, Config Reality.
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

**VR-PLAN-FEASIBILITY**: Files exist, config keys valid, dependencies available, patterns documented.
**VR-PLAN-SPECIFICITY**: Every item has exact path, exact content, insertion point, verification command.
**Pattern Alignment**: Cross-reference ALL applicable patterns from CLAUDE.md and patterns/*.md.

---

## Phase 1 Complete -> APPROVAL POINT #1: PLAN

See `approval-points.md` for the exact format.
