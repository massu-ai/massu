---
name: massu-rule
description: "Inspect, approve, or dismiss rule candidates emitted by the v0.2 interactive rule-approval hook. Subcommands: list, show <id>, approve <id>, dismiss <id>, recurrence."
allowed-tools: Bash(*), Read(*), Grep(*), Glob(*), Write(*), Edit(*)
---

# Massu Rule: Interactive Rule-Approval

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding.

---

## Purpose

Surface rule-candidate sidecars written by the UserPromptSubmit hook (`packages/core/src/hooks/user-prompt.ts:115`) and let the operator inspect, approve, or dismiss them. The detector is `packages/core/src/rule-candidate-detector.ts`; candidate files live at `.massu/rule-candidates/<prompt_hash>.json`.

The slash command is the **single authoring surface** for new rules — pattern-scanner checks, CR rows, custom-destination entries, and `corrections.md` appends ALL flow through `applyRuleCandidate()` in `packages/core/src/rule-candidate-applier.ts`. Operators never hand-edit the destination files for rule promotions.

This is plan-v0.2-interactive-rule-approval (`docs/plans/2026-05-20-v0.2-interactive-rule-approval.md`). Phase B ships `list` + `show`; `approve` is wired in Phase C for the `corrections-md` destination and Phase D for the remaining three destination classes.

---

## Tier requirement (Requires Pro)

Auto-learning (rule-candidate **emission** + rule **promotion**) is a **Pro+** feature. The command and these docs are free to view, but:

- **Candidate emission** only happens at Pro or above — Free sessions write no candidate sidecars (the hook emits a one-time upgrade note instead), so `list`/`show` will be empty.
- **`approve`** refuses at Free: it surfaces the generic upgrade message (`Auto-learning … is a Pro feature. … Upgrade at https://massu.ai/pricing`) and writes nothing. The gate is enforced structurally inside `applyRuleCandidate()` — DO NOT hand-edit a destination file to bypass it.
- **`list`**, **`show`**, **`dismiss`**, and **`recurrence`** stay available regardless of tier (read + cleanup after a downgrade).

Confirm entitlement before approving — this hard-fails for sub-Pro:

```bash
npx massu license check --min pro || exit 1
```

---

## Workflow Position

```
correction prompt → hook detection (>=60) → sidecar JSON → /massu-rule list
                                                          → /massu-rule show <id>   (must be shown once per session before approve)
                                                          → /massu-rule approve <id> | dismiss <id>
                                                          → atomic write via applyRuleCandidate()
                                                          → audit_log row + destination edit + MEMORY.md index
```

---

## Subcommands

### `list`
Lists pending rule candidates in `.massu/rule-candidates/*.json` (excluding dotfiles). Each row prints `prompt_hash`, score, classification preview, age. No state writes.

### `show <id>`
Renders a six-section preview via `renderCandidatePreview()` (`packages/core/src/rule-candidate-renderer.ts`):

1. Detected correction text + correction-score + which signals fired
2. Reacting-to: prior assistant turn's Edit/Write/Bash with file path + 3-line diff snippet
3. Proposed rule text (schema-templated: `rule_id`, `scope`, `enforcement_mechanism`, `example_violation`, `example_fix`; the model fills wording)
4. Destination + reason (from `classifyCandidate()` rubric — `pattern-scanner | claude-md-cr | corrections-md | custom-destination`)
5. Example enforcement: exact `grep`, VR-* row, or rendered template line
6. Conflict check: results of `grep -F <pattern>` against scanner + CRs

Appends `<id>` to `.massu/rule-candidates/.shown-this-session.jsonl` so the `approve` subcommand can enforce show-before-approve (plan §4 / §6 row 7).

### `approve <id>` (Phase C+: corrections-md only; Phase D+: all four destinations)
1. Verify `<id>` appears in `.shown-this-session.jsonl` for the current session_id. If not, render `show <id>` output inline and return an error: **"call `show` before approving"** — single command read-then-act gate.
2. Classify destination via `classifyCandidate()` rubric.
3. Invoke `applyRuleCandidate(candidateId, destination, draftText)` which runs the §5 four-step SQLite transaction:
   - `INSERT INTO audit_log (event_type='rule_promoted', metadata={prompt_hash, score, classification, recurrence_count: 0, ...})` — UNIQUE INDEX on `(event_type, json_extract(metadata, '$.prompt_hash'))` is the idempotency lock.
   - Edit the destination file(s) per rubric (snapshot-set captured pre-write).
   - Append a `- [Title](feedback_<slug>.md) — hook` line to `memory/MEMORY.md` (canonical path resolved via `encodeMemoryDirName(getProjectRoot())`).
   - Delete the candidate sidecar.
4. On ANY step error: SQLite rollback + per-file restore via snapshot-set (NEW files unlinked, existing files re-written), candidate left in place for retry, failure appended to `.massu/rule-candidates/.failures.jsonl`.

### `dismiss <id> [--reason "..."]`
1. Append `{id, prompt_hash, score, signals_fired, reason}` to `.massu/rule-candidates/.dismissed.jsonl`.
2. For each signal that fired on the dismissed prompt, INSERT-OR-UPDATE `prompt_outcomes_signal_blacklist` (dismissal_count += 1). Downweight kicks in at the detector on the next prompt (each dismissal reduces signal weight by 10; >=5 dismissals zeroes the signal).
3. Delete the candidate sidecar.

### `recurrence`
Reports `audit_log` rows with `event_type='rule_promoted'` and `metadata.recurrence_count > 0`. Cross-references each with the file path where the rule was supposed to enforce. Surfaces CR-53 candidates for strengthening.

---

## Wired-in state

| Subcommand | Status | Notes |
|---|---|---|
| `list` | wired | read-only |
| `show <id>` | wired | read-only; renders via `renderCandidatePreview()` |
| `approve <id>` (destination=`corrections-md`) | wired | invokes `applyRuleCandidate(db, {destination: 'corrections-md', ...})` |
| `approve <id>` (destination=`pattern-scanner` / `claude-md-cr` / `custom-destination`) | stub | applier returns `{ok:false, error:"not yet wired in Phase C"}` — arrives in Phase D |
| `dismiss <id>` | stub | arrives in Phase D alongside the dismissal-loop downweight UPSERT |
| `recurrence` | wired | read-only; queries `audit_log` for `metadata.recurrence_count > 0` |

---

## Output Format

### `list`
```
| Hash        | Score | Age      | Destination (preview) | Signals fired                              |
|-------------|-------|----------|-----------------------|--------------------------------------------|
| 7c3a...     |    85 |   12m    | pattern-scanner       | strong_correction_phrase,prior_edit,length |
| ee21...     |    62 |   2h     | claude-md-cr          | negation_plus_instruction,bugfix_category  |
```

### `show <id>`
```
## Candidate <prompt_hash>

### 1. Detected correction
> "<correction prompt text>"
Score: <score>/100 (threshold 60)
Signals fired:
- strong_correction_phrase (+40): matched "that's wrong"
- prior_edit_or_write (+25): prior assistant turn contained Edit
- bugfix_or_refactor_category (+15): category=bugfix
- prompt_length_gt_10 (+10): 14 words > 10

### 2. Reacting to
File: <path>
```
<3-line diff snippet>
```

### 3. Proposed rule
- rule_id: <slug>
- scope: <where it applies>
- enforcement_mechanism: <how it's checked>
- example_violation: <code snippet>
- example_fix: <code snippet>

### 4. Destination + reason
**Destination**: pattern-scanner
**Reason**: matches rubric rule 1 (literal-grepable token detected: `<token>`).

### 5. Example enforcement
```bash
grep -E "<auto-generated pattern>" packages/core/src
```

### 6. Conflict check
- grep across `scripts/massu-pattern-scanner.sh`: 0 hits — no conflict
- grep across `scripts/hooks/pattern-feedback.sh`: 0 hits — no conflict
```

---

## Failure Modes (plan §6)

| Failure | Detection | Response |
|---|---|---|
| Approval but conflicting rule | `grep -nF <pattern>` finds existing matches in scanner/feedback | List existing matches; refuse write until operator confirms merge / allow-list / explicit override |
| False positive | `dismiss --reason` | Appends to `.dismissed.jsonl`; downweights signals; ≥5 dismissals blacklists the signal permanently |
| Rule promoted but problem recurs | post-tool-use.ts increments `metadata.recurrence_count` when scanner fires on a previously-corrected file path | CR-53 drift-guard (`packages/core/src/__tests__/rule-promotion-effectiveness.test.ts`) FAILs CI when any `rule_promoted` >7d old has `recurrence_count > 0` |
| Orphaned candidate | file >14 days old | `/massu-learning-audit` Section 6 reports; `dismiss --all-older-than 14d` mass-cleans |
| Slash command crashes mid-write | snapshot-set restore in applier | All edited files restored; candidate file left for retry |
| Operator approves before reading | not in `.shown-this-session.jsonl` | Approve returns error embedding full preview — single read-then-act keystroke |

---

## Related

- Plan: `docs/plans/2026-05-20-v0.2-interactive-rule-approval.md`
- Detector: `packages/core/src/rule-candidate-detector.ts`
- Applier: `packages/core/src/rule-candidate-applier.ts` (Phase C+)
- Renderer: `packages/core/src/rule-candidate-renderer.ts`
- Classifier: `packages/core/src/rule-classifier.ts` (Phase D)
- Hook wire-in: `packages/core/src/hooks/user-prompt.ts:115`
- Audit integration: `.claude/commands/massu-learning-audit.md` Section 6
