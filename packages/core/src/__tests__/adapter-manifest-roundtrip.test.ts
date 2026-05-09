// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3c Phase 9b P-D-001: drift-prevention #2 — manifest sha256 round-trip.
 *
 * For every workspace adapter listed in the registry manifest at
 * `https://registry.massu.ai/adapters/manifest.json`, this test asserts that
 * the published `dist/` sha256 matches the manifest's sha256 entry for that
 * `{package, version}` pair. If the workspace has been edited (or the
 * manifest has not been re-signed after a workspace change), the round-trip
 * fails — surfacing the drift before merge.
 *
 * Source-of-truth chain (cited):
 *   `packages/adapter-<f>/src/index.ts`        ── source of truth
 *   `packages/adapter-<f>/dist/index.js`       ── built artifact
 *   sha256OfDir(packages/adapter-<f>/dist/)    ── trust anchor
 *   `manifest.adapters[].sha256`               ── signed by Ed25519 (registry)
 *
 * Behaviour matrix:
 *   1. live manifest fetch succeeds → use it (default CI behaviour)
 *   2. MASSU_MANIFEST_OFFLINE=1     → skip fetch, use cached envelope at
 *                                       packages/core/src/__tests__/fixtures/
 *                                       manifest-offline-cache.json IF present;
 *                                       else skip the test cleanly
 *   3. fetch fails (transient outage) → cache hit if available; else SKIP
 *      with a clear console.warn (does NOT fail CI on flake — round-trip is
 *      a structural invariant, not a network probe)
 *   4. manifest.adapters empty + dist exists → PASS (no live entries to
 *      verify; first-time-publish gap window before P-C-006 deploys envelope)
 *
 * Path filter (P-D-003): the test is gated by env var
 * MASSU_MANIFEST_ROUNDTRIP=1 in CI so unrelated PRs (those not touching
 * packages/adapter-X/src or packages/core/src/security/manifest-X.ts)
 * skip cleanly. Local devs run via MASSU_MANIFEST_ROUNDTRIP=1 npm test.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// .test.ts → __tests__ → src → packages/core → packages → repo-root
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const PACKAGES_DIR = resolve(REPO_ROOT, 'packages');

const REGISTRY_MANIFEST_URL = 'https://registry.massu.ai/adapters/manifest.json';
const OFFLINE_CACHE_PATH = resolve(__dirname, 'fixtures', 'manifest-offline-cache.json');

// Tag-gated for opt-in (P-D-003 path filter equivalent for local dev).
const ENABLED = process.env.MASSU_MANIFEST_ROUNDTRIP === '1';
const OFFLINE_ONLY = process.env.MASSU_MANIFEST_OFFLINE === '1';

interface AdapterEntry {
  package: string;
  version: string;
  sha256: string;
  signing_key_id: string;
  deprecated?: unknown;
  unpublished?: boolean;
}

interface ManifestBody {
  manifest_schema_version: number;
  issued_at: string;
  adapters: AdapterEntry[];
}

interface Envelope {
  manifest: ManifestBody;
  manifest_b64: string;
  signature: string;
  manifest_sha256: string;
  signed_at: string;
  signing_key_id: string;
}

let envelope: Envelope | null = null;
let fetchSkipReason: string | null = null;

/**
 * Compute sha256 of a directory's contents, deterministically. Mirrors the
 * algorithm used by `packages/core/src/security/install-tracking.ts:sha256OfDir`
 * — sorts files by relative path, hashes file contents in that order, returns
 * the hex digest.
 */
function sha256OfDir(dir: string): string {
  const files: string[] = [];
  function walk(d: string): void {
    for (const entry of readdirSync(d).sort()) {
      const full = join(d, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile()) {
        files.push(full);
      }
    }
  }
  walk(dir);
  files.sort((a, b) => relative(dir, a).localeCompare(relative(dir, b)));
  const hash = createHash('sha256');
  for (const f of files) {
    hash.update(relative(dir, f));
    hash.update('\0');
    hash.update(readFileSync(f));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function fetchEnvelope(): Promise<{ envelope: Envelope } | { skipReason: string }> {
  if (OFFLINE_ONLY) {
    if (existsSync(OFFLINE_CACHE_PATH)) {
      try {
        const parsed = JSON.parse(readFileSync(OFFLINE_CACHE_PATH, 'utf-8')) as Envelope;
        return { envelope: parsed };
      } catch (err) {
        return {
          skipReason: `offline cache parse failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    return { skipReason: 'MASSU_MANIFEST_OFFLINE=1 + no offline cache fixture' };
  }

  try {
    const resp = await fetch(REGISTRY_MANIFEST_URL, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      return { skipReason: `registry HTTP ${resp.status}` };
    }
    const parsed = (await resp.json()) as Envelope;
    return { envelope: parsed };
  } catch (err) {
    return {
      skipReason: `fetch ${REGISTRY_MANIFEST_URL} failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

describe.skipIf(!ENABLED)('adapter manifest round-trip (P-D-001)', () => {
  beforeAll(async () => {
    const result = await fetchEnvelope();
    if ('skipReason' in result) {
      fetchSkipReason = result.skipReason;
      console.warn(`[adapter-manifest-roundtrip] SKIP: ${result.skipReason}`);
    } else {
      envelope = result.envelope;
    }
  });

  it('manifest envelope fetched (or offline cache hit)', () => {
    if (fetchSkipReason) {
      // Soft skip — registry transient outage shouldn't fail CI.
      return;
    }
    expect(envelope).not.toBeNull();
    expect(envelope!.manifest).toBeDefined();
    expect(Array.isArray(envelope!.manifest.adapters)).toBe(true);
  });

  it('every manifest.adapters entry has matching workspace dist sha256', () => {
    if (fetchSkipReason || !envelope) return;

    const adapters = envelope.manifest.adapters;
    if (adapters.length === 0) {
      // Empty list = first-publish gap window (envelope deployed pre-Stage-C
      // P-C-006). PASS — no entries to verify means no possible drift.
      console.warn(
        '[adapter-manifest-roundtrip] manifest.adapters is empty — first-publish gap window (pre-Stage-C P-C-006). Test PASSES.',
      );
      return;
    }

    for (const entry of adapters) {
      // Skip non-@massu/adapter-* packages (forward-compat for third-party).
      if (!entry.package.startsWith('@massu/adapter-')) continue;

      // Resolve workspace package dir: @massu/adapter-rails → packages/adapter-rails
      const adapterId = entry.package.replace(/^@massu\/adapter-/, '');
      const pkgDir = resolve(PACKAGES_DIR, `adapter-${adapterId}`);
      const distDir = resolve(pkgDir, 'dist');

      // Workspace dir absent ⇒ third-party adapter not in our monorepo.
      if (!existsSync(pkgDir)) continue;
      if (!existsSync(distDir)) {
        // Built artifact missing — CI must run `npm run build` before this
        // test. Soft skip with warning so local dev doesn't false-positive.
        console.warn(
          `[adapter-manifest-roundtrip] SKIP entry ${entry.package}@${entry.version}: ` +
          `${distDir} missing — run "npm run build" before this test.`,
        );
        continue;
      }

      // Verify version pin matches workspace package.json (catches the case
      // where workspace was bumped but manifest was not re-signed).
      const pkgJsonPath = resolve(pkgDir, 'package.json');
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as { version: string };
      expect(
        pkgJson.version,
        `${entry.package}: workspace pinned to ${pkgJson.version}, manifest references ${entry.version}`,
      ).toBe(entry.version);

      // Round-trip sha256 check (the structural invariant).
      const actualSha = sha256OfDir(distDir);
      expect(
        actualSha,
        `${entry.package}@${entry.version}: workspace dist sha256 ${actualSha} ≠ manifest sha256 ${entry.sha256}. ` +
        `Either (a) the workspace adapter source was edited without re-signing the manifest ` +
        `(Stage C P-C-004 → P-C-006), or (b) the build is non-deterministic. ` +
        `Run "npm run build && bash scripts/provision/registry-publish.sh" to regenerate.`,
      ).toBe(entry.sha256);
    }
  });

  it('manifest signing_key_id matches the registry pubkey id', () => {
    if (fetchSkipReason || !envelope) return;
    // Must match registry-pubkey.generated.ts:8 (sha256 prefix 3b6226d0…)
    const EXPECTED_KEY_ID =
      '3b6226d036c472e533110d11a7d0cd2773ce1d7d4f1003517d5bd69c5418ed4c';
    expect(envelope.signing_key_id).toBe(EXPECTED_KEY_ID);
  });
});
