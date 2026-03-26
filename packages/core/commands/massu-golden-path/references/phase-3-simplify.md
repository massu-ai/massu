# Phase 3: Simplification

> Reference doc for `/massu-golden-path`. Return to main file for overview.

```
[GOLDEN PATH -- PHASE 3: SIMPLIFICATION]
```

## 3.1 Fast Gate

```bash
./scripts/pattern-scanner.sh  # Fix ALL violations before semantic analysis
```

## 3.1.5 Dead Code Detection

```bash
npx knip --no-exit-code --reporter compact 2>/dev/null | head -50
# OR use /massu-dead-code for full analysis
```

Review output for unused exports, files, and dependencies. Remove dead code before semantic review. Skip if knip is not installed (advisory gate, not blocking).

## 3.2 Parallel Semantic Review (3 Agents)

Spawn IN PARALLEL (Principle #20 -- one task per agent):

**Efficiency Reviewer** (haiku): Query inefficiency (findMany.length -> SQL COUNT, N+1, unbounded queries), React inefficiency (useState for derived, useEffect->setState, missing useMemo/useCallback), algorithmic inefficiency (O(n^2), repeated sort/filter).

**Reuse Reviewer** (haiku): Known utilities (formatFileSize, serializeUnifiedProduct, mergeWhereWithTenant, emptyToNull, PhoneInputField, sanitizeContentHtml), component duplication against src/components/shared/ and ui/, pattern duplication across new files.

**Pattern Compliance Reviewer** (haiku): React Query v5 (no onSuccess in useQuery), DB patterns (Object.assign->mergeWhereWithTenant, include:->3-step, BigInt Number()), UI patterns (Select value="", missing states, Suspense), security (z.string()->z.enum() for orderBy, CR-5 precedence, CRON_SECRET guard), architecture (link table scoping, SQL aggregates, client/server boundary).

## 3.3 Apply ALL Findings

Sort by SEVERITY (CRITICAL -> LOW). Fix ALL (CR-9). Re-run pattern scanner.

```
SIMPLIFY_GATE: PASS (N findings, N fixed, 0 remaining)
```
