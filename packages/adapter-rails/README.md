# @massu/adapter-rails

Massu first-party adapter for Ruby on Rails — Tree-sitter AST detection of routes,
namespaces, and root controllers in `config/routes.rb`.

## What it detects

- `route_method` — most-common explicit HTTP verb (`get`/`post`/`put`/`patch`/`delete`)
  used at top level with a string-literal path argument.
- `api_namespace` — first segment of the first `namespace :foo do …` block, normalized
  to a leading-slash path (per Rails routing guide §3).
- `root_controller` — controller name from `root 'pages#home'` or `root to: 'pages#home'`.

## Install

```bash
npm install @massu/adapter-rails
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
