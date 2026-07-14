# Authoring a Massu Adapter

> Plan 3c gap-31 deliverable. Documents the adapter authoring workflow for
> third-party `@massu/adapter-*` packages and project-local TypeScript
> adapters listed in `massu.config.yaml > adapters.local`.

## Quickstart

```bash
mkdir my-adapter && cd my-adapter
npm init -y
npm install --save-peer @massu/core
```

Edit `package.json`:

```json
{
  "name": "@your-org/adapter-yourframework",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "massu-adapter": true,
  "massu-adapter-api-version": "1",
  "peerDependencies": { "@massu/core": ">=1.5.0 <2.0.0" }
}
```

Create `src/index.ts`:

```typescript
import { defineAdapter, type CodebaseAdapter } from '@massu/core/adapter';

export default defineAdapter({
  id: 'your-framework',
  languages: ['typescript'],

  matches(signals) {
    return Boolean(
      signals.packageJson?.dependencies?.['your-framework'] ??
      signals.packageJson?.devDependencies?.['your-framework'],
    );
  },

  async introspect(files, rootDir) {
    // Run Tree-sitter queries, walk ASTs, sample files…
    // The runner has already pre-read `files`; do NOT re-read from disk inside introspect.
    return {
      conventions: {
        router: 'your-framework',
        // …whatever fields your framework's variant template consumes
      },
      provenance: [
        // Each field's provenance: where in the codebase + which query found it.
        { field: 'router', value: 'src/main.ts:12', query: 'package.json dependency' },
      ],
      confidence: 'high', // 'high' | 'medium' | 'low' | 'none'
    };
  },
});
```

Build + publish:

```bash
npm run build
npm pack          # smoke-test the tarball
npm publish --access public
```

## The contract

Every adapter package's default export MUST conform to `CodebaseAdapter`:

```typescript
interface CodebaseAdapter {
  id: string;                                   // stable kebab-case id
  languages: TreeSitterLanguage[];              // languages this adapter consumes
  matches(signals: DetectionSignals): boolean;  // cheap signal check, NO file IO
  introspect(files: SourceFile[], rootDir: string): Promise<AdapterResult>;
}
```

`defineAdapter` is a no-op identity function at runtime; it exists so adapter
authors get IDE autocomplete + compile-time type errors for missing or
mistyped fields. Use it instead of `const adapter: CodebaseAdapter = { ... }`
for cleaner author ergonomics.

### `matches(signals)` rules

- Cheap: NO file IO, NO async work, NO network. Returns `boolean` synchronously.
- Idempotent: same `signals` input → same return.
- The runner builds `signals` once per project scan and passes the same
  reference to every adapter; do NOT mutate.

### `introspect(files, rootDir)` rules

- May be slow + async. The runner isolates failures (a thrown error in
  one adapter does NOT abort the whole scan; the runner records it under
  `MergedAdapterOutput.errored`).
- `files` is pre-read by the runner. Re-reading from disk inside
  `introspect` defeats the runner's sampling discipline + breaks tests.
- Return per-field `provenance` so consumers can trace where each
  convention came from. `confidence` is per-adapter for v1; field-level
  confidence is reserved for a future major version.

## Three trust classes

The Massu adapter loader classifies every adapter into exactly one of three
trust classes. Pick the right one for your adapter:

| Class | When to use | Verification |
|---|---|---|
| **CORE-BUNDLED** | You contributed your adapter to `@massu/core` itself. | Inherits trust from `@massu/core`'s npm provenance. No per-load signature check. |
| **REGISTRY-VERIFIED** | You publish `@your-org/adapter-yourframework` separately on npm. | Manifest at `https://registry.massu.ai/adapters/manifest.json` lists the package + per-version sha256. Loader verifies the Ed25519 manifest signature + per-package sha256 before loading. |
| **LOCAL-EXPLICIT** | You have a project-internal TypeScript adapter that should NOT be published. | Listed in `massu.config.yaml > adapters.local` (POSIX-relative path). Loader checks the `~/.massu/adapters-local-fingerprint.json` sentinel — operator must run `massu adapters add-local <path>` to acknowledge each entry. |

Choose REGISTRY-VERIFIED for any community-contributed adapter. The
`@your-org/` prefix is up to you; the loader accepts any package whose
`package.json` declares `"massu-adapter": true` and whose name matches a
manifest entry.

## Submitting a REGISTRY-VERIFIED adapter

Adapter packages are added to the signed registry manifest by the Massu
maintainer via PR review. The flow:

1. Author your package per the Quickstart above.
2. Publish to npm: `npm publish --access public`.
3. Open a PR against `https://github.com/massu-ai/massu` proposing the
   manifest entry. The PR body should include:
   - Package name + version
   - sha256 of the published tarball (from `npm view <pkg>@<version> dist.shasum`)
   - Brief description of what the adapter detects
4. The maintainer reviews the package source, audits the introspect
   logic for resource use + secrets handling, verifies the sha256 matches
   the npm tarball, signs the updated manifest with the registry
   Ed25519 key, and deploys to `https://registry.massu.ai`.

Until the manifest is updated + redeployed, the loader will refuse your
adapter with a "not in the signed registry manifest" error. There is no
unsigned-loading bypass — the prior `allow_unsigned` config flag was
removed in CR-9 audit C2 because it was a tripwire: parsed but never
consulted by any callsite, creating a footgun for future contributors
who might wire it incorrectly. Authors who want to test their adapter
locally before the manifest is updated should use the LOCAL-EXPLICIT
class instead (path entry in `adapters.local`), which is the supported
operator-acknowledged loading path for in-development adapters.

## LOCAL-EXPLICIT adapter authoring

For project-internal adapters that you do not want to publish, list the
TS file path under `adapters.local`:

```yaml
adapters:
  local:
    - adapters/internal-thing.ts
```

Then run:

```bash
npx massu adapters add-local adapters/internal-thing.ts
```

The CLI:
1. Validates the path (rejects absolute paths + parent traversal; normalizes to POSIX).
2. Appends to `massu.config.yaml > adapters.local` preserving comments.
3. Updates `~/.massu/adapters-local-fingerprint.json` so the loader
   recognizes the new entry as operator-acknowledged.

To remove:

```bash
npx massu adapters remove-local adapters/internal-thing.ts
```

If you edit `massu.config.yaml > adapters.local` directly (instead of
via the CLI), the loader will refuse to load any local adapter on the
next run — it cannot tell whether the change was operator-intentional
or a malicious postinstall script. To re-acknowledge the current state:

```bash
npx massu adapters resync-local-fingerprint
```

This is the only-supported escape hatch for "I edited the yaml directly
and I trust the result."

## Stability commitment

Every export in `@massu/core/adapter` is part of the SemVer-stable surface.
Breaking changes to `CodebaseAdapter` (renamed fields, removed methods)
require a major version bump of `@massu/core` AND adapter packages
declaring `"massu-adapter-api-version": "1"` will be refused at startup
under the new major. This is intentional — the contract change requires
adapter authors to opt-in to the new shape.

Additive changes (new optional fields on result types, new
TreeSitterLanguage enum entries) are minor-version compatible.

## Manifest sha256 round-trip — what to do when CI fails

> Plan 3c Phase 9b P-D-004 runbook excerpt.

The `tarball-e2e` CI job runs `adapter-manifest-roundtrip.test.ts` against the
live registry manifest at `https://registry.massu.ai/adapters/manifest.json`.
The test rebuilds every workspace adapter's `dist/`, computes the sha256, and
asserts it matches the manifest's `sha256` entry for that `{package, version}`
pair.

**If the round-trip fails after a workspace adapter source edit**, the
manifest must be re-signed BEFORE merge. The flow:

1. **Verify your edit is intentional.** Run `npm run build` from the repo
   root and inspect `git diff packages/adapter-<f>/dist/`. If the diff is
   non-trivial, the source change is real and needs a manifest re-sign.
2. **Bump the adapter version** in `packages/adapter-<f>/package.json` (e.g.
   `1.0.0` → `1.0.1` for a bugfix; `1.1.0` for an additive feature). Manifest
   entries are versioned, so re-signing without a version bump would break
   reproducibility for users on the prior version.
3. **Compute the new sha256** via `node packages/core/scripts/compute-adapter-shasums.mjs`
   (or equivalent) — this writes to `~/.massu/build-shasums.json`.
4. **Re-sign the manifest.** Run `bash scripts/provision/registry-publish.sh
   path/to/manifest-body.json` — reads the Ed25519 private key from macOS
   Keychain (`massu/registry/signing/private`), produces an envelope, deploys
   to Vercel.
5. **Re-run the round-trip test locally**: `MASSU_MANIFEST_ROUNDTRIP=1 npm test
   -- adapter-manifest-roundtrip` — should now PASS.
6. **Commit + open PR**. The CI gate will re-verify against the freshly-deployed
   manifest.

If CI fails on a transient registry outage (5xx, DNS, CDN cache miss), the
test SKIPs cleanly with a console.warn — does NOT fail the job. Re-run the
job to recover.

**Non-monorepo adapter authors** (third-party packages NOT under `packages/adapter-*`):
the round-trip test SKIPs your package automatically (workspace dir absent in
the monorepo). Your install-time verification chain runs against the registry
sha256 directly via `discover.ts:295-360` — that path catches the same drift
class without requiring the test.

## See also

- [`SECURITY.md`](./SECURITY.md) — signing model, key rotation, supply-chain risks
- [`@massu/core/adapter`](../src/adapter.ts) — the SDK source
- Plan 3c (internal): adapter registry + supply-chain security architecture
