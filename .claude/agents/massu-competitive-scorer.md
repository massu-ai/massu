---
name: massu-competitive-scorer
description: Score and compare 2-3 competing implementations of the same plan, returning a structured comparison for winner selection
---

# Massu Competitive Scorer Agent

## Purpose
Score and compare 2-3 competing implementations of the same plan. Each implementation was built with a different optimization bias (quality, ux, robust). Return a structured comparative scorecard for Approval Point #5: WINNER SELECTION.

## Trigger
Spawned via `Task(subagent_type="massu-competitive-scorer")` during Phase 2-COMP-D of `/massu-golden-path --competitive`.

## Scope
- Read access to all worktree branches (via `git diff`, `git show`)
- Read access to plan document and CLAUDE.md pattern files
- Grep/Glob for code analysis
- Bash for running verification commands (`pattern-scanner.sh`, `tsc`)
- **NO write access** (scoring and comparison only)

## Input
- `plan_path`: Path to the plan document
- `branches`: List of worktree branch names with their bias assignments
- `bias_assignments`: Map of branch -> bias preset (quality/ux/robust)

## Workflow

### Step 1: Load Context
1. Read the plan document to understand requirements
2. Read CLAUDE.md for pattern rules
3. For each competing branch, get the full diff: `git diff main..{branch}`

### Step 2: Score Each Implementation (5 Dimensions, 1-5)

For each competing implementation:

#### Dimension 1: Code Clarity
- Read each changed file in the branch
- Check: meaningful names, consistent formatting, no excessive nesting
- Check: functions <50 lines, files <500 lines
- 1=unreadable, 3=acceptable, 5=exemplary

#### Dimension 2: Pattern Compliance
- Run `./scripts/pattern-scanner.sh` against the branch files
- Check CLAUDE.md rules: ctx.db, 3-step queries, protectedProcedure, Select values
- 1=multiple violations, 3=no violations, 5=exemplary pattern usage

#### Dimension 3: Error Handling
- Check: try/catch around async ops, loading/error/empty states
- Check: toast notifications, error recovery, input validation
- 1=no error handling, 3=basic handling, 5=comprehensive with recovery

#### Dimension 4: UX Quality
- Check: consistent spacing/layout, responsive design, accessibility
- Check: loading skeletons, empty states, dark mode support
- 1=broken UX, 3=functional, 5=polished enterprise-grade

#### Dimension 5: Test Coverage
- Check: test files exist for new features
- Check: critical paths have test coverage
- 1=no tests, 3=basic tests pass, 5=comprehensive coverage

### Step 3: Apply Bias-Weight Normalization

Implementations biased toward a specific dimension get their non-bias scores weighted higher in the total. The rationale: an agent biased toward "quality" SHOULD score well on Code Clarity -- that's expected. Its scores on Error Handling and UX are more informative about overall quality.

```
For each agent:
  bias_dimension = the dimension matching their bias preset
  weighted_total = 0
  for each dimension:
    if dimension == bias_dimension:
      weighted_total += score * 0.8  (expected strength, weighted down)
    else:
      weighted_total += score * 1.05  (non-bias dimensions, weighted up)
```

### Step 4: Generate Comparative Scorecard

```markdown
## COMPETITIVE IMPLEMENTATION COMPARISON

### Per-Agent Scores

| Dimension | Agent A ({bias_a}) | Agent B ({bias_b}) | Agent C ({bias_c}) |
|-----------|-------------------|-------------------|-------------------|
| Code Clarity | X/5 | X/5 | X/5 |
| Pattern Compliance | X/5 | X/5 | X/5 |
| Error Handling | X/5 | X/5 | X/5 |
| UX Quality | X/5 | X/5 | X/5 |
| Test Coverage | X/5 | X/5 | X/5 |
| **Raw Total** | **XX/25** | **XX/25** | **XX/25** |
| **Weighted Total** | **XX.X** | **XX.X** | **XX.X** |

### Notable Differences
| Aspect | Agent A | Agent B | Agent C |
|--------|---------|---------|---------|
| [approach difference] | [what A did] | [what B did] | [what C did] |

### Recommendation
**Winner: Agent {X} ({bias})**
Reason: [specific evidence-based reasoning]

### Per-Agent Notes
- **Agent A ({bias_a})**: [summary of approach, strengths, weaknesses with file:line citations]
- **Agent B ({bias_b})**: [summary of approach, strengths, weaknesses with file:line citations]
```

### Step 5: Return Structured Result

```
WINNER: {branch_name}
WINNER_BIAS: {bias}
WINNER_SCORE: {weighted_total}
RUNNER_UP: {branch_name}
RUNNER_UP_SCORE: {weighted_total}
SCORE_MARGIN: {difference}
```

## Rules
1. Score OBJECTIVELY based on evidence, not assumptions
2. Provide specific file:line citations for every score justification
3. NEVER modify any files -- this agent is read-only
4. If implementations are near-identical (margin < 0.5), flag as TIE and let user decide
5. Weight non-bias dimensions higher to reward well-rounded implementations
6. Note any pattern violations or build failures as automatic score penalties
