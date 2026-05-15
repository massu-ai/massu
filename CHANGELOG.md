# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
- **`verification_types` config block** — register custom VR-* types (e.g., `VR-IBKR-CONTRACT`, `VR-POLICY`) with descriptions.
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
