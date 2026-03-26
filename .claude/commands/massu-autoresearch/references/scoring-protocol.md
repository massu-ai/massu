# Scoring Protocol

## Score Calculation

```
score = (passing_checks / total_checks) * 100
```

Each eval check is binary: pass (true) or fail (false). No partial credit. No weighting.

---

## Baseline Measurement

Before any edits, establish the baseline:

1. Run the eval subagent 3 times with the same fixture and current command file
2. Score each run independently
3. Take the **median** score as the baseline
4. Log as iteration 0 in `autoresearch-runs.jsonl`

The median (not mean) accounts for subagent output variability without being skewed by a single outlier run.

**Note**: Only the baseline uses 3 runs. Per-iteration evals use a single run as an intentional cost tradeoff — running 3 evals per iteration would triple token usage. The single-run approach works because the simplicity gate and convergence criterion (3 consecutive passes) provide noise resistance.

---

## Accept/Reject Threshold

After each iteration edit:

- `score_after > score_before` → candidate for KEEP (subject to simplicity gate)
- `score_after == score_before` → DISCARD (no improvement = no noise-driven drift) — **exception**: if `net_delta < 0` (deletion), proceed to simplicity gate instead
- `score_after < score_before` → DISCARD (regression)

**Strict greater-than** is required for non-deletion edits. Equal scores are rejected to prevent random walk drift where the command changes without improving. The one exception is deletion edits (`net_delta < 0`) which maintain score — these proceed to the simplicity gate where the "deletion bonus" rule applies.

---

## Simplicity Gate

After scoring, before accepting a KEEP candidate:

1. Count `checks_improved`: how many checks flipped from false to true
2. Calculate `net_delta`: lines_added - lines_removed in the edit
3. Apply the simplicity criterion:

| checks_improved | net_delta | Decision | Log action |
|----------------|-----------|----------|------------|
| >= 2 | any | KEEP | `"kept"` |
| == 1 | > 0 | **REJECT** | `"rejected_complexity"` |
| == 1 | <= 0 | KEEP | `"kept"` |
| == 0 | < 0 | KEEP (if score maintained) | `"kept"` (simplification) |
| == 0 | >= 0 | DISCARD | `"discarded"` |

**Deletion bonus**: If `net_delta < 0` (change removes lines) AND `score_after >= score_before`, ALWAYS KEEP. Karpathy: "Improvement from deleting code = definitely keep."

---

## Convergence

The loop converges when score >= target (default 90%) for **3 consecutive iterations** where each iteration includes running an eval and scoring. The 3-consecutive requirement applies to iterations that produce a score (KEEP or DISCARD), not CRASH iterations. Three consecutive readings at target eliminates the possibility of a lucky single run.

---

## Score Logging Format

Append one JSONL line per iteration to `.claude/metrics/autoresearch-runs.jsonl`:

```json
{
  "command": "[target command name]",
  "iteration": 1,
  "timestamp": "2026-03-20T10:30:00Z",
  "score_before": 62.5,
  "score_after": 75.0,
  "action": "kept",
  "edit_type": "add_worked_example",
  "edit_summary": "Added before/after example for gap analysis section",
  "checks": {
    "has_executive_summary": true,
    "has_score_table": true,
    "has_massu_comparison": true,
    "has_gap_analysis": false,
    "has_action_items": true,
    "has_source_credibility": true,
    "mentions_specific_commands": true,
    "has_implementation_path": false
  },
  "lines_added": 8,
  "lines_removed": 2,
  "net_delta": 6,
  "cumulative_kept": 1,
  "cumulative_discarded": 0,
  "cumulative_crashed": 0,
  "cumulative_rejected": 0,
  "escalation_level": 0,
  "consecutive_reverts": 0
}
```

### Field Definitions

| Field | Type | Description |
|-------|------|-------------|
| `command` | string | Target command name (e.g., "massu-article-review") |
| `iteration` | number | 0 = baseline, 1+ = edit iterations |
| `timestamp` | string | ISO 8601 timestamp |
| `score_before` | number\|null | Score percentage before this iteration's edit. `null` for baseline (iteration 0) since there is no prior score. |
| `score_after` | number | Score percentage after this iteration's edit |
| `action` | string | One of: `"baseline"`, `"kept"`, `"discarded"`, `"crashed"`, `"rejected_complexity"` |
| `edit_type` | string\|null | `null` for baseline/dry-run. Otherwise one of: `"add_rule"`, `"add_example"`, `"add_worked_example"`, `"restructure"`, `"promote"`, `"ban_pattern"`, `"merge_sections"`, `"split_section"`, `"reorder"`, `"simplify"` |
| `edit_summary` | string | One-line human-readable description of the change |
| `checks` | object | Map of check_id to boolean pass/fail |
| `lines_added` | number | Lines added by this edit |
| `lines_removed` | number | Lines removed by this edit |
| `net_delta` | number | `lines_added - lines_removed` |
| `cumulative_kept` | number | Running total of kept changes this run |
| `cumulative_discarded` | number | Running total of discarded changes this run |
| `cumulative_crashed` | number | Running total of crashed evals this run |
| `cumulative_rejected` | number | Running total of complexity-rejected edits this run |
| `escalation_level` | number | Current escalation level (0-3) |
| `consecutive_reverts` | number | Current consecutive revert count (resets on KEEP) |

---

## Final Summary Format

After the loop exits, produce a summary:

```
  Score Trajectory:
    [iteration 0]  62.5%  (baseline)
    [iteration 1]  75.0%  KEPT    "Added worked example for gap analysis"
    [iteration 2]  75.0%  DISCARD "Tried adding source credibility template"
    [iteration 3]  87.5%  KEPT    "Promoted source credibility to mandatory section"
    ...

  Per-Check Progression:
    Check                       Baseline    Final
    has_executive_summary       PASS        PASS
    has_score_table             PASS        PASS
    has_massu_comparison        PASS        PASS
    has_gap_analysis            FAIL        PASS  <-- improved
    has_action_items            PASS        PASS
    has_source_credibility      FAIL        PASS  <-- improved
    mentions_specific_commands  PASS        PASS
    has_implementation_path     FAIL        FAIL  (hardest check)
```

This summary shows the optimization journey and identifies which checks responded to edits and which are structurally difficult.
