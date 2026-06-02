---
name: massu-rule
description: "Inspect, approve, or dismiss rule candidates emitted by the v0.2 interactive rule-approval hook. Subcommands: list, show <id>, approve <id>, dismiss <id>, recurrence, pull, packs, revoke <prompt_hash>."
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

### Team tier: shared promotion (`pull` / `revoke`)

At **Team** (and Enterprise), auto-learning becomes **shared**: a rule you promote propagates to your org's other seats as a *reviewable proposal* (your team learns as one). Two extra subcommands cover this:

- **`pull`** fetches your org's team-shared promotions from the cloud, verifies the Ed25519 signature, and materializes each as a **local rule-candidate** — provenance-tagged, surfaced like any other candidate. It **never applies anything**; a human must `show` then `approve`. Free/Pro seats no-op (Pro auto-learning is local-only). `pull` also runs automatically at session end.
- **`revoke <prompt_hash>`** lets the original publisher tombstone a team promotion; receiving seats drop the still-pending candidate (or, if already approved, get a one-time "consider reverting" notice — never an auto-revert).

Only **`corrections-md`** and **`claude-md-cr`** (non-executing memory / governance text) are shareable across seats by default. `approve` of a **team-origin** candidate additionally requires **Team tier + verified provenance** — enforced structurally inside `applyRuleCandidate()`.

**Hardened path (Phase 3):** `pattern-scanner` (bash) and `custom-destination` (file write) — the executable classes — may propagate cross-seat ONLY behind the hardened-review path: the org must opt in (server-attested, default OFF), the receiving seat must run **`review <prompt_hash>`** (a RENDER-ONLY preview — the bash/file-write is displayed and statically risk-scanned but **never executed** — plus a SECOND distinct operator's attestation), and only THEN may `approve` apply it. A hardened team candidate without a recorded two-operator render-only attestation is refused at the apply gate.

Confirm entitlement before approving — this hard-fails for sub-Pro:

```bash
npx massu license check --min pro || exit 1
```

`pull` / `revoke` require Team:

```bash
npx massu license check --min team || exit 1
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
Lists pending rule candidates in `.massu/rule-candidates/*.json` (excluding dotfiles). Each row prints `prompt_hash`, score, classification preview, age. No state writes. A candidate with `provenance.origin === 'team'` is flagged **"PROPOSED by `<promoted_by>` (team) — NOT yet applied"** so the operator knows it came from a teammate and still requires explicit `approve`. A candidate with `provenance.origin === 'pack'` is flagged **"FROM PACK `<slug>@<version>` — NOT yet applied"** (materialized by `packs`, see below) so the operator knows it came from an installed rule pack and still requires explicit `approve`.

### `show <id>`
Renders a six-section preview via `renderCandidatePreview()` (`packages/core/src/rule-candidate-renderer.ts`):

1. Detected correction text + correction-score + which signals fired
2. Reacting-to: prior assistant turn's Edit/Write/Bash with file path + 3-line diff snippet
3. Proposed rule text (schema-templated: `rule_id`, `scope`, `enforcement_mechanism`, `example_violation`, `example_fix`; the model fills wording)
4. Destination + reason (from `classifyCandidate()` rubric — `pattern-scanner | claude-md-cr | corrections-md | custom-destination`)
5. Example enforcement: exact `grep`, VR-* row, or rendered template line
6. Conflict check: results of `grep -F <pattern>` against scanner + CRs

Appends `<id>` to `.massu/rule-candidates/.shown-this-session.jsonl` so the `approve` subcommand can enforce show-before-approve (plan §4 / §6 row 7).

After rendering, record the `shown` promotion-funnel event for the auto-learning analytics dashboard (P1-002, `plan-2026-06-01-auto-learning-analytics-dashboard`) — Team-gated, best-effort (never fails the show):

```bash
npx massu rule record-shown <id> || true
```

(`<id>` is the candidate id — the sha-keyed 16-hex prompt hash. The CLI is a silent no-op below Team.)

### `approve <id>` (Phase C+: corrections-md only; Phase D+: all four destinations)
1. Verify `<id>` appears in `.shown-this-session.jsonl` for the current session_id. If not, render `show <id>` output inline and return an error: **"call `show` before approving"** — single command read-then-act gate.
2. Resolve the destination + draft body by ORIGIN:
   - If the candidate carries `provenance.origin` ∈ {`team`, `pack`}, use the sidecar's **STORED** `destination` + `draft_text` **VERBATIM** — the team publisher / pack author already decided, and migration 048's destination mapping is authoritative; do **NOT** re-classify. Re-classifying would silently re-route a `claude-md-cr` rule to `corrections-md` (or downgrade an executable rule off the hardened path). The applier enforces this structurally: applying a provenance-bearing candidate to a destination other than its authored one is refused (`destination mismatch …`) with zero mutation.
   - Only a Phase-1 **LOCAL** candidate (no `provenance`) classifies its destination via `classifyCandidate()`.
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

### `pull` (Team+)

Invokes `pullTeamPromotions(db)` (`packages/core/src/team-rule-sync.ts`):

1. Tier gate — Free/Pro no-op (cache-only, no network).
2. Reads the monotonic `seq` cursor (`memory_meta.team_promotions_cursor`) and fetches `${endpoint}/promoted-rules?since=<seq>` with the seat's API key.
3. **Verifies the Ed25519 envelope** (`verifyPromotionEnvelope()`); an unsigned / invalid / wrong-org response is **dropped whole** (no transition mode) with telemetry.
4. For each promotion: drops non-shareable destinations (H1); handles revocation tombstones (H3); skips duplicates already pending/applied; otherwise **writes a provenance-tagged candidate sidecar** + a `shared_observations` row. It **never applies** — the candidate is surfaced for `show` → `approve`.
5. Advances the cursor to the max `seq` seen.

Also runs automatically at session end (best-effort, bounded). Reports `{pulled, materialized, skipped, dropped_unverified, dropped_nonshareable, revoked_handled}`.

### `packs` (Team+)

Invokes `pullInstalledPackRules(db)` (`packages/core/src/rule-pack-sync.ts`) — the rule-pack analogue of `pull`. Materializes the rules of the org's *installed* rule packs (from the marketplace) as reviewable candidates:

1. Tier gate — Free/Pro no-op (pack enforcement is a Team+ shared feature, gated like team-shared promotion via `entitledForTeamSharedPromotion`).
2. Fetches the org's installed-pack rules from the `installed-rules` edge function with the seat's API key.
3. **Verifies the Ed25519 envelope** (`verifyPromotionEnvelope()` / pack-bound wrapper over the same core); an unsigned / invalid / wrong-org response is **dropped whole** with telemetry. Org-match is checked against `getCachedOrgId()`.
4. For each pack rule: dedups against already pending/applied; **writes a provenance-tagged candidate sidecar** with `provenance.origin === 'pack'` + `pack_slug` + `pack_version`. Executable-destination pack rules (`pattern-scanner` / `custom-destination`) are materialized as **hardened-pending** (`provenance.hardened === true`) and must pass `review <prompt_hash>` before `approve`, exactly like a hardened team candidate. It **never applies** — surfaced for `show` → `approve` (packs propose, humans approve — CR-39, no fake "active" state).

Reports `{pulled, materialized, skipped, dropped_unverified}`. The sync module imports NO applier write function (the materialize-never-apply invariant, drift-guarded by pattern-scanner Check 36 + the bridge drift-guard test).

### `revoke <prompt_hash>` (Team+, publisher-initiated)

Enqueues `enqueueTeamRevocation(db, prompt_hash)`; the session-end sync drains it into the `/sync` payload's `rule_revocations[]`. Only the original publisher (server-attested) may revoke. Receiving seats drop a still-pending candidate or get a one-time "consider reverting" notice for an already-applied rule — never an auto-revert.

### `review <prompt_hash>` (Team+, hardened candidates only)

Gates a **hardened-pending** team candidate (an executable destination — `pattern-scanner` / `custom-destination` — materialized via the hardened path) before it may be `approve`d. RENDER-ONLY — nothing is executed.

1. Read the sidecar; confirm `provenance.origin === 'team'` AND `provenance.hardened === true`. (Non-hardened candidates do not need `review`.)
2. Render the preview via `renderHardenedPreview(destination, draft_text)` (`packages/core/src/rule-candidate-preview.ts`): the exact bash / file-write body is **displayed verbatim** alongside a static, non-executing risk scan (flags `rm -rf`, pipe-to-shell, network tools, `eval`, command substitution, redirects to absolute/home/parent paths, `sudo`, etc.). The body is **NEVER executed** — there is no sandbox because nothing runs.
3. A SECOND distinct operator (≠ the original `promoted_by`) reviews the rendered preview and attests. Record the attestation via `recordHardenedReviewAttestation(sidecarPath, { second_operator_id, dry_run_ack: { ran_at: <iso>, ack: true } })`, which validates the shape + the two-operator-distinctness invariant and writes `provenance.review_attestation` into the sidecar.
4. Only after the attestation is recorded does `approve` pass the applier's hardened apply-gate (`applyRuleCandidate()` PA3-004: tier≥Team + verified provenance + `provenance.hardened===true` + a valid `review_attestation` with a distinct second operator + render-only `dry_run_ack`). Still NEVER auto-applies.

### `approvals` (Enterprise, N-of-M governance)

Surfaces the org's Enterprise **promotion-governance policy** and the N-of-M approval state of pending promotions. Auto-learning governance (an org policy with N-of-M approvals + a signed audit export) is an Enterprise feature, gated via `entitledForEnterpriseGovernance` (`packages/core/src/auto-learning-entitlement.ts`); Free/Pro/Team see an upgrade hint.

1. Tier gate — `entitledForEnterpriseGovernance(currentTier)`; sub-Enterprise prints `enterpriseGovernanceUpgradeMessage()` and no-ops.
2. Shows the resolved policy (minimum promoter role, approvals required, allowed destinations, hardened-review requirement) and, per pending promotion, `needs M-of-N approvals (k recorded)`.
3. The client gate (`validateGovernanceGate(policy, approvals)`) is the honor-system mirror of the **server** gate in `promoted_rule_upsert` + role-aware RLS (migration 049) — the server is the real boundary (CR-54/55 disclosure). A promotion that has not met its threshold is held server-side (`approval_state = 'pending'`) and is **excluded from every seat's pull cursor** until the threshold flips it to `applied`.
4. **Recording an approval** is a privileged write and is done by an owner/admin/auditor in the **Governance dashboard** at `/dashboard/governance` (a server action calls the `promotion_approval_record` RPC under the operator's authenticated session). Distinct-operator is enforced (an approver may not be the original promoter); when the Nth distinct approval lands, the rule flips to `applied` and re-surfaces to seats. The signed audit export (Governance dashboard → Download) covers the full policy + approval + revocation history as an Ed25519-signed envelope.

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
| `pull` (Team+) | wired | invokes `pullTeamPromotions(db)`; verifies Ed25519 envelope, materializes provenance-tagged candidates (never applies); also auto-runs at session end |
| `revoke <prompt_hash>` (Team+) | wired | invokes `enqueueTeamRevocation(db, prompt_hash)`; drained into `/sync` `rule_revocations[]` |
| `approve <id>` (team-origin candidate) | wired | requires Team tier + `provenance.signature_verified === true` + shareable destination — enforced inside `applyRuleCandidate()` |
| `approvals` (Enterprise) | wired | read-only client surface; gates via `entitledForEnterpriseGovernance` + `validateGovernanceGate(policy, approvals)`. Approval RECORDING happens server-side via the Governance dashboard (`promotion_approval_record` RPC) — the server RPC + role-aware RLS are the real boundary |

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
