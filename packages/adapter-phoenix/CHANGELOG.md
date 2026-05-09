# Changelog

All notable changes to `@massu/adapter-phoenix` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] - 2026-05-09

First publish of `@massu/adapter-phoenix` as a standalone npm package — see Plan 3c Phase 9b (`plan-3c-phase9b`) for the architecture and rationale.

### Added

- Tree-sitter AST adapter for Phoenix (Elixir): detects `route_method`, `scope_prefix_base`, and `router_module` from `lib/<app>_web/router.ex`. Matches via `{:phoenix\b(?!_)` regex in `mix.exs` (rejects `:phoenix_live_view`).
- Built on top of `@massu/core/adapter` (the SemVer-stable adapter authoring surface). Workspace-canonical source (`packages/adapter-phoenix/src/index.ts`); `@massu/core@1.6.0` bundles the same code via `bundle-adapters.ts` for CORE-BUNDLED zero-config use.

### Verification

- npm tarball shasum: `22d856030b8d220d3846d7f16d32d7daa41b76ea`
- signing key id: `3b6226d036c472e533110d11a7d0cd2773ce1d7d4f1003517d5bd69c5418ed4c`
- Cross-reference: see [root `CHANGELOG.md`](../../CHANGELOG.md) `[1.6.0]` entry for the cross-package release notes.
