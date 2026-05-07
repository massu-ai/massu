# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
