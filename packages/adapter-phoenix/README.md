# @massu/adapter-phoenix

Massu first-party adapter for Phoenix (Elixir) — Tree-sitter AST detection of
routes, scopes, and pipelines in `lib/*_web/router.ex`.

## What it detects

- `route_method` — most-common explicit HTTP verb (`get`/`post`/`put`/`patch`/`delete`)
  with a string-literal path argument inside a `Phoenix.Router` module.
- `api_namespace` — first scope path from `scope "/api", FooWeb do …`, normalized
  to a leading-slash path.
- `pipeline` — pipeline name applied to the api scope (e.g. `:api`, `:browser`).

## Install

```bash
npm install @massu/adapter-phoenix
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
