# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
