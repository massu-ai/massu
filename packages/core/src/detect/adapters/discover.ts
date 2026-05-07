/**
 * Adapter discovery — Plan 3c Phase 5 5H deliverable.
 *
 * Scans three source classes per the three-class trust model
 * (CORE-BUNDLED + REGISTRY-VERIFIED + LOCAL-EXPLICIT, see security/
 * adapter-origin.ts), classifies each candidate, and returns the
 * deduplicated AdapterDescriptor[] the CLI + loader consume.
 *
 * Three sources scanned:
 * 1. CORE-BUNDLED: caller-provided id set (typically built from a static
 *    list of bundled adapter filenames in @massu/core itself). The
 *    discovery module does NOT enumerate the filesystem for these — that
 *    enumeration is done at @massu/core build time and shipped as a
 *    constant. Discovery just classifies the ids.
 * 2. REGISTRY-VERIFIED: walk node_modules/@massu/adapter-* directories
 *    + any node_modules/<pkg>/ where package.json declares
 *    "massu-adapter": true. Cross-reference each candidate against the
 *    cached registry manifest's adapters[] list — only entries that
 *    appear in the manifest are accepted (CR-46 Rule 0 single-source-of-
 *    truth: the registry manifest IS the authoritative allowlist).
 * 3. LOCAL-EXPLICIT: read getConfig().adapters?.local entries. Each entry
 *    is a POSIX-normalized relative path (already validated +
 *    normalized at config-parse time per AdapterLocalPathSchema in
 *    config.ts). Discovery resolves the path relative to the project
 *    root and confirms the file exists.
 *
 * The discovery surface returns warnings (not errors) for candidate-
 * classification refusals — a malformed package.json or a missing local
 * file does NOT abort the whole scan; those candidates are simply not
 * loaded, and the warning is surfaced to the CLI for operator awareness.
 *
 * What this module does NOT do (deferred to follow-up commits, all
 * in-flight Phase 5 deliverables):
 * - Install-time + load-time sha256 of installed adapter package
 *   contents (gap-37 install-tracking + tarball verification). This
 *   requires sha256 of the package's dist/ directory recursively + the
 *   ~/.massu/adapter-manifest-installed.json sidecar file.
 * - adapters.local fingerprint check (gap-32 postinstall-poisoning).
 *   This requires a sha256 of the canonical adapters.local entry list
 *   stored in ~/.massu/adapters-local-fingerprint.json.
 * - User-installed adapter scan at ~/.massu/adapters/ (CLI install
 *   path). Populated by `massu adapters install`, also Phase 5
 *   follow-up.
 *
 * Loading the actual adapter code (importing the JS module + invoking
 * detect/extract) is the loader's job (Plan 3b runner.ts). Discovery
 * just enumerates + classifies.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  getAdapterOrigin,
  type AdapterDescriptor,
  type AdapterOriginInput,
} from '../../security/adapter-origin.js';
import type { Envelope, AdapterEntry } from '../../security/manifest-schema.js';
import { checkFingerprintDrift, FINGERPRINT_PATH } from '../../security/local-fingerprint.js';
import { verifyInstalledIntegrity, INSTALLED_MANIFEST_PATH } from '../../security/install-tracking.js';

/**
 * Minimal shape of a node_modules package.json that we care about for
 * adapter discovery. Strict enough to reject malformed packages at parse
 * time, loose enough (passthrough) to ignore unrelated keys.
 */
const AdapterPackageJsonSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  // Plan 3c gap-31 + gap-50: `"massu-adapter": true` is the explicit opt-in
  // marker. @massu/adapter-* packages also declare this.
  'massu-adapter': z.union([z.boolean(), z.literal(undefined)]).optional(),
  // Plan 3c gap-31: api version. Loader refuses incompatible major (caller-side).
  'massu-adapter-api-version': z.union([z.string(), z.number(), z.literal(undefined)]).optional(),
}).passthrough();

export interface DiscoverOptions {
  /**
   * Absolute path to the project root where node_modules/ lives. Caller
   * passes from getProjectRoot() or equivalent.
   */
  projectRoot: string;
  /**
   * Set of adapter ids that are CORE-BUNDLED in @massu/core itself.
   * Built from a static const at @massu/core build time. Pass an empty
   * set in tests when not exercising CORE-BUNDLED classification.
   */
  coreBundledIds: ReadonlySet<string>;
  /**
   * The verified registry manifest envelope (from manifest-cache.getManifest).
   * Discovery uses envelope.manifest.adapters[] as the REGISTRY-VERIFIED
   * allowlist. Pass undefined if running offline + cache absent — discovery
   * will then refuse all REGISTRY-VERIFIED candidates with a clear warning.
   */
  manifestEnvelope: Envelope | undefined;
  /**
   * POSIX-normalized relative paths from getConfig().adapters?.local.
   * Each entry must already pass AdapterLocalPathSchema (config.ts). Pass
   * empty array if no local adapters configured.
   */
  configLocalPaths: ReadonlyArray<string>;
  /**
   * Override the on-disk fingerprint sentinel path for testing
   * (gap-32 postinstall-poisoning check). Production callsite uses
   * the default `~/.massu/adapters-local-fingerprint.json`.
   */
  fingerprintSentinelPath?: string;
  /**
   * Override the on-disk install-tracking sidecar path for testing
   * (gap-37 install-time + load-time sha256 check). Production callsite
   * uses the default `~/.massu/adapter-manifest-installed.json`.
   */
  installedManifestPath?: string;
  /**
   * Skip the gap-37 load-time sha256 integrity check. Default: false
   * (always check). Setting this to `true` is a test seam ONLY — it
   * exists so unit tests that don't materialize real package directories
   * can still exercise the classification logic. Production callsites
   * MUST NOT pass `true`; per CR-46 this is the most-robust posture.
   */
  skipInstalledIntegrityCheck?: boolean;
}

export interface DiscoveryResult {
  adapters: AdapterDescriptor[];
  warnings: string[];
}

/**
 * Walk node_modules for @massu/adapter-* directories AND any other package
 * declaring "massu-adapter": true. Returns the parsed package.json and
 * absolute package directory for each candidate. Skips malformed packages
 * with a warning.
 *
 * Walks ONLY one level of node_modules — does NOT descend into nested
 * node_modules (transitive deps' adapter packages). Adapters are operator-
 * installed top-level dependencies, not transitive.
 */
function walkNodeModules(projectRoot: string, warnings: string[]): Array<{
  packageDir: string;
  pkg: z.infer<typeof AdapterPackageJsonSchema>;
}> {
  const nodeModulesDir = resolve(projectRoot, 'node_modules');
  if (!existsSync(nodeModulesDir)) {
    return [];
  }
  const candidates: Array<{ packageDir: string; pkg: z.infer<typeof AdapterPackageJsonSchema> }> = [];
  let topLevelEntries: string[];
  try {
    topLevelEntries = readdirSync(nodeModulesDir);
  } catch (err) {
    warnings.push(`failed to read node_modules: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  for (const entry of topLevelEntries) {
    if (entry.startsWith('.')) continue;
    const entryPath = resolve(nodeModulesDir, entry);
    let entryStat;
    try {
      entryStat = statSync(entryPath);
    } catch {
      continue;
    }
    if (!entryStat.isDirectory()) continue;

    if (entry.startsWith('@')) {
      // Scoped namespace — e.g., node_modules/@massu/. Walk one more level.
      let scopedEntries: string[];
      try {
        scopedEntries = readdirSync(entryPath);
      } catch {
        continue;
      }
      for (const sub of scopedEntries) {
        const subPath = resolve(entryPath, sub);
        const result = tryReadAdapterPackage(subPath, warnings);
        if (result) candidates.push(result);
      }
    } else {
      const result = tryReadAdapterPackage(entryPath, warnings);
      if (result) candidates.push(result);
    }
  }
  return candidates;
}

function tryReadAdapterPackage(packageDir: string, warnings: string[]): {
  packageDir: string;
  pkg: z.infer<typeof AdapterPackageJsonSchema>;
} | null {
  const pkgJsonPath = resolve(packageDir, 'package.json');
  if (!existsSync(pkgJsonPath)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
  } catch (err) {
    warnings.push(
      `skipping ${packageDir}: package.json parse failed (${err instanceof Error ? err.message : String(err)})`,
    );
    return null;
  }
  const parsed = AdapterPackageJsonSchema.safeParse(raw);
  if (!parsed.success) {
    warnings.push(`skipping ${packageDir}: package.json shape invalid`);
    return null;
  }
  const pkg = parsed.data;

  // Filter: only consider candidates that EITHER match @massu/adapter-*
  // glob OR declare "massu-adapter": true. Other npm packages are ignored
  // (vast majority of node_modules entries).
  const isMassuAdapterGlob = /^@massu\/adapter-[a-z][a-z0-9-]*$/.test(pkg.name);
  const declaresMassuAdapter = pkg['massu-adapter'] === true;
  if (!isMassuAdapterGlob && !declaresMassuAdapter) {
    return null;
  }
  return { packageDir, pkg };
}

/**
 * Run discovery across all three trust classes. Returns the combined
 * descriptor list + a list of human-readable warnings the CLI prints.
 */
export function discoverAdapters(opts: DiscoverOptions): DiscoveryResult {
  const warnings: string[] = [];
  const adapters: AdapterDescriptor[] = [];
  const seenIds = new Set<string>();

  // 1. CORE-BUNDLED — pass-through. Each id in coreBundledIds becomes a
  // descriptor with origin='core-bundled'. No verification needed (trust
  // derives from @massu/core itself).
  for (const id of opts.coreBundledIds) {
    const origin = getAdapterOrigin({ id, coreBundledIds: opts.coreBundledIds });
    if (origin !== 'core-bundled') {
      // This shouldn't happen — coreBundledIds + getAdapterOrigin is a
      // closed loop. If it does, it's a programmer bug worth surfacing.
      warnings.push(`expected core-bundled classification for id=${id}, got ${origin ?? 'null'}`);
      continue;
    }
    adapters.push({ id, origin: 'core-bundled' });
    seenIds.add(id);
  }

  // 2. REGISTRY-VERIFIED — walk node_modules. For each candidate, look
  // up the manifest entry; refuse if not in the allowlist.
  const manifestEntries = opts.manifestEnvelope?.manifest.adapters ?? [];
  const manifestByName = new Map<string, AdapterEntry>(
    manifestEntries.map((e) => [e.package, e]),
  );
  const npmCandidates = walkNodeModules(opts.projectRoot, warnings);
  for (const { packageDir, pkg } of npmCandidates) {
    if (seenIds.has(pkg.name)) continue;
    const manifestEntry = manifestByName.get(pkg.name);
    if (!manifestEntry) {
      if (!opts.manifestEnvelope) {
        warnings.push(
          `cannot verify ${pkg.name}@${pkg.version}: registry manifest unavailable. ` +
          `Refusing to load. Run \`massu adapters refresh\` when online.`,
        );
      } else {
        warnings.push(
          `refusing ${pkg.name}@${pkg.version}: not in the signed registry manifest. ` +
          `If you authored this adapter, submit a PR to the registry per AUTHORING-ADAPTERS.md.`,
        );
      }
      continue;
    }
    if (manifestEntry.unpublished === true) {
      warnings.push(
        `refusing ${pkg.name}@${pkg.version}: registry marks this package as unpublished. ` +
        `Remove via: npm uninstall ${pkg.name}`,
      );
      continue;
    }
    if (manifestEntry.deprecated) {
      warnings.push(
        `${pkg.name}@${pkg.version} is deprecated since ${manifestEntry.deprecated.since}: ` +
        `${manifestEntry.deprecated.reason}. Replacement: ${manifestEntry.deprecated.replacement ?? '(none listed)'}.`,
      );
      // Adapter still loads despite deprecation — gap-57.
    }
    if (manifestEntry.version !== pkg.version) {
      warnings.push(
        `${pkg.name}@${pkg.version} version mismatch with manifest entry ${manifestEntry.version}. ` +
        `Loading the installed version; the gap-37 sha256 integrity check below will catch tampering.`,
      );
    }

    // gap-37 LOAD-time integrity check: re-compute sha256OfDir on the
    // installed package and compare to the install-time hash recorded in
    // ~/.massu/adapter-manifest-installed.json. Missing sidecar entry →
    // refuse (operator must run `massu adapters install <pkg>`); drift →
    // refuse (post-install tampering). Caller can suppress for tests via
    // skipInstalledIntegrityCheck=true.
    if (!opts.skipInstalledIntegrityCheck) {
      const integrity = verifyInstalledIntegrity(
        pkg.name,
        packageDir,
        opts.installedManifestPath ?? INSTALLED_MANIFEST_PATH,
      );
      if (integrity.kind !== 'ok') {
        warnings.push(`refusing ${pkg.name}@${pkg.version}: ${integrity.reason}`);
        continue;
      }
    }

    const origin = getAdapterOrigin({
      id: pkg.name,
      coreBundledIds: opts.coreBundledIds,
      npmPackage: { name: pkg.name, version: pkg.version, massuAdapter: pkg['massu-adapter'] === true },
    });
    if (origin !== 'registry-verified') {
      warnings.push(`expected registry-verified classification for ${pkg.name}, got ${origin ?? 'null'}`);
      continue;
    }
    adapters.push({
      id: pkg.name,
      origin: 'registry-verified',
      version: pkg.version,
      packageDir,
    });
    seenIds.add(pkg.name);
  }

  // 3. LOCAL-EXPLICIT — read configLocalPaths. Each entry is already POSIX-
  // normalized + path-validated by AdapterLocalPathSchema (config.ts).
  //
  // Plan 3c gap-32 postinstall-poisoning defense: BEFORE classifying any
  // local adapter, check the fingerprint sentinel. If the current
  // adapters.local content's fingerprint does NOT match the last
  // operator-acknowledged sentinel, REFUSE to load any local adapter and
  // surface the drift in warnings. The operator must run
  // `massu adapters resync-local-fingerprint` (or add-local/remove-local)
  // to re-acknowledge before discovery accepts local adapters again.
  const fingerprintCheck = opts.configLocalPaths.length === 0
    ? { kind: 'match' as const }
    : checkFingerprintDrift(opts.configLocalPaths, opts.fingerprintSentinelPath ?? FINGERPRINT_PATH);
  if (fingerprintCheck.kind !== 'match') {
    if (opts.configLocalPaths.length > 0) {
      warnings.push(
        `refusing all LOCAL-EXPLICIT adapters: ${fingerprintCheck.reason}`,
      );
    }
    // Skip the LOCAL-EXPLICIT loop entirely.
    return { adapters, warnings };
  }
  const localSet = new Set(opts.configLocalPaths);
  for (const localPath of opts.configLocalPaths) {
    if (seenIds.has(localPath)) continue;
    const absPath = isAbsolute(localPath) ? localPath : resolve(opts.projectRoot, localPath);
    if (!existsSync(absPath)) {
      warnings.push(
        `local adapter file not found: ${localPath} (resolved to ${absPath}). ` +
        `Remove via: massu adapters remove-local ${localPath}`,
      );
      continue;
    }
    const origin = getAdapterOrigin({
      id: localPath,
      coreBundledIds: opts.coreBundledIds,
      configLocalPaths: localSet,
    });
    if (origin !== 'local-explicit') {
      warnings.push(`expected local-explicit classification for ${localPath}, got ${origin ?? 'null'}`);
      continue;
    }
    adapters.push({
      id: localPath,
      origin: 'local-explicit',
    });
    seenIds.add(localPath);
  }

  return { adapters, warnings };
}
