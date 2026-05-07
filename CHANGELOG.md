# Changelog

## Unreleased

- chore(config): migrated massu.config.yaml to v2 schema via @massu/core@1 config upgrade (auto-detected stack, preserved user overrides)


All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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

## [Unreleased]

### Added
- **43 slash commands** now bundled in `@massu/core` npm package
- `massu init` Step 5 automatically installs slash commands into `.claude/commands/`
- `massu install-commands` standalone CLI command for updating commands
- 3 new commands: `massu-deploy`, `massu-loop-playwright`, `massu-simplify`
- BSL 1.1 license (Phase 1A)
- Supabase schema with RLS policies (Phase 1A)
- Auth flow: login, signup, forgot-password, OAuth (Phase 1B)
- Dashboard with session analytics (Phase 1E)
- Stripe checkout and billing integration (Phase 1C)
- API key management with bcrypt hashing (Phase 1D)
- Cloud sync edge functions (Phase 1D)
- Terms of Service and Privacy Policy pages
- CI/CD pipeline with lint, type-check, test, and build jobs (GitHub Actions)
- Website test infrastructure (vitest + Playwright E2E stubs)
- Sentry error monitoring configuration stubs
- Docker and docker-compose setup for local development
- Contributor License Agreement (CLA.md)
- Comprehensive security hardening (audit remediation)
- Toast notification system
- Shared UI components (TextInput, GitHubIcon, CopyInstallCommand)
- Public/private visibility classification for observations
- Zod runtime validation for config parsing (replaced ~35 type assertions)
- Plugin README documenting planned Claude Code plugin

### Changed
- Contributing guide updated with environment variable and config documentation
- Cookie security and CSRF protection documented in code comments
- API key lookup uses unique key prefix for efficient index queries
- Hook git commands use spawnSync instead of execSync for safety

### Fixed
- Stripe checkout redirect SSRF vulnerability
- XSS via javascript: URLs in MarkdownRenderer
- CSP unsafe-eval removed
- CORS restricted on edge functions
- Webhook secret validation
- Stripe price ID env var naming mismatch
- Dashboard billing nav link path
- Checkout session plan assignment
- Domain inconsistency (massu.dev to massu.ai)
- Password visibility toggle keyboard accessibility
- Multiple silent error handling blocks

### Security
- Added RLS INSERT/UPDATE/DELETE policies
- Input validation on sync edge function
- UUID validation on org IDs
- Server-side org ID derivation
- Rate limiting on auth forms
- LIKE wildcard escaping
- Redirect parameter validation
- Auth error message normalization

### Dependency Audit
- 5 moderate vulnerabilities found, all in dev-only toolchain (esbuild <=0.24.2 via vite/vitest)
- These affect only the development server, not production builds
- Fix requires breaking change to esbuild 0.27+ (`npm audit fix --force`)
- No production runtime vulnerabilities detected
