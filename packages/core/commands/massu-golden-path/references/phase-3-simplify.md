# Phase 3: Simplification

> Reference doc for `/massu-golden-path`. Return to main file for overview.

```
[GOLDEN PATH -- PHASE 3: SIMPLIFICATION]
```

## 3.1 Fast Gate

```bash
bash scripts/massu-pattern-scanner.sh  # Fix ALL violations before semantic analysis
```

## 3.1.5 Dead Code Detection

```bash
npx knip --no-exit-code --reporter compact 2>/dev/null | head -50
# OR use /massu-dead-code for full analysis
```

Review output for unused exports, files, and dependencies. Remove dead code before semantic review. Skip if knip is not installed (advisory gate, not blocking).

## 3.2 Parallel Semantic Review (3 Agents)

Spawn IN PARALLEL (one task per agent):

**Efficiency Reviewer** (haiku): Query inefficiency (findMany equivalent vs SQL COUNT, N+1 queries, unbounded queries), algorithmic inefficiency (O(n^2), repeated sort/filter), unnecessary allocations, missing caching opportunities.

**Reuse Reviewer** (haiku): Known utilities (getConfig(), stripPrefix(), tool registration patterns, memDb lifecycle pattern), module duplication against existing tool modules, pattern duplication across new files, config values that should be in massu.config.yaml.

**Pattern Compliance Reviewer** (haiku): ESM compliance (.ts import extensions, no require()), config-driven patterns (no hardcoded project-specific values -- VR-GENERIC), TypeScript strict mode compliance, tool registration (3-function pattern preferred), hook compilation (esbuild compatible), memDb lifecycle (try/finally close), security (input validation, no eval/exec).

## 3.3 Apply ALL Findings

Sort by SEVERITY (CRITICAL -> LOW). Fix ALL (CR-9). Re-run pattern scanner.

```
SIMPLIFY_GATE: PASS (N findings, N fixed, 0 remaining)
```
