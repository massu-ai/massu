# Security Model

> Plan 3c gap-29, gap-47, gap-54, gap-61 deliverable. Documents the
> Massu adapter trust model: signing, verification, key rotation, three
> trust classes, and the supply-chain risks the design mitigates.

## Threat model

Massu adapters run **unsandboxed** inside the host Node process. An
adapter that's compromised at install or load time can do anything the
host process can do — read environment variables, write files, make
outbound HTTP requests, etc. Sandboxing (Node `vm.Context` isolation
or worker-thread separation with a defined adapter API surface) is a
deferred 40h+ scope; for the foreseeable future, mitigations are
**signature/sha-pinning + revocation**, not isolation.

The supply-chain attack surface is the largest in the entire Plan 3
series. The defenses are layered:

1. **Three-class trust model** — every adapter classifies into exactly
   one origin (CORE-BUNDLED / REGISTRY-VERIFIED / LOCAL-EXPLICIT).
   Anything that doesn't classify refuses to load.
2. **Signed manifest** — REGISTRY-VERIFIED adapters appear in a
   per-release Ed25519-signed manifest at
   `https://registry.massu.ai/adapters/manifest.json`. The signature
   is verified against a public key bundled inside `@massu/core`.
3. **Per-package sha256** — each manifest entry pins a sha256 of the
   adapter's published tarball. Tampering with the unpacked package
   in `node_modules` is detected at load time (gap-37 follow-up).
4. **Postinstall-poisoning fingerprint** — `adapters.local` mutations
   require an operator-CLI sentinel file. A malicious postinstall script
   that mutates `massu.config.yaml > adapters.local` is detected at
   startup; the loader refuses all local adapters until the operator
   re-acknowledges via `massu adapters resync-local-fingerprint`.
5. **Strict cache schema** — cached manifest at
   `~/.massu/adapter-manifest.json` parses through Zod; corrupted or
   unknown-shape entries are dropped without disclosing why.
6. **Telemetry strictness** — the optional adapter-discovery telemetry
   (off by default) emits ONLY four allowlisted fields, enforced at
   write AND replay time by a `.strict()` Zod schema. PII keys are
   rejected at write time, never persisted.

## Three trust classes

| Class | Trust derives from | Verification path |
|---|---|---|
| **CORE-BUNDLED** | `@massu/core`'s own npm publish + `prepublish-check.sh` audit + your `npm install @massu/core` choice | Skips signature verification (this IS the trusted baseline) |
| **REGISTRY-VERIFIED** | The signed `manifest.json` at registry.massu.ai | Manifest sig + per-package sha256 + `signing_key_id` rotation drift detection |
| **LOCAL-EXPLICIT** | The operator's per-path opt-in via `adapters.local` | `~/.massu/adapters-local-fingerprint.json` sentinel must match current config + be sourced from `cli` or `cli-resync` |

The loader REFUSES to load any adapter that doesn't classify into exactly
one class. Multi-class collisions (an id matching CORE-BUNDLED and
LOCAL-EXPLICIT simultaneously) also refuse with a clear stderr warning
naming all the matching classes.

## Manifest signing

The registry manifest envelope at
`https://registry.massu.ai/adapters/manifest.json` has the following
structure:

```json
{
  "manifest":             { "manifest_schema_version": 1, "issued_at": "...", "adapters": [...] },
  "manifest_b64":         "<base64 of the EXACT bytes that were signed>",
  "signature":            "<base64 Ed25519 signature>",
  "manifest_sha256":      "<sha256 hex of manifest_b64-decoded bytes>",
  "signed_at":            "<ISO8601>",
  "signing_key_id":       "<sha256 hex of the public key>"
}
```

The `manifest_b64` field is required: it carries the byte-for-byte
input that `nacl.sign.detached(msg, priv)` was invoked over. The
verifier base64-decodes it, computes sha256, compares to
`manifest_sha256`, JSON-parses, deep-equals against `manifest`,
runs `nacl.sign.detached.verify` against the bundled public key, and
verifies that `signing_key_id == sha256(bundled-pubkey)`. Any step
failing → refuse the manifest. (The cache + the live registry both
ship the same envelope shape.)

## Adapter signing model

For v1, **a single registry signing key signs the entire manifest**,
including entries for `@massu/`-org-published adapter packages
(rails, phoenix, aspnet, spring, go-chi) AND community contributions.
The `signing_key_id` field is in the per-entry shape but always equals
the same single registry key for v1; the field is reserved for a future
federated model where individual adapter publishers countersign their
own entries (deferred to a future major version).

Implication for community contributors: a third-party developer
publishing `@your-org/adapter-foo` on npm CANNOT have their package
added to the signed manifest without the Massu maintainer's review +
signature. The PR-to-manifest flow is documented in
[`AUTHORING-ADAPTERS.md`](./AUTHORING-ADAPTERS.md) under "Submitting a
REGISTRY-VERIFIED adapter."

The maintainer (`ethankowen-73`) holds the signing key in macOS
Keychain at `massu/registry/signing/private`. A backup maintainer
documented in this file's "Succession" section below is the single-
point-of-failure mitigation.

## Key rotation

The Ed25519 keypair is rotated annually OR on suspected compromise.
Rotation procedure:

1. Generate a new keypair via `tweetnacl` (operator-only, store private
   in macOS Keychain replacing the prior entry).
2. Update `packages/core/security/registry-pubkey.{pem,b64,env}` with
   the new public key bytes in all 3 formats (PEM-wrapped, raw base64,
   env-var format).
3. Append the new RAW-bytes sha256 to `KNOWN_PUBKEY_FINGERPRINTS` in
   `scripts/bundle-pubkey.mjs` (DO NOT remove the old entry — rotation
   grace window).
4. Run `bash scripts/bundle-pubkey.mjs` to regenerate
   `packages/core/src/security/registry-pubkey.generated.ts`.
5. Sign a transition manifest **countersigned by both old AND new keys**
   so consumers running pre-rotation `@massu/core` can still verify
   under the old key during the grace window. (The Phase 5 verifier
   accepts manifests countersigned by ANY entry in the `KNOWN_PUBKEY_FINGERPRINTS`
   allowlist during the rotation grace window.)
6. Ship a new `@massu/core` minor release bundling the new pubkey;
   document the rotation in the release CHANGELOG.
7. Old-key-only verification remains accepted until the NEXT minor
   release after rotation, at which point old-key entries are removed
   from `KNOWN_PUBKEY_FINGERPRINTS`.

The cached manifest at `~/.massu/adapter-manifest.json` records the
`bundled_pubkey_fingerprint` of the @massu/core that wrote the cache.
On read, if the cache's fingerprint != currently-running @massu/core's
bundled pubkey fingerprint, the cache is treated as STALE-DUE-TO-ROTATION
and the loader forces a fresh fetch from the registry. This catches the
upgrade case where an operator runs `npm install -g @massu/core@latest`
mid-rotation and would otherwise hold a manifest signed under the old
key.

## Postinstall-poisoning defense

`adapters.local` listings bypass the registry-signed allowlist (operators
opt-in per-path). To prevent malicious npm postinstall scripts from
mutating `adapters.local` to inject attacker-controlled paths, the
loader checks a sentinel file at `~/.massu/adapters-local-fingerprint.json`:

```json
{
  "fingerprint": "<sha256 hex of canonical-stringified sorted adapters.local array>",
  "source":      "cli" | "cli-resync",
  "ts":          "<ISO8601>"
}
```

Any time the operator runs `massu adapters add-local <path>`, `massu adapters
remove-local <path>`, or `massu adapters resync-local-fingerprint`, the
sentinel is updated with `source: "cli"` (or `cli-resync`). At loader
startup, the current `massu.config.yaml > adapters.local` content's
fingerprint is compared to the sentinel:

- **Match** → proceed to load LOCAL-EXPLICIT adapters.
- **Drift OR sentinel absent** → REFUSE all LOCAL-EXPLICIT adapters
  with a stderr warning naming the divergence + pointing the operator
  at `massu adapters resync-local-fingerprint`.

A malicious postinstall script could, in principle, also mutate the
sentinel. Mitigations:

- The sentinel is mode `0o600` (owner-only). A postinstall script running
  as the same user CAN write to it, but doing so requires advance
  knowledge of the file format AND the canonical-fingerprint scheme. The
  schema is `.strict()`, so any unknown-key write is rejected at
  read time (treated as "no sentinel").
- A future hardening (gap-32 follow-up) could require a HMAC over the
  sentinel using a key only the CLI knows, but the CLI is itself
  operator-installed, so HMAC keys would need to derive from operator
  state outside the npm tree.

## Telemetry posture

Telemetry is **off by default**. Enable via:

```yaml
telemetry:
  adapters: true
```

When enabled, the adapter-discovery writer emits ONE JSONL line per
discovery event matching this schema (`.strict()` so unknown keys are
rejected):

```typescript
{
  adapter_id: string;     // canonical id (e.g. "@massu/adapter-rails")
  count:      number;     // discovery events observed in this batch
  version:    string;     // adapter version when known
  ts:         string;     // ISO8601
}
```

Specifically:

- File paths are NEVER sent.
- Symbol names are NEVER sent.
- Source code content is NEVER sent.
- Project names are NEVER sent.
- Operator identity is NEVER sent.

The transport is HTTPS POST to `https://telemetry.massu.ai/adapter-discovery`
through the same allowlisted fetcher (`packages/core/src/security/fetcher.ts`)
that the registry uses. Pending events buffer at
`~/.massu/telemetry-pending.jsonl` (mode `0o600`) when the endpoint is
unreachable, with a 1MB / 1000-entry hard cap. Replay re-validates every
entry against the same `.strict()` schema before sending; entries that
fail re-validation are dropped without sending. Disabling telemetry
mid-flight stops both new records AND any pending replay.

## Succession

The npm `@massu` org is currently owned by `ethankowen-73`. Backup
maintainer assignment (open action — required before Phase 9
publish per the canonical plan): a second account must hold
`Maintainer` role on the `@massu` org so deprecate / unpublish capability
is not single-point-of-failure on holiday or illness. Verify via
`npm org ls @massu` showing ≥2 maintainers before the next minor
release ships.

## Reporting a vulnerability

If you discover a supply-chain or signing-flow vulnerability in
`@massu/core` or any registry-listed adapter, do NOT open a public
GitHub issue. Email `security@massu.ai` with the details (mailbox
provisioning is an open action — required before Phase 9 publish
per the canonical plan). The maintainer will:

1. Acknowledge within 48h.
2. Investigate + reproduce.
3. Issue a CVE if confirmed.
4. Publish a patched `@massu/core` release with `npm deprecate` on the
   affected versions.
5. Add the affected adapter to the manifest's `unpublished: true` list
   if applicable, so all consumers refuse to load on next refresh.

## Migration: 1.5.x → 1.6.0 (workspace adapter publish)

> Plan 3c Phase 9b shipped 2026-05-09. See root `CHANGELOG.md` `[1.6.0]`.

`1.6.0` is **additive** — end-users on `1.5.x` are unaffected. No
breaking changes. No config migration. The 5 first-party AST adapters
(`rails`, `phoenix`, `aspnet`, `spring`, `go-chi`) continue to ship
CORE-BUNDLED in `@massu/core` itself; zero-config detection still works
out of the box.

What's new for users who want REGISTRY-VERIFIED trust:

```bash
npm install @massu/core@^1.6.0 @massu/adapter-rails@^1.0.0
```

After install, `npx massu adapters list` will show TWO entries for
`rails`:

- `rails` — CORE-BUNDLED (from `@massu/core`'s bundled `dist/detect/adapters/rails.js`).
- `@massu/adapter-rails` — REGISTRY-VERIFIED (from `node_modules/@massu/adapter-rails/dist/`,
  sha256-cross-checked against the signed manifest at
  `https://registry.massu.ai/adapters/manifest.json`).

The two co-exist. Discovery prefers REGISTRY-VERIFIED when present
(the standalone package opts the user into the more-verified path);
CORE-BUNDLED remains the fallback. There is no "elevation" — they are
two distinct trust-class entries.

### peerDependency note

`@massu/adapter-*@1.0.0` declares `peerDependencies: { "@massu/core": "^1.6.0" }`.
Users pinning `@massu/core@1.5.x` who install a standalone adapter will
see an npm peerDep warning (non-fatal). For cleanest UX, upgrade
`@massu/core` to `^1.6.0` before installing standalone adapters. The
adapter source is binary-identical between CORE-BUNDLED and
REGISTRY-VERIFIED — the warning is informational, not a runtime
incompatibility.

## See also

- [`AUTHORING-ADAPTERS.md`](./AUTHORING-ADAPTERS.md) — how to write a
  conformant adapter
- `packages/core/src/security/` — the verifier, fetcher, atomic-write,
  fingerprint, and cache modules implementing this model
- Plan 3c (internal): full architectural background + threat-model
  decisions
