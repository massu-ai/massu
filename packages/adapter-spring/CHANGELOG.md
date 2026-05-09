# Changelog

All notable changes to `@massu/adapter-spring` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] - 2026-05-09

First publish of `@massu/adapter-spring` as a standalone npm package — see Plan 3c Phase 9b (`plan-3c-phase9b`) for the architecture and rationale.

### Added

- Tree-sitter AST adapter for Spring (Java/Kotlin): detects `route_method`, `route_prefix_base`, and `controller_class` from `@RestController` / `@Controller` classes. Handles parameterized (`@GetMapping("/{id}")`) AND parameterless (`@PostMapping`) annotations via separate Tree-sitter `annotation` and `marker_annotation` queries. Matches via `spring-boot-starter*` artifact or `org.springframework` reference in `pom.xml` / `build.gradle.kts`.
- Built on top of `@massu/core/adapter` (the SemVer-stable adapter authoring surface). Workspace-canonical source (`packages/adapter-spring/src/index.ts`); `@massu/core@1.6.0` bundles the same code via `bundle-adapters.ts` for CORE-BUNDLED zero-config use.

### Verification

- npm tarball shasum: `b3f7a87e0f25c9174c4e3540c1a255feb333a6cb`
- signing key id: `3b6226d036c472e533110d11a7d0cd2773ce1d7d4f1003517d5bd69c5418ed4c`
- Cross-reference: see [root `CHANGELOG.md`](../../CHANGELOG.md) `[1.6.0]` entry for the cross-package release notes.
