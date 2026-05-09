# @massu/adapter-go-chi

Massu first-party adapter for Go Chi — Tree-sitter AST detection of
`router.Get`/`router.Post`/`router.Put`/`router.Delete` registrations and
`router.Mount` prefixes in Go Chi codebases.

## What it detects

- `route_method` — most-common explicit HTTP verb method (`Get`, `Post`, `Put`,
  `Patch`, `Delete`) called on a Chi router with a string-literal path argument.
- `mount_prefix_base` — first prefix from `router.Mount("/api", ...)`, normalized
  to a leading-slash path.

## Install

```bash
npm install @massu/adapter-go-chi
```

The adapter is also CORE-BUNDLED in `@massu/core@1.6.0+` for zero-config use; the
standalone package adds the REGISTRY-VERIFIED trust class — the published tarball's
`dist/` is sha256-verified end-to-end against the signed manifest at
`https://registry.massu.ai/adapters/manifest.json`.

## Authoring SDK

This adapter is built on top of `@massu/core/adapter` (the SemVer-stable adapter
authoring surface). See [docs/AUTHORING-ADAPTERS.md](https://github.com/massu-ai/massu/blob/main/docs/AUTHORING-ADAPTERS.md)
for the full contract.

## License

Business Source License 1.1 — see [LICENSE](./LICENSE).
