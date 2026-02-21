---
name: massu-benchmark
description: Performance benchmarking — run benchmarks, compare against baselines, detect regressions, and update baselines
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---
name: massu-benchmark

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9, CR-35 enforced.

# CS Benchmark: Performance Benchmarking

## Objective

Run performance benchmarks across MCP tool response time, test suite speed, build time, and hook compilation time. Compare results against stored baselines and flag regressions. Baselines are stored in `.claude/benchmarks/baseline.json`. No source code is modified.

**Usage**: `/massu-benchmark` (run + compare) or `/massu-benchmark update` (run + update baseline) or `/massu-benchmark [area]` (focused: tests, build, hooks, tools)

---

## NON-NEGOTIABLE RULES

- Do NOT modify source code files
- Baselines are stored in `.claude/benchmarks/baseline.json` — this is the only file that may be written
- Run EACH benchmark 3 times and record the median — single runs are unreliable
- A regression is defined as > 20% slower than baseline
- FIX ALL ISSUES ENCOUNTERED (CR-9) — if a regression is caused by a bug, flag it immediately
- NEVER update baseline on a degraded run — only update when all benchmarks pass or improve

---

## STEP 1: BASELINE CHECK

```bash
# Check if baseline exists
if [ -f ".claude/benchmarks/baseline.json" ]; then
  echo "Baseline found:"
  cat .claude/benchmarks/baseline.json
else
  echo "No baseline found — this run will establish the baseline."
fi
```

```markdown
### Baseline Status

| Status | Action |
|--------|--------|
| EXISTS | Compare this run against stored values |
| NOT FOUND | This run establishes the initial baseline |
| STALE (> 30 days) | Warn; baseline may not reflect current hardware |
```

---

## STEP 2: BENCHMARK EXECUTION

Run each benchmark 3 times. Record all 3 values and compute the median.

### 2a. Test Suite Speed

```bash
# Run 3 times, record wall-clock time
echo "=== Test Run 1 ==="
time npm test 2>&1 | tail -5

echo "=== Test Run 2 ==="
time npm test 2>&1 | tail -5

echo "=== Test Run 3 ==="
time npm test 2>&1 | tail -5
```

Record:
```markdown
### Test Suite Speed

| Run | Wall Time (s) | Tests Passed |
|-----|-------------|-------------|
| 1 | [T] | [N] |
| 2 | [T] | [N] |
| 3 | [T] | [N] |
| **Median** | **[T]** | **[N]** |
```

### 2b. TypeScript Build Time

```bash
echo "=== TS Check Run 1 ==="
time (cd packages/core && npx tsc --noEmit) 2>&1

echo "=== TS Check Run 2 ==="
time (cd packages/core && npx tsc --noEmit) 2>&1

echo "=== TS Check Run 3 ==="
time (cd packages/core && npx tsc --noEmit) 2>&1
```

Record:
```markdown
### TypeScript Build Time

| Run | Wall Time (s) | Errors |
|-----|-------------|--------|
| 1 | [T] | [N] |
| 2 | [T] | [N] |
| 3 | [T] | [N] |
| **Median** | **[T]** | **[N]** |
```

### 2c. Hook Compilation Time

```bash
echo "=== Hook Build Run 1 ==="
time (cd packages/core && npm run build:hooks) 2>&1

echo "=== Hook Build Run 2 ==="
time (cd packages/core && npm run build:hooks) 2>&1

echo "=== Hook Build Run 3 ==="
time (cd packages/core && npm run build:hooks) 2>&1
```

Record:
```markdown
### Hook Compilation Time

| Run | Wall Time (s) | Hooks Compiled |
|-----|-------------|----------------|
| 1 | [T] | [N] |
| 2 | [T] | [N] |
| 3 | [T] | [N] |
| **Median** | **[T]** | **[N]** |
```

### 2d. Pattern Scanner Speed

```bash
echo "=== Pattern Scanner Run 1 ==="
time bash scripts/massu-pattern-scanner.sh 2>&1

echo "=== Pattern Scanner Run 2 ==="
time bash scripts/massu-pattern-scanner.sh 2>&1

echo "=== Pattern Scanner Run 3 ==="
time bash scripts/massu-pattern-scanner.sh 2>&1
```

Record:
```markdown
### Pattern Scanner Speed

| Run | Wall Time (s) | Exit Code |
|-----|-------------|-----------|
| 1 | [T] | [0/1] |
| 2 | [T] | [0/1] |
| 3 | [T] | [0/1] |
| **Median** | **[T]** | **[0]** |
```

### 2e. Code Metrics (Static)

```bash
# Source line count — a proxy for growing build complexity
find packages/core/src -name "*.ts" -not -path "*/__tests__/*" | xargs wc -l 2>/dev/null | tail -1

# Test count
npm test 2>&1 | grep -E "Tests|passed|failed" | tail -3

# Hook count
ls packages/core/src/hooks/*.ts 2>/dev/null | wc -l
ls packages/core/dist/hooks/*.js 2>/dev/null | wc -l

# Tool count
grep -c "name:" packages/core/src/tools.ts 2>/dev/null
```

```markdown
### Code Metrics

| Metric | Current | Baseline | Delta |
|--------|---------|----------|-------|
| Source LOC | [N] | [N] | [+/-N] |
| Test count | [N] | [N] | [+/-N] |
| Tool count | [N] | [N] | [+/-N] |
| Hook count | [N] | [N] | [+/-N] |
```

---

## STEP 3: COMPARISON

Compare each benchmark median against the stored baseline.

### Regression Threshold

| Delta | Classification |
|-------|---------------|
| < -20% (faster) | IMPROVEMENT |
| -20% to +10% | STABLE |
| +10% to +20% | WARNING |
| > +20% (slower) | REGRESSION |

```markdown
### Benchmark Comparison

| Benchmark | Baseline (s) | Current (s) | Delta (%) | Status |
|-----------|-------------|-------------|-----------|--------|
| Test Suite | [T] | [T] | [±N%] | IMPROVEMENT/STABLE/WARNING/REGRESSION |
| TS Build | [T] | [T] | [±N%] | IMPROVEMENT/STABLE/WARNING/REGRESSION |
| Hook Build | [T] | [T] | [±N%] | IMPROVEMENT/STABLE/WARNING/REGRESSION |
| Pattern Scanner | [T] | [T] | [±N%] | IMPROVEMENT/STABLE/WARNING/REGRESSION |
```

---

## STEP 4: REGRESSION DETECTION

For every REGRESSION found:

### 4a. Investigate the Cause

```bash
# What changed recently that could affect this benchmark?
git log -10 --oneline --stat 2>/dev/null | grep -E "packages/core|scripts|hooks"

# For test regression: any new slow tests?
npm test -- --reporter=verbose 2>&1 | grep -E "ms|slow" | sort -t'(' -k2 -rn | head -10

# For build regression: any new imports that are heavy?
grep -c "^import" packages/core/src/*.ts 2>/dev/null | sort -t: -k2 -rn | head -10

# For hook regression: hook file sizes
ls -lh packages/core/dist/hooks/*.js 2>/dev/null
```

### 4b. Regression Report

```markdown
### Regression Analysis

| Benchmark | Delta | Likely Cause | Commit Range | CR-9 Flag? |
|-----------|-------|-------------|-------------|------------|
| [benchmark] | [+N%] | [cause] | [commits] | YES/NO |
```

**If CR-9 flag is YES:** The regression is caused by a defect that MUST be fixed immediately. Document in session state.

---

## STEP 5: BASELINE UPDATE

Only update baseline if `$ARGUMENTS` contains `update` AND there are no REGRESSION findings.

```
IF arguments == "update":
  IF any benchmark is REGRESSION:
    OUTPUT: "BASELINE UPDATE REFUSED: [N] regression(s) detected. Fix regressions before updating baseline."
    EXIT without writing
  ELSE:
    Write new baseline JSON
    OUTPUT: "Baseline updated successfully."
```

### Write Baseline

```bash
mkdir -p .claude/benchmarks
```

Write `.claude/benchmarks/baseline.json`:

```json
{
  "updated": "[ISO date]",
  "git_sha": "[git rev-parse --short HEAD]",
  "benchmarks": {
    "test_suite_seconds": [median value],
    "ts_build_seconds": [median value],
    "hook_build_seconds": [median value],
    "pattern_scanner_seconds": [median value]
  },
  "metrics": {
    "source_loc": [N],
    "test_count": [N],
    "tool_count": [N],
    "hook_count": [N]
  }
}
```

---

## COMPLETION REPORT

```markdown
## CS BENCHMARK COMPLETE

### Run Summary
- **Mode**: [compare / update baseline / focused: area]
- **Benchmarks run**: [N]
- **Runs per benchmark**: 3 (median reported)
- **Git SHA**: [hash]

### Results

| Benchmark | Median (s) | Baseline (s) | Delta | Status |
|-----------|-----------|-------------|-------|--------|
| Test Suite | [T] | [T] | [±N%] | [status] |
| TS Build | [T] | [T] | [±N%] | [status] |
| Hook Build | [T] | [T] | [±N%] | [status] |
| Pattern Scanner | [T] | [T] | [±N%] | [status] |

### Overall: IMPROVED / STABLE / DEGRADED

- **IMPROVED**: At least one benchmark improved, none regressed
- **STABLE**: All benchmarks within -20% to +10% of baseline
- **DEGRADED**: One or more benchmarks > +20% slower than baseline

### Regressions Found: [N]

| Benchmark | Delta | Likely Cause | Action Required |
|-----------|-------|-------------|-----------------|
| [benchmark] | [+N%] | [cause] | [fix / investigate] |

### Baseline
- **Status**: [COMPARED / UPDATED / NOT UPDATED (regressions)]
- **Baseline date**: [date]
- **Baseline SHA**: [hash]

### Next Steps
- Regressions: Investigate with `/massu-perf` for detailed analysis
- To update baseline after fixing regressions: `/massu-benchmark update`
```
