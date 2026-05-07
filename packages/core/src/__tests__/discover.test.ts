/**
 * Tests for adapter discovery (Plan 3c Phase 5 5H).
 *
 * Coverage:
 * - CORE-BUNDLED ids round-trip through descriptor
 * - REGISTRY-VERIFIED scan finds @massu/adapter-* in node_modules
 * - REGISTRY-VERIFIED with manifest match → descriptor + correct version
 * - REGISTRY-VERIFIED without manifest entry → refused with warning
 * - REGISTRY-VERIFIED + manifest unavailable (offline) → refused with warning
 * - REGISTRY-VERIFIED with manifest deprecated → still loads + warning
 * - REGISTRY-VERIFIED with manifest unpublished → refused with warning
 * - LOCAL-EXPLICIT path that exists → descriptor
 * - LOCAL-EXPLICIT path that does NOT exist → warning + skipped
 * - Malformed package.json in node_modules → warning + skipped
 * - Non-adapter package in node_modules → silently ignored (no warning, no descriptor)
 * - Deduplication: same id in multiple sources is reported once
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { discoverAdapters } from '../detect/adapters/discover.js';
import { writeFingerprintSentinel } from '../security/local-fingerprint.js';
import type { Envelope } from '../security/manifest-schema.js';

/**
 * Test seam: gap-32 fingerprint check intercepts LOCAL-EXPLICIT discovery
 * unless the sentinel matches the configured paths. Tests that pass non-
 * empty configLocalPaths must also seed a matching sentinel file via
 * `seedSentinel(localPaths, fingerprintPath)`.
 */
function seedSentinel(localPaths: string[], fingerprintPath: string): void {
  writeFingerprintSentinel(localPaths, 'cli', fingerprintPath);
}

let projectRoot: string;

function makeNodeModulesPackage(
  packageName: string,
  packageJson: Record<string, unknown>,
): void {
  let dir: string;
  if (packageName.includes('/')) {
    const [scope, name] = packageName.split('/');
    dir = resolve(projectRoot, 'node_modules', scope, name);
  } else {
    dir = resolve(projectRoot, 'node_modules', packageName);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'package.json'), JSON.stringify(packageJson, null, 2), 'utf-8');
}

function manifestWithEntries(
  entries: Array<{
    package: string;
    version: string;
    deprecated?: { since: string; replacement: string | null; reason: string };
    unpublished?: boolean;
  }>,
): Envelope {
  return {
    manifest: {
      manifest_schema_version: 1,
      issued_at: '2026-05-07T00:00:00Z',
      adapters: entries.map((e) => ({
        ...e,
        sha256: 'a'.repeat(64),
        signing_key_id: 'b'.repeat(64),
      })),
    },
    manifest_b64: 'unused-in-discovery',
    signature: 'unused-in-discovery',
    manifest_sha256: 'a'.repeat(64),
    signed_at: '2026-05-07T00:00:00Z',
    signing_key_id: 'b'.repeat(64),
  } as unknown as Envelope;
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'massu-discover-'));
});

afterEach(() => {
  if (existsSync(projectRoot)) {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

describe('discoverAdapters — CORE-BUNDLED', () => {
  it('emits descriptor for each id in coreBundledIds', () => {
    const result = discoverAdapters({
      projectRoot,
      coreBundledIds: new Set(['python-fastapi', 'nextjs-trpc']),
      manifestEnvelope: undefined,
      configLocalPaths: [],
    });
    expect(result.adapters).toHaveLength(2);
    expect(result.adapters.every((a) => a.origin === 'core-bundled')).toBe(true);
    expect(result.adapters.map((a) => a.id).sort()).toEqual(['nextjs-trpc', 'python-fastapi']);
  });

  it('emits no descriptors when coreBundledIds is empty', () => {
    const result = discoverAdapters({
      projectRoot,
      coreBundledIds: new Set(),
      manifestEnvelope: undefined,
      configLocalPaths: [],
    });
    expect(result.adapters).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});

describe('discoverAdapters — REGISTRY-VERIFIED', () => {
  it('finds @massu/adapter-rails in node_modules + matches manifest', () => {
    makeNodeModulesPackage('@massu/adapter-rails', {
      name: '@massu/adapter-rails',
      version: '0.1.0',
      'massu-adapter': true,
    });
    const result = discoverAdapters({
      projectRoot,
      coreBundledIds: new Set(),
      manifestEnvelope: manifestWithEntries([{ package: '@massu/adapter-rails', version: '0.1.0' }]),
      configLocalPaths: [],
    });
    expect(result.adapters).toHaveLength(1);
    expect(result.adapters[0]).toMatchObject({
      id: '@massu/adapter-rails',
      origin: 'registry-verified',
      version: '0.1.0',
    });
  });

  it('refuses package not in manifest with actionable warning', () => {
    makeNodeModulesPackage('@massu/adapter-foo', {
      name: '@massu/adapter-foo',
      version: '0.1.0',
      'massu-adapter': true,
    });
    const result = discoverAdapters({
      projectRoot,
      coreBundledIds: new Set(),
      manifestEnvelope: manifestWithEntries([]),
      configLocalPaths: [],
    });
    expect(result.adapters).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes('@massu/adapter-foo') && w.includes('not in the signed registry manifest'))).toBe(true);
  });

  it('refuses with offline warning when manifest unavailable', () => {
    makeNodeModulesPackage('@massu/adapter-rails', {
      name: '@massu/adapter-rails',
      version: '0.1.0',
      'massu-adapter': true,
    });
    const result = discoverAdapters({
      projectRoot,
      coreBundledIds: new Set(),
      manifestEnvelope: undefined,
      configLocalPaths: [],
    });
    expect(result.adapters).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes('registry manifest unavailable'))).toBe(true);
  });

  it('warns + still loads on deprecated entry (gap-57)', () => {
    makeNodeModulesPackage('@massu/adapter-old', {
      name: '@massu/adapter-old',
      version: '0.1.0',
      'massu-adapter': true,
    });
    const result = discoverAdapters({
      projectRoot,
      coreBundledIds: new Set(),
      manifestEnvelope: manifestWithEntries([
        {
          package: '@massu/adapter-old',
          version: '0.1.0',
          deprecated: { since: '2026-05-01', replacement: '@massu/adapter-new', reason: 'fork' },
        },
      ]),
      configLocalPaths: [],
    });
    expect(result.adapters).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes('deprecated'))).toBe(true);
  });

  it('refuses on unpublished entry (gap-57)', () => {
    makeNodeModulesPackage('@massu/adapter-bad', {
      name: '@massu/adapter-bad',
      version: '0.1.0',
      'massu-adapter': true,
    });
    const result = discoverAdapters({
      projectRoot,
      coreBundledIds: new Set(),
      manifestEnvelope: manifestWithEntries([
        { package: '@massu/adapter-bad', version: '0.1.0', unpublished: true },
      ]),
      configLocalPaths: [],
    });
    expect(result.adapters).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes('unpublished'))).toBe(true);
  });

  it('finds non-@massu adapter when massu-adapter:true is declared', () => {
    makeNodeModulesPackage('community-adapter-foo', {
      name: 'community-adapter-foo',
      version: '1.0.0',
      'massu-adapter': true,
    });
    const result = discoverAdapters({
      projectRoot,
      coreBundledIds: new Set(),
      manifestEnvelope: manifestWithEntries([{ package: 'community-adapter-foo', version: '1.0.0' }]),
      configLocalPaths: [],
    });
    expect(result.adapters).toHaveLength(1);
    expect(result.adapters[0]?.id).toBe('community-adapter-foo');
  });

  it('silently ignores normal npm packages (no massu-adapter declaration)', () => {
    makeNodeModulesPackage('react', { name: 'react', version: '19.0.0' });
    makeNodeModulesPackage('@types/node', { name: '@types/node', version: '20.0.0' });
    const result = discoverAdapters({
      projectRoot,
      coreBundledIds: new Set(),
      manifestEnvelope: manifestWithEntries([]),
      configLocalPaths: [],
    });
    expect(result.adapters).toHaveLength(0);
    expect(result.warnings).toHaveLength(0); // no warning — these are simply not adapters
  });

  it('warns + skips on malformed package.json', () => {
    const dir = resolve(projectRoot, 'node_modules', '@massu', 'adapter-broken');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'package.json'), '{ invalid json', 'utf-8');
    const result = discoverAdapters({
      projectRoot,
      coreBundledIds: new Set(),
      manifestEnvelope: manifestWithEntries([]),
      configLocalPaths: [],
    });
    expect(result.adapters).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes('parse failed'))).toBe(true);
  });
});

describe('discoverAdapters — LOCAL-EXPLICIT (gap-32 fingerprint sentinel)', () => {
  it('emits descriptor for existing local file when sentinel matches', () => {
    const localPath = 'adapters/my-custom.js';
    const absPath = resolve(projectRoot, localPath);
    mkdirSync(resolve(projectRoot, 'adapters'), { recursive: true });
    writeFileSync(absPath, 'module.exports = {};', 'utf-8');
    const fingerprintPath = join(projectRoot, '.massu-fp.json');
    seedSentinel([localPath], fingerprintPath);
    const result = discoverAdapters({
      projectRoot,
      coreBundledIds: new Set(),
      manifestEnvelope: undefined,
      configLocalPaths: [localPath],
      fingerprintSentinelPath: fingerprintPath,
    });
    expect(result.adapters).toHaveLength(1);
    expect(result.adapters[0]).toMatchObject({
      id: localPath,
      origin: 'local-explicit',
    });
  });

  it('warns + skips local file that does not exist (sentinel matches)', () => {
    const fingerprintPath = join(projectRoot, '.massu-fp.json');
    seedSentinel(['adapters/missing.js'], fingerprintPath);
    const result = discoverAdapters({
      projectRoot,
      coreBundledIds: new Set(),
      manifestEnvelope: undefined,
      configLocalPaths: ['adapters/missing.js'],
      fingerprintSentinelPath: fingerprintPath,
    });
    expect(result.adapters).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes('not found'))).toBe(true);
  });

  it('refuses ALL local adapters when no sentinel exists (postinstall-poisoning defense, gap-32)', () => {
    const localPath = 'adapters/suspicious.js';
    const absPath = resolve(projectRoot, localPath);
    mkdirSync(resolve(projectRoot, 'adapters'), { recursive: true });
    writeFileSync(absPath, 'module.exports = {};', 'utf-8');
    const fingerprintPath = join(projectRoot, '.massu-fp.json'); // does NOT exist
    const result = discoverAdapters({
      projectRoot,
      coreBundledIds: new Set(),
      manifestEnvelope: undefined,
      configLocalPaths: [localPath],
      fingerprintSentinelPath: fingerprintPath,
    });
    expect(result.adapters).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes('refusing all LOCAL-EXPLICIT'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('resync-local-fingerprint'))).toBe(true);
  });

  it('refuses ALL local adapters when sentinel mismatches current paths', () => {
    const goodPath = 'adapters/good.js';
    const newPath = 'adapters/added-by-attacker.js';
    const fingerprintPath = join(projectRoot, '.massu-fp.json');
    // Sentinel records [goodPath] as acknowledged; configLocalPaths
    // includes a NEW entry not in the sentinel — drift detected, refuse.
    seedSentinel([goodPath], fingerprintPath);
    mkdirSync(resolve(projectRoot, 'adapters'), { recursive: true });
    writeFileSync(resolve(projectRoot, goodPath), '', 'utf-8');
    writeFileSync(resolve(projectRoot, newPath), '', 'utf-8');
    const result = discoverAdapters({
      projectRoot,
      coreBundledIds: new Set(),
      manifestEnvelope: undefined,
      configLocalPaths: [goodPath, newPath],
      fingerprintSentinelPath: fingerprintPath,
    });
    expect(result.adapters).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes('drift') || w.includes('refusing all LOCAL-EXPLICIT'))).toBe(true);
  });

  it('empty configLocalPaths skips fingerprint check entirely (no sentinel needed)', () => {
    // No fingerprint file, no warnings, no adapters — but the absence
    // of a sentinel does NOT produce a warning when there are no local
    // paths to verify in the first place.
    const result = discoverAdapters({
      projectRoot,
      coreBundledIds: new Set(),
      manifestEnvelope: undefined,
      configLocalPaths: [],
    });
    expect(result.adapters).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes('refusing all LOCAL-EXPLICIT'))).toBe(false);
  });
});

describe('discoverAdapters — combined sources + dedup', () => {
  it('emits all three classes when present (with seeded sentinel for LOCAL-EXPLICIT)', () => {
    makeNodeModulesPackage('@massu/adapter-rails', {
      name: '@massu/adapter-rails',
      version: '0.1.0',
      'massu-adapter': true,
    });
    mkdirSync(resolve(projectRoot, 'adapters'), { recursive: true });
    writeFileSync(resolve(projectRoot, 'adapters/local.js'), '', 'utf-8');
    const fingerprintPath = join(projectRoot, '.massu-fp.json');
    seedSentinel(['adapters/local.js'], fingerprintPath);
    const result = discoverAdapters({
      projectRoot,
      coreBundledIds: new Set(['python-fastapi']),
      manifestEnvelope: manifestWithEntries([{ package: '@massu/adapter-rails', version: '0.1.0' }]),
      configLocalPaths: ['adapters/local.js'],
      fingerprintSentinelPath: fingerprintPath,
    });
    expect(result.adapters).toHaveLength(3);
    const origins = result.adapters.map((a) => a.origin).sort();
    expect(origins).toEqual(['core-bundled', 'local-explicit', 'registry-verified']);
  });
});
