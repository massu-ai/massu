---
name: massu-command-health
description: "When user asks about command quality, says 'how are my commands', 'command health', or wants to see which slash commands have quality issues"
allowed-tools: Bash(*), Read(*)
---
name: massu-command-health

# Massu Command Health: Quality Score Dashboard

## Purpose

Read `.claude/metrics/command-scores.jsonl` and display a summary of command quality over time. This is a READ-ONLY command — it does not modify anything.

---

## Data Sources

### Quality Scores
Each line in `.claude/metrics/command-scores.jsonl` is a JSON object:

```json
{"command":"massu-create-plan","timestamp":"2026-03-18T14:30:00","scores":{"items_have_acceptance_criteria":true,"references_real_tables":true,"ui_items_have_paths":false,"has_vr_types":true,"explicit_counts":true},"pass_rate":"4/5","input_summary":"knowledge-graph-phase-5"}
```

### Invocation Frequency
Each line in `.claude/metrics/command-invocations.jsonl` tracks when a command was used:

### Autoresearch Runs
Each line in `.claude/metrics/autoresearch-runs.jsonl` tracks autonomous optimization iterations:
```json
{"command":"massu-article-review","iteration":5,"timestamp":"ISO8601","score_before":75,"score_after":87.5,"action":"kept","edit_summary":"Added worked example for gap analysis"}
```

```json
{"skill":"massu-create-plan","timestamp":"2026-03-18T14:30:00Z"}
```

---

## Output Format

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
COMMAND HEALTH — [date]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

OVERVIEW
  Total scored runs: [N]
  Commands tracked:  [N]
  Date range:        [earliest] — [latest]

SCORECARD
  Command                   Last 5 avg    Trend    Weakest check                    Runs
  ─────────────────────────────────────────────────────────────────────────────────────
  massu-create-plan          80%           =        ui_items_have_paths (40%)         12
  massu-loop                 90%           ^        memory_persisted (60%)             8
  massu-article-review      100%           =        —                                  5
  massu-plan                 75%           v        zero_gaps_at_exit (50%)            6
  massu-debug                85%           =        regression_test_added (60%)        4

  Trend: ^ improving (last 3 > prior 3)  v declining  = stable

USAGE (last 7 days from command-invocations.jsonl)
  Command                   Invocations/week
  ─────────────────────────────────────────
  massu-create-plan          12
  massu-debug                 8
  massu-loop                  6
  massu-bearings              5
  massu-commit                4
  (or "No invocation data yet")

ALERTS (commands below 60% on last 3 runs)
  ! massu-plan — 50% on last 3 runs. Weakest: zero_gaps_at_exit
  (or "No alerts — all commands above threshold")

CHECK DETAIL (per-command breakdown, last 10 runs)
  massu-create-plan:
    items_have_acceptance_criteria   9/10 (90%)
    references_real_tables           8/10 (80%)
    ui_items_have_paths              4/10 (40%)  <-- weakest
    has_vr_types                     7/10 (70%)
    explicit_counts                  9/10 (90%)

  [repeat for each command with data]

AUTORESEARCH (from autoresearch-runs.jsonl)
  Command               Last run         Iterations   Score: start -> end
  ─────────────────────────────────────────────────────────────────────────
  massu-article-review   2026-03-19       12           62% -> 87%
  (or "No autoresearch runs yet")

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Logic

1. Read `.claude/metrics/command-scores.jsonl` AND `.claude/metrics/command-invocations.jsonl`
2. If both empty: display "No command data recorded yet. Scores and invocations accumulate automatically as you use commands."
3. Parse each line as JSON
4. Group scores by `command`, group invocations by `skill`
5. For each command:
   - Count total runs
   - Calculate average pass rate for last 5 runs
   - Calculate trend (compare last 3 avg vs prior 3 avg)
   - Find weakest check (lowest pass rate across all runs)
   - Per-check breakdown for last 10 runs
6. Sort by average pass rate (lowest first — worst commands at top)
7. Flag any command below 60% on last 3 runs as an ALERT
8. Read `.claude/metrics/autoresearch-runs.jsonl` — group by command, find last run's iteration range, extract start/end scores, display in AUTORESEARCH section

---

## Arguments

Optional: command name to show detail for just one command.

```
/massu-command-health                    # Full dashboard
/massu-command-health massu-create-plan   # Detail for one command
```

---

## START NOW

1. Read `.claude/metrics/command-scores.jsonl`
2. Parse and aggregate scores
3. Display dashboard in the format above
4. Do NOT modify any files
