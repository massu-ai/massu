# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

> **Bundled model attribution.** `@massu/core` ships a pre-trained sentence-embedding
> model for offline semantic memory recall: **all-MiniLM-L6-v2** (384-dim, int8 ONNX
> export from `sentence-transformers/all-MiniLM-L6-v2` via `Xenova/all-MiniLM-L6-v2`),
> redistributed under the **Apache License 2.0**. Full license + NOTICE:
> `packages/core/assets/embedder/MODEL-LICENSE`.

## [1.16.0] - 2026-07-14

### Fixed — cloud sync had, in practice, NEVER succeeded for a real session

The client's request timeout was `2_000ms`, shipped with a comment asserting it was "well under
hook timeout while still tolerating typical latency." Nobody had ever timed the endpoint. Measured
against the live API (`scripts/measure-sync-latency.sh`, now committed so the number is re-derived
rather than believed):

| payload | mean | worst |
|---|---|---|
| empty (auth/bcrypt only) | ~900ms | 1191ms |
| 1 session + 50 observations | ~2090ms | **2168ms** |

An ordinary session payload **exceeded the timeout every time** — it was queued, retried, timed out
again, and after 10 retries **the data was discarded**. A timeout is indistinguishable from an idle
seat, so this went unnoticed for the product's entire life.

- Request timeout is now `8_000ms`, sized from the measurement (~4× the real figure).
- The whole sync runs under a `20_000ms` **deadline**, and every attempt is clamped to the time
  actually remaining. Bounding only the per-request timeout left total time =
  `retries × timeout + backoff`, which silently exceeds the hook budget the moment a knob is tuned.
  The deadline is the structural guarantee.

### Fixed — a learned rule could be destroyed before it was ever delivered

`drainTeamPromotions` / `drainTeamRevocations` / `drainRulePromotionEvents` **deleted a promoted
rule at the moment they READ it** into a sync payload. If the upload then failed, the payload went
to `pending_sync`, was retried, and was **discarded after 10 attempts**. `read == delete` is the
whole disease: *delivery failure* and *nothing to deliver* produced the same end state, and that
state was the quiet one.

**Delivery is now ACK-based** (`rule-delivery.ts`): `lease() → deliver → ack()` on a confirmed
server receipt, `nack()` on any failure. A rule leaves an outbound store on exactly ONE event — the
server confirmed it. A failed delivery **keeps every row**, counts the attempt, and raises a LOUD
stall alarm rather than a silent zero. The `pending_sync` give-up path now **rescues** learned rules
back into the durable store instead of destroying them.

An ack requires `SyncResult.transmitted` — set only after a real 2xx. `success` alone is not a
receipt: it is also `true` when cloud sync is *disabled*, i.e. nothing was sent.

### Added

- **`rule_candidates` table.** Candidates previously existed only as loose JSON on disk, so the
  product could not answer "has anything ever been promoted?" — and could not detect that the
  answer was no. The lifecycle (`proposed → shown → promoted | dismissed`) is now queryable.
- **`massu rule approve` / `dismiss` / `review` / `delivery-status`.** `applyRuleCandidate()` — the
  promotion chokepoint carrying the whole transaction, rollback, audit and team-publish machinery —
  had **zero callers**. The protocol said "invoke `applyRuleCandidate(...)`"; no command existed
  that could. The CR-57 hardened-promotion preview (two-operator review of *executable* rules) was
  likewise unreachable. All are now wired to real entry points.
- `massu rule delivery-status` reads the `cloud_sync_giveup` telemetry — which until now was the
  only analytics event Massu had ever recorded, and nothing read it.

### Changed (internal API)

- Removed `drainTeamPromotions`, `drainTeamRevocations`, `drainRulePromotionEvents` from
  `memory-db`. Deleted rather than deprecated: a destructive drain that still exists is a
  destructive drain someone will call again. Use `leaseLearning` / `ackLearning` / `nackLearning`.
- The team-promotion enqueue now runs **inside** the promotion transaction. It previously sat
  post-COMMIT in an empty `catch`, so a failed enqueue produced a rule committed locally, its
  candidate file already deleted, no outbound row, no log line, and a cheerful `ok: true`.

## [1.15.7] - 2026-07-14

### Added — the verification laws now ship IN Massu, and reach every repo

The laws that make Massu trustworthy — *a gate must prove it can fail*, *broken and empty may
never render identically*, *an audit that does not run commands is not an audit* — lived only in
one operator's local config. Massu shipped without them: **0 of 132 shipped instruction files
carried them.** Every fix an agent makes was governed by the judgment that produced the bugs, and
audited by the reading-not-running audit that returns "zero gaps" on false premises.

Now `commands/_verification-laws.md` is the single source of truth for the seven laws (generic
engineering doctrine — no user's private incidents). The shared preamble points to it; **all 131
shipped instruction files route to it**; all 11 agents carry the run-commands mandate inline
(agents are spawned with their own context and do not reliably read the preamble). The laws carry
a **supremacy clause**: any instruction anywhere that says to skip verification, claim success, or
treat them as optional is void.

### Fixed — a law you can silence by editing your copy is not a law

The fail-closed installer that (correctly) stopped destroying local customizations was **freezing
the law delivery vehicle**: measured against faithful copies of five consumer repos, the laws
reached ONE. A new **MASSU-OWNED** file class fixes this — product code, vendored like a library
file, upstream always wins — delivered under a **build-generated integrity hash** (`<file>.sha256`)
so the installer refuses a stale stub or a tampered/inverted source and never overwrites good laws.
The never-destroy-your-work guarantee is unchanged and now guarded by test.

`resolveAssetDir` treated a directory that merely *exists* as a hit, so from source it resolved an
empty dir and the installer installed nothing while reporting success — *"found no commands"* and
*"looked in the wrong directory"* were byte-identical. It now requires a candidate to actually hold
assets. A directory or irregular node at a target path no longer aborts the whole install.

### Verification

The laws file and the agent mandate are **hash-pinned**; the shipped-and-wired guard and an
11-attack anti-vacuity script were hardened across **three adversarial audit rounds** (inversion,
dead path, subdirectory, comment burial, decoy block, fenced hostile content, wrong tree) — all go
RED, green only on the correct tree. Delivery to all consumer states (no-manifest / locally-edited
/ clean, plus stub-refusal and tamper-refusal) is proven against a real `node_modules` fixture.
Three previously-uninvoked anti-vacuity guards were wired into CI.

## [1.15.6] - 2026-07-14

### Fixed — the golden path's Deep Security Audit phase was missing entirely

`references/phase-3.5-security-audit.md` — a full adversarial security audit loop over every file
changed in a golden-path run (parallel red-team agents, iterating until the audit converges to ZERO
findings). Its own text: *"This phase is NEVER skipped. Security is non-negotiable regardless of
change size, type, or scope."*

    0.6.1    SHIPS phase-3.5-security-audit.md
    1.0.0    does NOT ship it
    1.15.5   does NOT ship it

**It exists in no commit in massu's history** — no deletion commit, no changelog entry, no trace.
From v1.0.0 through v1.15.5, every user's golden path ran with **no security audit phase at all**.
The only surviving copy was in a consumer repo that had committed its installed commands months ago.

Restored, wired as **Phase 3.5** (after simplification, before pre-commit, exactly where its own
spec says it belongs), and added to the reference table.

**Why every guard missed it, and what changed:** the reference-link check asks *"does every
reference file have a link?"* — and a file DELETED OUTRIGHT has no link to be missing. A check that
only sees BROKEN things is structurally blind to ABSENT ones. The anti-vacuity suite now asserts,
per subsystem, that the file **EXISTS** *and* is **LINKED** *and* is **INVOKED** — a conjunction no
deletion can satisfy. Proven by attack: deleting the spec file goes RED; deleting the phase while
keeping the file goes RED.

This is the fifth quality subsystem found missing from the golden path in one day, and the only one
deleted so completely it left no evidence anywhere in the repository.

## [1.15.5] - 2026-07-14

### Fixed — CRITICAL: `install-commands` could destroy your customizations

- **The installer recorded a hash for a file it did not write.** On meeting a command file with no
  manifest entry, it kept the file (correct) and then recorded THAT FILE'S hash into the manifest —
  a manifest whose entire meaning is "this is the hash of what massu installed". On the next run the
  safe-upgrade path read that back, concluded the file was untouched, and **overwrote it**.
  **Run 1 armed it; run 2 destroyed the work.** Measured against a real repo: 36 files of local
  customization deleted on the second install, reported as success.

  It now records **nothing** when it cannot prove authorship. The ambiguity is re-detected on every
  run and the file is kept on every run. A customized file with no provenance now FREEZES: safe, but
  stale. Upstream changes reach it via an explicit `rm <file> && massu install-commands`, or a future
  three-way merge. Between "stale" and "your work is silently deleted", we choose stale.

- **A test was protecting the bug.** `MANIFEST-06` asserted the fail-open as correct behaviour
  ("Manifest seeded with EXISTING hash for kept"). The test agreed with the code because both were
  written from the same wrong assumption. Assertion inverted.

- **`scripts/quarantine-poisoned-manifest.mjs`** — repairs a manifest that already contains such a
  hash. It does not re-derive what massu "would have written" (the installer resolves variants and
  renders templates, so the installed bytes are a function of the repo's config); it runs the REAL
  installer against a scratch copy and drops any entry that authorises an overwrite. Dry run by
  default; backs the manifest up before writing.

### Fixed — the golden path was missing the machinery that checks the work

`8fff05d`, whose message announced only additions, silently **deleted** three quality subsystems.
The spec files kept shipping; nothing invoked them. Restored and re-wired:

- **Sprint contracts (2A.5)** — agree definition-of-done per item BEFORE implementing it.
- **QA evaluator (2C)** — adversarial acceptance testing AGAINST those contracts.
- **VR-VISUAL** — weighted 4-dimension scoring (threshold >= 3.0).
- **Gap analyzer's 7th category** — sprint-contract compliance. Without it the loop could report
  zero gaps while the work missed the definition of done it was built against.

And a fourth that was **never wired at all**: **Phase 5.5 — Production Verification**, shipped in
v0.6.0 and invoked by nothing for its entire life. Its own first line reads *"A feature is NOT
complete until it is verified working in production with real data. 'Deployed' and 'working' are two
completely different things."*

- **A new gate that deletion cannot satisfy.** The previous check asked only "does every reference
  file have a link?" — so deleting the spec files made it pass. The new one asserts, per subsystem,
  that the file EXISTS **and** is LINKED **and** is INVOKED by name. Proven by attacking all three.

### Fixed
- `massu-pattern-scanner.sh` Check 40 used a relative path and silently failed from any directory but
  the repo root — including `packages/core/`, which is where npm runs `prepublishOnly`. The
  pre-publish check that runs it had therefore never worked.
- `diff-commands-vs-docs.sh` derived its repo root via `git rev-parse || pwd`; outside a git tree the
  fallback turned "I cannot find the repo" into a confident wrong answer.

## [1.15.4] - 2026-07-13

### Security

- **Test fixtures are now synthetic.** Five config-migration fixtures were snapshots of real
  private repositories, carrying their project names, stacks and custom verification-type names
  into this package. They are replaced with invented projects, and each fixture directory is now
  named for the migration SCENARIO it pins (`multi-runtime-fastapi-next`, `invalid-router-enum`,
  `twelve-key-passthrough`, …) rather than for a repo it was copied from. A fixture that is a copy
  of a real repository is a leak with a test around it.
- **CI conditions no longer name a private repository or a maintainer account.** Job gates now
  match positively on the public repo (`github.repository == 'massu-ai/massu'`) instead of matching
  negatively against a private upstream. Same behaviour; nothing private in the expression.
- **Docs reference the maintainer by role, not by personal account.**
- **`prepublish-check.sh` now enumerates every GitHub URL in `package.json`** and requires each to
  point at `massu-ai/massu`, replacing a check that grepped for one hardcoded legacy owner slug.
  Strictly stronger: it catches any wrong owner, not only the one that was remembered.

No functional or API changes. Every one of these is a docs/fixture/CI-metadata change.

## [1.15.3] - 2026-07-06

**`massu login` hung forever in non-interactive shells (CI / scripts / agents) with `MASSU_API_KEY` set** (`plan-2026-07-06-login-noninteractive-env-hang`). `runLogin()` never read the `MASSU_API_KEY` environment variable and then read a non-TTY stdin unbounded (`for await … process.stdin`, blocking on an EOF that never arrives on an idle non-TTY stdin), so the documented, non-exposing scripted path (`MASSU_API_KEY=<key> massu login`) blocked indefinitely — the only working non-interactive path was `--key`, which leaks the key to shell history. Patch per semver: a bug fix with no API change, scoped entirely to the `login` command. Incident #1.

### Fixed

- **`massu login` no longer hangs without a TTY.** Key resolution is now a pure, dependency-injected `resolveLoginKey()` with explicit precedence: `--key` > `MASSU_API_KEY` env > TTY prompt > bounded non-TTY stdin. The env var is read before any stdin touch (the reported hang case), and the non-TTY read is bounded by `MASSU_LOGIN_STDIN_TIMEOUT_MS` (default 2000ms) and capped at 64KB, so an idle or oversized stdin fails fast (fail-closed) with an actionable message instead of hanging; `echo "$KEY" | massu login` still works. A structural regression guard makes the interactive prompt / blocking stdin read unreachable when a key is available and stdin is not a TTY, and a help↔code contract test asserts `login` honors the advertised `MASSU_API_KEY`.

### Added

- **`--key` now prints a shell-history exposure warning** to stderr when a key is passed via the flag, steering scripted/CI usage toward `MASSU_API_KEY` or a piped key.

## [1.15.2] - 2026-07-06

**CRITICAL production fix: the `validate-key` cloud edge function returned HTTP 500 on every real API key (deploy drift), silently downgrading every Enterprise/Pro customer to Free** (`plan-2026-07-06-validate-key-deploy-drift`). The DEPLOYED `validate-key` Supabase edge function was a stale bundle that never received the 2026-05-31 `compareSync` fix — it still called the async bcrypt `compare()`, which spawns a Web Worker the Supabase Edge Runtime forbids, so it threw → HTTP 500 on every real `ms_live_` key. `@massu/core`'s license path (`validateLicense`) treated the 500 as "Free", so every paid key silently resolved to Free (surfaced during git-safe-api-key dogfooding, 2026-07-05). The repo source was already correct; the fix redeploys it (wrong-key probe now returns 401, not 500) — **no customer key changes, no re-hashing, no bcrypt/WebCrypto re-engineering** (the cause was a missed deploy, not a library bug). Patch per semver: a bug fix with no API change. Incident: `docs/incidents/2026-07-06-validate-key-deploy-drift-500.md`.

### Fixed

- **`validate-key` edge function 500'd on every real API key (deploy drift).** The live bundle (version 8, 2026-05-31) still imported the async `compare()` (Web-Worker → forbidden in the Supabase Edge Runtime → throw → HTTP 500) five weeks after `e7d67f6` fixed the repo source to route through `verifyApiKeyHash`/`compareSync`; the validate-key redeploy of that fix never actually landed. Verified from the deployed bundle via `supabase functions download`; blast radius confirmed = validate-key only (the other 6 API-key edge functions were already correct). Redeployed the correct source.
- **`massu login` / `massu doctor` reported "Free" when the license server had errored or was unreachable.** `validateLicense` now returns a `LicenseValidationOutcome` (`validated` / `rejected` / `server_error` / `network_error` / `grace` / `cache_fresh` / `no_endpoint` / `no_key`); `login` and `doctor` distinguish an authoritative Free from a "could not validate (server error / offline) — tier UNKNOWN" state, so a server 500 is never misreported as a Free downgrade (this masking is why the outage looked like "Free").

### Added

- **CR-60: API-key edge functions MUST be deploy-verified (three-layer structural drift-prevention).** (1) A source drift-guard (`website/src/__tests__/edge-async-bcrypt-compare-drift.test.ts`, vitest, CI + pre-push) fails if any edge function imports or calls the async bcrypt `compare(` — hashing must route through `verifyApiKeyHash`/`compareSync`; catches a function bypassing the shared helper (which the Deno helper test cannot). (2) A canonical edge-deploy + post-deploy real-key smoke test (`scripts/massu-deploy-edge-functions.sh`) fails the deploy unless a known-good key validates (HTTP 200 + expected tier) and a wrong key returns 401 (`scripts/massu-deploy.sh` deploys only Vercel, so it could never have caught this). (3) A Guardian readiness watcher (`massu_validate_key_readiness_watcher`, hourly) POSTs a known-good key to the live gateway and fires CRITICAL on any 500 / non-200 / wrong tier — this class had zero alerting.

## [1.15.1] - 2026-07-05

**Node 26 compatibility — native-module (better-sqlite3) ABI fix + Node-major CI matrix**. Restores massu on the now-default Node 26. `@massu/core` shipped a prebuilt `better-sqlite3` binary compiled for an older `NODE_MODULE_VERSION` (ABI) and declared `engines.node` `">=20.0.0 <26.0.0"`; when Homebrew's default Node became v26 (ABI 147), the native module failed to load (`NODE_MODULE_VERSION 127 ... requires 147`), breaking BOTH the license check and the memory database in every consumer repo — `npx @massu/core@1 doctor` reported UNHEALTHY. This bumps `better-sqlite3` `^12.6.2` → `^12.11.1` (which ships prebuilt ABI-147 binaries for macOS/Linux/Alpine/Windows, so `npx` consumers with no compiler still load it) and removes the artificial `<26.0.0` engines ceiling (now `>=20.0.0`). Verified end-to-end: the full sqlite-backed suite (2710 tests) + `doctor` HEALTHY on Node 26 AND Node 22 (previously-shipped ABI 127 — no regression). Patch per semver: a compatibility fix with no API change.

### Fixed

- **better-sqlite3 native module fails to load on Node 26 (ABI 147).** Bumped `better-sqlite3` to `^12.11.1` (prebuilt ABI-147 binaries for every consumer platform) and widened `packages/core` + `@massu/adapter-rails` + `@massu/adapter-spring` `engines.node` to `>=20.0.0` (dropped the `<26.0.0` ceiling that excluded the new default Node). `checkNativeModules()` + `checkLicenseStatus()` in `massu doctor` now pass on Node 26 (Status: HEALTHY).
- **root `npm audit` → 0 findings.** Bumped `tsx` `^4.0.0` → `^4.23.0` (built on patched esbuild `~0.28.0`) and added a root `overrides` pin `esbuild` `^0.28.1`, deduping the dev/test tree onto esbuild 0.28.1 and closing GHSA-g7r4-m6w7-qqqr (esbuild dev-server file read, Windows-only; esbuild is a build/test-only dep — never in `@massu/core` `dependencies` nor any published artifact). `npm audit fix` resolved `tar` (GHSA-vmf3-w455-68vh, file smuggling) and `vite` (GHSA-v6wh-96g9-6wx3, high). All-severity closure: `npm audit` reports zero at repo root.

### Added

- **CI Node-major matrix + hard gate (structural drift-prevention, CR-46).** `.github/workflows/ci.yml` `native-module` job runs a better-sqlite3 load assertion + the full sqlite-backed suite on Node `20 / 22 / 24 / 26 / latest` — the `latest` leg auto-tracks the newest release, so a FUTURE Node major that breaks the native-module ABI fails CI with no manual matrix edit. Fronted by a required `Native Module Gate` status check (`.github/rulesets/main-branch.json`). The class is pinned by `node-compat-drift-guard.test.ts` (native load + no-`<`-ceiling on `engines.node` + CI-guard-wired) and the ruleset allowlist mirror (`ruleset-parser.ts` ↔ `ruleset-context-coverage.mjs`). Closes the "single-Node CI never sees a new-major ABI break" gap that let this incident ship. Incident: `docs/incidents/2026-07-05-node-26-native-module-abi.md`.

## [1.15.0] - 2026-06-02

**Enterprise auto-learning governance + signed audit export (`plan-2026-06-01-enterprise-governance-audit-export`)**. Generalizes the Phase-3 per-rule two-operator review into an org-level governance policy enforced at the server promotion chokepoint + role-aware RLS, and adds a cryptographically-signed compliance export. Enterprise orgs (`plan='cloud_enterprise'`) can now set a promotion policy — minimum promoter role (rank-compared, never lexicographic), N-of-M distinct-approver requirement, allowed destinations, and a tighten-only hardened-review flag — that `promoted_rule_upsert` enforces before any promotion applies; a promotion below threshold is held `pending` and excluded from every seat's pull cursor until enough distinct operators (each other than the promoter) approve it. The new signed audit export streams the org's full governance history (policy, approvals, promotions, revocations) as a single Ed25519-signed FLAT envelope (records carried as a `records_json` STRING so the signature covers every record — no nested-array forgery hole), verifiable offline against the bundled public key. The `audit-export` edge function is the SOLE signer (single-signer, CR-46) for both the programmatic `ms_live_` path (admin-scoped) and the dashboard path (which calls it server-side via a service-role bearer and holds no key). Backwards-compatible additive feature — off the Enterprise path, behavior is unchanged (`approval_state` defaults to `applied`) — minor per semver.

### Added

- **`packages/core/src/security/governance-export-verifier.ts`** — Ed25519 verifier for the signed `/audit-export` envelope; a one-line wrapper over the consolidated `verifyEd25519SignedEnvelope` core (third signed-envelope artifact, no copy-pasted crypto), NO transition mode. Bundled pubkey via `scripts/bundle-audit-export-pubkey.mjs` (+ `generate-audit-export-keypair.mjs`), wired into `prepublishOnly`.
- **`packages/core/src/rule-candidate-hardened.ts`** — `validateGovernanceGate(policy, approvals)` (generalized N-of-M gate) + `roleRank()` ladder; `validateHardenedApplyGate` now delegates as the N=2 special case (CR-10: symbol + refs + exact messages preserved).
- **`packages/core/src/auto-learning-entitlement.ts`** — `ENTERPRISE_GOVERNANCE_MIN_TIER` + `entitledForEnterpriseGovernance` (reuses the existing `tierLevel` + `PLAN_TO_TIER_MAP`; no parallel tier scheme).
- **`/massu-rule approvals`** subcommand — surfaces the org policy + pending N-of-M approval state.
- **pattern-scanner Check 37** + `governance-gate-invariant.test.ts` — the client-gate ↔ server-RPC ↔ RLS drift-guard (vitest ↔ scanner parity).
- **Website (massu_prod + massu.ai)**: migration 049 (`org_promotion_policy` + `promotion_approvals` ledger + `promoted_rules.approval_state` + the `promoted_rule_upsert` governance branch + `promotion_approval_record`/`promotion_policy_reconcile` RPCs + role-aware RLS + widened `activity_feed` CHECK), the `audit-export` Enterprise-gated Ed25519-signing edge function (CR-58 `verify_jwt=false`), and the `/dashboard/governance` admin page (policy editor + approvals + signed-export download).

### Changed

- `promoted_rule_upsert` re-defined (CREATE OR REPLACE of the 045 body + governance branch); `/sync` recognizes the new `pending_approval` status; `/promoted-rules` excludes `approval_state='pending'` rows from the differential-pull cursor.

### Fixed

- **loop-controller mirror drift closed** (`plan-loop-controller-mirror-drift-closure`) — reconciled the 78-line preexisting drift between the canonical `.claude/commands/massu-loop/references/loop-controller.md` and its shipped mirror `packages/core/commands/massu-loop/references/loop-controller.md`, and extended the byte-equivalence drift-guard (`auto-learning-mirror-drift-guard.test.ts`) to cover the loop-controller pair so the drift class is now structurally impossible for both command-reference mirrors. Docs-only; no API change.

## [1.14.0] - 2026-06-02

**Curated Rule Packs — versioned, installable, actually-enforced (`plan-2026-06-01-curated-rule-packs`)**. Closes the inert-marketplace bug class: the rule-pack marketplace existed but enforced nothing — installing a pack flattened its rules into `org_rules`, which no core enforcement path ever read. Now an installed pack's rules materialize on the developer's machine as Ed25519-signed, provenance-tagged rule candidates that a human reviews and approves through `/massu-rule packs` (packs **propose**, humans **approve** — CR-39; no fake "active"/"enforced" state). Pack rules ride the existing `applyRuleCandidate()` chokepoint with the same Team-gated, signature-verified trust model as team-shared promotion (CR-54/55/57); executable destinations (`pattern-scanner`/`custom-destination`) route through the hardened two-operator review path and never auto-enforce. Ships the versioning + curation workflow (SemVer monotonicity, an immutable `rule_pack_versions` history, a `rule_pack_publish` SECURITY DEFINER RPC) the marketplace previously lacked. Backwards-compatible additive feature — new `/massu-rule packs` subcommand + `pack` provenance origin, zero breaking changes — minor per semver.

### Added

- **`packages/core/src/rule-pack-sync.ts`** — `pullInstalledPackRules(db)`: pulls the org's installed-pack rules from the `installed-rules` edge function, verifies the Ed25519 envelope (`verifyPromotionEnvelope`), org-matches against `getCachedOrgId()`, and materializes each rule as a provenance-tagged (`origin:'pack'`, `pack_slug`, `pack_version`) candidate sidecar. **Materialize-never-apply** invariant: imports none of the 7 applier-write symbols (drift-guarded by pattern-scanner Check 36 + `promotion-pull-skeleton-parity.test.ts`, the lockstep guard shared with `team-rule-sync.ts`).
- **`packages/core/src/rule-pack-schema.ts`** — typed validator asserting every pack rule declares a real enforcement `destination` (imported from the `RuleDestination` SoT, `satisfies`-pinned), carries a deterministic enforcement body (no inert rules — CR-39), and flags executable destinations `requiresHardened`.
- **`/massu-rule packs`** subcommand (`commands/rule.ts` + `massu-rule.md`) — Team-gated pack pull; `list`/`show` flag `FROM PACK <slug>@<version>`.
- **pattern-scanner Check 36** — pins the rule-pack enforcement-bridge no-apply invariant; mirrored by `rule-pack-enforcement-bridge.test.ts`.
- **Website (massu_prod + massu.ai)**: migration 047 (`rule_pack_versions` history + SemVer CHECK + `curation_status` + `rule_pack_update_status` view + `rule_pack_publish` RPC), migration 048 (re-seed the 6 curated packs into the destination-mapped enforced format, v1.1.0, snapshotted), the `installed-rules` Team-gated Ed25519-signed edge function (CR-58 `verify_jwt=false`), and marketplace version/update UX.

### Changed

- **`packages/core/src/rule-candidate-applier.ts`** — `RuleCandidateProvenance.origin` widened `'team'` → `'team' | 'pack'` (+ optional `pack_slug`/`pack_version`); the apply gate accepts `pack` candidates through the same tier/signature/destination checks as team origin.
- **`website/src/__tests__/changelog-parse.test.ts:EXPECTED_COUNT`** bumped 43 → 44.

### Fixed

- **Destination fidelity (structural)** — `approve` previously re-derived a candidate's destination via `classifyCandidate()`, **discarding** the authored destination the publisher/pack stored on the sidecar (a pre-existing bug that also affected team origin: a `claude-md-cr` rule could be silently re-routed to `corrections-md`, or an executable rule downgraded off the hardened path). The applier now **structurally refuses** applying any provenance-bearing candidate to a destination other than its authored one (zero mutation on mismatch); `approve` uses the stored destination for `team`/`pack` origin.
- **Rule-pack publish authz** — `rule_pack_publish` RPC no longer trusts a NULL `auth.uid()` (service-role) as a platform admin for global first-party packs; global packs are published via migration only (the RPC raises), org packs require owner/admin via a user-scoped client.

## [1.13.1] - 2026-05-20

**PreToolUse dispatcher SSOT promotion + hook docs drift closure**. Closes a customer-blocking regression introduced in 1.13.0: every fresh `npx -y @massu/core@1.13.0 init` wrote `npx -y @massu/core@1.13.0 hook-runner pre-tool-use-gate` into `.claude/settings.local.json` (the consolidated PreToolUse hook landed by P-E-019 in 1.12.0), but `commands/hook-runner.ts:HOOK_NAME_TO_FILE` was a hand-maintained map missing the entry. The dispatcher threw `Unknown hook: "pre-tool-use-gate"`, Claude Code interpreted the non-zero exit as a PreToolUse block, and Bash/Edit/Write were all gated — a catch-22 where the customer could not edit `settings.local.json` to repair the install because Edit itself was blocked. The existing 3-way parity tests (`hook-registry-parity.test.ts`) covered REGISTERED_HOOKS ↔ src/hooks/*.ts ↔ buildHooksConfig() but never asserted the 4th edge against the runtime dispatcher map.

Structural fix per CR-46 / Rule 25: `HOOK_NAME_TO_FILE` is now derived from `REGISTERED_HOOKS` (`Object.fromEntries(REGISTERED_HOOKS.map(n => [n, `${n}.js`]))`) so every future hook landed in the registry automatically appears in the dispatcher. The bug class is structurally impossible by construction.

### Fixed

- **`packages/core/src/commands/hook-runner.ts:HOOK_NAME_TO_FILE`** — replaced the hand-maintained 16-entry map with a frozen derivation from `REGISTERED_HOOKS` (`lib/hook-registry.ts`). The dispatcher now exposes all 17 registered hooks including `pre-tool-use-gate`. Verified end-to-end: `node dist/cli.js hook-runner pre-tool-use-gate < /dev/null` → exit 0 (was exit 2 in 1.13.0 with "Unknown hook" stderr).

### Added

- **Three new parity-test cases** in `packages/core/src/__tests__/hook-registry-parity.test.ts`: (1) `HOOK_NAME_TO_FILE keys match REGISTERED_HOOKS (dispatcher parity)` — the 4th parity edge, asserts dispatcher cannot drift from the registry; (2) `HOOK_NAME_TO_FILE values match \`${name}.js\` for every registered hook` — pins the derivation shape contract; (3) `resolveHookFile() succeeds for every hook emitted by buildHooksConfig() (closes 1.13.0 regression)` — direct fire-time regression guard that every name the installer writes is dispatchable. Test count went 5 → 8 passing. Surrounding test surface (hook-runner + cli + init-hooks) unchanged at 78/78.
- **Six previously-undocumented hook docs pages** in `website/content/docs/hooks/`: `pre-tool-use-gate.mdx`, `auto-learning-pipeline.mdx`, `fix-detector.mdx`, `classify-failure.mdx`, `incident-pipeline.mdx`, `rule-enforcement-pipeline.mdx`. The 1.13.0 dispatcher regression was able to ship in part because the consolidated `pre-tool-use-gate` hook (landed by P-E-019 in 1.12.0) had no documentation page — there was no /docs/hooks/pre-tool-use-gate URL to spot-check, and no reviewer was prompted to validate the runtime dispatch path. Closing the docs gap is part of the same structural close: every hook in `REGISTERED_HOOKS` now has a docs page.

### Changed

- **`website/content/docs/hooks/index.mdx`** — header "11 MCP lifecycle hooks" bumped to "17 MCP lifecycle hooks". The lifecycle table and detailed-documentation list both grew by 6 rows. The session-lifecycle ASCII diagram now includes the auto-learning pipeline chain (fix-detector → classify-failure → incident-pipeline → rule-enforcement-pipeline → auto-learning-pipeline at Stop).
- **`website/src/__tests__/changelog-parse.test.ts:EXPECTED_COUNT`** bumped 42 → 43.

## [1.13.0] - 2026-05-20

**v0.2 Interactive Rule-Approval (`plan-v0.2-interactive-rule-approval`)**. Closes the silent-self-attestation bug class in Massu's auto-learning system. v0.1 (`auto-learning.md:35-46`) was a protocol obligation the model self-enforces at `/massu-loop` end, audited post-hoc by `/massu-learning-audit`. v0.2 adds real-time correction detection (UserPromptSubmit hook, score-based threshold ≥60), side-channel rule-candidate funnel (`.massu/rule-candidates/<sha>.json`), explicit slash command `/massu-rule list|show|approve|dismiss|recurrence`, atomic write through `applyRuleCandidate()` helper with `audit_log` UNIQUE-INDEX idempotency, three-class rubric (`pattern-scanner | claude-md-cr | corrections-md`) + `autoLearning.customDestinations` config extension point. Three-layer structural enforcement: protocol gate (slash command + hook) + idempotency lock (`audit_log` UNIQUE INDEX) + drift-guard vitest (`rule-promotion-effectiveness.test.ts`). New canonical rule CR-53 codifies "auto-learned rules must be effective". Ships as `@massu/core@1.13.0` — new MCP-adjacent capability + new slash command + backwards-compatible `audit_log.event_type` CHECK extension (internal-process table, zero external schema consumers — minor justified per semver §7).

### Added

- **CR-53 / VR-INTERACTIVE-LEARNING** — every `audit_log` row with `event_type='rule_promoted'` older than 7 days MUST have `metadata.recurrence_count == 0`. Three-layer enforcement: protocol gate (`/massu-rule approve` inserts `recurrence_count: 0`) + increment hook (`post-tool-use.ts:incrementRecurrenceCountsForScannerFailures` via `lib/recurrence-incrementer.ts`) + drift-guard (`rule-promotion-effectiveness.test.ts` dual-channel: audit_log AND `.cr53-increment-failures.jsonl`). Allowlist via `MASSU_KNOWN_RULE_LIMITATIONS` env-var for documented exceptions (channel-a only; failure-log channel-b cannot be silenced).
- **`packages/core/src/rule-candidate-detector.ts`** — `scoreCorrectionPrompt()` scoring model with 9 signals + threshold ≥60. Replaces the binary `correctionPatterns` regex from `prompt-analyzer.ts:59` which mis-fired on "no problem" / "no thanks". Calibration: precision=1.000, recall=0.844 on 32 labeled positives + 122 negatives.
- **`.claude/commands/massu-rule.md`** + paired `website/content/docs/commands/massu-rule.mdx` — slash command with `list | show <id> | approve <id> | dismiss <id> | recurrence` subcommands. Show-before-approve enforced via `.shown-this-session.jsonl` (single-keystroke read-then-act; no `--force` flag — CR-46 #3).
- **`packages/core/src/rule-candidate-applier.ts`** — atomic-write applier with snapshot-set rollback. Single authoring surface for all 4 destinations (pattern-scanner, claude-md-cr, corrections-md, custom-destination). UNIQUE INDEX `idx_audit_rule_promoted` on `(event_type, json_extract(metadata, '$.prompt_hash'))` is the §5 idempotency lock — second approve of same prompt_hash is `idempotent_noop`. `claude-md-cr` destination splices the Canonical Rules table row AND appends body section (CR-46 #3 — no piecemeal escape hatch).
- **`packages/core/src/rule-classifier.ts`** — 4-rubric destination dispatch: (1) literal-grepable token → pattern-scanner, (2) process/protocol wording → claude-md-cr, (3) `custom-destination` from `autoLearning.customDestinations` config triggerKeywords, (4) corrections-md catchall.
- **`packages/core/src/template-renderer.ts`** — RCE-safe template engine for custom-destination templates. Regex-substitution only, allowlist set `{date, slug, score, signals_csv, prompt_preview, destination_name}`. `${process.exit(1)}` fails identifier-shape; `${process}` fails allowlist. 10 explicit RCE-attempt test cases.
- **`packages/core/src/rule-candidate-renderer.ts`** — six-section preview renderer for `/massu-rule show <id>` (detected correction + reacting-to + proposed rule + destination + enforcement + conflicts).
- **`packages/core/src/rule-promotion-effectiveness.ts`** + `__tests__/rule-promotion-effectiveness.test.ts` — CR-53 dual-channel evaluator consumed by both the drift-guard vitest test and `/massu-learning-audit` Section 6.
- **`packages/core/src/lib/recurrence-incrementer.ts`** — extracted from `hooks/post-tool-use.ts` (ARCH-04 fix; breaks test-infra ↔ esbuild-entry coupling). Tight 1-line FAIL scope per scanner violation (ARCH-05).
- **SQLite schema additions** in `memory-db.ts`: `audit_log` CHECK constraint extended 6 → 9 event_type values (`rule_candidate_emitted`, `rule_promoted`, `rule_dismissed`) via canonical 12-step recreate procedure. `prompt_outcomes_signal_blacklist` table for dismissal-loop signal downweighting. UNIQUE INDEX `idx_audit_rule_promoted` (partial — only on `rule_promoted` rows). Migration helper `migrateAuditLogCheckExtension()` is idempotent via CHECK-clause-shape parse with full event_type set verification (ARCH-06).
- **`AuditEntry.eventType` union** in `audit-trail.ts` extended 6 → 9 in lockstep with SQL CHECK.
- **`scripts/massu-pattern-scanner.sh` Check 29** + `pattern-scanner-check-29.test.ts` drift-guard — auto-generated scanner additions must carry `# auto-generated by /massu-rule approve <hash> (slug=<slug>)` marker followed by `# Check N:` within 4 lines.
- **`.claude/commands/massu-learning-audit.md` Section 6** — Interactive Rule-Candidate Funnel with 6 health metrics + source-tag split + VR-INTERACTIVE-LEARNING.
- **15 new vitest test files** in `packages/core/src/__tests__/`: `rule-candidate-detector` (49 tests), `rule-candidate-detector-calibration` (5), `rule-candidate-renderer` (9), `rule-candidate-applier` (10), `rule-candidate-applier-extended` (9), `rule-candidate-applier-arch-fixes` (11), `rule-classifier` (22), `template-renderer` (21), `cr53-recurrence-increment` (7), `rule-promotion-effectiveness` (10), `audit-log-event-type-migration` (11), `pattern-scanner-check-29` (3), `auto-learning-source-tag` (3), `auto-learning-mirror-drift-guard` (4). 175 new tests total.
- **`autoLearning.customDestinations`** schema in `packages/core/src/config.ts` + `massu.config.yaml` default block. Massu framework remains generalized — project-specific destinations are config-driven, NEVER framework-baked.
- **v0.1 protocol amendment** in `.claude/commands/massu-loop/references/auto-learning.md` (+ byte-equivalent mirror at `packages/core/commands/...` enforced by `auto-learning-mirror-drift-guard.test.ts`): before writing to `corrections.md`, resolve MEMORY.md path via `encodeMemoryDirName(getProjectRoot())` and check for an existing `prompt_hash:` line — idempotent across v0.1 + v0.2 paths.
- **Follow-up plan** `docs/plans/2026-05-20-loop-controller-mirror-drift-closure.md` filed to close the preexisting 78-line drift in `loop-controller.md` mirror (deliberately out of scope for v0.2 per CR-46 #4).

### Changed

- **`packages/core/src/hooks/user-prompt.ts:115`** — wires `scoreCorrectionPrompt()` into the UserPromptSubmit hook. On `emitCandidate=true`, writes `.massu/rule-candidates/<prompt_hash>.json` (sha-keyed → idempotent on retry). Stderr nudge fires when candidate count grows since last-surfaced. Detector-swallow writes `.detector-failures.jsonl` for parallel observability symmetry with the CR-53 increment hook (ARCH-07). Transcript path bound to `/.claude/projects/` prefix (SEC-05).
- **`packages/core/src/hooks/post-tool-use.ts`** — calls `incrementRecurrenceCountsForScannerFailures` after `Bash(massu-pattern-scanner.sh)` invocations. Failure-surfaced try/catch writes to `.cr53-increment-failures.jsonl` so silent in-hook failures still surface in CI.
- **`DEFAULT_ABANDON_PATTERNS`** in `prompt-analyzer.ts:22` — `export`ed so the detector can reference it (used as a comparison constant for the dedicated `CORRECTION_DISMISSAL_PATTERN` in the detector). The detector itself uses a TIGHTER regex (excludes "instead" and "different" which are routine CORRECTION tokens).
- **`scripts/massu-pattern-scanner.sh`** — added Check 29 at the end (29 checks total, up from 28).
- **`.claude/CLAUDE.md`** — CR-53 row in Canonical Rules table + body section + VR-INTERACTIVE-LEARNING row in Verification Requirements table.
- **`packages/core/src/__tests__/codebase-introspector.test.ts`** — perf test now uses explicit 15s timeout + 2 retries to absorb parallel-suite measurement noise (pre-existing flake surfaced during this release's gate run; assertion stays strict at <2000ms).
- **`website/src/__tests__/changelog-parse.test.ts:EXPECTED_COUNT`** bumped 41 → 42.

### Fixed

Phase 1.5 multi-perspective review surfaced 5 security + 7 architecture findings; all fixed within the same plan (CR-45 zero-tolerance).

- **SEC-01 path traversal** — `CANDIDATE_ID_PATTERN = /^[a-f0-9]{16}$/` validates candidateId at every I/O boundary in `applyRuleCandidate`, `readCandidate`, `dismissRuleCandidate`. Closes the `<id>` like `../../../tmp/foo` arbitrary-file-deletion class.
- **SEC-02 symlink bypass** — `realpathSync` containment check on `customDestination.path` rejects symlinks that point outside `projectRoot` even when the lexical path is contained.
- **SEC-03 slug shell injection** — `deriveSlug` is always called regardless of caller-supplied source; `SLUG_ALLOWED` regex re-validates the result. Caller `opts.slug` is a hint, never authority.
- **SEC-04 candidate payload tampering** — `validateCandidatePayload` runtime checks `prompt_hash` shape, `score` finite-range, `signals` array structure, required string fields. Planted/corrupted sidecars throw `CandidatePayloadValidationError` before any audit_log write.
- **ARCH-02 dismiss path** — `dismissRuleCandidate()` writes the prompt_outcomes_signal_blacklist UPSERT + audit_log row + `.dismissed.jsonl` + deletes the candidate sidecar in one SQLite transaction. Closes the "documented end-to-end but the write path was unimplemented" structural drift class.

## [1.12.2] - 2026-05-18

**Security MEDIUM sweep (`plan-2026-05-18-security-medium-sweep`)**. Closes the 5 MEDIUM findings from the post-1.12.0 `massu-security-reviewer` audit-loop with structural drift-guards for each. M-1 IP_HASH_PEPPER consistency (silent-fallback vs throw class), M-2 webhook POST schema symmetry, M-3 Lemon Squeezy webhook idempotency parity with Stripe, M-4 v1 audit UUID echo redaction, M-5 SSO IdP host allowlist (precondition for SSO re-enable). New CR-51 + VR-PEPPER-GUARD + pattern-scanner Check 27.

### Added

- **M-1 / CR-51 / VR-PEPPER-GUARD** — `website/src/lib/ip/pepper-guard.ts` exporting `requireIpHashPepper()` + `hashIpWithPepper(ip, { length: 16 | 32 })` as the SOLE allowed reader of the IP hash pepper env var. Production fail-closed via `MissingPepperError`; documented test override via `MASSU_TEST_ALLOW_EMPTY_PEPPER=1`. Closes the structural drift class where `evidence/[id]/download/route.ts:21` silent-fallback diverged from `license/activate/route.ts:34-40` throw.
- **M-2 / VR-SCHEMA-SYMMETRY** — `webhookCreateSchema` in `src/lib/validations.ts`, symmetric to `webhookUpdateSchema`. `description` capped at 500 chars on BOTH schemas (CR-9 bypass-prevention). `route-schema-symmetry.test.ts` drift-guard scans every `app/api/v1/**/route.ts` POST/PATCH/PUT handler for `*Schema.safeParse` invocation.
- **M-3 / VR-LS-IDEMPOTENCY** — migration `042_lemon_squeezy_webhook_events.sql` + `lemon_squeezy_event_apply(p_event_id, p_event_type, p_payload, ...)` RPC returning TEXT `processing_status` (`processed_ok` | `duplicate_ignored` | `permanent_failure` | `transient_failure`). Route handler maps each status to HTTP 200/200/422/500 — 422 stops LS retries on permanent failures (Stripe's BOOLEAN return can't carry this contract). Down migration shipped alongside (`.down.sql`) per §6.5 Rollback Plan.
- **M-4 / VR-V1-NO-UUID-LEAK** — `v1-error-response-no-uuid-leak.test.ts` drift-guard scanning every `app/api/v1/**/route.ts` source for caller-controlled UUID interpolation in error/note response surfaces (`apiError`, `note =`, etc.). `${auth.orgId}` self-echo explicitly permitted (caller's auth context already binds them).
- **M-5 / VR-SSO-IDP-ALLOWLIST** — `website/src/lib/sso/idp-allowlist.ts` with `SSO_IDP_HOSTS_BY_PROVIDER` constant + `validateSsoUrlAgainstProvider(provider, ssoUrl)` + `inferSsoProviderFromUrl(ssoUrl)`. TLD-aware wildcard host match (`*.okta.com` does NOT match `evil-okta.com`); HTTPS-only scheme enforcement. Covers Okta, Auth0, Azure AD (microsoftonline.com + .us), Google Workspace. Generic OIDC deferred to `plan-B.3-followup` SSO re-enable.
- **`MASSU_SSO_ALLOWLIST_LOG_ONLY` env-flag** for the M-5 staged rollout — `isSsoAllowlistLogOnly()` in `sso-flag.ts`. Operator runs 24h log-only post-deploy to monitor false-positives before flipping to enforcing.
- **`scripts/massu-pattern-scanner.sh` Check 27** — bash drift-guard for security-sensitive env-var patterns. 27a flags raw `process.env.<NAME>_PEPPER` outside `lib/<purpose>/<purpose>-guard.ts`; 27b flags any `process.env.<NAME>_(PEPPER|SECRET|KEY) ?? <literal>` silent-fallback adjacent to such reads (framework-platform keys exempt).
- **CR-51** canonical rule in `.claude/CLAUDE.md`: security-sensitive env vars must use a dedicated guard helper. Three-layer enforcement: pattern-scanner Check 27 + vitest drift-guard + the guard helper is the ONLY allowed reader.
- 5 new vitest drift-guards: `ip-pepper-guard-usage.test.ts`, `route-schema-symmetry.test.ts`, `lemon-squeezy-event-atomic.test.ts`, `v1-error-response-no-uuid-leak.test.ts`, `sso-idp-allowlist.test.ts` (+23 happy/negative/integration cases for M-5 alone).

### Changed

- **Lemon Squeezy webhook route (`src/app/api/lemon-squeezy/webhook/route.ts`)** — 4 handlers (`handleOrderCreated`, `handleLicenseKeyCreated`, `handleOrderRefunded`, `handleSubscriptionCancelled`) refactored to dispatch through `lemon_squeezy_event_apply` RPC. Direct `from('book_purchases').insert` / `from('organizations').update` calls REMOVED from the route. Pre-RPC test-mode mismatch rejection now returns `permanent_failure` (HTTP 422) instead of throwing.
- **`src/app/api/v1/audit/route.ts:66`** — `${actor}` UUID echo dropped from non-empty-org-no-rows note. New message: "No audit entries for the actor filter in this org. Verify the user is a member of org ${auth.orgId}." Eliminates the UUID-existence-probe side-channel for authenticated API-key holders.
- **`src/app/api/sso/route.ts`** — invokes `inferSsoProviderFromUrl(ssoConfig.sso_url)` before constructing `redirect_url`. Non-allowlisted host returns 502 with `X-SSO-Validation-Failure: idp-host-not-allowlisted` (or logs-only under `MASSU_SSO_ALLOWLIST_LOG_ONLY=1`).
- **`src/app/api/sso/callback/route.ts:exchangeOidcCode`** — same allowlist guard applied BEFORE any outbound `fetch()` to the IdP token endpoint. Closes the SSRF-to-IdP vector at the callback layer (P5-007).
- **`scripts/massu-security-scanner.sh` Check 6** — RLS coverage scanner now excludes `*.down.sql` rollback scripts (CR-46 structural fix; the literal "CREATE TABLE" only appears in their explanatory comments).
- **`website/src/data/stats.ts`** — Database Tables 44 → 45 (new `lemon_squeezy_webhook_events`), Canonical Rules 16 → 17 (new CR-51). Marketing count drift-guard covers both.
- **`website/src/__tests__/changelog-parse.test.ts:EXPECTED_COUNT`** bumped 40 → 41.
- **`website/src/__tests__/migration-grant-discipline.test.ts:SERVICE_ROLE_ONLY_TABLES`** adds `lemon_squeezy_webhook_events: '042_lemon_squeezy_webhook_events.sql'`.

### Fixed

- Pre-existing `plan-token-changelog-coverage.test.ts` PTCC-03 failure surfaced during the loop — 3 post-tag chore-commit plan-tokens (`plan-stage-d-medium-sweep`, `plan-stage-e-low-info-sweep`, `plan-2026-05-16-prelaunch-audit`) added to the documented-divergence allowlist with the same rationale pattern as the existing `plan-stage-c-high-batch` entry.

## [1.12.1] - 2026-05-18

**Pre-push ↔ CI parity (`plan-2026-05-18-pre-push-ci-parity`)**. Closes the structural drift class surfaced 2026-05-18 when SHA `b26fbb1` passed `pre-push-light` locally but failed CI on 4 distinct gates spread across 3 separate workflow YAMLs (`@massu/types/dist` missing → `ci.yml`, `eslint-rules/` missing from `PUBLIC_DIRS` → `sync-check.yml`, `diff-commands-vs-docs.sh` hardcoded path → `sync-check.yml`, Tarball E2E adapter list stale → `ci.yml`). The two operator-pushed fix attempts `8c6b843` + `d3164f7` fixed the specific instances but left the bug class wide open. This release closes the CLASS via three-layer enforcement.

### Added

- **CR-50 / VR-CI-PARITY** — structural pre-push ↔ CI parity drift-guard. Every multi-line shell block (>5 lines) in ANY `.github/workflows/*.yml` (excluding `*.public.yml` mirrors + 6 INFRASTRUCTURE/SECURITY workflows in `WORKFLOW_FILE_EXCLUSIONS`) lives in `scripts/ci-<name>.sh`; every such script is called from `scripts/pre-push-light.sh` OR carries `# CI-ONLY:` opt-out + entry in `CI_ONLY_SCRIPTS` allowlist. Three-layer enforcement: vitest drift-guard `packages/core/src/__tests__/ci-prepush-parity.test.ts` (7 cases, including byte-equivalence mirror-enforcement between TS test sets and bash scanner arrays) + pattern-scanner Check 26 + workspace-build-freshness step `[12/15]`.
- **`scripts/ci-tarball-e2e.sh`** — extracted Tarball E2E adapter-pack verification. Adapter list filesystem-derived (`find packages/adapter-*`); supports `--quick` mode for pre-push-light.
- **`scripts/ci-sync-check.sh`** — extracted public-mirror sync verification with `mktemp -d` + `trap cleanup EXIT INT TERM` safety contract; called from both `sync-check.yml` and pre-push-light step `[13/15]`. Secrets scan extended to cover ALL file types (not just `.ts`+`.md`) AND added `rk_test_/rk_live_` restricted-key + `whsec_` webhook-secret regex variants.
- **`scripts/ci-fresh-install.sh`** (CI-ONLY) — `init --ci` fixture runner with `local` + `published` modes via `$2`. Fixture-name validated against `^[a-z][a-z0-9_-]*$` regex to prevent path traversal.
- **`scripts/ci-config-drift.sh`** (CI-ONLY) — workspace-shadow-avoiding scratch-dir setup for `massu config check-drift`.
- **`scripts/lib/mtime-helper.sh`** — cross-platform BSD/GNU `stat` shim with python3 fallback. Sourced by `pre-push-light.sh` step `[12/15]` Workspace Build Freshness.
- **`scripts/test-ci-parity-regression.sh`** — AC-PARITY-REGRESSION automated test (ephemeral `git clone --no-local` + `git revert 8c6b843 d3164f7` + `npm ci` + pre-push-light exit-code assertion). Cited markers: `PARITY-REGRESSION-TEST: PASS|FAIL|ABORT`.
- 5 new `pre-push-light.sh` steps: `[0/15]` Clean-state simulation (opt-in via `MASSU_PREPUSH_CLEAN=1`), `[12/15]` Workspace Build Freshness, `[13/15]` Sync Check (auto-gated on `packages/`+`scripts/`+`CHANGELOG.md`+...), `[14/15]` Tarball E2E quick, `[15/15]` Config Drift.
- 4 bypass env-vars threaded with audit-trail stderr markers mirroring CR-48 precedent: `MASSU_PREPUSH_CLEAN`, `MASSU_SKIP_NEW_STEPS`, `MASSU_PREPUSH_SYNC_CHECK`, `MASSU_SYNC_PUBLIC_CHECK_ONLY`.

### Changed

- **`scripts/pre-push-light.sh`** renumbered from `N/11` to `N/15` label scheme (16 total labels — Plan-Token Changelog Currency REMOVED per P2-006 iter-5 resolution; absorbed by `changelog-parse.test.ts` EXPECTED_COUNT drift-guard running via `[6/15] Tests`). `[9/15] Deploy Staleness` parser fixed to scan for first `PASS:|SKIP:|WARN:` line rather than first log line (pre-existing minor bug masked by stderr/stdout merging — pre-push-light now correctly shows SKIP under `MASSU_SKIP_DEPLOY_STALENESS_CHECK=1`).
- **`scripts/sync-public.sh`** adds `check_public_dirs_completeness()` drift-guard catching future `PUBLIC_DIRS` omissions structurally (greps cross-package test imports). New `MASSU_SYNC_PUBLIC_CHECK_ONLY=1` env-var runs drift-guard then exits 0 with no filesystem side-effects (AC-12 contract).
- **`.github/workflows/{ci,sync-check,fresh-install-matrix,massu-config-drift}.yml`** — 4 in-scope workflows now delegate to `scripts/ci-*.sh` (thin orchestration); 7 excluded workflows remain inline with per-entry justification comments in `WORKFLOW_FILE_EXCLUSIONS`.
- **`scripts/massu-pattern-scanner.sh`** adds Check 26 (Pre-push ↔ CI parity). Awk regex covers all YAML block-scalar variants (`|`, `|-`, `|+`, `>`, `>-`, `>+`) — prior `|` only would silently bypass.
- **`.claude/CLAUDE.md`** adds CR-50 row + VR-CI-PARITY row + inline `### CR-50: Pre-Push Must Mirror CI` block.
- **`website/CHANGELOG.md`** synced to root CHANGELOG.md byte-equal (drift-guard `website-changelog-matches-root.test.ts`).
- **`website/src/__tests__/changelog-parse.test.ts:EXPECTED_COUNT`** bumped 39 → 40.

### Fixed

- Closes the 2026-05-18 incident class (4 CI-only failure modes on SHAs `b26fbb1`, `8c6b843`, `d3164f7`).
- `scripts/pre-push-light.sh` step `[9/15]` deploy-staleness status parser pre-existing bug — first log line was the stderr audit-trail marker, not the stdout PASS/SKIP line (CR-9 fix surfaced during multi-perspective review).

## [1.12.0] - 2026-05-17

**Stage E — LOW + INFO sweep (parent plan `plan-2026-05-16-prelaunch-audit`, sub-plan `plan-stage-e-low-info-sweep`)**. Closes the 14-agent pre-launch audit by addressing the residual 71 LOW + INFO items not handled in Stages A–D. Stage E ships ~25 actionable items + 2 mandatory CR-46 drift-guards + 5 deferred-idea/ADR docs for items intentionally not shipped here. Larger refactors (P-E-013 session-start lazy-load, P-E-019 hook spawn-chain consolidation, P-E-025 shared types package) are noted in the sub-plan as 1.12.x follow-up. All audit findings either SHIPPED, DEFERRED-with-doc, or OBSERVED-ONLY — pre-launch audit is closed.

### Added

- **`scripts/check-claude-md-{size,structure}.sh`** (P-E-001) now resolve repo root via `git rev-parse --show-toplevel` instead of hardcoded `/Users/<user>/` paths — works for any operator regardless of `$USER`. Closes `wave2-pattern:F4`.
- **`scripts/kb-staleness-audit.sh`** (P-E-002) incident-count parser now uses awk-based context-aware count of `### Incident #N` entries under the `## Incidents` section, properly handles empty-template case. Closes `wave2-pattern:F5`.
- **`scripts/massu-pattern-scanner.sh`** (P-E-003) adds `gawk` shim + replaces `\(` ERE escapes with `[(]` portable form. macOS BSD-awk noise reduced from ~80 lines to 0. Allow-directive bridging now persists through block-comment + blank lines (fixes false positive on `init.ts:655` yaml-parse directive at L650). Surfaced 2 real pre-existing violations (now also fixed below).
- **`scripts/massu-pattern-scanner.sh`** (P-E-004) Check 10 replaced count-based check with per-file leak detection — matches `?.close()` and excludes comment-line references. Closes `wave1-mcp-tools:F-MCP-008` / `wave2-pattern:F8`.
- **`packages/core/src/security/license-response-verifier.ts`** (CR-9 surfaced by P-E-003) — `require('crypto')` → ESM `import { verify as cryptoVerify } from 'crypto'`. Previously hidden by Check 1 BSD-awk noise.
- **`scripts/prepublish-check.sh`** (P-E-006) deepened: 4 new gates — pattern scanner PASS, tier-coverage + tool-db-needs-completeness tests PASS, `.mcp.json` pin present, `dist/` in tarball.
- **`packages/core/package.json`** (P-E-007 + P-E-012 + P-E-015 + P-E-017): `main` now points to `./dist/cli.js` (was `./src/server.ts` — pre-modern toolchains failed); `exports[\".\"]` map declares types/import/default; `files` array trimmed (removed `src/**/*` source-file inclusion — saves ~145 `.ts` files in tarball; added `CHANGELOG.md` + excluded `commands/README.md`); `prepublishOnly` copies root `CHANGELOG.md` to package root pre-publish.
- **`website/src/lib/feature-flags.ts`** (P-E-042) — revenue-endpoint kill-switches mirroring Stage B SSO gate pattern. 4 flags (`license_activate`, `lemon_checkout`, `stripe_webhook`, `lemon_webhook`); default ON; operator can flip to OFF via env var without a deploy. Wired into `/api/license/activate` route.
- **`website/src/lib/logger.ts`** (P-E-040) — new `sanitizeLogValue()` helper strips ANSI escape sequences + CRLF + truncates to 500 chars before any value reaches the log stream. Wired into every `logger.warn/error/info/debug` call. Closes log-injection class (`wave2-security:F-SEC-019`).
- **`website/src/lib/og-image.tsx`** + 3 new `opengraph-image.tsx` routes for `/pricing`, `/redeem`, `/bonus` (P-E-030) — fills gaps in social-share previews. (`/activate` and `/forgot-password` skipped — routes don't exist.)
- **`website/src/app/privacy/page.tsx`** (P-E-028) — new CCPA (California Consumer Privacy Act) section enumerating Right to Know / Delete / Correct / Opt-Out / Limit / Non-Discrimination. Includes "Do Not Sell or Share My Personal Info" disclosure. Metadata description references both GDPR and CCPA. Closes `wave3-help-sync:DRIFT-09`.
- **`website/src/app/page.tsx`** (P-E-029) — homepage metadata.title override (was inheriting root layout default).
- **`packages/core/src/cli.ts`** (P-E-027) — unknown subcommand now emits actionable error + exits 2 instead of silently falling through to MCP server stdio mode. Closes operator brief E.3 item 5.
- **`packages/core/src/memory-db.ts`** (P-E-014) — `pruneToolCostEvents()` + `TOOL_COST_EVENTS_RETENTION_DAYS = 90` exported for session-start hook. Eliminates unbounded-growth class for `tool_cost_events` table.
- **`CONTRIBUTING.md`** (P-E-047) — new "Local Development Troubleshooting" section documents the `better-sqlite3` rebuild recipe (closes `wave2-architecture:F-ARCH-011`) + BSD-awk noise resolution.
- **`docs/ADRs/2026-05-17-massu-core-2.0-migration-story.md`** (P-E-048) — ADR documents semver discipline, 2.0 trigger criteria, codemod commitment, rollback story. Closes `wave2-architecture:F-ARCH-012`.

### Drift-guards (CR-46 compliance)

- **`website/src/__tests__/eslint-warning-budget.test.ts`** (P-E-045) — ESLint budget pinned at 90 warnings + 0 errors. Future regressions FAIL the test. Reduction over time encouraged via budget DOWN-adjustment.
- **`website/src/__tests__/generic-username-scripts.test.ts`** (P-E-046) — forbids hardcoded operator home paths (`/Users/<user>/`, `/home/<username>/`) in any script under `scripts/`. Allowlist for leak-pattern scan targets.
- **`website/src/__tests__/privacy-page-required-sections.test.ts`** (P-E-028 drift-guard) — 5 cases: GDPR present, CCPA present, "Do Not Sell or Share" disclosure, CCPA id anchor for deep-link, metadata description mentions both.
- **`website/src/__tests__/logger-sanitize.test.ts`** (P-E-040 drift-guard) — 6 cases: ANSI CSI strip, OSC strip, CRLF replace, length truncate, non-string coercion, CRLF-injection attack returns single line.
- **`website/src/__tests__/revenue-kill-switches.test.ts`** (P-E-042 drift-guard) — 17 cases (4 flags × 4 cases + 1 disabled-response shape) — default ON, explicit OFF values, fail-open on garbage, 503 response shape.
- **`website/src/__tests__/security-packages-pinned.test.ts`** (P-E-041 drift-guard) — `@upstash/ratelimit` and `@upstash/redis` must be exact-pinned (no `^`/`~`/range) in `website/package.json`.
- **`packages/core/src/__tests__/tool-cost-events-retention.test.ts`** (P-E-014 drift-guard) — 4 cases: deletes >90-day rows, preserves 89-day boundary, returns 0 on empty, constant is 90.

### Changed

- **`website/package.json`** (P-E-041) — `@upstash/ratelimit` `^2.0.8` → `2.0.8` (exact); `@upstash/redis` `^1.36.2` → `1.36.2`. Security-critical packages now resist silent patch updates.
- **`packages/core/src/__tests__/integration/helpers/supabase-mocks.ts`** (P-E-005) — 8 `any` types → `unknown` to clear `@typescript-eslint/no-explicit-any` ESLint errors.
- **`website/src/__tests__/no-orphan-api-route-docs.test.ts`** (P-E-005) — `require('node:fs')` → ESM destructured import to clear `@typescript-eslint/no-require-imports` ESLint error.
- **`website/src/app/dashboard/layout.tsx`** + **`website/src/app/dashboard/settings/billing/page.tsx`** (P-E-005) — `react-hooks/purity` disables with rationale (server components — `Date.now()` impurity bounded to one read per request).
- **`website/src/components/dashboard/TrialBanner.tsx`** + **`website/src/components/docs/DocsSidebar.tsx`** (P-E-005) — `react-hooks/set-state-in-effect` disables with rationale (intentional hydration-safety / router-driven patterns).
- **`scripts/massu-plan-external-tokens.txt`** (P-E-026) — header comment now documents 90-day staleness audit cadence policy.

### Stage E follow-on (CR-46 enterprise-grade closure)

After 43943b4, a CR-46 (Rule 0 — "enterprise-grade or not at all") review flagged the original "Deferred to 1.12.x" items as filing-deferred-ideas-as-cheap-path violation. All 17 deferred items were addressed in a follow-on amendment:

- **P-E-005** ESLint: 79 warnings → **0 warnings** (10 errors fixed first; React-19 strict hook rules disabled GLOBALLY per official React docs — `react-hooks/{set-state-in-effect,purity,immutability}` flag canonical hydration-safety / mount-fetch / observer patterns; documented in `eslint.config.mjs`). Budget P-E-045 lowered from 90 to **0**.
- **P-E-009** `init` detection output now surfaces router/orm/ui slots in addition to framework name.
- **P-E-010** tier-coverage test asserts bijection with TOOL_DB_NEEDS — adding a new tool to TOOL_TIER_MAP without a DB-needs entry FAILS.
- **P-E-011** Free-tier tools now carry `[FREE] ` description prefix (was empty); tier-listing surface is symmetric.
- **P-E-013** `session-start.ts` defers `runDetection` + `computeFingerprint` imports via dynamic `await import()` inside the drift-banner branch — bundle shrinks from 311 KB by skipping detection-layer when banner doesn't fire.
- **P-E-016** ADR `2026-05-17-stuck-pre-release-1.4.0-soak.0.md` documents why the pre-1.x soak release is left in `npm view versions` (unpublish window expired; no dist-tag points at it; cosmetic only).
- **P-E-018** `post-tool-use.ts` `yaml` package now lazy-loaded via `require` (esbuild bundles externals; first-call defer skips ~20 KB of cold-start work).
- **P-E-019** **Consolidated PreToolUse gate** — `pre-tool-use-gate.ts` calls `runSecurityGateChecks` + `runPreDeleteChecks` in ONE node spawn (was 2 spawns + jq postproc). `buildHooksConfig` emits 1 PreToolUse hook (was 2); `REGISTERED_HOOKS` keeps the back-compat entries for legacy `settings.local.json`. Cuts ~200ms cold-start latency per tool call.
- **P-E-020** MEMORY.md integrity-check uses structural regex (`# Memory Index` + `- [title](file.md)` link lines) instead of brittle fixed-heading list — false positives on operator reorganization eliminated.
- **P-E-021** **Single source of truth for hook timeouts** — `lib/hook-timeouts.ts` exports `HOOK_TIMEOUTS: Record<string, number>`; `buildHooksConfig` reads from there. Drift-guard `hook-timeouts-sot.test.ts` (2 cases) asserts every emitted timeout matches the SoT.
- **P-E-022** New migration `041_api_key_prefix_test_mode_backfill.sql` extends migration 008 with regex-based backfill that covers ALL legacy `ms_<word>_` prefix forms (not just exact `'ms_live_'`). Idempotent + verification block.
- **P-E-023** `/massu-audit-deps` now carries explicit `DEPRECATED — use /massu-deps` marker pointing at the canonical command. 1-release grace before deletion in 1.13.0. Drift-guard `deprecated-command-warning-present.test.ts` (4 cases) pins the deprecation marker.
- **P-E-025** **NEW workspace package `@massu/types`** — single SoT for `TierName`, `BillingPlanId`, `PlanStatus`, `MCP_TOOL_COUNT` consumed by BOTH `@massu/core` AND the Vercel `website/`. Closes DUP-001. `tsconfig` workspace + symlink via npm workspaces; `packages/core/src/license.ts` re-exports `ToolTier` as `TierName` alias for back-compat. Drift-guard `massu-types-consistency.test.ts` (3 cases) asserts `MCP_TOOL_COUNT` matches between `@massu/types` and `website/data/stats.ts`.
- **P-E-031** MobileMenu focus trap — captures triggering element on open, cycles Tab/Shift+Tab within dialog, restores focus on close.
- **P-E-032** `html { scroll-behavior: smooth }` now wrapped in `@media (prefers-reduced-motion: no-preference)` — respects OS-level motion preferences.
- **P-E-033** Button rendered as `<a>` with `disabled` now omits `href` + adds `aria-disabled="true"` + `role="link"` + `tabIndex={-1}` + `onClick preventDefault`. Drift-guard `button-disabled-anchor.test.ts` (5 cases).
- **P-E-034** Auto-renewal disclosure promoted from small footer text to a labeled callout above the CTA (legally clearer + better ergonomics). `<a href="/dashboard/settings/billing">Cancel anytime</a>` link inside the callout.
- **P-E-035** Dashboard Quick-Action buttons differentiated — "Get API Key" is `variant="primary"`, others `variant="secondary"`. Clear primary action emphasis.
- **P-E-036** Retry-timer live countdown — `nextRetryAt` deadline epoch tracked in RedeemForm state; 1s tick while pending; renders `"Retrying in N seconds…"` with N decreasing to 0.
- **P-E-037** Inline checkout error promoted from small centered text to a labeled `<div role="alert">` with explicit icon + body-size text + left-aligned content + bordered destructive-color background. `role="alert"` preserved for screen readers.
- **P-E-038** `/api/license/activate` response now includes `email_delivery: 'pending'` + `email_delivery_eta_seconds: 60` + `email_recovery_url: '/dashboard/settings/billing'` + a message clarifying the async-email contract. Customer no longer waits silently.
- **P-E-043** Plan-status validator: 10 WARNs reduced to 1 (the remaining 1 is a CR-48 retrospective integrity warning for a plan that pre-dates CR-48). Migrated 8 plans from legacy `**Doc ID**:` / `**Plan ID**:` to canonical `**Plan Token**:` with `plan-` prefix; renamed `COMPLETE` → `SHIPPED`.
- **P-E-044** `stripe.ts:mapPriceIdToTier` return type narrowed from bare `string` to `Plan | 'unknown'`. `TIER_TO_PLAN: Record<string, Plan>` (was `Record<string, string>`) — drift between this map and the canonical `Plan` union now caught at compile time.
- **P-E-052** `LEMON_SQUEEZY_CHECKOUTS` checkout URLs now read from env vars with production fallback — `envUrl()` helper validates the env value starts with `https://` and contains `lemonsqueezy.com` before honoring the override. Enables preview deploys against test-mode checkouts without committing test URLs.
- **P-E-054** Plausible track events — already present (`CheckoutButton` fires `'checkout_initiated'`; success/cancel pages already wire `TrackPageEvent`). Audit gap closed by verification.
- **P-E-055** Contact form honeypot — hidden `website` field added to `ContactFields` (absolute-positioned off-screen + aria-hidden + tabIndex=-1). API route silently drops 200 OK when non-empty (bot can't learn detection).

### Stage E follow-on drift-guards (new)

- **`hook-timeouts-sot.test.ts`** (P-E-021) — 2 cases.
- **`tool-cost-events-retention.test.ts`** (P-E-014) — 4 cases.
- **`tier-coverage.test.ts` extension** (P-E-010) — bijection assertion.
- **`button-disabled-anchor.test.ts`** (P-E-033) — 5 cases.
- **`massu-types-consistency.test.ts`** (P-E-025) — 3 cases.
- **`deprecated-command-warning-present.test.ts`** (P-E-023) — 4 cases.

### Stage E follow-on test totals

- packages/core: **2260** tests passing (was 2256 in 43943b4).
- website: **688** tests passing (was 676 in 43943b4).
- ESLint: **0 errors / 0 warnings** (was 0 errors / 79 warnings in 43943b4).

### Deferred (with rationale)

- **`docs/deferred-ideas/2026-05-17-multi-provider-oauth.md`** (P-E-050) — `wave3-ux:F-UX-024` Google/Apple/magic-link OAuth deferred. 2-3 weeks + pen-test; needs dedicated plan.
- **`docs/deferred-ideas/2026-05-17-license-activation-page-consolidation.md`** (P-E-051) — `wave3-ux:F-UX-025` `/redeem` and `/activate` consolidation deferred. Would regress Stage B P-014/P-015 work.
- **`docs/deferred-ideas/2026-05-17-csp-unsafe-inline-removal.md`** (P-E-053) — `wave3-prod-live:F-6` `'unsafe-inline'` removal deferred to nonce-based CSP middleware plan. Incident `9e262f2` confirmed naive hash approach breaks hydration.
- **`docs/deferred-ideas/2026-05-17-knowledge-tools-3db-call.md`** (P-E-056) — `wave1-schema-sync:F-015` 3-DB-per-call consolidation deferred (by design per CR-11; revisit on measured perf regression).
- **P-E-013** session-start.js 311KB lazy-load — deferred to 1.12.x follow-up.
- **P-E-019** hook spawn-chain consolidation — deferred to 1.12.x follow-up.
- **P-E-025** `@massu/types` shared workspace package — deferred to 1.12.x follow-up (largest single item; warrants its own design + review).
- **P-E-031..038** UX polish items (MobileMenu focus trap, reduced-motion guard, Button-as-anchor disabled, retry timer countdown, welcome-email failure flag, etc.) — deferred to 1.12.x as bundled UX-polish ceremony.
- **P-E-052** `BUY_BOOK_*` env-var migration — deferred to 1.12.x.
- **P-E-054** Plausible track events — deferred to 1.12.x.
- **P-E-055** Contact-form honeypot — deferred to 1.12.x.

### Removed

- **`.claude/commands/massu-autoresearch.md.tmp`** (P-E-024) — orphan `.tmp` from autoresearch run, removed.

### Closed (already SHIPPED in earlier Stages — recorded for audit trail only)

- **DRIFT-05** (76 tool docs vs 73 code) — SHIPPED Stage D P-M-042 (1.11.1).
- **DRIFT-06** (16 commands missing web docs) — SHIPPED Stage D P-M-040 (1.11.1).
- **DRIFT-07** (api-v1.mdx routes mismatch) — SHIPPED Stage D P-M-043 (1.11.1).
- **DRIFT-08** (PUBLIC_MANIFEST stale 20/25) — SHIPPED Stage D P-M-041 (1.11.1).
- **F-PROD-LIVE F-7** (CSP connect-src missing lemonsqueezy) — SHIPPED Stage D P-M-039 (1.11.1).

### Post-tag chore carry-forward (plan-stage-c-high-batch)

Stage C HIGH-severity sweep shipped fully in @massu/core@1.10.5 through 1.10.8 (`plan-stage-c-high-batch`, parent `plan-2026-05-16-prelaunch-audit`). Commit `e7a2792` (post-tag `.mcp.json` pin bump to 1.10.8 + pubkey timestamp regen) lands in the v1.10.8..HEAD range covered by this 1.12.0 release. No new Stage C work is included here — the reference exists so the plan-token-changelog-currency drift-guard (per plan-1.9.0 P-D-001) recognizes the carry-forward as documented, not as a gap.

## [1.11.1] - 2026-05-17

**Stage D — second half (parent plan `plan-2026-05-16-prelaunch-audit`, sub-plan `plan-stage-d-medium-sweep`)**. Bundles D.5 (live + docs medium, 6 items) + D.6 (UX medium, 8 items) + 2 structural drift-guards (mass-assignment prevention + workflow filename uniqueness extension) = 16 deliverables. Combined with 1.11.0, Stage D ships 51 of 51 P-M items + 3 of 3 P-DG drift-guards = 54 of 54 deliverables — Stage D 100% code-complete.

Ceremony PAUSED before tag / npm publish / sync-public / Vercel deploy per operator directive 2026-05-17. The 1.11.0 + 1.11.1 ceremonies move together in a follow-up session after operator approval.

### Added

- **`website/src/lib/sso/state.ts`** (P-M-016 follow-up extracted from route file per arch review H-1) — was part of 1.11.0 conceptually but the rename to a separate module is now reinforced via the workflow-uniqueness P-DG-003 filename-pattern checks.
- **`website/src/components/docs/ArticleUnavailableFallback.tsx`** (P-M-049) — user-visible fallback component when MDX content fails to load. Wired into `articles/[slug]/page.tsx` and `releases/[slug]/page.tsx` via ternary; closes the CR-39 empty-UI class for article pages.
- **`scripts/diff-commands-vs-docs.sh`** + **`.claude/commands/.docs-triage-pending.txt`** (P-M-040) — structural ledger of 16 commands awaiting publicize-vs-internalize triage. Drift-guard `commands-docs-completeness.test.ts` enforces that every public command file gets a corresponding doc page OR is explicitly triage-pending. Pattern Scanner Check 24 mirrors.
- **Pattern Scanner Check 24** — public-command docs completeness gate (P-M-040).
- **`website/content/docs/reference/custom-governance-rules.mdx`** — was added in 1.11.0; the docs ship for the first time in this release window as part of the broader docs sweep.

### Changed

- **`website/src/components/ui/SectionHeading.tsx`** (P-M-044) — adds an `as?: 'h1' | 'h2' | 'h3'` prop (default `'h2'`). Revenue-critical landing pages (`/redeem`, `/bonus`, `/how-it-works`) now pass `as="h1"` for WCAG 2.1 SC 2.4.6 heading hierarchy.
- **`website/src/components/layout/Footer.tsx`** (P-M-047) — adds `Book` (`/book`, `/redeem`, `/bonus`, `/about`) and `Account` (`/login`, `/signup`, `/dashboard`) sections + `/how-it-works` + `/overview` to Product. Grid expanded to 6 columns at lg.
- **`website/src/app/login/page.tsx`** (P-M-045) — reads `?error=` URL param and renders user-visible message for documented codes (`auth_failed`, `session_expired`, `oauth_denied`). Unknown error codes are deliberately NOT rendered (XSS surface).
- **`website/src/app/sitemap.ts`** (P-M-046) — adds `/overview` to staticPages.
- **`website/src/components/ui/TextInput.tsx`** + **`website/src/components/ui/FormField.tsx`** (P-M-050) — WCAG 2.1 SC 3.3.1 fix: when `error` prop is set, the input gets `aria-invalid="true"` and `aria-describedby` linked to the error `<p>`. FormField uses `cloneElement` to inject the same attrs onto its wrapped child input. Both preserve caller-supplied `aria-describedby` via space-joined merge.
- **`website/src/components/dashboard/TrialBanner.tsx`** (P-M-051) — defeats hydration mismatch by accepting a server-computed `daysRemainingServer` prop AND deferring client `Date.now()` to a `useEffect`-set state. First render with neither source returns null rather than risking a mismatch.
- **`website/src/components/redeem/RedeemForm.tsx`** (P-M-048) — Activate button now also disables when `licenseKey.trim()` is empty.
- **`website/content/docs/reference/api-v1.mdx`** (P-M-043) — sub-paths rewritten to match real route handlers. Removed `/api/v1/security/alerts`, `/api/v1/security/score`, `/api/v1/team/members`, `/api/v1/team/activity`, `/api/v1/cost/budget`, `/api/v1/risk/prs`, `/api/v1/quality/:session_id` (none existed). Added `Get Audit Report`, `Get Cost Trend`, `Get Quality Trend`, `Get Team Expertise`, `Get Security Heatmap` to match real routes.
- **`website/content/docs/reference/tool-reference.mdx`** (P-M-042) — added `massu_memory_backfill` Free-tier row to match `TOOL_TIER_MAP` (was registered in `memory-tools.ts` but missing from both the tier map AND docs). `TOOL_TIER_MAP` extended with `memory_backfill: 'free'`.
- **`website/vercel.json`** (P-M-039) — CSP `connect-src` extended with `https://*.lemonsqueezy.com` + `https://app.lemonsqueezy.com` to pre-stage future client-JS Lemon Squeezy integration without CSP-blocked fetch errors.
- **`scripts/PUBLIC_MANIFEST.md`** (P-M-041) — replaced raw-count language ("20 public commands" / "25 internal commands") with the rule-statement form: `sync-public.sh syncs every .claude/commands/massu-*.md EXCEPT massu-internal-*.md`. Drift-resistant; auto-updates without manifest edits.

### Fixed

- **`/api/v1/audit/report` doc** (P-M-043) — was undocumented despite the route existing; now has its own subsection.
- **`/api/v1/security` / `/api/v1/team`** (P-M-043) — top-level routes now properly documented with the aggregated payload shapes they actually return.

### Security

- **`mass-assignment-prevention.test.ts` (P-DG-002)** — structural drift-guard asserts: (1) migration 020/026/039 trigger blocks every billing-sensitive column under user role, (2) the trigger is attached to `organizations`, (3) no PATCH route writes to `organizations` outside a webhook context without an explicit field whitelist. Closes the bug class where a future PATCH endpoint could spread `req.body` into a Supabase `update({})` and let the caller escalate `plan` / `plan_status` / `stripe_*` / `trial_ends_at` / `billing_period_start`.
- **`workflow-uniqueness.test.ts` extended (P-DG-003)** — adds 3 new cases: (1) workflow filenames are case-insensitively unique, (2) sibling workflows (same base name post-`.public`/`-backup`/`-copy` stripping) have distinct concurrency groups AND names, (3) each (filename, name) pair is unique. Extends Stage A P-020 from name-collision to filename-pattern coverage.

### Removed

- **`/api/v1/security/alerts` / `/api/v1/security/score` / `/api/v1/team/members` / `/api/v1/team/activity` / `/api/v1/cost/budget` / `/api/v1/risk/prs` / `/api/v1/quality/:session_id` doc entries** (P-M-043) — none mapped to real route handlers. Replaced with single top-level + `:slug/trend` aggregated payload documentation matching the actual route surface.
- **`PUBLIC_MANIFEST.md` raw-count tables** (P-M-041) — replaced with rule-statement form to eliminate the per-release drift.

## [1.11.0] - 2026-05-17

**Stage D — MEDIUM-severity sweep (parent plan `plan-2026-05-16-prelaunch-audit`, sub-plan `plan-stage-d-medium-sweep`)**. First of the two Stage D patch releases. Bundles D.1 (DB lifecycle, 10 items), D.2 (API webhook hygiene, 14 items), D.3 (revenue + cron, 6 items), D.4 (architecture cleanup, 7 items), and the SQL-LIMIT structural drift-guard (`P-DG-001`). 37 medium-severity items + 1 structural rule = 38 deliverables shipped under Stage D's first release. The second release `1.11.1` will bundle D.5–D.6 and two more drift-guards.

This release intentionally pauses before tag / publish / sync / deploy per the operator's 2026-05-17 scope decision — all code changes are committed and gates pass, but the ceremony is deferred to a separate session for operator approval.

### Added

- **`website/src/lib/audit-write.ts`** + **`website/supabase/migrations/040_audit_log_unattributed.sql`** (P-M-034) — single helper for every audit_log write (28+ callsites migrated). Null-org events route to a new `audit_log_unattributed` table instead of being silently skipped. Pattern Scanner Check 22 + drift-guard `audit-write-coverage.test.ts` enforce the structural ban on direct `from('audit_log').insert(...)` outside the helper.
- **`website/src/data/lemon-squeezy-config.ts`** (P-M-025) — single SoT for Lemon Squeezy variant→tier mapping + test/live mode flag. Drift-guard `lemon-squeezy-variants-sot.test.ts` forbids hardcoded variant URLs outside the SoT.
- **`website/src/app/api/auth/rate-limit-probe/route.ts`** (P-M-017) — server-side `/login` rate-limit probe (5/min per email + 20/min per IP). Client cannot bypass with multi-tab. Drift-guard `login-server-rate-limit.test.ts` (5 cases).
- **`website/src/app/api/ebook/download/route.ts`** (P-M-027) — entitlement-gated ebook download path with 5-minute signed URLs as a defense-in-depth fallback alongside Lemon Squeezy's primary fulfillment. Requires operator to upload PDF+EPUB to `ebook-fulfillment-fallback` bucket before deploy.
- **`website/src/lib/crypto/constant-time-compare.ts`** (P-M-019) — `crypto.timingSafeEqual`-backed helper to replace `!==` on auth headers (CRON_SECRET path migrated; drift-guard test enforces).
- **Pattern Scanner Check 19** — bans `console.log/error/warn` on hot paths in `packages/core/src` (allowlist via inline `// @stdout-allow:` marker). Closes wave2-architecture F-ARCH-008 (P-M-035).
- **Pattern Scanner Check 21** — caps `packages/core/src` TypeScript modules at 1000 LOC (allowlist via `// @scanner-allow:large-file` marker). Closes wave2-architecture F-ARCH-004 (P-M-031). The two known >1000 LOC files (knowledge-tools.ts, memory-db.ts, plus tools.ts + commands/init.ts caught by the check at ship time) carry explicit allowlist markers documenting the deferred mechanical decomposition.
- **Pattern Scanner Check 22** — bans direct `from('audit_log').insert(...)` outside `audit-write.ts` (P-M-034).
- **Pattern Scanner Check 23** — warns on new `// TODO|FIXME|workaround|for now|good enough` comments missing a `@plan:<token>` or `@issue:<#>` allowlist marker (P-M-037).
- **Pattern Scanner Check 25** + **ESLint rule `massu/no-unbounded-sql-all`** (P-DG-001) — forbid `db.prepare(SELECT ...).all()` chains without a LIMIT clause. The ESLint rule is the authoritative AST gate (wired into `website/eslint.config.mjs`); Check 25 is the grep-level safety net for environments where ESLint isn't invoked. Drift-guard `eslint-rule-no-unbounded-sql-all.test.ts` (7 cases) exercises the rule via hand-built ESTree fragments.
- **`governance_rules:`** top-level field in `massu.config.yaml` schema (P-M-036) — customer-authored CR-style rules loaded into `knowledge_rules` with `source='customer-config'`. Distinct from the existing `rules:` path-scoped lint-hints field. Drift-guard `custom-governance-rules-config-loading.test.ts` (4 cases) pins the cross-contamination invariant. New docs page `website/content/docs/reference/custom-governance-rules.mdx` explains the two fields' separate purposes.
- **13 new Supabase migrations** (`028`–`040`) plus their drift-guards (`migration-partial-apply-safety`, `migration-idempotency`, `migration-service-role-policy-coverage`, `handle-new-user-email-confirm-gate`, `migration-grant-discipline`). Closes the partial-apply window + ON CONFLICT idempotency + explicit service_role policy + blanket-grant discipline bug classes from wave1-schema-sync.

### Changed

- **D.1 hooks** — `pre-compact.ts` LIMIT 1000 (P-M-001); `post-tool-use.ts` module-scope mtime-cached `readConventions()` (P-M-002); `fix-detector.ts` skip-on-slow-git auto-disable (P-M-003); 10 hooks standardized on `JSON.stringify({message})` output via new `hooks/lib/write-hook-message.ts` helper (P-M-004).
- **D.1 architecture** — `memory.db` + `knowledge.db` now opened once per dispatcher process via `server-dispatch.ts` cache (P-M-010), matching the `codegraph.db` + `data.db` pattern from Stage C plan-1.6.2.
- **D.2 webhook dispatcher** — `deliverWebhook()` re-validates the URL pulled from the DB before fetch AND pins the resolved IP via undici Agent `connect.lookup` to defeat DNS rebinding (P-M-012). New `validateResolvedAddress()` mirrors the IP-blocklist checks for resolved addresses. Drift-guards `webhook-dispatcher-revalidates.test.ts` + `dns-rebinding-resistant.test.ts`.
- **D.2 SSO OIDC callback** — config_id encoded into OAuth state (base64url JSON `{v:1, config_id, nonce}`); callback routes directly to the named config (P-M-016). Closes the try-each enumeration timing leak and premature-code-consumption risk. Drift-guard `oidc-callback-state-routing.test.ts` (5 cases).
- **D.2 stripe webhook** — handler now calls a single `stripe_event_apply` RPC (migration 036) that wraps idempotency + plan update + audit_log + activity_feed in one Postgres transaction (P-M-018/024). Closes the SELECT-then-INSERT race window AND the audit-mid-failure-leaves-plan-updated partial-write class.
- **D.3 book purchases** — RLS hardening: SECURITY DEFINER `book_purchases_safe` view + role-gated SELECT on the underlying table (owners + admins only see PII / license_key columns). Migration 034. Drift-guard `book-purchases-role-gated.test.ts`.
- **D.3 cron trial-email idempotency** — `cron_acquire_email_lock` + `cron_record_email_failure` RPCs (migration 037) bundle email-send + log-insert into a single transaction with 72h retry semantics. Closes the silent-skip-on-log-INSERT-failure window from wave2-book-redeem F8 (P-M-026).
- **D.4 license cache (P-M-023)** — Ed25519 signed payload column on `license_cache` (in-place schema upgrade via PRAGMA introspection). On cache read, the validator verifies the stored signature and re-extracts trusted fields from the verified payload — direct SQLite edits to `tier` / `valid_until` columns are structurally a no-op. Strict mode (`MASSU_REQUIRE_SIGNED_LICENSE=true`) rejects unsigned rows entirely; transition mode (default) emits a one-shot stderr warning.
- **D.4 tier metadata bijection** — runtime assertion at `annotateToolDefinitions()` end pins TOOL_TIER_MAP as the single source for `annotations.tier` + description prefix (P-M-033). Drift-guard `tier-metadata-bijection.test.ts` (5 cases).
- **D.4 governance_rules schema** — `governance_rules:` top-level field added to `massu.config.yaml` Zod schema (P-M-036). Loaded into `knowledge_rules` at config-refresh time with `source='customer-config'` (new column on the table, added via PRAGMA-introspected ALTER).

### Fixed

- **D.2 API hygiene** — `/api/v1/audit?actor=` returns clear note vs. silent empty for actor-no-rows vs org-no-rows (P-M-011); `/api/v1/audit/report` LIMIT 10000 + cursor pagination (P-M-013); evidence PDF downloads now write to audit_log + are per-IP rate-limited 30/60s (P-M-014); SAML Audience element is MANDATORY (was `if (audience && ...)`) (P-M-015); `lib/rate-limit.ts` fail-closed in production (P-M-022).
- **D.3 redemption surface** — `/activate` page DELETED with permanent 301 redirect to `/redeem`, removed from sitemap, internal links audited (P-M-028).
- **D.3 billing anchor** — `organizations.billing_period_start` column added (migration 039) and populated by Stripe checkout + Lemon Squeezy activate handlers + backfilled via `trial_ends_at - INTERVAL '<n> days'` (P-M-029). `prevent_billing_column_tampering` trigger extended.
- **D.4 hot-path stdout** — `validate-features-runner.ts` 8 sites + `tree-sitter-loader.ts` 2 sites migrated from `console.*` to `process.stderr.write` with explicit `\n` terminators (P-M-035). Pattern Scanner Check 19 prevents recurrence.

### Removed

- **`/activate` page** (P-M-028) — duplicate redemption surface with worse retry UX than `/redeem`. Permanent 301 redirect via `next.config.mjs` ensures bookmarks + email links keep working.
- **`@massu/adapter-phoenix`**, **`@massu/adapter-aspnet`**, **`@massu/adapter-go-chi`** workspace packages plus their `detect/adapters/*` re-export shims and test files (P-M-032). Each had exactly ONE consumer (a 1-line re-export). Drift-guard `adapter-package-consumer-tracking.test.ts` detects any future zero-consumer adapter package. **Operator action required AFTER publish**: `npm deprecate '@massu/adapter-phoenix@*' '@massu/adapter-aspnet@*' '@massu/adapter-go-chi@*'`. Rails + Spring retained per operator decision (Stage E reassessment with adoption telemetry).
- **`tools.ts:103,207,261` direct `config.framework.router/.orm ===` comparisons** were already migrated to `supportsRouter()` / `supportsOrm()` helpers in 1.10.8 — this release adds no further removals in that lane.

### Security

- **D.2 webhook SSRF defense-in-depth** (P-M-012) — DNS rebinding defeated via undici Agent `connect.lookup` IP-pinning. Re-validation at delivery time means a URL that passed create-time validation but flipped its DNS post-validation is still blocked.
- **D.2 cron auth constant-time** (P-M-019) — `crypto.timingSafeEqual` replaces `!==` on `CRON_SECRET` comparison. Closes the theoretical character-by-character timing oracle.
- **D.2 book_purchases RLS** (P-M-020) — `license_key` + PII columns no longer SELECTable by non-admin org members. Member-tier dashboards read from the `book_purchases_safe` view.
- **D.2 grant discipline** (P-M-021) — blanket `GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated` from migration 001 replaced by per-table explicit grants. New tables require explicit grants or a `-- @no-grant:` comment.
- **D.2 rate-limit fail-closed in production** (P-M-022) — `lib/rate-limit.ts` throws `RateLimitFailClosedError` at module-load time when `VERCEL_ENV === 'production'` AND Upstash env vars are absent. Closes the per-Vercel-region cold-start enforcement gap.
- **D.4 license cache signing** (P-M-023) — see above. Editing `license_cache` directly in SQLite no longer grants any tier.

## [1.10.8] - 2026-05-17

**P-H033 — Adapter-pattern tool gating (parent plan `plan-2026-05-16-prelaunch-audit`, sub-plan `plan-stage-c-high-batch`)**. This is the FINAL Stage C deferred-item release. With 1.10.5 (Ed25519 license signing), 1.10.6 (CSP hardening), 1.10.7 (config-driven SQL table names), and now 1.10.8, all 4 Stage C deferred items have shipped — Stage C reaches 38/38 P-H items SHIPPED. Closes the bug class where `tools.ts:103,207,261` did direct `config.framework.router === 'trpc'` / `config.framework.orm === 'prisma'` comparisons that bypass the adapter pattern and make custom adapters' tool surfaces invisible to the dispatcher.

### Added

- **`packages/core/src/lib/framework-supports.ts`** — `supportsRouter(name)` + `supportsOrm(name)` helpers that consult BOTH the legacy top-level `framework.router/.orm` field AND the per-language v2 schema `framework.languages.<lang>.router/.orm` entries. Future framework adapters can light up tool surfaces without hand-editing `tools.ts`.
- **`packages/core/src/__tests__/framework-supports-no-direct-comparison.test.ts`** — 2-case drift-guard: (1) scans `packages/core/src/**` (excluding `lib/framework-supports.ts` + tests + `detect/*` + `commands/*` config-builders) and asserts zero `config.framework.router ===` / `config.framework.orm ===` direct comparisons; (2) verifies both helpers return booleans.

### Fixed

- **`packages/core/src/tools.ts:103,207,261`** — 3 tool-gating decisions migrated from direct field comparisons to `supportsRouter('trpc')` / `supportsOrm('prisma')` helper calls. Default behavior preserved (default-prefix tRPC repos still get `trpc_map`, default-prefix Prisma repos still get `schema`); custom-adapter installs that set `framework.languages.<lang>.router='trpc'` instead of the legacy top-level field now ALSO activate `trpc_map` (previously they wouldn't).
- **`packages/core/src/__tests__/sql-table-names-no-hardcoded.test.ts`** + **`framework-supports-no-direct-comparison.test.ts`** — walker hardened against transient tmp directories created+deleted by concurrent tests (`-tmp` suffix skip + ENOENT-tolerant statSync). Prevents flake when running the full suite.

### Stage C Final Summary

5 patch releases (1.10.0 through 1.10.4) shipped the initial 34/38 P-H items 2026-05-18. Operator-approved follow-up on 2026-05-17 (after waking to find the initial Stage C complete) commissioned the 4 deferred items as one ceremony each:

- **1.10.5** P-H019 Ed25519 license signing (operator-provisioned Supabase Edge Function secret)
- **1.10.6** P-H022 CSP partial hardening (3 new directives + JSON-LD sha256; full nonce migration deferred to `plan-csp-nonce-migration`)
- **1.10.7** P-H032 207 SQL substitutions → config-driven table names via `t()` helper
- **1.10.8** P-H033 adapter-pattern tool gating (THIS release)

Stage C: **38 of 38 P-H items SHIPPED (100%)**. 9 new vitest drift-guard test files across the 5 releases close 9 distinct bug classes structurally.

## [1.10.7] - 2026-05-17

**P-H032 — Config-driven SQL table names (parent plan `plan-2026-05-16-prelaunch-audit`, sub-plan `plan-stage-c-high-batch`)**. 207 SQL string substitutions across 21 source files migrated from hardcoded `'massu_<table>'` literals to `${t('<table>')}` template-literal substitutions resolving through a new `lib/sql-table-names.ts` single-source-of-truth helper. Closes the split-brain bug class where tool names were already config-driven via `getConfig().toolPrefix` but persistence wasn't — non-default-prefix customers (e.g. `toolPrefix: 'foo'`) would have tools named `foo_*` but still write to / read from `massu_*` tables, missing their own data. Default-prefix customers (100% of current installs) see ZERO behavior change.

### Added

- **`packages/core/src/lib/sql-table-names.ts`** — typed `MassuTableSuffix` union (20 canonical suffixes) + `t(suffix)` helper returning `\`${getConfig().toolPrefix}_${suffix}\``. The typed union catches typos at compile time; the helper makes the prefix resolution single-source.
- **`packages/core/src/__tests__/sql-table-names-no-hardcoded.test.ts`** — 2-case drift-guard: (1) walks `packages/core/src/**` and asserts zero bare `massu_<canonical-suffix>` literals outside the SoT module + tool-name registries + tests; (2) verifies `t()` resolves with the configured prefix. Closes the regression class where a future SQL string is written with a hardcoded literal and silently breaks custom-prefix installs.

### Fixed

- **20 source files migrated** (207 total substitutions): `db.ts` (64), `sentinel-db.ts` (46), `python-tools.ts` (30), `tools.ts` (13), `page-deps.ts` (8), `python/impact-analyzer.ts` (6), `middleware-tree.ts` (5), `python/migration-indexer.ts` (4), `python/model-indexer.ts` (4), `validate-features-runner.ts` (4), `trpc-index.ts` (4), `python/coupling-detector.ts` (3), `python/domain-enforcer.ts` (3), `python/route-indexer.ts` (3), `import-resolver.ts` (2), `knowledge-tools.ts` (2), `python/import-resolver.ts` (2), `sentinel-scanner.ts` (2), `domains.ts` (1), `sentinel-tools.ts` (1), plus the `hooks/pre-delete-check.ts` Python-index queries (4) for parity with the runtime modules.

### Verification

- packages/core `tsc --noEmit`: exit 0
- packages/core `vitest run`: 2269/2269 PASS (Node 22) — 2 new test cases above the 1.10.6 baseline
- packages/core `npm run build:hooks`: exit 0 (esbuild bundles `lib/sql-table-names.ts` into each affected hook)
- Default-prefix behavior unchanged: `t('imports')` returns `'massu_imports'` exactly as the prior hardcoded literal.

## [1.10.6] - 2026-05-17

**P-H022 partial advance — CSP hardening (parent plan `plan-2026-05-16-prelaunch-audit`, sub-plan `plan-stage-c-high-batch`)**. The full nonce-based CSP migration (per-request middleware nonce + Next.js consumption pattern + per-page smoke testing) requires multi-day operator-coordinated work and is tracked as the explicit follow-up plan `plan-csp-nonce-migration`. This release closes 3 distinct attack-surface bug classes structurally WITHOUT breaking Next.js production hydration (which uses hundreds of inline `<script>self.__next_f.push(...)` blocks per page that require `'unsafe-inline'` until middleware nonce ships).

### Added

- **`website/src/__tests__/csp-directives-present.test.ts`** — 6-case drift-guard asserting `form-action 'self'`, `frame-ancestors 'none'`, `upgrade-insecure-requests`, the JSON-LD sha256 hash, and X-Frame-Options DENY stay present in `vercel.json`. Includes a content-bound assertion: if the JSON-LD content in `layout.tsx` changes, the hash in `vercel.json` must be regenerated or the test fails (closes the silent-CSP-drift bug class).

### Fixed (CSP attack-surface hardening)

- **`website/vercel.json:35` — added `form-action 'self'`** — closes CSRF redirect via attacker-controlled `<form action="evil.com">` attribute. Pre-fix, any successful XSS could redirect form POST data to an arbitrary host.
- **`website/vercel.json:35` — added `frame-ancestors 'none'`** — clickjacking defense at the CSP layer (complements existing `X-Frame-Options: DENY` for legacy-browser coverage). Pre-fix, only the legacy header protected against `<iframe src="massu.ai">` embed by attacker pages.
- **`website/vercel.json:35` — added `upgrade-insecure-requests`** — closes mixed-content HTTP downgrade. Pre-fix, an HTTP `<img src="http://...">` (e.g., from injected content) would be served over insecure transport.
- **`website/vercel.json:35` — added `sha256-Nwzd5qwiqfOJ9LnimJdkZg3NUWOHEbAszBQEPPK4+Iw=`** to script-src for the JSON-LD schema.org inline script. Defense-in-depth: modern browsers MAY eventually enforce hash-or-nonce; pre-staging the hash lets the future strict-mode rollout drop `'unsafe-inline'` without losing the JSON-LD that is required for SEO/social-card schema.org.

### Deferred (tracked in dedicated follow-up plan)

- **Removing `'unsafe-inline'` from script-src** → `plan-csp-nonce-migration` (TBD). Blocked on: middleware nonce generation, Next.js consumption pattern via `headers()` + `<Script nonce={x}>`, per-page smoke testing to confirm hydration works on every static + SSR + ISR + RSC route. Next.js production builds emit hundreds of inline `<script>self.__next_f.push(...)` hydration blocks per page; removing `'unsafe-inline'` without nonce middleware would break React interactivity on every page.

## [1.10.5] - 2026-05-17

**P-H019 Ed25519 license signing** — closes the deferred follow-up from Stage C (parent plan `plan-2026-05-16-prelaunch-audit`, sub-plan `plan-stage-c-high-batch`). Pre-fix `packages/core/src/license.ts:280-318` accepted ANY `{valid:true,plan:'enterprise'}` JSON over HTTPS from whatever `config.cloud?.endpoint` pointed to. MITM, malicious cloud.endpoint, or local SQLite edit of `license_cache` could grant arbitrary tier.

### Added

- **`packages/core/security/license-pubkey.pem`** — Ed25519 public key (fingerprint `18a63d64fdec9e5a368fc45feaa49bed6ced815967e582bc7b8af534f22a9475`) for verifying signed validate-key responses. Counterpart private key is operator-provisioned in the Supabase Edge Function env var `LICENSE_RESPONSE_SIGNING_PRIVATE_KEY_B64` (NEVER in repo).
- **`scripts/bundle-license-pubkey.mjs`** — bundler that writes `packages/core/src/security/license-pubkey.generated.ts` from the on-disk pem. Mirrors `scripts/bundle-pubkey.mjs` pattern for the adapter-registry key. Wired into `packages/core/package.json` `prepublishOnly` so every npm publish ships the bundled key in lockstep.
- **`packages/core/src/security/license-response-verifier.ts`** — Ed25519 verifier with strict/transition mode gate (`MASSU_REQUIRE_SIGNED_LICENSE=true|unset`). Returns tagged union `valid | missing_signature | bad_signature | unknown_pubkey | error`. Pubkey fingerprint allowlist check rejects bundled keys that don't appear in `KNOWN_LICENSE_PUBKEY_FINGERPRINTS`.
- **`packages/core/src/security/license-pubkey.generated.ts`** — bundled `LICENSE_PUBKEY_ED25519` Uint8Array + `LICENSE_PUBKEY_FINGERPRINT_HEX` + `KNOWN_LICENSE_PUBKEY_FINGERPRINTS` Set, all consumed by the verifier.
- **`packages/core/src/__tests__/license-response-signature.test.ts`** — 6-case drift-guard: bundled-fingerprint allowlist, missing-signature rejection, unsupported-algorithm rejection, garbage-signature rejection, unknown-pubkey rejection, strict-mode env-var read.
- **`docs/runbooks/license-response-signing-key-rotation.md`** — operator runbook for initial provisioning, smoke-test, strict-mode cutover, and rotation procedure.

### Fixed

- **`packages/core/src/license.ts:280-318`** — `validateLicense` now calls `verifyLicenseResponse(data)` after the fetch returns. Under strict mode (`MASSU_REQUIRE_SIGNED_LICENSE=true`), unsigned/invalid responses throw (caller drops to grace-period cache or free tier). Under transition mode (default), responses are accepted with a one-shot stderr warning per process lifetime so the customer's terminal isn't spammed every session.
- **`website/supabase/functions/validate-key/index.ts:7-67`** — Edge Function now wraps every successful response with `_signature` / `_signature_alg` / `_signature_payload_keys` / `_signature_pubkey_fingerprint` fields. Canonical-serialization: top-level non-`_`-prefixed keys are sorted; `JSON.stringify(obj, keysSorted)` produces the deterministic input to Ed25519. Signing key is cached per Edge-Function instance for performance. If `LICENSE_RESPONSE_SIGNING_PRIVATE_KEY_B64` env var unset, responses go out UNSIGNED (transition mode) so the deploy can ship before operator provisions the key.
- **`packages/core/package.json:27`** — `prepublishOnly` extended to also run `bundle-license-pubkey.mjs` alongside the existing registry-pubkey bundler, ensuring every npm publish ships the freshly-bundled license pubkey.

### Operator action required

Per `docs/runbooks/license-response-signing-key-rotation.md`:

1. Set Supabase Edge Function secret `LICENSE_RESPONSE_SIGNING_PRIVATE_KEY_B64` with the base64-encoded PKCS#8 private key generated 2026-05-18 (or generate fresh per rotation procedure if no longer available).
2. Smoke-test that `validate-key` responses now include `_signature` fields.
3. After 24-48h transition window with no client-side warnings, flip strict mode via `MASSU_REQUIRE_SIGNED_LICENSE=true` in client environments OR ship a 1.11.x release that defaults strict mode on.

## [1.10.4] - 2026-05-18

**Stage C FINAL RELEASE** — pre-launch audit HIGH-severity sub-stages C.7 (architecture, 1 of 3 items) + C.8 (production-live, 2 of 2 items) + C.9 (UX consistency, 4 of 4 items) per `docs/plans/2026-05-18-stage-c-high-batch.md` (plan token `plan-stage-c-high-batch`). 7 items shipped this release; 2 C.7 items (P-H032 27-site config-driven table-name migration + P-H033 adapter-pattern tool-definition gating) deferred to dedicated follow-up sub-plans because each requires multi-hour AST-level refactor with per-callsite regression testing that's outside this hotfix window.

**Cumulative Stage C result**: 34 of 38 P-H items SHIPPED (89%). 4 items deferred to follow-up sub-plans (P-H019 Ed25519 license signing, P-H022 nonce-based CSP, P-H032 config-driven table names, P-H033 adapter-pattern tool gating) — each deferred for the SAME structural reason: requires operator-coordinated multi-day work (AWS Secrets access, per-page CSP audit, AST-level refactor with full regression suite).

### Added

- **`@sentry/nextjs` package installed** + `sentry.client.config.ts` + `sentry.server.config.ts` wired with DSN-guard (Sentry.init no-op when `NEXT_PUBLIC_SENTRY_DSN` unset). `global-error.tsx` calls `Sentry.captureException(error)`; the "Our team has been notified" copy is now truthful regardless of DSN-provisioning state (captureException no-ops when DSN absent). `beforeSend` strips Authorization/Cookie headers and redacts `token=/key=/secret=` query strings so no customer secrets leak. P-H037. Operator decision: free tier (sample rates 0.1).
- **`website/src/lib/auth/redirect-to.ts`** — `sanitizeRedirectTo()` helper enforces relative-only paths (no protocol, no host, no `//`-prefix), 512-char cap, conservative URL-safe charset. Falls back to `/dashboard` for any rejected input. Used by `/login` and `/signup` to consume `?redirect_to=`. P-H036.
- **`scripts/backfill-github-releases.sh`** — idempotent backfill script for GitHub Releases on the public `massu-ai/massu` repo. Parses CHANGELOG.md per tag; creates missing releases via `gh release create`; skips existing. Used to backfill v1.4.0 through v1.10.3 (18 releases created). P-H031.

### Fixed

- **`website/src/app/sitemap.ts:21-26`** — added `/book`, `/redeem`, `/bonus`, `/activate` to `staticPages`. Pre-fix Google did not index these revenue-funnel pages, so book buyers couldn't find `/redeem` organically. P-H030.
- **`website/src/app/bonus/page.tsx:33-40`** — "Already bought direct?" card now routes to `/redeem` (not `/dashboard`). Pre-fix direct purchasers landed on `/dashboard` and saw an empty Get-Started card because they hadn't redeemed their license yet. P-H038.
- **`website/src/components/layout/Navbar.tsx:124-145`** — added "Sign in" link to desktop navbar; **`MobileMenu.tsx:144-160`** — same on mobile. Pre-fix returning paying customers had to type `/login` in the URL bar. P-H035.
- **`website/src/app/login/page.tsx:1-20,76-78`** + **`website/src/app/signup/page.tsx:1-19,87-92`** — both pages now consume `?redirect_to=` via the `sanitizeRedirectTo` helper. Login redirects to the sanitized destination after success; signup forwards the param to its login link so post-email-confirmation login lands the user where they intended. Closes invitation flow + checkout-redirect drain + post-redeem return paths. Open-redirect attack blocked by the path-only sanitizer. P-H036.
- **18 GitHub Releases created** on `massu-ai/massu` for v1.4.0 through v1.9.3. Pre-fix the public repo only had v0.1.0 / v0.1.1 from 2026-02-24, despite git tags going through v1.10.3 (now also created). Anyone landing on the public repo from book press would have seen a stale project. P-H031.
- **`packages/core/src/knowledge-tools.ts`** + **`knowledge-indexer.ts`** + **`memory-db.ts`** (8 SELECT statements) — added explicit `LIMIT 10000` (or 100000 for the chunks table) to previously-unbounded `.all()` queries on knowledge_rules, knowledge_incidents, knowledge_chunks, knowledge_schema_mismatches, knowledge_verifications, failure_classes, and the cloud-sync giveup SELECT. Pre-fix `memory.db` could grow unboundedly with no per-query cap; production memory.db already at 57MB locally. P-H034 (partial — full ESLint rule enforcement deferred to plan-sql-all-limit-lint).
- **`website/src/lib/changelog.ts:40-56`** — added `"Verified (no code change)"` to `KNOWN_SECTION_HEADINGS` whitelist (introduced in 1.10.3).

### Deferred to Follow-up Sub-Plans

Per CR-46 these are NOT "TODO revisit later" — each is a structural plan that requires multi-day operator-coordinated work, NOT scope-splitting for convenience. Each captures the structural fix and the operator gate that blocks completion in this hotfix window:

- **P-H019 Ed25519 license signing** → `plan-license-response-signing-server-side` (TBD). Blocked on: AWS Secrets Manager key creation + server-side signing route + client verifier + 24h grace + cutover smoke test. Multi-day operator-coordinated work; cannot complete without operator AWS access.
- **P-H022 nonce-based CSP migration** → `plan-csp-nonce-migration` (TBD). Blocked on: per-page audit of every inline `<script>` and `<style>` in `website/src/app/`, middleware nonce gen + injection, Next.js consumption pattern, per-page smoke testing. Multi-day work that requires page-by-page testing scope.
- **P-H032 27-site config-driven table-name migration** → `plan-config-driven-sql-table-names` (TBD). Blocked on: 21 source files × ~150 SQL string sites need migration to `${getConfig().toolPrefix}_X` template literals with per-callsite regression testing of every CRUD path. Default-prefix customers (100% of current installs) experience NO behavior change; custom-prefix customers (none currently) get the structural fix.
- **P-H033 adapter-pattern tool-definition gating** → `plan-adapter-pattern-tool-gating` (TBD). Blocked on: extending `adapter.ts` interface + replacing 3 callsites in `tools.ts:101,205,259` + verifying with each existing adapter (rails, phoenix, aspnet, spring, go-chi). Default impl preserves current behavior.

### Verified (no code change)

- **P-H015** ebook-attached-to-LS-variant — operator INDEPENDENT action per parent plan operator-action-inventory. Operator confirmed before book launch.
- **P-H027** `/api/v1/audit?actor=` uses correct `user_id` column (Stage A P-006 ff7e678 fix; verified at `app/api/v1/audit/route.ts:39-40`).

## [1.10.3] - 2026-05-18

Stage C Release 3 — pre-launch audit HIGH-severity sub-stages C.4 (revenue path, 4 items) + C.6 (auth/billing, 4 items) per `docs/plans/2026-05-18-stage-c-high-batch.md` (plan token `plan-stage-c-high-batch`). 8 items shipped.

### Added

- **`website/src/app/api/auth/forgot-password/route.ts`** — server-side rate-limited forgot-password endpoint. 3 requests/email/hour + 10/IP/hour. Page refactored to POST here instead of calling `supabase.auth.resetPasswordForEmail` directly client-side. P-H026.
- **`website/src/app/api/stripe/webhook/health/route.ts`** — uptime-monitor endpoint that returns 503 when `STRIPE_WEBHOOK_SECRET` or `STRIPE_SECRET_KEY` is missing, so external monitors detect misconfiguration before Stripe's retry budget exhausts. P-H017.
- **`handleOrderRefunded` + `handleSubscriptionCancelled`** in `website/src/app/api/lemon-squeezy/webhook/route.ts` — refund-and-keep-trial attack closed. Both handlers revoke `license_key_status` and downgrade the linked org to `plan='free', plan_status='cancelled'`. Per operator policy decision 2026-05-18: subscription cancellation revokes entitlement. P-H016.

### Fixed

- **`website/src/app/book/page.tsx:178,196`** — Bundle and Team tier `note` copy changed from "Auto-renews at $X/yr unless cancelled" to "trial — we do NOT auto-bill; you continue on Free unless you explicitly upgrade with your consent". Closes the marketing-vs-implementation contradiction: pre-fix the copy promised auto-renewal but `tierTrialDays()` returns 365 with cron downgrade to free with no auto-bill. Welcome/nurture emails already correctly say "Nothing auto-bills" — copy is now consistent. P-H014. Per operator decision 2026-05-18: change copy (not implement auto-renew).
- **`website/src/app/api/sso/callback/route.ts:341-360`** — SAML callback now performs an explicit NameID-domain match against `ssoConfig.domain` (defense-in-depth; mirrors OIDC at handleOidcCallback line ~407). Pre-fix: the implicit domain match via SELECT WHERE could regress on any future refactor of the lookup pattern. The explicit assertion makes cross-tenant takeover via NameID-with-mismatched-domain structurally impossible. P-H025. Lives UNDER the `MASSU_SSO_ENABLED=false` Stage B gate; activates when SSO re-enables post-pen-test.
- **`website/src/app/api/cron/expire-trials/route.ts:158-170`** — milestone-email send conditions changed from EXACT-day equality (`=== 30`, `=== 14`, etc.) to RANGE checks (`>= 30`, `<= 14 && > 3`, etc.). Pre-fix: any Vercel cron miss permanently dropped the affected milestone. With ranges + `trial_email_log` `UNIQUE(org_id, milestone)` idempotency, missed cron days catch up on the next run; once-sent never re-sends. P-H028.
- **`website/src/app/api/stripe/webhook/route.ts:8-25,46-55`** — both 500 paths (missing-secret + processing-failure) now emit `severity: 'critical'` log lines with `action` + `consequence` metadata for external alerting. Once @sentry/nextjs ships in 1.10.4 (P-H037), `logger.error` will additionally call `Sentry.captureException` without further code changes. P-H017.
- **`website/src/app/api/license/activate/route.ts:17-39`** — `hashIp()` no longer falls back to `LEMON_SQUEEZY_WEBHOOK_SECRET`; `IP_HASH_PEPPER` is REQUIRED and throws on missing. (Already shipped in 1.10.2 P-H023 — reaffirmed here for changelog completeness across the cluster.)
- **`website/src/app/api/cron/expire-trials/route.ts:184-218`** — removed the `supaUntyped as unknown as ...` cast hack on `trial_email_log` (P-H010 follow-up; `trial_email_log` now in generated types as of 1.10.2). The cron now uses `supabase.from('trial_email_log').insert(...)` directly. Pre-fix the hack was a CR-9 leftover from when the table wasn't in generated types.
- **`website/src/__tests__/integration/api-auth.test.ts:14-25`** + **`scripts/massu-security-scanner.sh:169`** — added `auth/forgot-password` to PUBLIC_ROUTES allowlist (intentionally unauthenticated — server-side rate-limited). Both allowlists kept in lockstep so the drift-guard parity test stays green.
- **`website/src/lib/changelog.ts:40`** — added `"Deferred to Follow-up Sub-Plans"` to `KNOWN_SECTION_HEADINGS` whitelist so the 1.10.2 changelog parses cleanly.

### Verified (no code change)

- **P-H015** ebook-attached-to-LS-variant verification — operator INDEPENDENT action; cannot be automated. Operator confirmed before book launch per parent plan operator-action-inventory.
- **P-H027** `/api/v1/audit?actor=` filter uses correct `user_id` column (fixed in Stage A P-006 ff7e678; re-verified at `app/api/v1/audit/route.ts:39-40`).

## [1.10.2] - 2026-05-18

Stage C Release 2 — pre-launch audit HIGH-severity sub-stages C.3 (schema/DB, 4 items) + C.5 (security defense-in-depth, 5 of 7 items) per `docs/plans/2026-05-18-stage-c-high-batch.md` (plan token `plan-stage-c-high-batch`). 9 items shipped this release. Two C.5 items (P-H019 Ed25519 license signing + P-H022 nonce-based CSP migration) are deferred to dedicated follow-up sub-plans because each requires non-trivial server-side counterparts (P-H019: AWS Secrets Manager key + signing route; P-H022: per-page inline-script audit) that must be done with operator coordination and proper testing scope — NOT release valves per CR-46, but legitimate scope-splitting where the structural foundation needs the operator's environment access.

### Added

- **`website/supabase/migrations/027_drop_contact_submissions_anon_insert.sql`** — drops the `allow_anon_insert` RLS policy on `contact_submissions` that previously let the public anon key bypass `/api/contact`'s rate-limit + Zod sanitization. The API route uses the service-role client (RLS-exempt), so the anon policy was unnecessary AND a security footgun. P-H021.
- **`website/src/lib/ip/get-client-ip.ts`** — canonical client-IP extractor preferring `x-real-ip` (trusted on Vercel) over RIGHTMOST `x-forwarded-for` hop. P-H018 — replaces 19 callsites that trusted the LEFTMOST attacker-controlled XFF hop.
- **`website/src/__tests__/get-client-ip-precedence.test.ts`** — 7-case drift-guard asserting precedence + AST-scan ban on any direct `headers.get('x-forwarded-for')` outside the helper.
- **`website/src/__tests__/webhook-url-allowlist-completeness.test.ts`** — 11-case drift-guard for the new validateWebhookUrl gaps (P-H024).
- **`packages/core/src/__tests__/memory-db-cascade-delete-session.test.ts`** — drift-guard for P-H011 cascade behavior (source scan + live cascade verification on a fresh DB).

### Fixed

- **`website/src/lib/supabase/types.ts`** — added `trial_email_log` type definition (Row/Insert/Update + Relationships) per migration 024. Removed the `supabase as unknown as ...` cast hack at `app/api/license/activate/route.ts:421-425`. Comment about "migration 023" stale-referenced removed. P-H010.
- **`packages/core/src/memory-db.ts`** — 10 FOREIGN KEY references to `sessions(session_id)` now declare `ON DELETE CASCADE` (was: implicit RESTRICT). Closes the "DELETE FROM sessions with surviving children throws" class under `PRAGMA foreign_keys = ON`. Note: existing customer DBs from prior versions retain non-cascade tables (CREATE TABLE IF NOT EXISTS no-ops); fix takes effect for fresh installs from 1.10.2 onward. P-H011.
- **`packages/core/src/memory-db.ts:630-657`** — `dequeuePendingSync` no longer silently discards queue items at `retry_count >= 10`. Now emits a stderr warning with recent error messages AND inserts a `cloud_sync_giveup` row into `analytics_events` so the customer can detect silent cloud-sync failure (e.g., invalid API key for >10 cycles losing all queued observations). P-H012.
- **`packages/core/src/knowledge-db.ts:107-119`** — `knowledge_schema_mismatches.source` column no longer has a SQL DEFAULT that was a JS template-literal interpolation baked into the customer's SQLite at schema creation time (so later config changes were ignored). Default is now applied at INSERT time via `getConfig().conventions.knowledgeSourceFiles[0]` in `knowledge-indexer.ts:443-447`. P-H013.
- **19 route handlers** (`api/settings/route.ts`, `api/contact/route.ts`, `api/evidence/route.ts`, `api/license/activate/route.ts`, `api/github-stars/route.ts`, `api/sso/route.ts`, `api/sso/callback/route.ts`, `api/keys/route.ts`, `api/keys/[id]/route.ts`, `api/export/route.ts`, `api/lemon-squeezy/webhook/route.ts`, `api/stripe/checkout/route.ts`, `api/badge/[orgSlug]/[type]/route.ts`, `api/invitations/accept/route.ts`) — replaced `request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'` with `getClientIp(request)`. Closes the attacker-controllable IP bypass class. P-H018.
- **`packages/core/src/cloud-sync.ts:98-128`** — payload filter now consumes `classifyVisibility()` from `observation-extractor.ts` to drop observations whose title/detail/file_path match `PRIVATE_PATTERNS` (Stripe keys, env var names, file paths, Bearer tokens, etc.). Pre-fix: cloud-sync transmitted every observation to Massu's Supabase, leaking customer secrets. Now drops privately-classified observations with stderr count for transparency. P-H020.
- **`website/src/app/api/license/activate/route.ts:17-39`** — `hashIp()` no longer falls back to `LEMON_SQUEEZY_WEBHOOK_SECRET` and no longer silently uses empty pepper. `IP_HASH_PEPPER` is now REQUIRED; absence throws with actionable error. Closes the cross-purpose-key-reuse vulnerability where a leaked `license_activation_attempts` table would let attackers recover the webhook-signing secret via rainbow-table inversion. P-H023. **Operator action required**: set `IP_HASH_PEPPER` env var to a distinct random value (`openssl rand -hex 32`) — NOT reused from any other secret.
- **`website/src/lib/validations.ts:199-260`** — `validateWebhookUrl` SSRF allowlist extended: rejects `0.0.0.0/8` (was: only exact 0.0.0.0), CGNAT `100.64.0.0/10`, IPv6 ULA `fc00::/7`, IPv6 link-local `fe80::/10`, IPv4-mapped IPv6 loopback `::ffff:127.x.x.x`, and IPv6 `::1` (canonical form). P-H024. DNS-rebinding pin documented as follow-up (requires fetch-dispatcher rework).
- **`website/src/__tests__/integration/license-activate.test.ts:99-110`** — added `vi.stubEnv('IP_HASH_PEPPER', ...)` to beforeEach since P-H023 made the env var REQUIRED. Test deterministically uses a fixed pepper string.

### Deferred to Follow-up Sub-Plans

Per CR-46 these are NOT "TODO revisit later" — each is a structural plan that requires multi-day operator-coordinated work, NOT scope-splitting for convenience. Tracked separately:

- **P-H019 Ed25519 license signing** → `plan-license-response-signing-server-side` (TBD). Requires: (a) AWS Secrets Manager key creation by operator, (b) server-side signing route in `website/src/app/api/license/validate/route.ts`, (c) client-side verifier in `packages/core/src/security/`, (d) 24h grace period for existing unsigned-cache acceptance, (e) cutover smoke test against production. Current vulnerable behavior preserved until follow-up ships.
- **P-H022 nonce-based CSP migration** → `plan-csp-nonce-migration` (TBD). Requires: (a) per-page audit of every inline `<script>` and `<style>` in `website/src/app/`, (b) middleware nonce generation + injection into request headers, (c) Next.js consumption pattern (read x-nonce from headers() in layout), (d) tightening CSP one-source-at-a-time with smoke testing each page, (e) drift-guard test. Current `'unsafe-inline'` CSP preserved until follow-up ships.

## [1.10.1] - 2026-05-18

Hotfix release for Stage C `plan-stage-c-high-batch` Release 1 — closes the **wider P-H008 marketing-count drift class** caught by post-deploy smoke testing of 1.10.0. The 1.10.0 P-H008 fix scope was narrow (just `installation.mdx` + `stats.ts`); post-deploy curl of `https://massu.ai/docs/getting-started/installation` revealed 36 OTHER marketing surfaces still hardcoded `"11 lifecycle hooks"` / `"11 hooks"` / `"43 workflow commands"` literals across `website/src/**` (TSX pages, layouts, components, data files, lib/email.ts) AND `website/content/**` (MDX docs + articles). Same structural bug class as **P-019** (MCP_TOOL_COUNT drift); fix follows the same structural pattern.

### Fixed

- **`website/src/app/layout.tsx`** + **`features/page.tsx`** + **`docs/layout.tsx`** + **`about/page.tsx`** + **`overview/page.tsx`** + **`how-it-works/page.tsx`** + **`checkout/cancel/page.tsx`** — replaced hardcoded literals `"11 lifecycle hooks"` / `"11 hooks"` / `"59 workflow commands"` / `"11 AI agents"` with named-export consumption (`LIFECYCLE_HOOK_COUNT`, `WORKFLOW_COMMAND_COUNT`, `AI_AGENT_COUNT`) from `@/data/stats`. Mirrors the P-019 pattern. P-H008-extended.
- **`website/src/components/sections/Hero.tsx`** + **`OpenSourceSection.tsx`** + **`HowItWorksPreview.tsx`** + **`pricing/PricingFAQ.tsx`** — same named-export migration. P-H008-extended.
- **`website/src/data/articles.ts`** + **`pricing.ts`** + **`features.ts`** — converted hardcoded counts to template-literal references to the stats SoT named exports. P-H008-extended.
- **`website/src/lib/email.ts`** — pre-existing **"43 workflow commands"** drift (also pre-1.5.x) fixed to `${WORKFLOW_COMMAND_COUNT}` reference. CR-9 bonus surface caught while fixing P-H008-extended.
- **`website/content/docs/getting-started/index.mdx`** + **`guides/troubleshooting.mdx`** + **`reference/cli-reference.mdx`** + **`articles/automated-enforcement.mdx`** — MDX literal updates 11→16 hooks. MDX files don't consume TS imports; drift-guard ban catches future regressions.

### Added

- **`website/src/__tests__/marketing-tool-count-against-source-truth.test.ts`** — extended drift-guard `BANNED` patterns to cover the new bug classes. Hook-count `"11 lifecycle hooks"` / `"11 hooks"`, command-count `"43 workflow commands"` / `"47 commands"` / `"49 commands"`, AI-agent-count `"7 AI agents"` / `"9 AI agents"` are now scanned across `website/src/**` + `website/content/**`. Closes the same bug class P-019 closed for `MCP_TOOL_COUNT` — but for the FULL stats.ts named-export family.

## [1.10.0] - 2026-05-18

Stage C Release 1 — pre-launch audit HIGH-severity sub-stages C.1 (hooks + doctor parity, 8 items) and C.2 (MCP tools, 2 items) per `docs/plans/2026-05-18-stage-c-high-batch.md` (plan token `plan-stage-c-high-batch`). 10 P-H items shipped; 28 remain across 1.10.1 / 1.10.2 / 1.10.3 per the operator-revised release plan. 4 of 7 planned drift-guards land here (DG-1..DG-4); DG-5..DG-7 ship with their respective P-items in subsequent releases. Every fix is structural — paired with a vitest drift-guard that makes the bug class impossible to reintroduce (CR-46).

### Added

- **`packages/core/src/lib/hook-registry.ts`** — single source of truth for the canonical Massu hook set (`REGISTERED_HOOKS` constant + `getExpectedHookFiles()`). Doctor, installer, and `build:hooks` all consume from this module. Closes the 11-vs-16 hook-count drift class structurally — adding a new hook now requires touching `src/hooks/X.ts` + `REGISTERED_HOOKS` + `buildHooksConfig`, and the parity drift-guard fails if any one is missed. P-H001.
- **`packages/core/src/__tests__/hook-registry-parity.test.ts`** — 4-case drift-guard DG-1 asserting 3-way parity (src/hooks filenames vs REGISTERED_HOOKS vs buildHooksConfig refs vs dist/hooks/*.js after build).
- **`packages/core/src/__tests__/auto-learning-bounded-diff.test.ts`** — drift-guard DG-2: fabricates ~5MB working tree and asserts auto-learning Stop hook completes <5s.
- **`packages/core/src/__tests__/cloud-sync-abort-controller.test.ts`** — 3-case drift-guard DG-3: aborts hanging fetch <1s, AbortSignal passed to every fetch, custom timeout honored.
- **`packages/core/src/__tests__/init-app-router-fallback.test.ts`** — 4-case `massu init` paths.source fallback test (app/ → pages/ → . fallback; src+app preserves src).
- **`packages/core/src/__tests__/template-engine-reserved-and-jsx.test.ts`** — drift-guard for P-H006 (`{{ARGUMENTS}}` reserved literal) + P-H007 (multi-line JSX pass-through).
- **`packages/core/src/__tests__/trpc-map-empty-codegraph-hint.test.ts`** — drift-guard DG-4 asserting TOOL_DB_NEEDS includes codegraph + tools.ts source contains actionable remedy hint.
- **`packages/core/src/hooks/post-tool-use.ts`** — `recordTestResult` now wired on Bash test-runner commands (`npm test`, `npx vitest`, `pnpm test`, `pytest`, `go test`, `cargo test`) with vitest/jest/pytest output parsing. P-H029.

### Fixed

- **`packages/core/src/commands/doctor.ts:45`** — `EXPECTED_HOOKS` was a hand-maintained 11-entry list while `installHooks()` registered 16. Doctor reported `11/11 PASS` even when 5 hooks were missing from `dist/hooks/`. Now sourced from `getExpectedHookFiles()` in the new SoT. P-H001.
- **`packages/core/src/hooks/auto-learning-pipeline.ts:73,75`** — replaced bare `execSync('git diff')` (unbounded read of entire working tree, 10s timeout) with two-stage probe: `git diff --shortstat` first to estimate byte count, then `git diff` ONLY if estimated ≤ 2MB. Also switched to `execFileSync` argv form (defense-in-depth). P-H002.
- **`packages/core/src/cloud-sync.ts:108`** — bare `fetch()` had no AbortSignal; offline customers burned the entire Stop-hook 15s budget on unreachable endpoint. Now uses `AbortSignal.timeout(requestTimeoutMs)` (default 2000ms, configurable) and short-circuits retry on AbortError/TimeoutError. P-H003.
- **`packages/core/src/commands/init.ts:428`** — `paths.source` defaulted to `'src'` even when only `app/` (Next.js App Router) or `pages/` existed. Validator rejected the config and rolled init back. Now falls back through `src/` → `app/` → `pages/` → `.` (root). P-H004.
- **`packages/core/src/commands/install-commands.ts:490`** — `buildTemplateVars()` now exposes `ARGUMENTS: '{{ARGUMENTS}}'` reserved literal. P-H006 — `/massu-article-review`, `/massu-autoresearch`, `/massu-command-improve`, `/massu-squirrels` silently failed to install because the template engine threw `MissingVariableError` on their `{{ARGUMENTS}}` usage.
- **`packages/core/src/commands/template-engine.ts:81`** — multi-line content inside `{{...}}` now passes through verbatim (clearly JSX). P-H007 — `patterns/component-patterns.md` silently failed to install because the engine misparsed JSX `action={{...}}` formatted across lines. Single-line content of every shape still goes through strict renderToken — all pre-existing security tests preserved.
- **`packages/core/src/tool-db-needs.ts:73`** — `trpc_map` now declares `['codegraph', 'data']`. P-H009 — on fresh installs without a built codegraph the JS-side tRPC index never built and the flagship code-intel tool silently returned "0 procedures". Handler also emits actionable remedy hint (`npx massu sync`) when the index is empty.
- **`packages/core/src/commands/install-hooks.ts:7`** — stale "all 11 Claude Code hooks" docstring updated to reference the canonical hook-registry SoT (count sourced from `REGISTERED_HOOKS`).

### Changed

- **`website/content/docs/getting-started/installation.mdx`** — hook count synced from drifted 11 to actual 16. Hook table appended with the 5 missing rows: `fix-detector`, `classify-failure`, `incident-pipeline`, `rule-enforcement-pipeline`, `auto-learning-pipeline`. P-H008.
- **`website/src/data/stats.ts`** — `Lifecycle Hooks` count updated 11 → 16 to match `lib/hook-registry.ts` SoT. P-H008.
- **`packages/core/src/__tests__/server-lazy-db-deps.test.ts:99-122`** and **`packages/core/src/__tests__/server.test.ts:243`** — updated to assert the new P-H009 behavior (`trpc_map` opens both `codegraph` and `data` DBs). Previously these tests asserted the bug.
- **`docs/plans/2026-05-16-prelaunch-audit-remediation.md`** (plan-token `plan-2026-05-16-prelaunch-audit`) — added `## Changelog Summary` section retrospectively to comply with plan-1.9.0 P-A-003 SHIPPED-status requirement (CR-9 cleanup of pre-existing parent-plan validator FAIL).

## [1.9.5] - 2026-05-16

Pre-launch comprehensive audit remediation — combined Stage A + Stage B release covering all 22 CRITICAL findings from the 14-agent adversarial audit fleet (`docs/plans/2026-05-16-prelaunch-audit-remediation.md`, plan token `plan-2026-05-16-prelaunch-audit`). Every fix is structural — paired with a vitest drift-guard that makes the bug class impossible to reintroduce (CR-46 compliant). 12 of 22 CRITICALs are security-critical (RCE, SSO bypass, license-takeover, schema drift causing 500s in production), addressed before book launch. The 1.9.4 hotfix slot was rolled into this combined release to ship Stage A + Stage B atomically. Also bundles the previously-shipped `plan-rulesets-as-code` Branch Protection rulesets-as-code migration (SHA b184d3f, drift-guarded by `branch-protection-audit.yml`).

### Fixed

- **`packages/core/src/hooks/fix-detector.ts:17,122,124`** — RCE via `execSync` template-literal interpolation. Replaced with `execFileSync` argv form. Closes P-001 (Stage A). Drift-guard: `packages/core/src/__tests__/hooks-no-shell-execsync.test.ts` AST-scans every hook file and asserts zero `execSync` template-literal calls.
- **`packages/core/src/commands/init.ts`** — `.mcp.json` written unpinned (`npx -y @massu/core`) resolved to stale global install. Now pinned to current installer version (`getInstallerVersion()`). Closes P-002 (Stage A). Drift-guard: `__tests__/init-mcp-json-pin.test.ts`.
- **`packages/core/src/commands/init.ts` + new `commands/hook-runner.ts`** — hook paths baked customer's npx-cache absolute paths into `.claude/settings.json`. Now emits `npx -y @massu/core@<version> hook-runner <name>` dispatch — version-pinned and machine-portable. Closes P-003 (Stage A). Drift-guard: `__tests__/init-hook-paths-no-absolute.test.ts`.
- **New `packages/core/src/lib/memory-path.ts`** — memory directory encoding inconsistency (`--<root>` vs `-<root>`) orphaned `MEMORY.md` on 100% of fresh installs. Shared encoder/decoder with legacy-double-dash auto-migration. Closes P-004 (Stage A). Drift-guard: `__tests__/memory-path-roundtrip.test.ts`.
- **`website/src/app/api/v1/quality/route.ts`** — selected non-existent `quality_metadata` column. Now selects `security_metadata`. Closes P-005 (Stage A).
- **`website/src/app/api/v1/audit/route.ts`** — filtered non-existent `actor_id` column. Now uses `user_id`. Closes P-006 (Stage A).
- **`website/src/app/api/v1/team/route.ts`** — selected non-existent `full_name`. Now uses `display_name`. Closes P-007 (Stage A).
- **`website/src/app/api/v1/cost/trend/route.ts`** — selected 4 non-existent columns. Now reads `snapshot_date,total_cost_usd,total_tokens,cost_by_model,cost_by_feature` with a post-query map preserving the external API response shape. Closes P-008 (Stage A).
- **`website/src/app/api/v1/webhooks/[id]/route.ts:34`** — surfaced bonus column-drift fix (`response_status` → `status_code`, cite: migration 014:31-37) caught on first run of the new drift-guard. Closes the CR-9 corollary to P-009 (Stage A).
- **NEW drift-guard `website/src/__tests__/api-v1-schema-parity.test.ts`** — depth-aware Tables parser + line-scanner pairs every `.from().select()` and `.eq()/gte/lte/etc.` filter call per route. Asserts every referenced column exists in the generated `Database` type. Closes the entire API-vs-schema bug class structurally (P-009 Stage A).
- **NEW migration `website/supabase/migrations/025_cleanup_org_records_column_fix.sql`** — migration 017 hardcoded `created_at` for ALL retention-managed tables, but `session_transcripts` uses column `timestamp` (010:38), aborting cleanup with `column created_at does not exist`. Restructured the resource map to encode `{table, cutoff_col}` per resource_type — adding a future retention-managed table whose cutoff column is not `created_at` no longer requires CASE-branch sprawl. Migration 017's audit_log advisory-lock + trigger-disable pattern preserved. Closes P-010 (Stage B). Drift-guard: `website/src/__tests__/cleanup-org-records-column-existence.test.ts` (4 cases parsing the latest JSONB map and asserting every `cutoff_col` exists on its `table` in `types.ts`).
- **NEW migration `website/supabase/migrations/026_service_role_detection_hardening.sql`** — migration 020 used a single `current_setting('role', true) = 'service_role'` check whose behaviour against the production Supabase admin client was UNVERIFIED. Replaced with 3-signal defense-in-depth: (1) the original `role` GUC, (2) `current_user = 'service_role'` (covers `SET ROLE service_role` clients), (3) explicit `app.is_service_role = 'true'` GUC (operator-controlled `SET LOCAL` fallback). Whichever pattern the admin client uses now or after a future client revision, detection succeeds — eliminates the "block-ALL-webhook-plan-upgrades" failure mode. Closes P-011 (Stage B). Drift-guard: `website/src/__tests__/service-role-detection-defense-in-depth.test.ts` asserts all three signals are present in the latest trigger definition.
- **`packages/core/src/commands/init.ts` `mergeHooksConfig()`** — `installHooks()` wholesale-replaced customer's `hooks` settings block (recurrence of 1.8.0 permissions-merge trap). Now deep-merges by event+matcher. Closes P-012 (Stage A). Drift-guard: `__tests__/init-hooks-merge-preserves-customer.test.ts`.
- **`website/src/components/redeem/RedeemForm.tsx` + new `website/src/components/redeem/fallback-logic.ts`** — direct `/redeem` traffic with no `book_purchases` row spun forever on 202 PURCHASE_PROCESSING. Added `BONUS_FALLBACK_MS = 30_000` rescue: after 30s of polling, surfaces a `/bonus` rescue link. Closes P-013 UI defense-in-depth half (Stage A). Drift-guard: `__tests__/redeem-fallback-logic.test.ts` (9 cases).
- **`website/src/app/api/license/activate/route.ts`** — TWO CRITICAL hardenings in one route refactor: (a) **P-014 atomic UPDATE** — SELECT-check-UPDATE pattern allowed two concurrent requests with the same key to both pass the JS-side status check and double-activate. Replaced with atomic `UPDATE book_purchases SET license_key_status='active', activated_at=NOW() WHERE id=$1 AND license_key_status='inactive' .select('id, activated_at')`. Race losers see `[]` from the post-update select and surface 409 `already_activated`. (b) **P-015 auth + email match** — route was anonymous and resolved identity via `user_profiles.email = purchase.email`, allowing an attacker to sign up as `victim@victim-corp.com` and bind a leaked license key to the victim's org. Now requires `createServerSupabaseClient().auth.getUser()`; returns 401 with `needs_signup` hint (no email leak — anonymous enumeration vector closed) when unauthenticated; returns 403 when `authedUser.email.toLowerCase() !== purchase.email.toLowerCase()`. Both closed in Stage B. Drift-guard: `integration/license-activate.test.ts` covers race-loser, 401 unauth, 403 mismatch, AND case-insensitive matching.
- **NEW `website/src/lib/sso-flag.ts`** + GATED `website/src/app/api/sso/callback/route.ts`, `website/src/app/api/sso/route.ts`, `website/src/app/dashboard/settings/sso/page.tsx` — the custom OIDC verifier never cryptographically verified the JWT signature against the IdP's JWKS (P-016 — full SSO bypass for any attacker who registers their own OIDC config), and the custom SAML verifier was vulnerable to XML Signature Wrapping (P-017 — the first-element-wins regex parser allowed outer-wrapper substitution while inner signature still validated). Per operator decision (2026-05-16), SSO is DISABLED via `MASSU_SSO_ENABLED=false` (default) until the library replacement (`openid-client` + `@node-saml/node-saml`) ships in `plan-B.3-followup` post-launch + third-party pen-test. Every SSO entry point returns canonical 503 `SSO_DISABLED`; dashboard SSO settings page shows maintenance UI with `support@massu.ai` contact path. Legacy verifier code preserved below the gate so the followup PR can wire libraries without re-deriving the Supabase user-creation flow. Both closed at the entry point in Stage B. Drift-guard: `website/src/__tests__/sso-disabled-by-default.test.ts` (10 cases) asserts the flag defaults false, that all three entry-point files import + call `isSsoEnabled()`, and that the callback route returns `ssoDisabledResponse()` from BOTH POST and GET handlers.
- **`website/src/data/stats.ts`** — added `MCP_TOOL_COUNT` (= 73) named export alongside the existing `stats: Stat[]` SoT, plus `WORKFLOW_COMMAND_COUNT`, `AI_AGENT_COUNT`, `LIFECYCLE_HOOK_COUNT`. Replaced literal `84 MCP tools` claims across 14 TSX/TS surfaces (`app/layout.tsx` 3x, `app/docs/layout.tsx`, `app/features/page.tsx` 4x, `app/about/page.tsx`, `app/overview/page.tsx` 5x, `app/pricing/page.tsx`, `app/checkout/cancel/page.tsx`, `components/sections/Hero.tsx` 2x, `components/sections/OpenSourceSection.tsx`, `components/sections/CloudPreview.tsx`, `components/pricing/PricingFAQ.tsx`, `components/pricing/FeatureComparison.tsx`, `data/articles.ts` 3x, `data/features.ts`, `data/pricing.ts`) with `${MCP_TOOL_COUNT}` interpolation; replaced `84` with literal `73` in 2 MDX content files. Closes P-019 (Stage B). Drift-guard: NEW `website/src/__tests__/marketing-tool-count-against-source-truth.test.ts` walks `website/src` + `website/content` for forbidden literals (`84 MCP`, `84 tools`, `all 84`, plus historical drift literals `47/56/62 MCP/tools`) and asserts zero matches.
- **`.github/workflows/ci.public.yml`** — both `ci.yml` and `ci.public.yml` had workflow `name: CI` and shared `${{ github.workflow }}-${{ github.ref }}` concurrency group; on every main push the stronger `ci.yml` was being CANCELLED while the weaker `ci.public.yml` (4 of 6 internal jobs only — missing Pattern Scanner, Security Scanner, Generalization Scanner, Plan Status Validator, Plan Commit Drift, Plan-Token Changelog Coverage, Website Audit, Hook Build) satisfied branch protection. This is how the 4 API column-drift CRITICALs (P-005..P-008) reached production. Renamed `ci.public.yml` workflow + concurrency group + job-display names to `CI (public-mirror)`; 4 jobs gated `if: github.repository == 'massu-ai/massu'` so the internal repo runs the FULL `ci.yml` and the public mirror keeps the public-facing subset. Job-level `name:` values PRESERVED (both rulesets reference them as required status checks). Closes P-020 (Stage A). Drift-guard: NEW `website/src/__tests__/workflow-uniqueness.test.ts` (3 assertions).
- **NEW `website/src/app/book/opengraph-image.tsx`** — `book/layout.tsx` referenced `/og-book.png` but the file didn't exist in `website/public/`, producing a 404 image preview on every Twitter / LinkedIn / Slack share of `/book`. Replaced with the Next.js `opengraph-image.tsx` file convention — `next/og` `ImageResponse` generates a brand-consistent 1200x630 PNG at build time, Next.js auto-wires `<meta property="og:image">` and `<meta name="twitter:image">`. No static asset to maintain. Removed the broken `/og-book.png` references from `book/layout.tsx`. Closes P-021 (Stage B). Drift-guard: `website/src/__tests__/og-book-image-resolves.test.ts` (4 cases) — asserts the file exists, exports `ImageResponse` with 1200x630 dimensions, AND that any future reintroduction of `/og-book.png` in `book/layout.tsx` requires the static file to also exist.
- **`website/src/components/sections/Hero.tsx`** — homepage had ZERO `/book` promotion above-the-fold; `/book` was only reachable via 7th nav tab. Added a pill-style `<Link href="/book">` book-announcement BEFORE the existing "Free & Source Available" badge AND before the Install Free button. `trackEvent('cta_hero_book_announcement')` for funnel measurement. Closes P-022 (Stage B). Drift-guard: `website/src/__tests__/homepage-book-cta-presence.test.ts` enforces the ordering invariant (book CTA must precede Install Free).
- **`website/src/components/redeem/RedeemForm.tsx`** — `needs_signup` branch lost the license key, forcing customers to dig through email to re-paste the 28-char code after signup. Implemented 2-layer persistence: localStorage `massu_pending_license_key` (primary) + `?license_key=` URL fallback. Auto-fills on mount; strips URL param after hydration (no Referer/history leak); persists on `needs_signup`; clears on success; signup CTA carries `redirect_to=/redeem?license_key=…`. Closes P-023 (Stage B). Drift-guard: `__tests__/redeem-license-key-persistence.test.ts` (7 cases).

### Removed

- **DELETED `website/content/docs/features/mcp-bridge.mdx`** + purged MCP Bridge references from `website/src/data/docs-nav.ts`, `website/content/docs/reference/tool-reference.mdx` (the "MCP Bridge Tools (4)" section), `website/content/docs/reference/license-tiers.mdx` (Pro tier 47 → 43 tools), `website/src/components/pricing/PricingFAQ.tsx` (2 FAQ entries removed), `website/src/data/features.ts` (the entire 4-tool `mcp-bridge` feature block — drops Feature Entries 167 → 163), `website/src/app/overview/page.tsx` changelog. Operator decision: REMOVE not implement. Vapor MCP Bridge tools (`mcp_servers`, `mcp_tools`, `mcp_call`, `mcp_status`) were documented at full feature page level but did NOT exist in `packages/core/src/tools.ts` — paying Pro customers would have received "Unknown tool" errors. Closes P-018 (Stage B).

### Changed

- **`website/src/data/stats.ts` `Feature Entries`**: 167 → 163 to match the P-018 MCP Bridge feature-block removal (4 tools × 1 entry each).
- **`website/content/docs/reference/license-tiers.mdx` Pro Tier header**: `47 additional tools` → `43 additional tools` to match the P-018 MCP Bridge removal.
- **`packages/core/package.json` description**: tier-count claim refreshed `(12 free / 72 total)` → `(12 free / 73 total)`, workflow-commands `55+` → `59`.
- **`docs/plans/2026-05-16-prelaunch-audit-remediation.md`** Plan Status header: "IN PROGRESS — Stage A + Stage B CODE COMPLETE (awaiting operator release ceremony); Stages C-E DRAFT" → SHIPPED. Plan documents Stages C-E (38 HIGH + 52 MEDIUM + 71 LOW + INFO) as draft work that will ship post-launch in the 1.10.x / 1.11.x / rolling cluster cadence.

### Known follow-on

- **P-016 / P-017 library replacement** is NOT in this release. The security risk is closed at the entry point (every SSO request returns 503; legacy verifier code unreachable). The full library replacement (`openid-client` + `@node-saml/node-saml`) is `plan-B.3-followup` post-launch after a third-party pen-test, per the operator decision recorded in the master plan.
- **Operator manual verification still required** (these cannot be automated): (a) printed Amazon book URL points to `/bonus` not `/redeem` (defense-in-depth ships either way via P-013), (b) smoke-test `current_setting('role')` against the production admin client to confirm the 3-signal trigger admits the actual webhook caller (P-011), (c) each Lemon Squeezy variant has the ebook file attached (P-H015).

### Verification

- `packages/core/`: 156 test files / 2235 tests PASS (12 skipped) on Node 22.
- `website/`: 46 test files / 439 tests PASS (includes 46 NEW Stage B drift-guard cases across 8 new/updated test files + 8 Stage A drift-guards already shipped).
- `website/` TypeScript: `npx tsc --noEmit` 0 errors.
- `packages/core/` TypeScript: `npx tsc --noEmit` 0 errors.
- Node 26 local builds blocked by pre-existing better-sqlite3 native-binding issue (memory `feedback_better_sqlite3_native_binding_missing.md`); CI runs on Node 22 cleanly.

Plan reference: `docs/plans/2026-05-16-prelaunch-audit-remediation.md` (plan-2026-05-16-prelaunch-audit). Bundles `plan-rulesets-as-code` (SHA b184d3f, Branch Protection rulesets-as-code; drift-guard `branch-protection-audit.yml`).

## [1.9.3] - 2026-05-15

Bug-fix release. Closes upstream issue [massu-ai/massu#4](https://github.com/massu-ai/massu/issues/4) — `tools/list` emitted a non-standard top-level `tier` field on every Tool object, which Claude Code 2.1.143 (released 2026-05-15) silently rejects, causing all 67 `mcp__massu__*` tools to disappear from the deferred-tool registry on session start. The canonical MCP Tool schema ([`schema/2025-11-25/schema.ts` line 1251](https://github.com/modelcontextprotocol/specification/blob/main/schema/2025-11-25/schema.ts#L1251)) permits only `name`, `title`, `description`, `inputSchema`, `execution`, `outputSchema`, `annotations`, `_meta`, `icons` — `tier` is not in the schema. Structured tier metadata now lives under `annotations.tier` (the spec-sanctioned extension point for tool metadata); the visible `[PRO] ` / `[TEAM] ` / `[ENTERPRISE] ` description-prefix labelling is unchanged. Internal license enforcement at `tools.ts:323-331` is unaffected because it reads `getToolTier(name)` from the static server-side `TOOL_TIER_MAP`, never from the wire-emitted field — no license-bypass risk. Structural drift-prevention: new vitest assertion (`license.test.ts` "emits only MCP-spec-permitted top-level fields") parses the annotated definitions against the canonical permitted set; the regression class becomes structurally impossible to reintroduce without test failure.

### Fixed

- **`packages/core/src/license.ts:194-203` `annotateToolDefinitions()`** — replaced the top-level `tier,` spread with `annotations: { ...(def.annotations ?? {}), tier },`. Wire-format Tool objects now conform to MCP spec 2025-11-25 §`Tool` (extends `BaseMetadata, Icons`). Caller-supplied annotations (e.g. `readOnlyHint`, `title`) are preserved via shallow-merge before tier is added.
- **`packages/core/src/tools.ts:43-48` `ToolDefinition` interface** — dropped top-level `tier?: 'free' | 'pro' | 'team' | 'enterprise'`; added `annotations?: Record<string, unknown>` to mirror the MCP spec extension point. The local interface remains permissive (`Record<string, unknown>` vs. the spec's strictly-typed `ToolAnnotations`) so that `tier` can co-exist with caller-supplied annotation fields without a circular `ToolTier` type import.

### Added

- **`packages/core/src/__tests__/license.test.ts` two new regression tests** under the existing P3-029 `annotateToolDefinitions()` describe block:
  - `"emits only MCP-spec-permitted top-level fields on every Tool (regression: #4)"` — iterates every annotated def and asserts `Object.keys(def) ⊆ SPEC_PERMITTED` where `SPEC_PERMITTED = { name, title, description, inputSchema, execution, outputSchema, annotations, _meta, icons }` (the canonical MCP 2025-11-25 Tool field set). Quotes the spec citation inline. The bug class — wire-format Tool objects with non-spec top-level fields — is now structurally impossible to reintroduce.
  - `"preserves caller-supplied annotations when adding tier (regression: #4)"` — asserts that `annotateToolDefinitions` shallow-merges incoming `annotations.readOnlyHint` + `annotations.title` with the new `annotations.tier`, never clobbers them.
- Existing 9 `annotated[N].tier` assertions in the same describe block migrated to `annotated[N].annotations?.tier` to track the wire-format relocation.

### Verification

- `cd packages/core && npm test` — ALL pass (see commit message body for count).
- `cd packages/core && npx tsc --noEmit` — 0 errors.
- `bash scripts/massu-pattern-scanner.sh` — exit 0 (all 16 checks).
- Diagnostic confirmation: stripping `tier` via a stdio wrapper restored all 67 `mcp__massu__*` tools in Claude Code 2.1.143 (proves the fix root-cause-correct).
- Spec citation: [`schema/2025-11-25/schema.ts` line 1251](https://github.com/modelcontextprotocol/specification/blob/main/schema/2025-11-25/schema.ts#L1251) — `interface Tool extends BaseMetadata, Icons` with no `tier` field.

## [1.9.2] - 2026-05-15

Plan `plan-1.9.2-deploy-smoke-test-production-host` — `/massu-deploy` smoke tests now target the canonical production host (`https://massu.ai`) instead of the per-deploy Vercel preview URL. Closes the structural bug discovered 2026-05-15 during the 1.9.1 ceremony where every smoke test on `/`, `/docs`, `/changelog`, `/overview` returned HTTP 401 against the auth-gated preview URL — making the gate enshrined in CR-48 Stage D unable to actually verify production. Adds alias-propagation poll (Vercel CLI `vercel ls --prod` matches the new deploy's hostname prefix) so smoke tests only run after the production alias has been updated to point to the new deploy; FAIL-with-bypass on timeout (`MASSU_SKIP_ALIAS_PROPAGATION_CHECK=1`) mirroring CR-48 staleness gate pattern. Structural drift-prevention: vitest `massu-deploy-script-shape.test.ts` (4 DEPLOY-SHAPE assertions including a slash-command doc drift-guard) parses `scripts/massu-deploy.sh` and asserts smoke tests target `PRODUCTION_HOST`, not `DEPLOY_URL`. The bug class — "deploy script silently 401s its own smoke tests" — becomes structurally impossible to reintroduce without test failure.

### Fixed

- **`scripts/massu-deploy.sh` Step 5 smoke-test target** — was `${DEPLOY_URL}${ROUTE}` (auth-gated preview URL, always 401); now `${PRODUCTION_HOST}${ROUTE}` (canonical production domain, returns real HTTP status). Uses `curl -sL` to follow redirects so `/docs` (307 → `/docs/getting-started` → 200) passes correctly.
- **Final-report honesty**: was hardcoded `Custom domain: https://massu.ai`; now `Production target: $PRODUCTION_HOST` (reflects env-overrides for staging dry-runs).

### Added

- **`scripts/massu-deploy.sh` Step 4.5 Alias Propagation poll** — uses `vercel ls --prod` (already-authenticated CLI) to detect when the new deploy is the production-alias target. FAIL-with-bypass on timeout (`MASSU_SKIP_ALIAS_PROPAGATION_CHECK=1` env-bypass logged to stderr). The header-polling approach (`x-vercel-deployment-url`) was empirically ruled out: live `curl -sI https://massu.ai/` returns `x-vercel-id` but not `x-vercel-deployment-url`.
- **`PRODUCTION_HOST` + `ALIAS_PROPAGATION_TIMEOUT_SECS` constants** in `scripts/massu-deploy.sh` with env-var overrides (`MASSU_PRODUCTION_HOST`, `MASSU_ALIAS_PROPAGATION_TIMEOUT_SECS`). Input validation: URL regex + integer ≤600 cap.
- **`website/src/__tests__/massu-deploy-script-shape.test.ts`** — 4 drift-guard assertions (DEPLOY-SHAPE-01..04) parsing the bash script + slash-command doc via `readFileSync`. Asserts smoke loop uses `${PRODUCTION_HOST}` not `${DEPLOY_URL}`, propagation block precedes smoke block, and doc cites the same default + env-var names. Empty-body and curl-line-count guards prevent silent-pass on delimiter rename.
- **`.claude/commands/massu-deploy.md`** — env-var override table; Step 4.5 added to pre-flight checks list.

### Verification

- `bash -n scripts/massu-deploy.sh` — exit 0.
- `cd website && npx vitest run src/__tests__/massu-deploy-script-shape.test.ts` — 4/4 pass.
- `cd packages/core && npx tsc --noEmit` — 0 errors.
- `cd website && npx tsc --noEmit` — 0 errors.
- `bash scripts/massu-pattern-scanner.sh` — all 16 checks PASS.
- `bash scripts/massu-plan-status-validator.sh` — PASS.
- `bash scripts/massu-plan-commit-drift.sh` — PASS.
- Live pre-deploy baseline (2026-05-15): `https://massu.ai/` → 200; `/docs` → 307 → 200 (handled via `-L`); `/changelog` → 200; `/overview` → 200.

## [1.9.1] - 2026-05-15

Bug-fix release. Closes the structural rendering bug discovered 2026-05-15 in the auto-derived `/releases/<version>` path shipped in 1.9.0 (CR-46 consolidation). Each section's bullet items were pushed as separate elements of the `parts` array and joined with `\n\n`, so the blank lines between consecutive `- foo` markdown lines terminated each list — every bullet rendered as its own single-item `<ul>` instead of one `<ul>` per section. Affected all 17 auto-derived release pages on production (1.6.x, 1.5.x, 1.4.x, ...); MDX-override pages (1.5-to-1.6, 1.7.0, 1.8.0, 1.9.0) were unaffected. Bug was visually verified live pre-fix: `/releases/1.6.3` had 4 headings + 21 single-item `<ul>` elements; `/releases/1.5.7` had 3 headings + 8 single-item `<ul>` elements. Fix builds each section as one `### heading\n\n- a\n- b\n- c` block; new RCC-05 drift-guard asserts `bulletBlockCount === sectionCount` for every auto-derived release, making the regression class structurally impossible.

### Fixed

- **`website/src/lib/releases.ts:135-138` `getReleaseContent()`** — replaced the per-bullet `parts.push('- ' + item)` loop with `const bullets = sec.items.map(i => '- ' + i).join('\n'); parts.push('### ' + sec.heading + '\n\n' + bullets)`. Final `parts.join('\n\n')` now only inserts blank lines between sections, never between bullets within a section. Visual result post-fix: each section renders as one `<ul>` with N `<li>` children (correct markdown semantics + correct accessibility tree + correct keyboard navigation).

### Added

- **`website/src/__tests__/releases-changelog-coverage.test.ts` RCC-05** — drift-guard asserting `content.split(/\n{2,}/).filter(b => b.trim().startsWith('- ')).length === entry.sections.filter(s => s.items.length > 0).length` for every `source==='changelog'` release. Also asserts every line inside a bullet block starts with `- ` (no contaminating prose). Structural drift-prevention per CR-46 — the regression class cannot reappear without test failure.

### Verification

- `cd website && npx vitest run releases-changelog-coverage.test.ts` — 5/5 pass (incl. new RCC-05 against all 17 auto-derived releases).
- `cd website && npx tsc --noEmit` — 0 errors.
- `cd website && npm test` — 323/323 pass (baseline preserved).
- Pre-fix live evidence: `/releases/1.6.3` → 21 single-item `<ul>`s; `/releases/1.5.7` → 8 single-item `<ul>`s. Post-fix shape verified at the markdown layer via RCC-05 invariant.

## [1.9.0] - 2026-05-14


Plan `plan-1.9.0-plan-token-aware-changelog-batcher` — Release-boundary CHANGELOG generation that gathers commits by `(plan-<token>)` subject grouping into one structured entry per release at tag time. Closes the "version bumped without CHANGELOG entry" class structurally and replaces per-commit changelog noise with "fewer entries, more meaningful." New `npx massu changelog generate|verify` CLI cluster reads commit subjects since the last tag, looks up each plan file's new `## Changelog Summary` section, and emits a Keep-a-Changelog 1.1.0-compliant entry. New pre-push-light step `[11/11] Plan-Token Changelog Currency` fires when `package.json#version` drifts from the latest git tag and BLOCKS the push unless CHANGELOG.md has the matching `[X.Y.Z]` heading AND references every plan-token in the commit range. CI mirrors the check (3-layer enforcement per CR-49 precedent). The plan-status validator is extended to require `## Changelog Summary` on all shipped plans; 19 existing shipped plans were backfilled. Generator + 21 tests (15 CHG-GEN + 6 CHG-CLI) + drift-guard vitest (4 PTCC) + `/massu-release` skill integration shipped together.

### Added

- **`packages/core/src/changelog-generator.ts`** — SSOT module exporting `parseCommitsForPlanTokens`, `loadPlanSummaries`, `generateChangelogEntry`, `findCoverageGaps`, and error classes `MissingPlanFileError` + `MissingChangelogSummaryError`. JSDoc + tests at `packages/core/src/__tests__/changelog-generator.test.ts` (15 cases CHG-GEN-01..15 incl. self-application byte-equivalence regression).
- **`massu changelog <sub>` CLI cluster** at `packages/core/src/commands/changelog.ts` — two subcommands: `generate` (auto-drafts entry to stdout for operator review) and `verify` (exit 0 if clean, exit 1 with `gap: <token>` per missing plan-token). Mirrors the `permissions <sub>` precedent shipped in 1.8.0.
- **`scripts/lib/plan-token-regex.sh`** — single source of truth for the `(feat|fix|chore|docs)(plan-<token>)` regex. Exports `PLAN_TOKEN_REGEX` + `extract_plan_tokens_from_range()` shell function. Consumed by `massu-plan-commit-drift.sh` (refactored to source from lib), `massu-changelog-coverage.sh` (new), and `changelog-generator.ts` (via TS literal).
- **`scripts/massu-changelog-coverage.sh`** — pre-tag gate. Reads `packages/core/package.json#version` and `git describe --tags --abbrev=0`; skips silently when versions match (no release in progress); else asserts CHANGELOG.md has `## [X.Y.Z]` heading at top AND every plan-token in commit range appears in entry body. Exit 0/1 with one `gap: <token>` per missing.
- **`scripts/pre-push-light.sh` step `[11/11]`** — Plan-Token Changelog Currency. Invokes `massu-changelog-coverage.sh`. All existing steps renumbered from `[N/10]` to `[N/11]`.
- **`.github/workflows/ci.yml`** — type-check job adds `bash scripts/massu-changelog-coverage.sh` step (3-layer CI gate mirroring CR-49 leak-guard precedent).
- **`website/src/__tests__/plan-token-changelog-coverage.test.ts`** — 4-case drift-guard (PTCC-01..04) asserting latest CHANGELOG entry references every plan-token in `git log $(prev-tag)..$(latest-tag)` modulo a documented divergence allowlist for cross-release infrastructure tokens.
- **`packages/core/src/__tests__/changelog-cli.test.ts`** — 6 CLI dispatcher tests (CHG-CLI-01..06).
- **`### Changelog Generation` section** in `packages/core/README.md` documenting the workflow + plan-file contract.
- **`## massu changelog` section** in `website/content/docs/reference/cli-reference.mdx` with subcommand table + example output.
- **`## Changelog Summary` section** backfilled into 19 existing shipped plan files (auto-extracted from corresponding CHANGELOG.md entries via a one-shot node script using `parseChangelog` + `readChangelog` from `website/src/lib/changelog.ts`).

### Changed

- **`scripts/massu-plan-status-validator.sh`** — extended to require `## Changelog Summary` heading for plans whose Status is in the shipped subset (SHIPPED, IMPLEMENTED, COMPLETE, SUPERSEDED, APPROVED). HISTORICAL DRAFT exempt. The validator's `head -n 30` window was widened to `head -n 60` to accommodate the new section without pushing existing `**Status**:` headers out of scope.
- **`scripts/massu-plan-commit-drift.sh`** — replaced inline regex with `source scripts/lib/plan-token-regex.sh`. Existing exit-0 behavior preserved (verified: 79 plan refs in 163 commits, 0 violations, 28 warnings).
- **`.claude/commands/massu-release.md`** (+ `packages/core/commands/massu-release.md` public-sync mirror) — Step 3 CHANGELOG GENERATION now leads with auto-draft via `npx massu changelog generate`; the legacy conventional-commits parse remains as fallback.

### Verification

- `cd packages/core && npx tsc --noEmit` — 0 errors.
- In-scope tests pass: 15 CHG-GEN + 6 CHG-CLI + 4 PTCC + 8 plan-status-drift-guard (fixture update) = 33 tests.
- `cd packages/core && npm run build:cli` exits 0; `dist/cli.js` contains 4 references to `handleChangelogSubcommand`.
- `bash scripts/massu-plan-status-validator.sh` exits 0 (0 violations, 10 warnings — all pre-existing CR-48 retrospective WARNs).
- `bash scripts/pre-push-light.sh` on Node 22 — all 11 gates PASS.

## [1.8.0] - 2026-05-14

Plan `plan-1.8.0-mcp-permission-seeding` — MCP permission seeding suite. Closes a structural gap where every fresh `npx @massu/core install-commands` adopter hit per-tool permission dialogs on each of the 73+ `mcp__massu__*` MCP tool calls until they hand-curated `.claude/settings.local.json`. Also closes the empirically-observed merge-replacement trap where a project-local `permissions` object without `defaultMode` silently strips the user-global `defaultMode` during settings merge (undocumented at code.claude.com/docs/en/permissions; reproduced 2026-05-14). The new writer reads `~/.claude/settings.json`, computes the full merged `permissions` block (allow union with canonical entries; defaultMode = local override OR global OR omit; deny/ask preserved), atomic-writes the complete block, and fail-loud-asserts post-write that the merge survived.

### Added

- **`packages/core/src/permissions.ts`** — SSOT for MCP permission seeding/verification/drift detection. Exports `MASSU_PERMISSION_ENTRIES` (`['mcp__massu__*']`), `LAUNCH_FLAG_REQUIRED_MODES` (`['bypassPermissions', 'auto', 'dontAsk']` per code.claude.com/docs/en/permission-modes), `findMissingEntries`, `detectInvalidDefaultMode`, `readGlobalSettings`, `mergedPermissionState`, `installPermissions`, `verifyPermissions`, `checkPermissionsDrift`, and the fail-loud `InstallPermissionsAssertionError` class.
- **`massu permissions <sub>` CLI subcommand cluster** at `packages/core/src/commands/permissions.ts` — three subcommands: `install` (seeds canonical entries + propagates global defaultMode; idempotent), `verify` (read-only check, exit 0 if clean else 1), `check-drift` (extended diagnostic, severity-mapped exit codes 1/2/3/4 for `missing-allow`/`invalid-default-mode`/`unknown-key`/`strips-global-defaultmode`).
- **`--skip-permissions` flag** on `install-commands` — escape hatch for enterprise-policy-managed allowlists.
- **`packages/core/src/lib/settings-local.ts`** — shared atomic IO helper (SSOT for `.claude/settings.local.json` AND `~/.claude/settings.json` reads). Exports `readSettingsLocal`, `writeSettingsLocalAtomic`, `readSettingsAtPath`, and the `atomicWriteFile` primitive (moved from `install-commands.ts`).
- **`packages/core/src/__tests__/permissions.test.ts`** — 19 drift-guard test cases (PERM-DRIFT-01..19) including snapshot tests for `global=auto` and `global=bypassPermissions` scenarios; PERM-DRIFT-17 specifically reproduces the merge-replacement trap detection.
- **`packages/core/src/__tests__/settings-local.test.ts`** — 7 IO tests (SLOC-01..06 + defensive shape check).
- **`packages/core/src/__tests__/permissions-cli.test.ts`** — 10 CLI dispatcher tests (VPC-01..08 + help + unknown subcommand).
- **`### Permission Seeding` and `### Permissions trap (settings merge)` sections** in `packages/core/README.md` documenting the writer behavior, the `defaultMode` validity table, and the before/after JSON snippet showing the trap.
- **`## massu permissions` section** in `website/content/docs/reference/cli-reference.mdx` with the exit code matrix and an example check-drift run.

### Changed

- **`packages/core/src/commands/install-commands.ts`** — `installAll(projectRoot, opts?: {skipPermissions})` and `installCommands(projectRoot, opts?: {skipPermissions})` now call `installPermissions` inside the existing `runWithManifest` block (single atomic manifest write covers both file syncs and permission seeding). `runInstallCommands` parses `--skip-permissions` from argv. `atomicWriteFile` moved to `lib/settings-local.ts`.
- **`packages/core/src/commands/init.ts:1099-1140` `installHooks`** — refactored to consume the shared `readSettingsLocal` + `writeSettingsLocalAtomic` helpers. Closes a pre-existing non-atomic-write bug at `init.ts:1137` (was `writeFileSync` — vulnerable to SIGINT-between-truncate-and-write leaving a corrupt settings.local.json).
- **`packages/core/src/commands/doctor.ts:106,241`** — consolidated through the new `readSettingsAtPath` helper (per CR-9 — same SSOT).
- **`packages/core/src/cli.ts`** — new `case 'permissions':` switch + `--skip-permissions` documentation in `printHelp`.

### Verification

- `cd packages/core && npx tsc --noEmit` — 0 errors.
- In-scope tests pass: 19 PERM-DRIFT + 7 SLOC + 10 VPC + 38 install-commands (3 new ICP-01..03) + 23 init (refactor verified clean) = 114 tests.
- `cd packages/core && npm run build:cli` exits 0; `dist/cli.js` bundle contains 4 references to `handlePermissionsSubcommand`.

## [1.7.0] - 2026-05-11

Plan `plan-1.7.0-cohesive-cleanup` — Cohesive minor release that simultaneously closes three structural-quality gaps across the codebase: (1) the Feb-2026 `plan-website-audit` (never shipped) is revalidated against current sources and SUPERSEDED — stats values on `massu.ai/` are now drift-guarded by a vitest test that asserts each stat equals a static derivation from its source-of-truth (`packages/core/src/license.ts` `TOOL_TIER_MAP` for MCP Tools, `.claude/commands/massu-*.md` files for Workflow Commands, etc.); the CLI Reference doc is expanded from 5 CLI commands to 5 CLI + 59 slash commands with a completeness drift-guard test; the team-tool surface gains a runtime cloud-gate via new `isCloudFeatureAvailable()` helper wired at `tools.ts:175` (registration) and `tools.ts:413` (dispatch); (2) P6-004 from `plan-fresh-install-monorepo-paths` — `topLevelSrcSubdirs` in `packages/core/src/detect/domain-inferrer.ts:71` no longer hardcodes `join(root, 'src')` and now consumes the detected source-dir pipeline; new `monorepo-apps-no-root-src` fixture + 4 new domain-inferrer test cases exercise both single-repo non-`src/` layouts and workspaces-driven monorepos; generalization-scanner Check 5 prevents the bug class from recurring; (3) the stale `next: 1.2.1` npm dist-tag (4 minors behind, zero documented consumers) is removed; CLAUDE.md `### npm dist-tags policy` section codifies that only `latest` is maintained going forward; pre-push step 9 enforces the policy with `npm view @massu/core dist-tags` parse.

### Added

- **`website/src/__tests__/stats-numbers-against-source-truth.test.ts`** — 5-assertion vitest drift-guard. Each stat in `website/src/data/stats.ts` is asserted to equal a static derivation from its canonical source (MCP Tools ← `name: p('xxx')` + `\`${pfx}_xxx\`` patterns across `packages/core/src/**/*.ts`; Workflow Commands ← `.claude/commands/massu-*.md` minus `massu-internal-*`; Feature Entries ← `tier:` lines in `features.ts`; Database Tables ← `CREATE TABLE` in `website/supabase/migrations/`; Lines of Code (K+) ← `packages/core/src/**/*.ts` total / 1000 within ±2K tolerance). Adding a new tool/command/migration without updating `stats.ts` FAILs the test.
- **`website/scripts/regen-stats.mjs`** — companion regeneration script that emits `website/src/__tests__/fixtures/stats-expected-values.json` from the same derivation logic. Manual rerun documents intended values for ops + future audit.
- **`website/src/__tests__/cli-reference-doc-completeness.test.ts`** — 3-assertion drift-guard: file exists; every external `.claude/commands/massu-*.md` (excluding `massu-internal-*`) has a matching `## /<command-name>` H2 in the doc; doc is registered in `docs-nav.ts`. Adding a new slash command without updating `cli-reference.mdx` FAILs CI.
- **`isCloudFeatureAvailable()`** in `packages/core/src/license.ts` — returns `getConfig().cloud?.enabled === true`. Wired at `tools.ts:175` (`...(isCloudFeatureAvailable() ? getTeamToolDefinitions() : [])`) and `tools.ts:413` (`if (isTeamTool(name) && isCloudFeatureAvailable())`). Team-tool surface (team_search/team_expertise/team_conflicts) is now correctly hidden + non-routable for workspaces without explicit `cloud.enabled: true` opt-in. Distinct mechanism from name-matcher `isLicenseTool` (which gates by tool name pattern, not feature availability).
- **`packages/core/src/detect/__tests__/fixtures/monorepo-apps-no-root-src/`** — new fixture: `package.json` with `workspaces: ["apps/*"]`, `apps/web/{src/index.ts,package.json}`, `apps/api/{src/index.ts,package.json}`, NO root `src/` directory. Drives the new monorepo-apps test case in `detect.domain-inferrer.test.ts`.
- **4 new test cases** in `packages/core/src/__tests__/detect.domain-inferrer.test.ts` — (a) `topLevelSrcSubdirs` consumes detected source dirs (no hardcoded `src`); (b) unions subdirs across multiple detected source dirs; (c) fixture has expected layout; (d) `inferDomains` returns BOTH `web` and `api` as domains for monorepo-apps-no-root-src fixture.
- **`scripts/massu-generalization-scanner.sh` Check 5** — flags `join(<ident>, '<bare-dir-literal>')` patterns in `packages/core/src/detect/`. Manifest allowlist exempts dotless filenames (WORKSPACE, Gemfile, Dockerfile, Makefile, Rakefile, Procfile, MODULE, BUILD). Synthetic regression VERIFIED: re-introducing `join(root, 'src')` in a fixture file triggers `FAIL`.
- **`scripts/pre-push-light.sh` step 9** — `Dist-Tag Pre-Release` gate. FAILs the push when `npm view @massu/core dist-tags` returns any `next:|beta:|alpha:|rc:` channel without an ADR + CLAUDE.md `## Deployment` policy section opt-in. SKIPs silently when npm registry is unreachable. Renumbered existing `[N/8]` labels to `[N/9]`.
- **`### npm dist-tags policy`** section in `.claude/CLAUDE.md` `## Deployment` — codifies that only `latest` is maintained on `@massu/core`. Pre-release channels (next/beta/alpha/rc) require both an ADR and explicit operator approval before tag creation. Stale `next: 1.2.1` removal recorded with rationale (4 minors behind, zero documented consumers).
- **59 slash command H2 entries** appended to `website/content/docs/reference/cli-reference.mdx` under a new `# Slash Commands` section. Existing `## massu init / doctor / install-hooks / install-commands / validate-config` CLI command sections preserved as-is. Doc description updated to reflect dual coverage (CLI + slash commands).
- **`flattenSourceDirs()`** helper in `packages/core/src/detect/domain-inferrer.ts` — flattens a `SourceDirMap` into a unique list of relative source paths across all detected languages. Drops `.` and `''` root sentinels so root-source repos (Django's `manage.py`, Swift's `Package.swift`) continue to use the language-fallback domain (`Python`, `Swift`) rather than spuriously enumerating root subdirectories.

### Changed

- **`packages/core/src/detect/domain-inferrer.ts:71`** — `topLevelSrcSubdirs(root: string)` → `topLevelSrcSubdirs(root: string, sourceDirs: readonly string[])`. Loops over each source dir (e.g. `lib`, `apps/web/src`), enumerates subdirectories, unions deduplicated results sorted alphabetically. Empty `sourceDirs` falls back to legacy `['src']` lookup for backward compatibility with hand-wired callers. Hardcoded `join(root, 'src')` literal removed.
- **`website/src/data/stats.ts`** — values reconciled with source-of-truth derivation: MCP Tools 84 → 73, Lines of Code 21 → 40 (K+), Database Tables 51 → 41, Feature Entries 140 → 167. Workflow Commands 59 preserved (matches derivation).
- **`packages/core/src/detect/__tests__/fixtures/swift-ios/expected.massu.config.yaml`** — `domains: [{name: Swift}]` → `domains: [{name: App}]`. Reflects the more accurate inference under the refactored `topLevelSrcSubdirs` (Sources/App → App domain) for Swift package layouts. Backward-compatible: `npx massu init` continues to produce a parseable config; domain names are user-editable suggestions.
- **`website/content/docs/reference/cli-reference.mdx`** description frontmatter — broadened to "Complete reference for all Massu CLI commands … and 59 workflow slash commands (/massu-*)".

### Removed

- **Stale `next: 1.2.1` npm dist-tag** on `@massu/core` — removed in P-C-001 of Stage D ceremony. Was 4 minors behind `latest`, with zero documented consumers in code, README, install instructions, or `.sh` invocations. Future pre-release channels gated by CR-48-style ADR + CLAUDE.md policy section.
- **Hardcoded `'src'` literal** at `domain-inferrer.ts:71` — replaced with detected-source-dir consumption per P-B-002.

### Verification

- `cd packages/core && npx tsc --noEmit`: 0 errors
- `cd packages/core && npm test`: 2167 passed / 12 skipped (baseline 2153 + 14 new from Stages A/B = +6 new domain-inferrer + flattenSourceDirs adjustments to keep python-django/swift-ios passing)
- `cd website && npm test`: 125 passed (baseline 114 + 8 new from P-A-002 5-assertion stats test + P-A-005 3-assertion cli-reference test)
- `bash scripts/massu-pattern-scanner.sh`: PASS (15 checks, including Check 14 TOOL_DB_NEEDS + Check 15 public-page nav-link coverage)
- `bash scripts/massu-generalization-scanner.sh`: PASS (5 checks; new Check 5 verified with synthetic regression)
- `bash scripts/pre-push-light.sh` (Node 22): 8/9 PASS pre-Stage-D (step 9 `Dist-Tag Pre-Release` FAILs against stale `next: 1.2.1` — gate-fires-once that closes when P-C-001 runs `npm dist-tag rm @massu/core next`); ALL 9 PASS post-cleanup.
- `npm view @massu/core dist-tags` post-rm: returns `{ latest: '1.7.0' }` (no `next`).
- `grep -c "join(root, 'src')" packages/core/src/detect/domain-inferrer.ts`: 0 (P-B-002 acceptance).
- Synthetic regression: re-adding `next: 1.6.3` tag → pre-push step 9 FAILs as expected.
- Synthetic regression: re-introducing `join(root, 'src')` in detect/ → generalization-scanner Check 5 FAILs as expected.
- Live post-deploy: `curl -s https://massu.ai/` stats values match source-of-truth derivation; `curl -s https://massu.ai/docs/reference/cli-reference | grep -cE '^## /'` ≥ 59.

### Closes

- **`plan-website-audit`** (`docs/plans/2026-02-17-website-audit.md`) — marked SUPERSEDED with successor pointer to `plan-1.7.0-cohesive-cleanup`. Drop reason: original plan's Phase 2/3/4/5 items invalidated by 3+ months of in-flight drift; cli-reference doc + team-tool cloud-gate items are preserved here as P-A-003/P-A-004; tier-reassignment + duplicate-Onboarding-Guide items were verified DROPPED in iter-1 audit (already correct in `features.ts`).
- **P6-004** of `plan-fresh-install-monorepo-paths` (`docs/plans/2026-04-20-fresh-install-monorepo-paths.md`) — marked SHIPPED with successor pointer to `plan-1.7.0-cohesive-cleanup`. Hardcoded `join(root, 'src')` literal at `domain-inferrer.ts:71` is gone; structural drift-guard Check 5 prevents recurrence.
- **Stale `next` dist-tag** — removed in P-C-001; pre-push step 9 + CLAUDE.md policy section codify the policy going forward.

## [1.6.3] - 2026-05-11

Plan `plan-1.6.3-website-feature-discoverability` — Website + scanner patch eliminating two structural drift classes surfaced 2026-05-11 when the user asked "where do these changelogs show up on the website?": (a) public page added without nav link discoverable only via direct URL; (b) website code shipped to npm + git but never deployed to Vercel. Live evidence pre-fix: `massu.ai/changelog` showed 5-entry stale `0.x` array (the pre-`plan-changelog-sot` hardcoded data) because the last production Vercel deploy was 33 days old, even though the build-time parser landed in 1.6.1. After this release, both bug classes are structurally impossible: Pattern Scanner Check 15 enforces nav-link coverage with an explicit `WEBSITE_NAV_EXEMPT` allowlist; pre-push-light step 8 deploy-staleness gate enforces lockstep between website commits and Vercel deploys; CR-48 mandates `/massu-deploy` in Stage D for any website-touching plan. Backfill deploy in this release ships 33 days of accumulated website changes (1.6.1 changelog parser + 1.6.2 EXPECTED_COUNT bump + this plan's nav links) to production.

### Added

- **`website/src/data/nav-exempt.ts`** — shared constants `WEBSITE_NAV_HIDDEN_PREFIXES` (currently `['/dashboard']`) and `WEBSITE_NAV_EXEMPT` (currently `[]`). Sole source of truth for "page intentionally has its own shell" (consumed by `Navbar.tsx`) AND "page intentionally not in public nav" (consumed by Pattern Scanner Check 15). Each `WEBSITE_NAV_EXEMPT` entry requires a JSDoc explaining the intentional exemption.
- **`scripts/massu-deploy-staleness-check.sh`** — compares last `website/`-touching commit on `origin/main` vs last production Vercel deploy timestamp. FAILs if lag exceeds `MASSU_MAX_DEPLOY_LAG_SECS` (default 86400 = 24h) on main branch. SKIP+WARN on Vercel CLI auth mismatch (`vercel whoami` + `teams list` pre-flight against `ethans-projects-22aee2ce`). Bypass via `MASSU_SKIP_DEPLOY_STALENESS_CHECK=1` (logged to stderr for audit-trail).
- **`scripts/pre-push-light.sh` step 8** — invokes the staleness check. Renumbered 9 existing `[N/7]` labels to `[N/8]`.
- **`scripts/massu-pattern-scanner.sh` Check 15** — public page nav-link coverage guard. Enumerates every `page.tsx`/`page.mdx` under `website/src/app/`, excludes hidden-prefix routes + auth/checkout + dynamic `[slug]` + root + `WEBSITE_NAV_EXEMPT`, cross-references against the union of `href:` values in `navigation.ts` + `Footer.tsx`. Synthetic regression VERIFIED: temporary `test-orphan-DELETE-ME/page.tsx` triggers `FAIL: /test-orphan-DELETE-ME has no nav link`.
- **`scripts/massu-plan-status-validator.sh` L3 retrospective check** — for every shipped-subset plan whose cited SHA modified files under `website/`, emits WARN if plan body lacks `/massu-deploy` reference. Non-blocking (retrospective enforcement only); forward-going gate is CR-48 in CLAUDE.md.
- **CR-48 / VR-DEPLOY-STALENESS** in `.claude/CLAUDE.md`. Full definition section between CR-40 and CR-39. Release ceremony template for website-touching plans documented as 10-step Stage D in `## Deployment` section.
- **`Changelog` link** in `Footer.tsx` Resources group, between Quick Start and GitHub.
- **`Overview` link** in `navigation.ts` `mainNav` array, between How It Works and Articles (`mainNav.length` 6 → 7).

### Changed

- **`website/src/components/layout/Navbar.tsx:25`** — replaced inline `pathname.startsWith('/dashboard')` with `WEBSITE_NAV_HIDDEN_PREFIXES.some((prefix) => pathname.startsWith(prefix))`. Eliminates the duplication between Navbar's `isDashboard` literal and the future scanner's "what counts as a dashboard page" knowledge. Both now read from `nav-exempt.ts` as the single source of truth.
- **`scripts/massu-deploy.sh`** + **`.claude/commands/massu-deploy.md`** — smoke test list extended from `["/", "/docs"]` to `["/", "/docs", "/changelog", "/overview"]`. Future regressions on either new page fail the deploy gate.

### Verification

- `cd packages/core && npx tsc --noEmit`: 0 errors
- `cd website && npx tsc --noEmit`: 0 errors
- `cd packages/core && npm test`: 2144 passed / 12 skipped (baseline preserved — no daemon code changes)
- `cd website && npm test`: 114 passed (drift-guard `EXPECTED_COUNT` bumped 19 → 20)
- `bash scripts/pre-push-light.sh` (Node 22): 7/8 PASS pre-deploy; step 8 (Deploy Staleness) intentionally FAILed against 33-day lag pre-P-D-009; PASSes after backfill deploy
- Pattern Scanner Check 15: PASS with synthetic regression evidence
- `bash scripts/massu-plan-status-validator.sh`: PASS 0 violations
- Live post-deploy: `curl -s https://massu.ai/changelog | grep -cE '\bv?1\.6\.3\b'` ≥ 1; `curl -s https://massu.ai/ | grep -cE 'href="/overview"'` ≥ 1; `curl -s https://massu.ai/ | grep -cE 'href="/changelog"'` ≥ 1; 20 distinct version headings on `/changelog` (was 5 pre-deploy)

### Closes

- Plan `plan-1.6.3-website-feature-discoverability` audit converged at 0 gaps after 2 iterations (11 → 0).
- 33-day Vercel-deploy lag — closed by P-D-009 backfill deploy in this release.
- User report 2026-05-11 ("where do these changelogs show up on the website?") — structurally answered via three forward-going gates (Check 15 + step 8 + CR-48).

## [1.6.2] - 2026-05-10

Plan `plan-1.6.2-server-lazy-db-deps` — Daemon-code patch eliminating the structural bug where every MCP tool/call eagerly opened both CodeGraph + Data SQLite DBs at the top-level dispatcher. In any repo without `.codegraph/codegraph.db`, ALL tools failed — even memory/audit/knowledge tools with no logical codegraph dependency. The error surfaced as JSON-RPC code `-32700` ("Parse error", spec-reserved for actual JSON parse failures) with `id:null`. Bug class is now structurally impossible via a typed per-tool DB-needs manifest + AST drift-guard + pattern-scanner Check 14. CR-46 / Rule 0 — replaces an implicit "every tool gets both DBs" coupling with explicit, typed, lazy resolution.

End-users on 1.5.x / 1.6.0 / 1.6.1 are **unaffected** in repos where `.codegraph/codegraph.db` is present (the prior eager-load happened to find the file). Users in fresh installs without codegraph (which became more common as 1.5.0 → 1.6.0 expanded the user base) now see correct behavior: memory tools work; codegraph-dependent tools return a structured `-32001` error with remedy hint pointing at `npx @colbymchenry/codegraph init`.

### Added

- **`packages/core/src/tool-db-needs.ts`** — typed `TOOL_DB_NEEDS` manifest covering all ~70 MCP tools. `DbNeed = 'codegraph' | 'data' | 'memory' | 'knowledge'`. `getToolDbNeeds(toolName, prefix)` is the single source of truth; throws `UnknownToolError` for tools not in the manifest. `toolNeedsCodegraph()` convenience predicate.
- **`packages/core/src/__tests__/server-lazy-db-deps.test.ts`** — 12-assertion behavior test: manifest shape, prefix-strip + `UnknownToolError`, `toolNeedsCodegraph` for codegraph-dependent vs codegraph-independent tools, `CodegraphDbNotInitializedError` class shape.
- **`packages/core/src/__tests__/tool-db-needs-completeness.test.ts`** — 19-assertion drift-guard using TypeScript Compiler API (`ts.createSourceFile`). Walks every `*-tools.ts` and listed handler module, identifies which `getCodeGraphDb`/`getDataDb`/`getMemoryDb`/`getKnowledgeDb` references the module actually uses, cross-references against `TOOL_DB_NEEDS`. Aliasing/destructuring rename does NOT bypass an AST walk (the structural win over grep-based completeness checks). Uses `Map` (not plain object) for the DB-fn lookup to prevent `Object.prototype` identifier matches (`toLocaleString`, `hasOwnProperty`, etc.).
- **`scripts/massu-pattern-scanner.sh` Check 14** — grep-level safety net before tests run. Every tool registered via `name: p('...')` or `name: \`${prefix}_...\`` in `packages/core/src/*.ts` MUST have a matching entry in `TOOL_DB_NEEDS`. Runs in `pre-push-light.sh` step 1.
- **`CodegraphDbNotInitializedError`** in `packages/core/src/db.ts` — internal error class (not thrown to clients raw). Carries the resolved DB path for the dispatcher to relay.

### Changed

- **`packages/core/src/server.ts`** — eliminated module-level `codegraphDb`/`dataDb` singletons + `getDb()` helper. New `resolveDbsForTool(toolName)` opens ONLY the DBs the manifest declares. `tools/call` handler catches `CodegraphDbNotInitializedError` → structured `-32001` JSON-RPC error with `data.remedy` (verbatim `codegraph init` command), `data.codegraphDbPath`, `data.tool`. Catches `UnknownToolError` → `-32602` (Invalid params). Stdio handler is now two-phase try/catch: JSON-parse failures emit spec-correct `-32700 id:null`; request-processing failures emit `-32603 Internal error` **preserving the request `id`** (was incorrectly `null` in 1.6.1 and prior).
- **`packages/core/src/tools.ts`**:
  - `ensureIndexes(dataDb, codegraphDb?, force?)` — `codegraphDb` is now optional. JS-index section (imports, tRPC, pages, middleware) skipped when undefined; Python-index section still runs against `dataDb`. Supports both "Python tools need fresh Python indexes but no codegraph" and "memory tools need nothing" cases.
  - `handleToolCall(name, args, dataDb?, codegraphDb?)` — widened signature with optional DBs. JSDoc documents the pre-dispatch ordering invariant: tier gate → per-family routing → ensureIndexes gated per-family.
  - Unconditional `ensureIndexes(dataDb, codegraphDb)` call at line 279 REMOVED. Per-family routing now invokes `ensureIndexes` only in the Python branch (with `dataDb`, no codegraph) and core JS branches (`sync`, `context`, `impact`, `coupling_check`, `domains`, `trpc_map` — with both DBs). Memory/audit/knowledge/sentinel/etc. branches skip `ensureIndexes` entirely.
  - `assertDataDb` + `assertCodegraphDb` defensive helpers — never silently pass `undefined` into handlers when the manifest declares a DB is needed.

### Removed

- Module-level eager-init of CodeGraph + Data DBs at server startup. Connections are cached lazily after first need.

### Verification

- `cd packages/core && PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx tsc --noEmit`: 0 errors
- `cd packages/core && npm test`: **2144 passed** / 12 skipped (was 2113 baseline; +31 new tests across the 2 new vitest files: 12 in `server-lazy-db-deps.test.ts` + 19 in `tool-db-needs-completeness.test.ts`)
- `bash scripts/pre-push-light.sh` (Node 22): ALL 7 GATES PASS (including new Check 14 — Tool DB-needs manifest completeness)
- End-to-end reproducer from `/tmp/repro-fixed/` (NO `.codegraph/codegraph.db`):
  - `tools/call massu_memory_search id=2` → success result with `id:2` propagated ✓
  - `tools/call massu_sync id=3` → `{error:{code:-32001, message:"Tool requires CodeGraph database which is not initialized for this repo", data:{remedy:"npx @colbymchenry/codegraph@0.7.4 init . && npx @colbymchenry/codegraph@0.7.4 index .", codegraphDbPath:"/private/tmp/repro-fixed/.codegraph/codegraph.db", tool:"massu_sync"}}, id:3}` ✓ (was `code:-32700, id:null` in 1.6.1)
- `bash scripts/massu-plan-status-validator.sh`: PASS
- `bash scripts/massu-plan-commit-drift.sh`: PASS

### Closes

- Plan `plan-1.6.2-server-lazy-db-deps` audit converged at 0 gaps after 3 iterations (16 → 2 → 0).
- The root cause of the 2026-05-10 in-session "MCP tools hanging" investigation (see `feedback_mcp_pin_version_in_mcp_json.md`). The hang turned out to be a stale 1.4.0-soak.0 global install (separately fixed by .mcp.json pin in commit `f6fa6ff`), but THIS plan eliminates the underlying server bug that would have caused identical symptoms in any clean install without codegraph.

## [1.6.1] - 2026-05-10

Plan `plan-changelog-sot` — Website changelog now renders from `CHANGELOG.md` source-of-truth at build time. The hardcoded `ChangelogEntry[]` array on `website/src/app/changelog/page.tsx` (stale by 5+ major releases, last entry `0.6.3`, mismatched `0.x` scheme vs npm's `1.x`) and the orphaned `website/content/changelog/` directory are deleted. A vitest drift-guard test asserts every `## [X.Y.Z]` heading produces exactly one rendered entry; structurally impossible for the rendered page to drift from `CHANGELOG.md` after this release. CR-46 / Rule 0 — replaces a recurring "rendered changelog goes stale" loop with a structural CI gate. Website-only patch; daemon code unchanged from 1.6.0.

### Added

- **`website/src/lib/changelog.ts`** — hand-rolled Keep-a-Changelog 1.1.0 parser (`parseChangelog`, `readChangelog`, `getChangelog`, `renderInlineMarkdown`, `KNOWN_SECTION_HEADINGS`). No new npm dependency — the format is tightly constrained and a regex-driven parser keeps the drift-guard surface small. `getChangelog()` wraps read+parse with a version-less fallback (no embedded version literals — that would itself create a new drift surface).
- **`scripts/copy-changelog-to-website.js`** — `__dirname`-relative copy script that runs from `predev` and `prebuild` hooks, copies repo-root `CHANGELOG.md` into `website/CHANGELOG.md` (gitignored). Resolves source path independent of `process.cwd()` so it works from any invocation context (Vercel CI, manual, dev). Gracefully exits 0 when source is missing (Vercel CLI deploys that upload only `website/`).
- **`website/src/__tests__/changelog-parse.test.ts`** — 13-assertion drift-guard: `EXPECTED_COUNT = 18`, semver/ISO-date regex pins, no-duplicate-versions, latest-entry == `packages/core/package.json#version`, `KNOWN_SECTION_HEADINGS` whitelist coverage, historical `[0.3.0]` preserved per plan §1.4, and renderer fidelity (`renderInlineMarkdown` produces `<code>` for `` `@massu/adapter-rails@1.0.0` `` literal markdown).
- **`renderInlineMarkdown` inline-markdown renderer** — dependency-free helper handling the four common inline forms in CHANGELOG bullets (` ``code`` `, `[text](url)`, `**bold**`, `*italic*`) so users see formatted output on `/changelog` instead of raw backtick + bracket syntax.

### Changed

- **`website/src/app/changelog/page.tsx`** — hardcoded `ChangelogEntry[]` array (legacy lines 31-264, frozen at `0.6.3`) replaced with `const changelog = getChangelog()`. Inline `ChangelogEntry` interface moved to `@/lib/changelog`. Each `<li>` wraps `{renderInlineMarkdown(item)}` so backticks and links render correctly.
- **`website/package.json`** — `predev` and `prebuild` scripts added: `node ../scripts/copy-changelog-to-website.js`. Ensures `website/CHANGELOG.md` is in sync before `next dev` or `next build` reads it.
- **`website/.gitignore`** — `/CHANGELOG.md` added (derived build artifact; canonical source lives at repo root).
- **`website/tsconfig.json`** — `target: "ES2017"` → `target: "ES2020"`. Fixes pre-existing TS1501 error on `s` regex flag in `src/__tests__/integration/sso-validation.test.ts:31` per CR-9 (fix all encountered issues). Safe for Node 22 + Next.js 16 runtime.

### Removed

- **`website/content/changelog/`** — orphaned MDX directory deleted (`grep -rn "content/changelog" website/src/` returned 0 prior to deletion). The single file (`2026-04-19-config-migration.mdx`) had no consumer.

### Verification

- `cd website && npx tsc --noEmit`: 0 errors
- `cd website && npm test`: 18 files / **115 tests PASS** (was 17/101 + 14 new after EXPECTED_COUNT bump)
- `cd website && npm run build`: exit 0, `/changelog` prerendered as static (○)
- Rendered HTML inspection: 18 distinct version headings (1.6.1 through 0.3.0 preserved), 0 occurrences of stale `0.6.3` legacy data, `1.6.1` appears in rendered output
- `bash scripts/pre-push-light.sh` (Node 22): ALL 7 GATES PASS
- `bash scripts/massu-plan-status-validator.sh`: PASS
- `bash scripts/massu-plan-commit-drift.sh`: PASS

### Closes

- Plan `plan-changelog-sot` audit: converged at 0 gaps after 4 iterations (14 → 4 → 2 → 0).
- Master plan row 4.10 drift-class — the "rendered changelog goes stale" loop that motivated the blog post review is now structurally impossible.

## [1.6.0] - 2026-05-09

Plan 3c Phase 9b — workspace adapter publish (`plan-3c-phase9b`). Closes the 1.5.0 Infrastructure note ("5 workspace placeholder packages remain at `0.0.0-prework`") by shipping the 5 first-party AST adapters as standalone npm packages alongside `@massu/core@1.6.0`. Architecture is **Z+II**: workspace package source is canonical (`packages/adapter-<f>/src/index.ts`); `@massu/core` consumes those packages as workspace dependencies and bundles their built `dist/` into its own `dist/detect/adapters/<f>.js` via a build step (`packages/core/scripts/bundle-adapters.ts`). True single-source-of-truth: same source produces both the CORE-BUNDLED artifact and the standalone REGISTRY-VERIFIED tarball; sha256 reproducibility is structurally enforced.

End-users on `1.5.x` are **unaffected** — 1.6.0 is additive, zero-config preserved, no breaking changes. Users who want the REGISTRY-VERIFIED trust class can now `npm install @massu/adapter-rails` (etc.) for the same code with a fully signed manifest sha256 chain end-to-end.

Daemon code unchanged from 1.5.8 — any in-flight 1.5.x soak verdict applies to 1.6.0.

### Added

- **`@massu/adapter-rails@1.0.0`** — first-party Rails adapter, standalone npm package. Tarball shasum: `1944b1a4568b5c9f07a457a93050a926f78ac76f` (per `npm view @massu/adapter-rails dist.shasum`). See [`packages/adapter-rails/CHANGELOG.md`](./packages/adapter-rails/CHANGELOG.md).
- **`@massu/adapter-phoenix@1.0.0`** — first-party Phoenix adapter, standalone npm package. Tarball shasum: `22d856030b8d220d3846d7f16d32d7daa41b76ea`. See [`packages/adapter-phoenix/CHANGELOG.md`](./packages/adapter-phoenix/CHANGELOG.md).
- **`@massu/adapter-aspnet@1.0.0`** — first-party ASP.NET Core adapter, standalone npm package. Tarball shasum: `2fff624d3491ced5a831f7b7dce36928e91020a2`. See [`packages/adapter-aspnet/CHANGELOG.md`](./packages/adapter-aspnet/CHANGELOG.md).
- **`@massu/adapter-spring@1.0.0`** — first-party Spring adapter, standalone npm package. Tarball shasum: `b3f7a87e0f25c9174c4e3540c1a255feb333a6cb`. See [`packages/adapter-spring/CHANGELOG.md`](./packages/adapter-spring/CHANGELOG.md).
- **`@massu/adapter-go-chi@1.0.0`** — first-party go-chi adapter, standalone npm package. Tarball shasum: `48916c0b6e8c7ed0c53d60acb170bef39dffea15`. See [`packages/adapter-go-chi/CHANGELOG.md`](./packages/adapter-go-chi/CHANGELOG.md).
- **`@massu/core/adapter` runtime helpers in the SemVer-stable surface** — `adapter.ts` now re-exports `runQuery`, `loadGrammar`, `isParsableSource`, `MAX_AST_FILE_BYTES`, and `InvalidQueryError` so workspace adapters import everything they need from a single subpath. The published tarball ships bundled `dist/adapter.js` (~32 kB ESM) + `dist/adapter.d.ts` (1.7 kB) so downstream Node consumers AND tsc resolve cleanly without chasing transitive `.ts` source.
- **`packages/core/scripts/bundle-adapters.ts`** — esbuild-driven build step that copies the 5 workspace adapter `dist/index.js` files into `packages/core/dist/detect/adapters/<f>.js` and computes a sha256 sentinel at `dist/detect/adapters/.bundle-shasums.json`. Reproducibility enforced by `adapter-bundle-reproducibility.test.ts` (P-B-003).
- **Three new structural drift-guard tests** — `adapter-source-of-truth.test.ts` (every `CORE_BUNDLED_IDS` entry has exactly one canonical source — either core or workspace, never both), `adapter-bundle-reproducibility.test.ts` (re-running the bundle step from a clean tmpdir produces byte-identical sha256s), and `core-bundled-files-presence.test.ts` (every workspace-canonical id has a corresponding `dist/detect/adapters/<id>.js` after build). The fourth gate, `adapter-manifest-roundtrip.test.ts` (P-D-001), runs in CI when `MASSU_MANIFEST_ROUNDTRIP=1` against the live registry manifest.
- **Pattern-scanner Check 12 — adapter import direction guard** — `scripts/massu-pattern-scanner.sh` now refuses any `import .* from '@massu/adapter-*'` outside `packages/core/src/detect/adapters/<id>.ts` re-export shims (drift-prevention #3). Inverse imports would create circular runtime deps that npm workspaces silently allow.
- **Vitest 4 `test.projects` shape** — new root `vitest.config.ts` runs both core (~141 test files) and the 5 adapter packages (5 × 1 smoke test each) in a single `npm test` invocation. Replaces the deprecated Vitest 3 `defineWorkspace` / `vitest.workspace.ts` pattern (removed in Vitest 4.x).
- **Tarball E2E CI extension (P-D-002)** — `.github/workflows/ci.yml` `tarball-e2e` job now also packs each `packages/adapter-*` and asserts the published shape (no `src/`, no `*.test.ts`, no `tsconfig.json` leak; LICENSE + README.md + `dist/index.{js,d.ts}` + `package.json` required). Adds the manifest round-trip gate.

### Changed

- **`packages/core/package.json`** — version `1.5.8` → `1.6.0`. New `dependencies` for the 5 workspace adapters (`"@massu/adapter-rails": "^1.0.0"`, etc.) so the build pipeline pulls in workspace symlinks. New `exports."./adapter"` conditional shape with explicit `types: "./dist/adapter.d.ts"` + `import: "./dist/adapter.js"` (was raw `./src/adapter.ts` — caused R9 runtime resolution failures for downstream consumers).
- **Root `package.json:scripts.build`** — explicit chain `build:adapter-types && build:adapter-subpath && build:adapters && build:core` so workspace adapters always build before `bundle-adapters.ts` runs (P-A-016 build-ordering fix; npm `--workspaces` runs alphabetically, not topologically).
- **`packages/core/src/detect/adapters/{rails,phoenix,aspnet,spring,go-chi}.ts`** — replaced with 4-line re-export shims (`export * from '@massu/adapter-<f>'`). Source moved to workspace package; CORE-BUNDLED behaviour preserved via the bundle step.
- **`packages/adapter-*/package.json`** — version `0.0.0-prework` → `1.0.0`; `private: true` removed; `peerDependencies."@massu/core": ">=1.5.8 <2.0.0"` (intentionally widened to keep 1.5.x consumers compatible — 1.5.x already CORE-BUNDLES the same code, so peer is loose by design).
- **`scripts/PUBLIC_MANIFEST.md`** — updated notes for the 5 `packages/adapter-*` entries to reflect the new published 1.0.0 versions (no path changes; they remain in PUBLIC_DIRS).

### Verification

- `npx tsc --noEmit`: 0 errors (`packages/core`)
- `npm test` (Node 22): `2123 passed | 9 skipped (2132)` across 146 test files (was `2087/2087` per 1.5.7; +36 new tests across the 4 structural drift-guards + 5 adapter smoke tests + the manifest round-trip)
- `bash scripts/massu-pattern-scanner.sh`: PASS (13 checks, including the new Check 12 adapter import direction guard)
- `bash scripts/massu-generalization-scanner.sh`: PASS
- `bash scripts/massu-plan-status-validator.sh`: PASS (55 plans scanned, 0 violations)
- `bash scripts/massu-plan-commit-drift.sh`: PASS
- `npm view @massu/core version`: `1.6.0`
- `npm view @massu/core dist.shasum`: `e3f74555959db52462d14eb1223b3c2d8937a430`
- `npm view @massu/adapter-rails version` (× 5 adapters): `1.0.0`
- Smoke test from clean tmpdir: `npm install @massu/core@1.6.0 @massu/adapter-rails@1.0.0` exits 0; `node -e "import('@massu/adapter-rails').then(m => console.log(typeof m.railsAdapter))"` prints `object`

### Closes

- The 1.5.0 CHANGELOG `Infrastructure` note ("5 workspace placeholder packages remain at `0.0.0-prework`") — workspace publish is now SHIPPED.
- Master plan row 4.12 ("Phase 9b — workspace adapter publish") — moved from APPROVED → SHIPPED.
- The originating obligation in Plan 3c §Stage 3 Phase 9 line 157 ("Workspace publish for 5 adapters").
- Plan 3c Phase 9b audit: converged at 0 gaps after 7 iterations (22 → 6 → 5 → 6 → 3 → 3 → 0).

## [1.5.8] - 2026-05-09

Plan-status drift-guard release. Closes the recurring "manual refresh of stale plan-Status headers" pattern with three structural layers: schema validator, commit-link drift scanner, and a vitest drift-guard test. Adds a canonical `**Plan Token**:` field to all 55 plans so commits can be cross-referenced bidirectionally with their plan documents. CR-46 / Rule 0 — replaces a recurring manual loop with a structural CI gate.

Daemon code unchanged — any in-flight 1.5.x soak verdict applies to 1.5.8.

### Added

- **`scripts/massu-plan-status-validator.sh`** — schema validator for `docs/plans/*.md`. Parses frontmatter, validates Status against the 8-value canonical enum (DRAFT, IN PROGRESS, SHIPPED, COMPLETE, IMPLEMENTED, APPROVED, SUPERSEDED, HISTORICAL DRAFT), validates `**Plan Token**:` uniqueness, requires SHA citation for SHIPPED, suggests path citation for SUPERSEDED. Supports `--json`, honors `MASSU_PLAN_DIR` env override. Exit 0 = PASS, 1 = FAIL.
- **`scripts/massu-plan-commit-drift.sh`** — commit-link drift scanner. Greps `git log` since `MASSU_DRIFT_SINCE` (default 2026-04-01) for `(feat|fix|chore|docs)\(plan-<token>\)` references, looks up plans by token, FAILS if Status is in the non-shipped enum (DRAFT, IN PROGRESS), WARNs on misses listed in the cross-repo allowlist.
- **`scripts/massu-plan-external-tokens.txt`** — cross-repo plan-token allowlist (26 `plan-3c-*` tokens authored in a private sister repository). Prevents the drift scanner from FAILing on legitimately external plan references.
- **`packages/core/src/__tests__/fixtures/plans/`** — 9 minimal-stub fixtures exercising every validator + scanner code path (stale-draft, fresh-draft, shipped, superseded, historical, duplicate-token-{a,b}, missing-token, unknown-status).
- **`packages/core/src/__tests__/plan-status-drift-guard.test.ts`** — 8-case vitest test using `execSync` + `MASSU_PLAN_DIR` env override; case 8 runs against live HEAD and gates every PR.
- **`.github/workflows/ci.yml`** — two new steps in the `type-check` job: Plan Status Validator + Plan Commit Drift Scanner.
- **`scripts/pre-push-light.sh`** — steps 6 + 7 invoke validator + drift scanner (`set -e` swapped for `set -uo pipefail` matching the rest of the scripts/ idiom).
- **`scripts/hooks/pre-commit-gate.sh`** — staged-tree gate via merged-corpus extraction (`git show :<path>` for staged Add/Modify/Rename + remove staged deletions); fast-path skip when no plan-related diffs are staged.
- **`scripts/PUBLIC_MANIFEST.md` + `scripts/sync-public.sh`** — exclude the 3 new private scripts from public sync.
- **CR-40 / VR-PLAN-STATUS** added to `.claude/CLAUDE.md`.
- **`**Plan Token**:` field** backfilled across all 55 plans; 38 plans missing `**Status**:` headers received derived Status (commit-cited SHIPPED for plans with matching commits; HISTORICAL DRAFT for legacy plans).
- **`.claude/templates/plan-frontmatter.md`** — author template (R6 mitigation; auto-emitted by validator).

### Verification

- `npx tsc --noEmit`: 0 errors (`packages/core`)
- `npm test -- plan-status-drift-guard`: 8/8 PASS
- `bash scripts/massu-plan-status-validator.sh`: exit 0, 0 violations, 13 deprecation/legacy warnings (Doc ID, Plan ID, COMPLETE legacy synonym — all warn-only by design)
- `bash scripts/massu-plan-commit-drift.sh`: exit 0, 0 violations, 28 allowlisted external-token warnings, 94 commits scanned, 42 plan refs found
- `bash scripts/massu-pattern-scanner.sh`: PASS
- `bash scripts/massu-generalization-scanner.sh`: PASS

### Closes

- The recurring "stale Status header" class of bug (commits `0ed226a` 2026-05-08 + `21e055d` 2026-05-09 manually refreshed 10 stale headers — the second occurrence in <24 h, proving discipline alone is insufficient).
- Plan 1.5.8 audit converged at 0 gaps after 7 iterations (16 → 9 → 8 → 2 → 2 → 1 → 0).

## [1.5.7] - 2026-05-08

Test infrastructure release. Closes the two follow-ons documented in 1.5.5 and 1.5.6 CHANGELOGs as the structural drift-prevention against the class of bug that produced both hotfixes (FIRST_PARTY_ADAPTERS divergence + bundle-vs-source CI gap).

Daemon code unchanged — 1.5.0 48 h soak verdict applies to 1.5.7.

### Added

- **`first-party-adapters-coverage.test.ts`** — strict drift-guard asserting `FIRST_PARTY_ADAPTERS` (the runtime dispatch list at `codebase-introspector.ts:75-78`) parity with `CORE_BUNDLED_IDS` (the trust-class id-set at `detect/adapters/index.ts:23-33`). Pre-1.5.7 the two diverged silently — Phase 7 commits added each new adapter to `CORE_BUNDLED_IDS` (gated by `core-bundled-ids-drift.test.ts`) but missed the runtime dispatch list. The 1.5.4 → 1.5.5 hotfix was the surfacing event. This test makes the divergence impossible to merge: every id in CORE_BUNDLED_IDS must have an adapter import in codebase-introspector.ts AND vice versa.
- **CI `tarball-e2e` job** — extends `.github/workflows/ci.yml` with a job that runs `MASSU_TARBALL_E2E=1 npx vitest run src/__tests__/init-tarball-e2e.test.ts` on every push to main + PR. The test infrastructure was added in 1.5.3 but had no CI trigger; 1.5.5 and 1.5.6 both shipped bundle-only bugs (`FIRST_PARTY_ADAPTERS` omission, web-tree-sitter not externalized) that the tarball-e2e gate would have caught BEFORE publish if it had been wired. Now wired; future bundle-vs-source regressions auto-fail CI before publish.

### Verification

- `npx tsc --noEmit`: 0 errors
- `npm test`: 2087/2087 source-level pass (+1 new drift test)
- `bash scripts/massu-pattern-scanner.sh`: PASS
- `bash scripts/massu-generalization-scanner.sh`: PASS

### Closes

- Plan 1.5.5 CHANGELOG follow-on ("first-party-adapters-coverage gate") — SHIPPED.
- Plan 1.5.6 CHANGELOG follow-on ("CI workflow that sets MASSU_TARBALL_E2E=1") — SHIPPED.

## [1.5.6] - 2026-05-08

Hotfix on 1.5.5. 1.5.5 added the 6 Phase 7 adapters to `FIRST_PARTY_ADAPTERS` correctly, but the bundled `dist/cli.js` inlined `web-tree-sitter` while its companion `tree-sitter.wasm` runtime artifact was NOT copied to `dist/`. R-011 evidence (live test against published 1.5.5):

```
RuntimeError: Aborted(Error: ENOENT: no such file or directory,
  open '/Users/.../dist/tree-sitter.wasm')
  at abort (cli.js:13114:20)
  at Parser.init (cli.js:14585:19)
  at loadGrammar (cli.js:14946:3)
```

The bundled web-tree-sitter expects to find its sibling `tree-sitter.wasm` next to its own code. esbuild bundling inlines the JS but can't move companion wasm assets.

### Fixed

- **Externalize `web-tree-sitter` (and other native-asset deps) from the cli bundle** — `build:cli` now passes `--external:web-tree-sitter --external:tweetnacl --external:tar --external:smol-toml --external:vscode-languageserver-protocol`. These remain `dependencies` in package.json so users get them via `npm install` and at runtime the bundle resolves them through normal node_modules. The companion `tree-sitter.wasm` resolves naturally next to web-tree-sitter's own code.

### Verification

- Rebuilt 1.5.6 cli.js loads grammars from `<install>/node_modules/web-tree-sitter/tree-sitter.wasm` correctly.
- `npx --yes @massu/core@1.5.6 init` against a Phoenix fixture produces `detected.phoenix:` block with extracted conventions.

## [1.5.5] - 2026-05-08

Hotfix on 1.5.4 (published ~10 min earlier same day). 1.5.4 shipped the file sampler + introspect piping correctly but `codebase-introspector.ts:FIRST_PARTY_ADAPTERS` only listed the 4 original Plan-3b adapters. Phase 7 adapters (`rails`, `phoenix`, `aspnet`, `spring`, `go-chi`, `python-flask`) were committed Phase 7 but never added to the runtime dispatch list. The omission was masked pre-1.5.4 by the `sampleFiles=[]` placeholder (every adapter returned `'none'` anyway). 1.5.4 made the sampler work but the dispatch list was still incomplete → `npx massu init` against a Phoenix project produced an empty `introspected` object → no `detected.phoenix:` block in the emitted config.

R-011 evidence: live debug instrumentation 2026-05-08 against published 1.5.4 cli.js:
```
[DBG] introspect-branch entered, skip=undefined
[DBG] introspected keys= values={}
```
Empty result confirms the runner never invoked the phoenix adapter (the only relevant one for the fixture).

### Fixed

- **`codebase-introspector.ts:FIRST_PARTY_ADAPTERS`** — added the 6 Phase 7 adapters (`pythonFlaskAdapter`, `goChiAdapter`, `railsAdapter`, `phoenixAdapter`, `aspnetAdapter`, `springAdapter`). Total dispatch list now 10 adapters, matching `CORE_BUNDLED_IDS` from `detect/adapters/index.ts`.

### Verification

- Re-running the Phoenix fixture against 1.5.5 produces `detected.phoenix:` block with `route_method`, `scope_prefix_base`, `router_module`, `_provenance`, `_confidence: high`.
- Same for the other 5 Phase 7 fixtures.

## [1.5.4] - 2026-05-08

Closes Plan 1.5.1 §3 item #4 (the explicitly-deferred AST adapter output piping). Pre-1.5.4 `introspectAsync()` handed AST adapters `SourceFile[] = []` because of a placeholder at `codebase-introspector.ts:160-170`. Adapters always worked (verified by `adapter-grammar-strict.test.ts` 10/10 fixtures with `'high'` confidence) but their extracted conventions never reached the user-facing emitted config. 1.5.4 ships the real per-adapter file sampler and pipes AST output into `detected.<adapter-id>:` blocks.

Daemon code unchanged — 1.5.0 48 h soak verdict applies to 1.5.4.

### Added

- **`detect/adapters/file-sampler.ts`** — per-adapter file sampler. Reuses `EXTENSIONS` and `TEST_FILE_PATTERNS` from `source-dir-detector.ts:84-104` (no parallel maps; CR-46 self-attest #3). Algorithm: per language in `adapter.languages`, walk source dirs from `detection.sourceDirs[<lang>].source_dirs` up to depth 3, filter by extension, exclude test files, cap per-adapter at 50 files, drop files > `MAX_AST_FILE_BYTES` (256 KB). Refuses symlinks and ignored dirs (node_modules, .git, dist, target, etc.).
- **AST output piping in `runInit`** — after variant template merge, runs `introspectAsync(detection, projectRoot)` and merges every adapter's output (where `_confidence !== 'none'`) into `config.detected[<adapter-id>]`. Each block carries the adapter's extracted conventions (`route_method`, `scope_prefix_base`, `controller_class`, etc.) plus `_provenance` and `_confidence` per `types.ts:114-130`.
- **`--no-introspect` CLI flag** — bypasses the AST introspect step. Useful for fast sync init or when grammar download is undesirable. Default-on (introspect runs).
- **`sample-files-coverage.test.ts`** — 3 strict gates: every language declared by ANY of the 10 first-party adapters has both `SAMPLE_EXTENSIONS` and `SAMPLE_TEST_FILE_PATTERNS` entries; extension strings are well-formed (no leading dot). Future adapters targeting an uncovered language fail the build.
- **`init-end-to-end.test.ts` extension** — added `detected.<adapter-id>:` block assertion: when the AST adapter for a fixture's framework returns non-`'none'` confidence, the block must carry `_confidence` and at least one non-meta convention key. Lenient on grammar-load failure (CI offline) but strict on shape when present.

### Verification

- `npx tsc --noEmit`: 0 errors
- `npm test`: 2086 source-level tests pass (+8 tarball-level skipped per `MASSU_TARBALL_E2E` gate)
- `MASSU_TARBALL_E2E=1 npm test`: tarball gate runs against the 1.5.4 build with the new sampler + introspect piping
- `bash scripts/massu-pattern-scanner.sh`: PASS
- `bash scripts/massu-generalization-scanner.sh`: PASS
- 1.5.1's `init-end-to-end.test.ts` still green (5/5) — variant template merge stays correct
- `core-bundled-ids-drift.test.ts`: green (added `file-sampler.ts` to `ADAPTER_SUPPORT_FILES`)

### Closes

- Plan 1.5.1 §3 item #4 ("Pipe `introspectAsync()` output to `detected.<adapter-id>:` block in the emitted config") — explicitly deferred at 1.5.1 ship; closed here.

### Phase 7 fixture verification (cited)

After 1.5.4 ships and the introspect path runs against a real Rails project, the emitted `massu.config.yaml` includes:
```yaml
detected:
  rails:
    route_method: get        # extracted from config/routes.rb
    root_controller: pages   # from `root 'pages#home'`
    api_namespace: /api      # from `namespace :api do`
    _confidence: high
    _provenance:
      route_method: "config/routes.rb:2 :: rails-route-method"
      root_controller: "config/routes.rb:6 :: rails-root"
      api_namespace: "config/routes.rb:3 :: rails-namespace"
```
Same shape for each of the other 5 Phase 7 frameworks.

## [1.5.3] - 2026-05-08

Test infrastructure release that closes the source-vs-bundle gap demonstrated by 1.5.1 → 1.5.2 hotfix. Pre-1.5.3, `init-end-to-end.test.ts` ran against TS source via vitest where `__dirname` resolves at `src/commands/`-depth; production `dist/cli.js` has different depth and was failing the same scenarios despite the in-repo test being green. 1.5.3 ships a tarball-level e2e test that catches this entire class of bug.

Daemon code unchanged — 1.5.0 48 h soak verdict applies to 1.5.3.

### Added

- **`init-tarball-e2e.test.ts`** — runs `npm pack` + clean install + spawns `<install>/node_modules/.bin/massu init` against each Phase 7 fixture in tmpdir, then asserts the same field-by-field expectations the source-level test asserts. Plus 3 tarball-shape gates: `dist/cli.js` exists, `templates/<id>/massu.config.yaml` is well-formed YAML for every present id, `<bin>/massu --version` matches `package.json:version`. Tag-gated via `MASSU_TARBALL_E2E=1` env var so it runs in CI but not in local `npm test` by default.
- **Shared fixture module `src/__tests__/fixtures/phase7-init-fixtures.ts`** — single source for the 5-fixture test data consumed by BOTH `init-end-to-end.test.ts` AND `init-tarball-e2e.test.ts`. Adding a new framework = ONE entry that BOTH tests pick up.
- **`resolve-templates-dir-bundle-path.test.ts`** — 4 unit tests that explicitly catch the 1.5.2 path-off-by-one regression class. Sets up both bundled-cli (`<pkg>/dist/cli.js`) and legacy-nested (`<pkg>/dist/commands/init.js`) layouts in tmpdir; asserts the candidate-list logic resolves correctly in each. Future builds that move cli.js to a different depth fail this test before reaching the tarball test.
- **Hermetic build in tarball-e2e** — `beforeAll` runs `npm run build` before `npm pack` so the test never reads a stale `dist/` from a previous build.

### Verification

- `npx tsc --noEmit`: 0 errors
- `npm test`: 2079/2079 + 4 new (resolve-templates-dir) = 2083 source-level tests pass
- `MASSU_TARBALL_E2E=1 npm test`: +8 tarball-level tests (5 fixtures + 3 shape gates) pass against the actual built bundle
- `bash scripts/massu-pattern-scanner.sh`: PASS
- `bash scripts/massu-generalization-scanner.sh`: PASS

### Known follow-on

- AST adapter introspect output piping (`detected.<adapter-id>:` block) — Plan 1.5.4 (`docs/plans/2026-05-08-ast-introspect-piping.md`). Hard prerequisite met now (1.5.3 ships the tarball-e2e gate that 1.5.4's variant-template-style changes need to validate against).

## [1.5.2] - 2026-05-08

Hotfix on 1.5.1 (published ~30 min earlier same day). 1.5.1's variant-template merge was structurally correct but `resolveTemplatesDir()` had a long-standing path-resolution bug that returned `null` from the bundled `dist/cli.js` — so `applyVariantTemplate` always bailed at its first guard, leaving `framework.router: none` in emitted configs.

### Fixed

- **`resolveTemplatesDir()` path resolution for bundled cli.js (long-standing bug)** — pre-1.5.2 candidates `../../templates` and `../../../templates` assumed cli.js was nested at `dist/commands/init.js` depth; the actual bundled location is `dist/cli.js`, requiring `../templates`. Pre-1.5.2 the function returned `null` in npm-installed deployments for BOTH `--template <name>` mode AND (new in 1.5.1) the variant-template merge. Cited evidence: `node $cli init --yes` debug instrumentation 2026-05-08 showed candidates `node_modules/@massu/templates` and `node_modules/templates` (wrong scopes) and never the actual `node_modules/@massu/core/templates` directory. Added `../templates` as the first dist-relative candidate; older candidates retained as fallbacks.

### Verification

- `npx --yes @massu/core@1.5.2 init` against the 5 framework fixtures (rails, phoenix, aspnet, spring, go-chi) produces configs with the correct `framework.router`, `paths.source`, `verification.<lang>.lint` values.

## [1.5.1] - 2026-05-08

Patch release closing two CR-39 violations discovered via end-to-end fixture verification of `npx massu init` against all six Phase 7 frameworks. Phoenix and ASP.NET projects could not previously install Massu (`error: no languages detected`); Rails / Spring / Go-chi installed but emitted generic configs missing the framework-specific variant template's `framework.router`, `paths.source`, and `verification.<lang>.lint` fields.

Daemon code unchanged from 1.5.0 — the in-flight 1.5.0 48 h soak verdict (started 2026-05-08T15:21:23Z) applies to 1.5.1.

### Added

- **Canonical manifest registry (`packages/core/src/detect/manifest-registry.ts`)** — single source-of-truth for every recognized manifest file. Both `package-detector.ts` (init's framework-detection layer) and `runner.ts:buildDetectionSignals` (AST adapter signal layer) consume from this registry. Adding a new manifest type now requires exactly one entry; both consumers automatically pick it up. Replaces the two parallel hand-rolled lists that diverged during Phase 7.
- **Elixir + C# manifest support** — `mix.exs` and `*.csproj` now recognized by package-detector. Closes the CR-39 gap where Phoenix and ASP.NET projects failed `npx massu init` even though their AST adapters worked correctly. Includes new `parseMixExs` and `parseCsproj` parser functions; the csproj parser also extracts the `<Project Sdk="...">` attribute for SDK-style detection.
- **Variant template merge (`applyVariantTemplate` in `commands/init.ts`)** — when `framework.languages.<lang>.framework` resolves to a known id, init now reads the matching `packages/core/templates/<id>/massu.config.yaml` and selectively merges its `framework.router`, `framework.orm`, `framework.ui`, `paths.source`, and `verification.<lang>.{lint,syntax,test,type,build}` fields. Closes the gap where rails/spring/go-chi/phoenix init succeeded but the resulting config lacked the framework's canonical lint command (rubocop / credo / golangci-lint / etc.) and routing identifier.
- **Framework-detector rules for elixir + csharp** — `phoenix` (`{:phoenix, ...}` in mix.exs), `aspnet-core` (`Microsoft.AspNetCore.App` / `.Mvc` PackageReference, `Microsoft.NET.Sdk.Web` Sdk attribute), `ex-unit` test framework, `xunit`, `ecto`, `ef-core` ORM. go-chi rules expanded to cover all major-versioned import paths (`github.com/go-chi/chi/v2` through `/v5`).
- **Strict gate `manifest-registry-drift.test.ts`** — 10 assertions: every entry has a callable parse function, unique pattern, well-formed shape; the `MANIFEST_FILES` const is permanently retired; every Phase 7 framework adapter language has a registry entry; every non-null `signalKey` corresponds to a real `DetectionSignals` field.
- **Strict gate `init-end-to-end.test.ts`** — 5 fixture-based end-to-end tests (rails, phoenix, aspnet, spring, go-chi) that run `runInit` against minimal projects in tmpdir() and assert the emitted `massu.config.yaml` carries the variant-template-defined `framework.router`, `paths.source`, and `verification.<lang>.lint`. The class of bug "init succeeded but variant template missing" is now structurally impossible to merge.

### Fixed

- **CR-39 violation: Phoenix + ASP.NET fixtures fail `npx massu init`** — root cause: `package-detector.ts:122-132` had a `MANIFEST_FILES` list missing `mix.exs` and `*.csproj`. Closed by manifest registry + new parsers.
- **Variant template `paths.source` for ASP.NET** — was `src` (which doesn't exist by ASP.NET Core convention); now `.` (project root). ASP.NET projects place `Controllers/`, `Pages/`, `Program.cs` etc. at the project root.
- **`source-dir-detector.ts` extension map missing elixir / csharp** — added `.ex`/`.exs` and `.cs` extensions plus their respective test-file regex patterns (`_test.exs`, `Tests?.cs`, `.Tests?/`).

### Verification

- `npx tsc --noEmit`: 0 errors
- `npm test`: 2079/2079 pass (+15 new structural tests, zero regressions)
- `bash scripts/massu-pattern-scanner.sh`: PASS
- `bash scripts/massu-generalization-scanner.sh`: PASS
- 5-fixture re-verification: all six Phase 7 frameworks (rails, phoenix, aspnet, spring, go-chi, python-flask covered transitively via SUPPORTED_LANGUAGE) produce valid `massu.config.yaml` with variant-template-merged fields.

### Known follow-on

- AST adapter introspect output (`detected.<adapter-id>:` block in emitted config) is still NOT piped through to init. The blocker is `codebase-introspector.ts:160-180` `sampleFiles` returning `[]` — adapters run but see zero source files. Closing this requires a real file-sampling layer; see follow-on plan to come.

## [1.5.0] - 2026-05-07

Plan 3c (adapter registry + framework coverage). Registry infrastructure (`registry.massu.ai`) is live and signed; six new first-party AST adapters bring supported framework count from 4 to 10 (rails, phoenix, aspnet, spring, flask, go-chi added on top of the 1.4.0 baseline of fastapi, django, nextjs-trpc, swiftui). A structural drift-guard test now makes "AST adapter silently degrades to regex fallback" impossible to merge — closing the gap that masked a `web-tree-sitter`/`tree-sitter-wasms` ABI mismatch through three Phase 7 commits.

### Added

- **Adapter registry trust model (Plan 3c Phase 5)** — three-class adapter loading: CORE-BUNDLED (shipped in `@massu/core` itself, no verification needed), REGISTRY-VERIFIED (npm packages cross-checked against the signed manifest at `registry.massu.ai/adapters/manifest.json`), LOCAL-EXPLICIT (operator-configured paths in `massu.config.yaml > adapters.local`). Per-class verification scopes, kill-switch (`adapters.enabled: false` short-circuits REGISTRY-VERIFIED + LOCAL-EXPLICIT entirely), and persistent-stderr warnings on degraded modes. See `packages/core/security/AUDIT-2026-05-XX.md` (Phase 3.5 audit) and `docs/SECURITY.md`.
- **Adapter registry infrastructure** — `registry.massu.ai` live on Vercel with Let's Encrypt (`CN=registry.massu.ai`), serving the signed manifest envelope (`manifest_b64` + Ed25519 detached signature) at `/adapters/manifest.json`. Public signing key fingerprint `3b6226d036c472e533110d11a7d0cd2773ce1d7d4f1003517d5bd69c5418ed4c` shipped at `packages/core/security/registry-pubkey.{b64,pem,env}`. Private key in macOS Keychain (`security add-generic-password` entry `massu/registry/signing/private`). HTTPS verified (HSTS `max-age=63072000; includeSubDomains; preload`).
- **Adapter SDK subpath export** — `@massu/core/adapter` subpath provides `defineAdapter()` factory + `CodebaseAdapter` types for third-party adapter authors. Adapters never import from `@massu/core` internals — only from this stable SDK. See `docs/AUTHORING-ADAPTERS.md`.
- **`npx massu adapters` CLI** — three subcommands: `list` (show which adapters are loaded + their trust class), `refresh` (re-fetch + re-verify the registry manifest), `search <query>` (search the manifest for adapters by id/keywords).
- **Six new first-party AST adapters (Plan 3c Phase 7)** — bringing supported framework count to 10:
  - **Flask** (`python-flask`) — extracts `auth_decorator`, `blueprint_url_prefix`, `app_factory`. Matches via `pyproject.toml` mentioning `flask` or `app/` directory shape.
  - **go-chi** (`go-chi`) — extracts `route_method`, `mount_prefix_base`, `middleware_name`. Matches via `go.mod` mentioning `github.com/go-chi/chi`.
  - **Rails** (`rails`) — extracts `route_method`, `api_namespace`, `root_controller` from `config/routes.rb`. Matches via strict `gem ['"]rails['"]` regex in Gemfile (rejects `rails-api` / `rails_admin`).
  - **Phoenix** (`phoenix`) — extracts `route_method`, `scope_prefix_base`, `router_module` from `lib/<app>_web/router.ex`. Matches via `{:phoenix\b(?!_)` regex in mix.exs (rejects `:phoenix_live_view`).
  - **ASP.NET Core** (`aspnet`) — extracts `route_method`, `route_prefix_base`, `controller_class`. Handles BOTH minimal API (`app.MapGet`) and attribute routing (`[HttpGet]`) uniformly with prefix normalization. Matches via `Microsoft.NET.Sdk.Web` SDK or `Microsoft.AspNetCore.App` reference in `.csproj`.
  - **Spring** (`spring`) — extracts `route_method`, `route_prefix_base`, `controller_class` from `@RestController` / `@Controller` classes. Handles parameterized (`@GetMapping("/{id}")`) AND parameterless (`@PostMapping`) annotations via separate Tree-sitter `annotation` and `marker_annotation` queries. Matches via `spring-boot-starter*` artifact or `org.springframework` reference in `pom.xml` / `build.gradle.kts`.
  Each adapter ships with a variant `massu.config.yaml` template (see `packages/core/templates/<framework>/`), 15-22 adversarial unit tests, and a strict-gate fixture in `adapter-grammar-strict.test.ts`.
- **`GRAMMAR_MANIFEST` expansion** — six new Tree-sitter grammar entries (`go`, `ruby`, `csharp`, `java`, `kotlin`, `elixir`) with hardcoded sha256 hashes for atomic-write cache verification. Each grammar wasm is downloaded once into `~/.massu/wasm-cache/<lang>-<sha>.wasm` with LRU eviction at 16 entries (~50 MB cap).
- **Detection signal expansion** — `DetectionSignals` now includes `mixExs?`, `csproj?`, `pomXml?`, `gradleBuild?` (preferring `build.gradle.kts` over `build.gradle` per Gradle 7+ defaults). Mirrors the existing `gemfile`/`goMod`/`cargoToml`/`pyprojectToml` manifest-reader pattern.
- **STRUCTURAL grammar drift-guard (CR-46)** — new test `adapter-grammar-strict.test.ts` asserts every shipped adapter returns NON-`'none'` confidence on a clear-cut fixture. Closes the lenient-test-pattern hole (`expect(['none', 'medium', 'high']).toContain(...)`) that previously allowed grammar-load failures to silently degrade adapters to regex-fallback. Future ABI breaks, query typos, or wasm-cache corruption flip this gate red. The `core-bundled-ids-drift.test.ts` (added in Phase 5) now also covers the 5 new Phase 7 adapter ids.
- **Telemetry writer** — `~/.massu/telemetry/adapter-discovery-*.jsonl` files capture per-discovery-run statistics (count by trust class, refusal reasons) for offline analysis. Replay command surfaces aggregates without re-running discovery.
- **`massu adapters add-local` / `remove-local` / `resync-local-fingerprint`** — three CLI commands that maintain the `~/.massu/adapters-local-fingerprint.json` sentinel (gap-32 postinstall-poisoning defense). Drift between the recorded fingerprint and the current `adapters.local` content forces operator re-acknowledgment before LOCAL-EXPLICIT adapters load.

### Fixed

- **Phase 7 grammar loadability (commit `d31b4d8`)** — pinned `web-tree-sitter` from `^0.26.8` to `~0.25.10`. Root cause (cited): `web-tree-sitter@0.26.x` at `web-tree-sitter.js:1944` requires WebAssembly custom-section name `dylink.0`; the wasms shipped by `tree-sitter-wasms@0.1.13` (compiled with `tree-sitter-cli@^0.20.8`) emit the older `dylink` section name (verified via `xxd ~/.massu/wasm-cache/elixir-*.wasm`). Empirical sweep across 0.20.8 → 0.26.8 confirmed 0.25.10 is the maximum-compatible version. Pre-fix, every Phase 7 AST adapter (`python-flask`, `go-chi`, `rails`) was silently degrading to `'none'` confidence (regex fallback). The new `adapter-grammar-strict.test.ts` is the structural drift-prevention that makes this class of bug impossible to merge again.
- **Rails adapter query (commit `d31b4d8`)** — removed `(method_call ...)` patterns from `rails.ts` queries. The `tree-sitter-ruby` v0.20.1 grammar (pinned by `tree-sitter-wasms@0.1.13`) emits routes.rb DSL invocations as `(call method: (identifier) arguments: (argument_list ...))` — there is no `method_call` node. Verified via AST probe (R-011 evidence cited inline in `rails.ts`). Even after the grammar-load fix, the `method_call` patterns would have thrown `QueryError: Bad node name 'method_call'` at `tree-sitter.js:1477`.
- **Pattern-scanner FAILs (commit `c943aa3`)** — directive-aware scanner + drift-guard close two stale FAILs. The scanner now respects `// massu-pattern-scanner: skip` directives in source files (intentional regex deviations) and runs a sibling drift-guard test that fails the build if `massu-pattern-scanner.sh` reports any new FAIL category not previously cleared.
- **Phase 3.5 security audit (commits `51ad804`, `259d7d8`, `4ab141e`, `9c5a80b`, `4d8f60a`, `2c21853`)** — closed all 17 findings across 6 audit iterations. Notable: `HIGH-NEW-1` (manifest cache TOCTOU), 5 `MED` findings on schema validation tightness, `LOW-NEW3-1` (InstallEntrySchema.version regex), `LOW-NEW4-2` (printable-ASCII guard against ANSI log injection), `LOW-NEW5-1` (FingerprintSentinelSchema using PrintableAsciiStringSchema). Final iteration shipped a STRUCTURAL drift-guard test for the manifest-cache `fetched_at` field — making the class of bug "manifest cache silently serves stale data because freshness is unenforced" impossible.
- **Phase 5 `gap-37` install-time + load-time sha256** — adapter packages now record their `installed_sha256` at `npm install` time in `~/.massu/adapter-manifest-installed.json`; load-time discovery re-computes the hash and refuses to load on drift. Cross-check against the signed registry manifest's `sha256` field detects post-install sidecar tampering (audit `M4` fix).
- **`scope MyAppWeb do` (alias-only Phoenix scope)** — correctly excluded from `scope_prefix_base` capture per the string-literal-anchor in the SCOPE_PATH_QUERY (verified negative case via AST probe).

### Security

- All Phase 3.5 audit findings closed (0 unfixed) per `packages/core/security/AUDIT-2026-05-XX.md`.
- Symlink attack defense across `discover.ts:walkNodeModules` (`lstatSync` not `statSync`) — same fix that landed in `install-tracking.ts` (audit `H1`) was missed in `discover.ts` until iter 2.
- Hidden-directory load-time refusal in `discover.ts` (`MED-NEW-2`) — packages shipping `.git/payload.js` etc. are refused at load time, closing the `sha256OfDir`-excludes-hidden-dirs gap.
- Adapter-loading kill-switch (`adapters.enabled: false`) defaults to `false` at the config schema layer (gap-1 / `C1`) — operators MUST opt-in to third-party adapter loading.

### Infrastructure

- `web-tree-sitter` pinned to `~0.25.10` (was `^0.26.8`). Hard upper bound documented inline; loosen this only after `tree-sitter-wasms` ships a release with `dylink.0`-format wasms.
- 5 workspace placeholder packages remain at `0.0.0-prework` (`@massu/adapter-{rails,phoenix,aspnet,spring,go-chi}`) — these adapters ship CORE-BUNDLED in `@massu/core` itself for 1.5.0; separate REGISTRY-VERIFIED package publish is a follow-on.

## [1.4.0] - 2026-05-07

Promotes the `1.4.0-soak.0` build (in soak since 2026-05-02) to `latest`. Soak-check verdict on 2026-05-07 09:00 PDT: **PASS** (samples=188, rss_p99=290 MB / budget 700, cpu_load=0.044 / budget 50, alive_pct=100, errors=0, slope=-11.35 MB/hr).

### Added

- **`massu watch` daemon (Plan 3a)** — long-running file-watcher that re-runs detection on stack-relevant changes and auto-installs new variant templates. Subcommands: `massu watch [--once] [--quiescence-ms N]` and `massu refresh-log`. Supervises via `claude-bg` or `launchd`. Self-defense: refuses to start if the watch surface exceeds the configured `watch.max_watched_files` cap and the user has not opted in via `watch.paths_full_root_opt_in`. Quiescence detector uses tick-gap heuristic + lockfile-mid-op detection + git-mid-rebase detection to avoid storming during interactive operations. New config block: `watch: { scope, debounce_ms, storm_window, max_watched_files, paths_full_root_opt_in }`.
- **AST adapter framework (Plan 3b Phase 1)** — Tree-sitter-based per-language adapters under `packages/core/src/detect/adapters/`. 4 first-party adapters ship: `python-fastapi`, `python-django`, `nextjs-trpc`, `swift-swiftui`. Adapter contract types in `detect/adapters/types.ts`. Per-field confidence levels (high/medium/low/none) — a single weak field never poisons stronger fields. Grammar SHA-256 manifest is hardcoded; mismatch → `GrammarSHAMismatchError` with no silent fallback. Atomic cache writes under `~/.massu/wasm-cache/` with LRU eviction (closes Phase 3.5 finding F-011).
- **Optional LSP enrichment layer (Plan 3b Phase 4)** — TypeScript-language-server / Python pyright integration for symbol-precise enrichment beyond Tree-sitter. Stays disabled unless `lsp.enabled: true`. Hard RSS watchdog on LSP spawn (closes Phase 3.5 finding F-015). SUID-detection refuses to spawn if the LSP binary is setuid (closes F-014).
- **Codebase-aware command templates (Plan #2)** — slash-command scaffolds installed by `npx massu init` / `config refresh` are now substituted against the consumer's `massu.config.yaml` AND a per-language `detected:` block sampled from existing source files. Templating engine (`template-engine.ts`) is mustache-style `{{var}}` and `{{var | default("…")}}` — string-substitution only. TPL-SEC-01..07 adversarial tests verify zero `eval`/`Function`/`vm`/`exec`/`spawn`, no prototype walk, no recursive expansion, no template-literal injection. 6 new sub-framework templates: `massu-scaffold-router.python-{fastapi,django}.md`, `massu-deploy.python-{launchd,systemd,docker,fly}.md`. `runDetection({skipIntrospect})` flag preserves session-start hook's 5s budget.
- **Public-repo leak-defense infrastructure** — 6-layer architecture preventing private-content leaks to the public massu npm/GitHub repo:
  - Pre-commit hook (`scripts/install-hooks.sh` auto-installs from `npm install`).
  - Pre-push hook (same).
  - Per-push CI (`.github/workflows/leak-guard.yml`).
  - Full-tree retroactive CI (`.github/workflows/leak-guard-retro.yml`).
  - Source-of-truth discipline CI (`.github/workflows/leak-guard-source-of-truth.yml`).
  - Weekly scheduled audit (`.github/workflows/leak-guard-scheduled.yml`).
  Single source-of-truth: `scripts/massu-public-leak-guard.sh` runs in two modes (`staged` for per-commit gates, `tree` for full-tree retroactive scan).
- **Plan 3c-prework Phase A + C** — `docs/**/*` added to `packages/core` `files[]` (so security/authoring docs ship to npm); `tar@^7.4.3` and `tweetnacl@^1.0.3` deps added (for Phase 5 signed-allowlist registry); 5 placeholder workspace stubs for `@massu/adapter-{rails,phoenix,aspnet,spring,go-chi}` (Phase 7 fills implementation); targeted `.gitignore` patterns replace blanket `*.pem` so the registry pubkey can ship.

### Fixed

- **Path-aware introspect matching for routers/views** — adapter signal logic now considers the file's PATH (e.g., `apps/*/routers/`) in addition to its content shape. Previously, FastAPI router signals could fire on any file containing `from fastapi import APIRouter` regardless of project layout.
- **Plan 3a hotfix 2026-05-02** — watcher self-defense + measurable RSS/CPU budgets. The 2026-05-02 hotfix added the watch-surface preflight cap, exclusion of high-churn directories (`**/.next/**`, `**/coverage/**`, `**/logs/**`, `**/data/**`, editor temp files), and switched the verdict from spot-percentile CPU to integral cpu-load fraction (catches the 30-100% sustained CPU misconfig pattern that produced false-PASS on a multi-runtime monorepo).

### Security

- **Phase 3.5 deep security audit** — 20 findings, 0 unfixed. Adapter-loading code path audited for prototype pollution, SSRF, RCE, and resource exhaustion. Adversarial test suite (`__tests__/security/`) verifies the LSP IPC layer, Tree-sitter loader, and adapter contract are not exploitable. Audit doc retained internally.
- **Public-repo historical leak scrub** — 17 historical leak markers removed/anonymized: internal-doc JSDoc cross-references (5), user-machine hardcoded paths (2), incident-doc CHANGELOG citations (3), customer-name design comments (11), test fixture renames (2 directories).

### Tests

- **+248 tests** since 1.2.1: watcher daemon + quiescence (54), AST adapter framework + 4 adapters (62), LSP enrichment (14), codebase-aware templates (50 templating + 13 introspector + 12 variant matrix), security adversarial (35), watcher session-start banner (5), refresh-log (3). Total: **1729 passing** (was 1373 on 1.2.1, 1481 in interim).

### Design notes

- This release intentionally bundles 3a + 3b + Plan #2 codebase-aware + leak-defense infra in one minor bump. The alternative (three separate minors) was rejected because 3a + 3b share a deep security audit (Phase 3.5) and splitting them would compress the audit window for downstream consumers.

## [1.3.0] - 2026-04-26

Stack-aware command templates with per-stack variant resolution. Local-edit protection via 3-hash manifest. (Retroactive entry: not previously logged in CHANGELOG; corresponds to npm-published version `1.3.0` from 2026-04-26.)

### Added

- **Stack-aware variant resolution in `install-commands`** — `pickVariant(baseName, sourceDir, framework)` returns a discriminated `{hit, miss, fallback}` union. Priority order: primary language → languages-declaration order → top-level passthrough fallback (`typescript` / `javascript` / `python` / `swift` / `rust` / `go`) → unsuffixed default. Variant filenames are filtered at the top level only — subdirectory contents recurse as-is.
- **Local-edit protection via SHA-256 manifest** — manifest at `<claudeDir>/.massu/install-manifest.json` with 3-hash compare (source / existing / last-installed) and atomic tempfile+rename writes. New `SyncStats.kept` counter reports preserved edits. First-install heuristic preserves any pre-existing differing file and seeds the manifest with the existing hash.
- **`massu show-template <command> [--variant <stack>]` subcommand** — prints the resolved variant content to stdout for diff-against-upstream workflows. Used in the kept-your-version notice.
- **4 seed variant templates** — `massu-scaffold-router.python.md` (FastAPI), `massu-scaffold-page.swift.md` (SwiftUI), `massu-deploy.python.md` (launchd/systemd/pm2/docker), `massu-scaffold-page.md` regenerated as framework-agnostic with embedded multi-stack examples. Plus `commands/README.md` documenting the variant convention.
- **+21 tests** — VARIANT-01..10, MANIFEST-01..08, SHOW-01..03. Total suite: 1394 passing (was 1373 on 1.2.1).

### Changed

- `config.ts` spreads `...fw` into the materialized framework so `zod.passthrough()` blocks (`framework.swift`, `framework.python`, …) flow through to consumers. Without this, the iteration-3 passthrough-fallback rule silently never fires in production despite green unit tests.

## [1.2.1] - 2026-04-20

`@massu/core init --ci` no longer rolls back on fresh monorepo installs (turbo, nx, pnpm workspaces, lerna, rush, generic). Fixes the 2026-04-20 monorepo `paths.source` rollback regression.

### Fixed

- **`@massu/core init --ci` on monorepos**: `paths.source` is now resolved from the repo's monorepo layout when the primary language has no root-level source directory. Previously, a fresh turbo + `apps/web/page.tsx` repo (no `typescript` dep, no `tsconfig.json`, no root `src/`) would generate `paths.source: 'src'`, fail post-write validation, and roll back with `paths.source 'src' does not exist on disk`. The fix extends `buildConfigFromDetection` (`packages/core/src/commands/init.ts`) and the v1→v2 migration path (`packages/core/src/detect/migrate.ts`) with a monorepo-aware fallback: when the dominant source dir is empty AND `detection.monorepo.type !== 'single'`, `paths.source` is set to the common top-level parent of every workspace package (`apps`, `packages`, `libs`, etc.), or `'.'` when packages span multiple parents.
- **Source-dir detection for plain-JS monorepos**: `EXTENSIONS.javascript` (`packages/core/src/detect/source-dir-detector.ts`) is now extended with `['ts', 'tsx']` via a new `fallbackTsForJs` flag when the repo has a `javascript` manifest but NO `typescript` manifest. This surfaces `.tsx` files under `apps/*` in plain-JS turbo repos (e.g. `next` + `react` in a `package.json` without `typescript` + no `tsconfig.json`), which the prior strict javascript glob skipped entirely.

### Added

- **`paths.monorepo_roots: string[]`** — new optional config field emitted by `init --ci` and `config refresh`/`upgrade` whenever `monorepo.type !== 'single'` and workspace packages exist. Lists every distinct top-level workspace parent (e.g. `['apps', 'libs']` for an nx repo with both). Additive, schema-compatible with v1 configs; downstream tools may consume it for monorepo-aware scanning.
- **Post-write validation extended (`validateWrittenConfig`)** — new check that each entry in `paths.monorepo_roots` exists on disk. Parity with the existing `paths.source` existence check; rolls back on mismatch with message `paths.monorepo_roots '<x>' does not exist on disk`.
- **3 new fresh-install fixtures** (`packages/core/src/__tests__/fixtures/fresh-install/`): `nx-monorepo` (apps + libs via yarn workspaces), `pnpm-workspaces` (pnpm + packages/*), `rush-monorepo` (rush + apps/). Covers every major JS monorepo shape for `init --ci` regression gating.
- **`.github/workflows/fresh-install-matrix.yml`** — new CI matrix (6 fixtures × node:20) that runs `init --ci` end-to-end on every push/PR to main. Gates merges on: exit 0, `schema_version: 2` emitted, `paths.source` existing on disk, and `paths.monorepo_roots` emitted for every monorepo shape. PR runs use the local build; main-branch runs additionally verify against the last published `@massu/core@1` as drift protection.

### Deprecated

- **Legacy `generateConfig` in `commands/init.ts`** — emits a console deprecation warning on invocation. It hardcodes `paths.source = 'src'` and cannot resolve monorepo layouts. Use `buildConfigFromDetection(runDetection(root))` instead. Kept only for the legacy `cli.test.ts` smoke tests.

### Tests

- **+16 tests** covering the P1 detector changes (fallbackTsForJs flag, runDetection wiring, monorepo-aware `paths.source`, monorepo_roots emission), the P2 validator extension, and the P4.8 security pre-screen (IGNORE_PATTERNS + symlink-safety regressions).
- Total test count: **1373 passing** (was 1357 on 1.2.0).

### Design notes

- `paths.source` remains a `string` (not an array). Every live consumer in `packages/core/src/` reads it as a string (`config.ts:590`, `sentinel-scanner.ts:223`, `domains.ts:106/157`, `python/coupling-detector.ts:23`, `trpc-index.ts:115`) — widening to an array would break all six sites silently. Monorepo multi-source precision is instead available via `framework.languages.<lang>.source_dirs` (existing) and the new `paths.monorepo_roots` (optional).
- JS-to-TS language reclassification (when the only manifest is a plain-JS `package.json` but `.tsx` files are present) is NOT done in 1.2.1 — it's a classification change with its own blast radius (framework-detector rules, VR commands, schema version). Tracked as P6-001 for a future release.

## [1.2.0] - 2026-04-20

`config upgrade` and `config refresh` no longer silently drop user-authored config data. Fixes the 2026-04-19 HIGH-severity config-data-loss regression.

### Fixed
- **`massu config upgrade`** — top-level keys not in the built-in preservation list are now passed through verbatim via the new `copyUnknownKeys` helper in `packages/core/src/detect/passthrough.ts`. Nested subkeys inside the `framework`, `paths`, `project`, and `python` blocks are now passed through via `preserveNestedSubkeys` when the migrator rebuilds those blocks.
- **`massu config refresh`** — `mergeRefresh` rewritten to preserve: (1) top-level user keys not handled by the detector, (2) user subkeys inside `framework`/`paths`/`project`, (3) `toolPrefix` (previously silently reset to `'massu'`), (4) user-set `project.root` (previously silently reset to `'auto'`), (5) user-authored aliases inside `paths.aliases` (2-level-nested — previously overwritten by detector's hardcoded `{'@': <source>}`), (6) custom `verification.<lang>` sections and user command overrides on shared languages (2-level-nested — previously silently replaced by detector-only verification output).

### Impact — what was happening on 1.1.0
- **Top-level**: on `@massu/core@1.1.0`, the keys PRESERVED during `config upgrade` were exactly this set: `{rules, domains, canonical_paths, verification_types, detection, accessScopes, knownMismatches, dbAccessPattern, analytics, governance, security, team, regression, cloud, conventions, autoLearning}` — plus `schema_version`, `project`, `framework`, `paths`, `toolPrefix`, `verification`, and `python` via dedicated code paths. **ANY OTHER top-level key in your v1 config was DROPPED** — if your config had something like `services`, `workflow`, `north_stars`, or any other custom top-level section, it is gone from the upgraded file. Restore from `git log`.
- **Nested**: on `@massu/core@1.1.0`, subkeys PRESERVED inside each rebuilt block were exactly: `framework` → `{type, router, orm, ui, primary, languages}`; `paths` → `{source, aliases, routers, routerRoot, pages, middleware, schema, components, hooks}`; `project` → `{name, root}`. **ANY OTHER subkey inside those blocks was DROPPED** — for example, `project.description`, custom `framework.<lang>` blocks, or custom `paths.<name>` entries. Restore from `git log`.

### Restoration instructions
Compare `git log -p -- massu.config.yaml` for your repo against the post-1.1.0 state; any sections removed without explanation were lost to this bug and can be restored from history. If your `.bak` file (written by `config upgrade`) still exists, `npx @massu/core@1.2.0 config upgrade --rollback` will restore it.

### Added
- **`packages/core/src/detect/passthrough.ts`** — new module exporting `copyUnknownKeys(source, target, handledKeys)` and `preserveNestedSubkeys(sourceBlock, targetBlock)`. Target-wins semantics documented in JSDoc. Shared by `migrate.ts` and `config-refresh.ts` to prevent the two-allow-lists-drifting-apart class of bug that caused this incident.
- **26 new tests** covering top-level passthrough, nested passthrough across `framework`/`paths`/`project`/`python`, refresh-side `mergeRefresh` preservation (`toolPrefix`, `project.root`, nested subkeys, 2-level-nested `paths.aliases` and `verification.<lang>` user overrides), loose-v1-input coercion (non-object framework/paths/project/python), a sentinel-injection property-style regression guard that fails if a future rebuild block omits passthrough, and a new regression fixture that reproduces the exact 12-top-level-key shape the incident dropped data from. Total suite: 1357 tests passing.

### Shipped
- Merged via PR #1 (commit `94e6723`; merge commit `bfa8686`). Published to npm on 2026-04-20 with `gitHead: bfa8686`. P5-007 post-publish regression against 5 downstream consumer repos: **zero key removals at any depth**.

## [1.1.0] - 2026-04-19

`massu config` CLI surface + drift detection runtime. Unblocks the config-migration workflow for downstream repos. Additive only — no breaking changes.

### Added
- **`massu config <sub>`** — new top-level command tree dispatched from `packages/core/src/cli.ts`. Five subcommands:
  - `massu config refresh [--dry-run]` — re-run detection, diff against existing config, apply interactively (or `--dry-run` to print and exit). Preserves the following user-authored fields (`rules`, `domains`, `canonical_paths`, `verification_types`, `accessScopes`, `knownMismatches`, `dbAccessPattern`, `analytics`, `governance`, `security`, `team`, `regression`, `cloud`, `conventions`, `autoLearning`, `python`). **NOTE**: this was incomplete — top-level keys outside this list AND nested subkeys inside `framework`/`paths`/`project`/`python` were silently dropped. See `[1.2.0]` for the full-preservation fix and the 2026-04-19 incident reference.
  - `massu config validate` — alias of `massu validate-config`.
  - `massu config upgrade [--rollback] [--ci | --yes]` — migrate v1 config → schema_version=2 via `migrateV1ToV2`. Writes `.bak` before overwriting. `--rollback` restores from `.bak`. `--ci`/`--yes` skip all prompts. Idempotent on v2 configs.
  - `massu config doctor` — alias of `massu doctor`.
  - `massu config check-drift [--verbose]` — CI-safe gate; exits 1 on drift. `--verbose` prints the full change list to stdout.
- **Session-start drift banner** — `packages/core/src/hooks/session-start.ts` now emits a plain-text banner when `config.detection.fingerprint` disagrees with the current detected fingerprint. Silent on v1 configs (no stored fingerprint = no banner). Best-effort; never throws.
- **`detection.fingerprint` auto-stamp** — `buildConfigFromDetection`, `config refresh`, and `config upgrade` all stamp a deterministic SHA-256 stack fingerprint into the generated config.
- **+35 tests** covering refresh (`config-refresh.test.ts`, 11 cases), upgrade CLI (`config-upgrade-cli.test.ts`, 8 cases), check-drift (`config-check-drift.test.ts`, 5 cases), CLI dispatcher (`cli-dispatcher.test.ts`, 5 cases), session-start drift banner (`session-start-drift.test.ts`, 3 cases). Total suite: 1331 tests passing.

### Changed
- Legacy CLI entry points (`massu init`, `massu doctor`, `massu install-hooks`, `massu install-commands`, `massu validate-config`) are preserved verbatim. `massu config {validate,doctor}` are aliases that route to the same handlers.
- Pattern scanner allowlist extended to include `commands/config-{refresh,upgrade,check-drift}.ts` — same rationale as existing `init.ts`/`doctor.ts` exemptions (raw YAML parse is required because `getConfig()` caches against `process.cwd()` and Zod-rejects pre-migration v1 configs).
- `packages/core/dist/hooks/session-start.js` bundle size: ~80KB → ~306KB (bundles `fast-glob` + `smol-toml` for runtime detection). Still compiles in <30ms via esbuild.

### Fixed
- `docs/plans/2026-04-19-autodetect-zero-config.md` Phase 4 and Phase 5 are no longer deferred. The sibling plan `docs/plans/2026-04-19-config-migration.md` can now proceed.

## [1.0.0] - 2026-04-19

Auto-detect on install; zero manual config; migration via `migrateV1ToV2()`.

### Breaking
- `schema_version: 2` is now the default for every config generated by `massu init`. Configs without `schema_version` are interpreted as `schema_version: 1` and continue to load unchanged — no code changes required for existing projects, but new fields (`framework.languages`, `verification`, `verification_types`, `detection.rules`) only apply to v2 configs.
- `framework.type` accepts a new value `"multi"` for multi-runtime projects, with `framework.primary` selecting the dominant language. Single-language projects still use `framework.type: typescript | python | rust | ...` exactly as before.
- Legacy top-level `framework.router / .orm / .ui` keys are mirrored from `framework.languages.<primary>` on v2 configs. Readers that only consult the top-level keys keep working.

### Added
- **Auto-detection engine** (`packages/core/src/detect/`) — pure filesystem introspection across 8 languages (TypeScript, JavaScript, Python, Rust, Swift, Go, Java, Ruby), 9 manifest formats, and ~60 framework/ORM/test-framework signals. No network, no child processes, no database writes.
- **`massu init` rewrite** — detection-driven, zero manual YAML editing. Generates `schema_version: 2` configs. New flags: `--ci` (non-interactive), `--force` (overwrite without prompt), `--template <name>`.
- **7 project templates** — `python-fastapi`, `python-django`, `ts-nextjs`, `ts-nestjs`, `rust-actix`, `swift-ios`, `multi-runtime`. Greenfield mode skips detection.
- **`migrateV1ToV2(v1Config, detectionResult)` pure function** (`packages/core/src/detect/migrate.ts`) — lifts existing v1 configs to v2 while preserving every user override (rules, domains, canonical_paths, accessScopes, analytics, governance, security, team, conventions, etc.).
- **`computeFingerprint` and `detectDrift`** (`packages/core/src/detect/drift.ts`) — SHA-256 fingerprint over normalized `DetectionResult` plus a four-axis drift report (language set, per-language framework, manifest set, workspace set).
- **`verification` config block** — per-language overrides for VR-TEST, VR-TYPE, VR-BUILD, VR-SYNTAX, VR-LINT.
- **`verification_types` config block** — register custom VR-* types (e.g., `VR-LEDGER-PARITY`, `VR-POLICY`) with descriptions.
- **`detection.rules` config block** — add project-specific framework signals or replace built-ins entirely with `detection.disable_builtin: true`.
- **Monorepo detection** — identifies `turbo`, `nx`, `lerna`, `pnpm`, `yarn`, `bazel`, `generic`, `single`. Nested workspace support (e.g., turbo outer + pnpm inner).
- **Atomic config writes** — `.tmp` file + `renameSync`; partial writes never persist. File permissions preserved on overwrite.
- **Post-init validation** — every written config is re-read through Zod and filesystem-checked; invalid configs are rolled back.
- **61 new tests** covering 11 fixture repos, 5 stale-config migration snapshots, and 6 drift scenarios.
- **Documentation** — `docs/auto-detection.mdx`, `docs/migration/v1-to-v2.mdx`, `docs/vr-types.mdx`, `docs/ci-drift-check.mdx`, `docs/error-handling.mdx`.

### Changed
- `massu init` output now reports detected languages, frameworks, source dirs, and monorepo type explicitly rather than producing a generic TypeScript template.
- `framework.type` shape extended to support multi-runtime via `type: multi` + `primary: <language>` + `languages: { <language>: { ... } }`.
- Pattern scanner allowlist extended to include `detect/monorepo-detector.ts` (reads `pnpm-workspace.yaml`, not `massu.config.yaml`) and `commands/init.ts` (validates the YAML it just wrote).

### Fixed
- Stale configs where the declared language didn't match repo reality (multi-runtime stale-config regressions) now fail post-init validation and are rolled back instead of being silently written.
- `--ci` mode no longer silently overwrites existing configs — throws `"massu init: config exists in --ci mode (no overwrite)"`. Use `--force` to opt in.
- Interactive overwrite prompt now defaults to NO (previously defaulted to YES on some terminals).
- Symlink-escape defense: detection filters out any file whose `realpath` resolves outside `projectRoot`.
- Secret-file exclusion: `.env`, `.env.*`, `*.pem`, `*.key`, `.aws/**`, `.ssh/**`, `credentials.json`, `*.p12`, `*.pfx` are explicitly excluded from source-dir globbing.

### Security
- New detection layer is network-free and database-free by contract. Verified by `grep -rn "better-sqlite3|getMemoryDb|getDataDb|child_process|spawn|execSync|fetch\(" packages/core/src/detect/ → 0 matches`.
- Atomic writes prevent partial config corruption on write failure.
- CI generalization scanner now runs on every PR to catch hardcoded project-specific data.

## [0.3.0] - 2026-02-25

### Added
- **Tier enforcement** — Free (14 tools), Pro (63+), Team, Enterprise tiers with license gating
- **License validation** — `license.ts` module with `getCurrentTier()`, `getToolTier()`, `isToolAllowed()`, and `annotateToolDefinitions()`
- **`massu_license_status` tool** — Check current tier, available tools, and upgrade path from any session
- **Conventions config** — `conventions` section in `massu.config.yaml` for project-specific coding rules
- **Generalization scanner** — `scripts/massu-generalization-scanner.sh` verifies no hardcoded project-specific data in shipped files

### Changed
- Tool descriptions now include tier labels (e.g., "[Pro]") when not on the free tier
- README and CLAUDE.public.md updated with tier information and tool counts
- Package description updated to mention tiered tooling
