# @massu/adapter-spring

Massu first-party adapter for Spring (Java) — Tree-sitter AST detection of
`@RestController`, `@RequestMapping`, `@GetMapping`/`@PostMapping`/etc. annotations
in Spring Boot codebases.

## What it detects

- `route_method` — most-common explicit HTTP verb annotation (`@GetMapping`,
  `@PostMapping`, `@PutMapping`, `@PatchMapping`, `@DeleteMapping`) on a controller
  method.
- `api_namespace` — first `@RequestMapping("/api")` value applied at controller
  class scope, normalized to a leading-slash path.

## Install

```bash
npm install @massu/adapter-spring
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
