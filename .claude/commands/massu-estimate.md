---
name: massu-estimate
description: Effort estimation with complexity scoring, codebase impact analysis, and historical comparison
allowed-tools: Bash(*), Read(*), Grep(*), Glob(*)
---

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9 enforced.

# CS Estimate: Effort Estimation

## Objective

Analyze a feature or change request, score its complexity across multiple dimensions, measure codebase impact, compare against historical work, and produce a structured effort estimate. This is READ-ONLY — no source code is modified.

**Usage**: `/massu-estimate [description of the feature or change]`

---

## NON-NEGOTIABLE RULES

- Do NOT modify any files
- All estimates MUST be based on actual codebase data — no guessing
- FIX ALL ISSUES ENCOUNTERED (CR-9) — if blockers are found during analysis, flag them
- Express uncertainty explicitly — ranges are more honest than point estimates
- Every complexity factor MUST be justified with a concrete codebase observation

---

## STEP 1: REQUIREMENT ANALYSIS

Parse and clarify the request from `$ARGUMENTS`.

### 1a. Identify Change Type

```markdown
### Change Classification

| Dimension | Assessment |
|-----------|-----------|
| Type | [new feature / enhancement / bug fix / refactor / infrastructure] |
| Scope | [MCP tool / website / config / testing / documentation / multi-area] |
| Public API change? | YES/NO — [what changes] |
| Database change? | YES/NO — [what changes] |
| Config change? | YES/NO — [what changes] |
| New dependencies? | YES/NO — [what needed] |
```

### 1b. Decompose into Sub-Tasks

Break the request into concrete deliverables:

```markdown
### Sub-Task Breakdown

| # | Sub-Task | Type |
|---|----------|------|
| 1 | [task] | [implementation/test/config/docs] |
| 2 | [task] | [implementation/test/config/docs] |
| ... | | |
```

---

## STEP 2: CODEBASE IMPACT ANALYSIS

Determine what the change will touch.

### 2a. Files That Will Be Modified

```bash
# Search for related code to the requested feature
grep -rn "$ARGUMENTS" packages/core/src/ --include="*.ts" | head -20
grep -rn "$ARGUMENTS" website/src/ --include="*.ts" --include="*.tsx" | head -20
```

### 2b. Tool Registration Impact (if adding MCP tools)

```bash
# Count existing tools for baseline
grep -c "name:" packages/core/src/tools.ts 2>/dev/null

# Check if tool registration pattern is stable
grep -n "getToolDefinitions\|handleToolCall" packages/core/src/tools.ts | head -10
```

### 2c. Database Schema Impact

```bash
# If changes require schema: check existing tables
grep -rn "CREATE TABLE" website/supabase/migrations/*.sql 2>/dev/null | tail -10
grep -rn "CREATE TABLE\|ALTER TABLE" packages/core/src/memory-db.ts 2>/dev/null | head -10
```

### 2d. Config Impact

```bash
# Current config structure
cat massu.config.yaml 2>/dev/null | head -30

# Config interface
grep -A 30 "interface.*Config\|type.*Config" packages/core/src/config.ts 2>/dev/null | head -40
```

### 2e. Blast Radius Estimate

```bash
# How many files import from core modules that would change
grep -rn "from.*tools\|from.*server\|from.*config" packages/core/src/ --include="*.ts" | wc -l
```

```markdown
### Impact Matrix

| Area | Impact | Files Affected | Notes |
|------|--------|---------------|-------|
| MCP tools | [NONE/LOW/MED/HIGH] | [N] | [details] |
| Website | [NONE/LOW/MED/HIGH] | [N] | [details] |
| Database | [NONE/LOW/MED/HIGH] | [N] | [details] |
| Config | [NONE/LOW/MED/HIGH] | [N] | [details] |
| Tests | [NONE/LOW/MED/HIGH] | [N] | [details] |
| Total affected files | | [N] | |
```

---

## STEP 3: COMPLEXITY SCORING

Score complexity across 6 dimensions. Each dimension is 1-5 (1=trivial, 5=very complex).

### Scoring Rubric

| Score | Definition |
|-------|-----------|
| 1 | Trivial — copy-paste pattern, well-understood domain, no surprises |
| 2 | Simple — small change, existing pattern to follow |
| 3 | Moderate — some novel logic, a few unknowns |
| 4 | Complex — non-trivial logic, cross-cutting concerns, or significant unknowns |
| 5 | Very complex — research required, high risk, many unknowns |

### 3a. Technical Complexity

```bash
# How novel is this relative to existing patterns?
# Read the most similar existing implementation for comparison
ls packages/core/src/*.ts | head -10
```

Score: [1-5] — Justification: [based on similarity to existing patterns]

### 3b. Integration Complexity

```bash
# How many systems does this touch?
# Check all integration points
grep -rn "import.*from" packages/core/src/tools.ts | wc -l
```

Score: [1-5] — Justification: [number of integration points]

### 3c. Testing Complexity

```bash
# Existing test patterns for reference
ls packages/core/src/__tests__/ 2>/dev/null
wc -l packages/core/src/__tests__/*.test.ts 2>/dev/null | sort -rn | head -5
```

Score: [1-5] — Justification: [test scope required]

### 3d. Risk Complexity

```bash
# Are there known blockers or failure modes?
cat .claude/session-state/CURRENT.md 2>/dev/null | grep -i "failed\|blocked\|issue" | head -10
```

Score: [1-5] — Justification: [known risks identified]

### 3e. Documentation Complexity

Score: [1-5] — Justification: [scope of docs required: JSDoc / README / API ref / config schema]

### 3f. Verification Complexity

```bash
# How many VR- gates apply?
# Count applicable: VR-TEST, VR-TYPE, VR-TOOL-REG, VR-HOOK-BUILD, VR-PATTERN, VR-BLAST-RADIUS
```

Score: [1-5] — Justification: [N applicable verification gates]

```markdown
### Complexity Scorecard

| Dimension | Score (1-5) | Weight | Weighted Score | Justification |
|-----------|-------------|--------|----------------|---------------|
| Technical | [N] | 2x | [N] | [reason] |
| Integration | [N] | 1.5x | [N] | [reason] |
| Testing | [N] | 1.5x | [N] | [reason] |
| Risk | [N] | 2x | [N] | [reason] |
| Documentation | [N] | 1x | [N] | [reason] |
| Verification | [N] | 1x | [N] | [reason] |
| **Total weighted score** | | | **[N]/50** | |

**Complexity Tier**: TRIVIAL (≤10) / SMALL (11-20) / MEDIUM (21-30) / LARGE (31-40) / EXTRA LARGE (>40)
```

---

## STEP 4: HISTORICAL COMPARISON

Compare against completed work for calibration.

### 4a. Recent Similar Work

```bash
# Commits of similar type/scope
git log -30 --format="%H %s" 2>/dev/null | grep -i "feat\|add\|implement" | head -15
```

### 4b. Time Proxy: Commit Count

```bash
# How many commits did similar features take?
# Look at feat commits and their diff stats
git log -20 --stat --format="%s" 2>/dev/null | grep -A 5 "^feat"
```

```markdown
### Historical Comparison

| Similar Past Work | Commit Count | Complexity Score | Actual Outcome |
|-------------------|-------------|-----------------|----------------|
| [commit subject] | [N] | [estimated] | [result if known] |
```

---

## STEP 5: ESTIMATE GENERATION

Produce the final estimate.

```markdown
### EFFORT ESTIMATE

**Request**: [description from $ARGUMENTS]
**Complexity Tier**: [TRIVIAL/SMALL/MEDIUM/LARGE/EXTRA LARGE]
**Complexity Score**: [N]/50

### Sub-Task Estimates

| # | Sub-Task | Complexity | Estimate | Notes |
|---|----------|-----------|----------|-------|
| 1 | [task] | [1-5] | [S/M/L] | [key assumption] |
| 2 | [task] | [1-5] | [S/M/L] | [key assumption] |

**S** = Small (< 1 session)  |  **M** = Medium (1-3 sessions)  |  **L** = Large (3+ sessions, consider plan)

### Total Estimate

| Scenario | Reasoning |
|----------|-----------|
| Optimistic | [N] sessions — [if assumptions hold and no blockers] |
| Realistic | [N] sessions — [expected with normal iteration] |
| Pessimistic | [N] sessions — [if integration complexity materializes] |

### Recommendation

**Approach**: [implement directly / create-plan first / spike required]

**Rationale**: [why this approach given the complexity score]

### Key Assumptions

1. [assumption 1 — what must be true for estimate to hold]
2. [assumption 2]
3. [assumption 3]

### Risk Flags

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| [risk] | HIGH/MED/LOW | HIGH/MED/LOW | [mitigation] |
```

---

## COMPLETION REPORT

```markdown
## CS ESTIMATE COMPLETE

### Request Analyzed
- **Feature**: [description]
- **Complexity Tier**: [tier]
- **Weighted Score**: [N]/50

### Estimate Summary
- **Optimistic**: [N] sessions
- **Realistic**: [N] sessions
- **Pessimistic**: [N] sessions

### Files Analyzed
| File | Purpose |
|------|---------|
| [file] | [why read] |

### Suggested Next Step
- Score < 20 (Small): `/massu-hotfix` or direct implementation
- Score 21-30 (Medium): Direct implementation with `/massu-loop`
- Score 31+ (Large): Create plan first with `/massu-create-plan`
```
