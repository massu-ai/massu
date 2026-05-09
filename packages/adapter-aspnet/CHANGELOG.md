# Changelog

All notable changes to `@massu/adapter-aspnet` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] - 2026-05-09

First publish of `@massu/adapter-aspnet` as a standalone npm package — see Plan 3c Phase 9b (`plan-3c-phase9b`) for the architecture and rationale.

### Added

- Tree-sitter AST adapter for ASP.NET Core (C#): detects `route_method`, `route_prefix_base`, and `controller_class`. Handles BOTH minimal API (`app.MapGet`) and attribute routing (`[HttpGet]`) uniformly with prefix normalization. Matches via `Microsoft.NET.Sdk.Web` SDK or `Microsoft.AspNetCore.App` reference in `.csproj`.
- Built on top of `@massu/core/adapter` (the SemVer-stable adapter authoring surface). Workspace-canonical source (`packages/adapter-aspnet/src/index.ts`); `@massu/core@1.6.0` bundles the same code via `bundle-adapters.ts` for CORE-BUNDLED zero-config use.

### Verification

- npm tarball shasum: `2fff624d3491ced5a831f7b7dce36928e91020a2`
- signing key id: `3b6226d036c472e533110d11a7d0cd2773ce1d7d4f1003517d5bd69c5418ed4c`
- Cross-reference: see [root `CHANGELOG.md`](../../CHANGELOG.md) `[1.6.0]` entry for the cross-package release notes.
