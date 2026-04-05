---
name: massu-bearings
description: "When user starts a new session, says 'good morning', asks 'where was I', 'what should I work on', or needs session orientation after being away"
allowed-tools: Bash(*), Read(*), Grep(*), Glob(*)
---
name: massu-bearings

# Massu Bearings: Session Orientation

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding.

---

## Purpose

Answer one question: **"Where am I and what should I focus on?"**

This is a READ-ONLY orientation command. It reads session state, recent history, parked ideas, and open plans, then presents a concise human-readable briefing. It does NOT modify any files.

**Privilege level**: Level 1 (read-only) — same as `massu-create-plan` in recovery.md hierarchy.

**This does NOT replace the recovery protocol** (`protocols/recovery.md`). Recovery is the full post-compaction restoration procedure. Bearings is the quick "good morning" briefing that layers on top.

---

## Data Sources

Read these in parallel where possible:

| # | Source | What to extract |
|---|--------|----------------|
| 1 | `session-state/CURRENT.md` | Active task, status, decisions, blockers |
| 2 | Last 5 session archives (by date) | Recent completed work, patterns |
| 3 | `session-state/squirrels.md` | Parked ideas count and list |
| 4 | `.claude/plans/*.md` | Any open/in-progress plans |
| 5 | `git log --oneline -10` | Recent commits for context |
| 6 | `git diff --stat` | Any uncommitted changes |
| 7 | `memory/corrections.md` | Active correction rules |
| 8 | `memory/auto-patterns/*.md` | Auto-extracted pattern candidates (status: candidate) |
| 9 | `.claude/metrics/command-scores.jsonl` | Command quality scores — flag any below 60% on last 3 runs |
| 10 | `.claude/metrics/command-invocations.jsonl` | Command usage frequency — top/least used in last 7 days |
| 11 | `.claude/metrics/bearings-history.jsonl` | Previous bearings runs — show trends |
| 12 | `.claude/commands/` (ls -d */`) | Detect folder-based skills (directories vs flat files) |

---

## Output Format

Present directly to terminal. Do NOT write to a file.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BEARINGS — [date]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CURRENT STATE
  Status: [active task or "No active task"]
  Branch: [current git branch]
  Uncommitted: [N files changed / clean]

STILL OPEN
  - [item 1 from CURRENT.md or recent archives]
  - [item 2]

RECENTLY COMPLETED (last 3-5)
  - [commit hash] [message] ([date])
  - [commit hash] [message] ([date])

OPEN PLANS
  - [plan name] — [status, items remaining]
  (or "No open plans")

PARKED IDEAS ([N] squirrels)
  - [idea 1]
  - [idea 2]
  (or "No parked squirrels")

SUGGESTED FOCUS
  1. [highest priority item — why]
  2. [next priority item — why]
  3. [optional third item]

PATTERN CANDIDATES ([N] pending review)
  - [date] [title] (confidence: X/15) — review and promote or dismiss
  (or "No auto-extracted patterns")

COMMAND HEALTH ALERTS
  ! [command] — [X]% on last 3 runs. Weakest: [check_name]
  (or "All commands healthy (above 60%)")

COMMAND USAGE (last 7 days)
  Top:   [command] (N invocations), [command] (N), [command] (N)
  Least: [command] (N invocations), [command] (N)
  (or "No invocation data yet")

FOLDER-BASED SKILLS
  [list any commands that are directories: massu-golden-path, massu-debug, massu-loop, massu-data]
  (or "No folder-based skills detected")

ACTIVE WARNINGS
  - [any correction rules or memory enforcement reminders]
  (or "No active warnings")

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Suggested Focus Logic

Prioritize items in this order:
1. **Blockers** — anything marked as blocked in CURRENT.md
2. **In-progress tasks** — partially completed work from last session
3. **Open plan items** — next items in an active plan
4. **Aging squirrels** — ideas parked > 7 days ago (mention but don't auto-promote)
5. **New work** — only if nothing else is open

Keep to 2-3 items. This is a focus list, not an inventory.

---

## Auto-Extracted Pattern Candidates

Check `memory/auto-patterns/` for files with `status: candidate` in frontmatter. For each candidate:
- Read the title and confidence score
- Display in the PATTERN CANDIDATES section
- If confidence >= 12/15, mark as "HIGH — consider promoting to corrections.md"
- If confidence 8-11/15, mark as "MEDIUM — review in next implementation session"

To act on candidates:
- **Promote**: Move key content to `memory/corrections.md` or `patterns-quickref.md`, change status to `promoted`
- **Dismiss**: Change status to `dismissed` (auto-cleanup after 60 days)
- **Ignore**: Leave as `candidate` (auto-dismissed after 30 days)

---

## Command Health Alerts Logic

Read `.claude/metrics/command-scores.jsonl`. If the file is empty or missing, show "All commands healthy (above 60%)".

For each command in the file:
1. Parse all JSONL lines for that command
2. Take the last 3 runs
3. Calculate average pass rate (e.g., "3/4" = 75%, "2/5" = 40%)
4. If average < 60%, flag as alert with the weakest check name
5. Display in COMMAND HEALTH ALERTS section

If no commands are below 60%, show "All commands healthy (above 60%)".

---

## Edge Cases

- **No CURRENT.md**: Say "No active session state. Starting fresh."
- **No archives**: Say "No session history found. This appears to be a new project."
- **No squirrels.md**: Skip the squirrels section (don't create the file — that's `/massu-squirrels`' job)
- **No open plans**: Say "No open plans"
- **No corrections.md**: Skip the warnings section

---

## Gotchas

- **Read-only command** — bearings READS state, it does NOT modify files or start work. Wait for user direction after presenting findings
- **Don't start working unprompted** — after showing bearings, wait for the user to tell you what to work on. Don't assume the suggested focus is approved
- **Session state may be stale** — CURRENT.md may be from a previous session that ended abruptly. Cross-reference with git log for ground truth
- **Archive files are historical** — session-state/archive/ files show past work but should not drive current decisions unless user references them

---

## Bearings History

After presenting the bearings output, append a JSONL line to `.claude/metrics/bearings-history.jsonl`:

```json
{"timestamp":"ISO","branch":"main","uncommitted":3,"open_plans":1,"squirrels":5,"suggested_focus":"item"}
```

On next bearings run, read last 5 entries from `bearings-history.jsonl` to show trends:
- "Uncommitted files trending up: 1 → 3 → 5"
- "Open plans stable at 1"
- If no history file exists, skip trends.

---

## Command Usage Logic

Read `.claude/metrics/command-invocations.jsonl`. Filter to last 7 days by `timestamp` field. Group by `skill`, count invocations, sort descending. Show top 3 and bottom 2. If no data exists, show "No invocation data yet".

---

## Folder-Based Skill Detection

Run `ls -d .claude/commands/*/` to find commands that are directories. Display the list in FOLDER-BASED SKILLS section. Each folder-based skill has a `## Skill Contents` table in its main file listing sub-files.

---

## START NOW

1. Read all data sources in parallel (CURRENT.md, archives, squirrels, plans, git log, git diff, corrections, metrics, bearings-history)
2. Synthesize into the output format above
3. Present to terminal
4. Append bearings-history.jsonl entry
5. Do NOT start working on anything — wait for user to choose what to focus on
