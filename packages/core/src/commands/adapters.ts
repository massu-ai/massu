/**
 * `npx massu adapters <subcommand>` — Plan 3c Phase 5 5I-J.
 *
 * Sub-dispatcher mirroring `cli.ts:handleConfigSubcommand`. Each subcommand
 * returns `{ exitCode }` so the dispatcher in cli.ts calls process.exit(N)
 * (per VR-LIBRARY-NO-PROCESS-EXIT — library throws / returns; CLI exits).
 *
 * Subcommands shipped in this commit (read-only operational):
 *   - list                      Show all discovered adapters + their origin class
 *   - refresh [--force --check] Refresh the cached registry manifest (gap-55 UX)
 *   - search <query>            List manifest entries matching a substring
 *   - --help / -h               Print this list
 *
 * Subcommands deliberately scoped to the next Phase 5 commits (still in-flight
 * Phase 5 work, NOT deferred-ideas):
 *   - add-local / remove-local / resync-local-fingerprint
 *     (these need security/local-fingerprint.ts gap-32 mechanism)
 *   - install / resign
 *     (these need security/install-tracking.ts gap-37 install-time sha256
 *      sidecar + npm walk integration)
 *
 * Each unshipped subcommand returns exit code 64 (EX_USAGE per BSD sysexits)
 * with stderr explaining which Phase 5 follow-up commit will land it. This
 * is honest "not yet implemented in this @massu/core release" UX, not a
 * silent stub.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { getConfig, getProjectRoot, resetConfig, AdapterLocalPathSchema } from '../config.js';
import { getManifest } from '../security/manifest-cache.js';
import { discoverAdapters } from '../detect/adapters/discover.js';
import { CORE_BUNDLED_IDS } from '../detect/adapters/index.js';
import { writeFingerprintSentinel } from '../security/local-fingerprint.js';
import { atomicWrite } from '../security/atomic-write.js';
import { withFileLockSync } from '../lib/fileLock.js';
import {
  sha256OfDir,
  readInstalledManifest,
  writeInstalledManifestEntry,
  removeInstalledManifestEntry,
  containsHiddenDirs,
  type InstallEntry,
} from '../security/install-tracking.js';
import type { AdapterDescriptor } from '../security/adapter-origin.js';
import type { Envelope } from '../security/manifest-schema.js';

export interface AdaptersResult {
  exitCode: number;
}

/**
 * Top-level sub-dispatcher. cli.ts:case 'adapters' delegates here with
 * args.slice(1) (everything after the `adapters` token).
 */
export async function handleAdaptersSubcommand(args: string[]): Promise<AdaptersResult> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'list':
      return runAdaptersList(rest);
    case 'refresh':
      return runAdaptersRefresh(rest);
    case 'search':
      return runAdaptersSearch(rest);
    case 'add-local':
      return runAdaptersAddLocal(rest);
    case 'remove-local':
      return runAdaptersRemoveLocal(rest);
    case 'resync-local-fingerprint':
      return runAdaptersResyncLocalFingerprint(rest);
    case 'install':
      return runAdaptersInstall(rest);
    case 'resign':
      return runAdaptersResign(rest);
    case '--help':
    case '-h':
    case undefined:
      printAdaptersHelp();
      return { exitCode: 0 };
    default:
      process.stderr.write(`massu adapters: unknown subcommand: ${sub}\n`);
      printAdaptersHelp();
      return { exitCode: 1 };
  }
}

function notYetImplemented(sub: string, reason: string): AdaptersResult {
  process.stderr.write(
    `massu adapters ${sub}: not yet implemented in this @massu/core release.\n` +
    `  Reason: requires ${reason}.\n` +
    `  Track via the Plan 3c Phase 5 gap referenced in the reason text;\n` +
    `  ships in the next @massu/core minor release.\n`,
  );
  return { exitCode: 64 }; // EX_USAGE per BSD sysexits.h
}

/**
 * `npx massu adapters list` — show all discovered adapters + origin + version.
 *
 * Behavior:
 * - Loads getConfig() + getManifest() (cache-fresh fast path; falls back to
 *   refresh on stale/expired/rotation-detected).
 * - Runs discoverAdapters across all three trust classes.
 * - Renders a single tab-separated table to stdout.
 * - Prints any warnings to stderr.
 * - Exits 0 on any successful classification (even if some candidates were
 *   refused with warnings); exits 2 if discovery itself fails (e.g. project
 *   root not found).
 */
export async function runAdaptersList(_args: string[]): Promise<AdaptersResult> {
  let projectRoot: string;
  try {
    projectRoot = getProjectRoot();
  } catch (err) {
    process.stderr.write(
      `adapters list: cannot resolve project root: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return { exitCode: 2 };
  }

  const config = getConfig();
  const localPaths = config.adapters?.local ?? [];
  const adaptersEnabled = config.adapters?.enabled === true;

  // Best-effort: try to load the manifest. If unreachable, discovery still
  // runs but REGISTRY-VERIFIED candidates will be refused with a clear
  // "registry manifest unavailable" warning per the discovery module.
  let manifestEnvelope: Envelope | undefined;
  const manifestResult = await getManifest();
  if (manifestResult.kind === 'ok') {
    manifestEnvelope = manifestResult.envelope;
    for (const w of manifestResult.warnings) {
      process.stderr.write(`[manifest] ${w}\n`);
    }
    if (manifestResult.source === 'cache-stale' && manifestResult.staleReason) {
      process.stderr.write(`[manifest] cache-stale: ${manifestResult.staleReason}\n`);
    }
  } else {
    for (const r of manifestResult.reasons) {
      process.stderr.write(`[manifest] ${r}\n`);
    }
  }

  const { adapters, warnings } = discoverAdapters({
    projectRoot,
    coreBundledIds: CORE_BUNDLED_IDS,
    manifestEnvelope,
    configLocalPaths: localPaths,
    adaptersEnabled,
  });

  for (const w of warnings) {
    process.stderr.write(`[discover] ${w}\n`);
  }

  renderAdapterTable(adapters);
  return { exitCode: 0 };
}

function renderAdapterTable(adapters: AdapterDescriptor[]): void {
  if (adapters.length === 0) {
    process.stdout.write('No adapters discovered.\n');
    process.stdout.write('  - CORE-BUNDLED:    @massu/core ships first-party adapters; check massu.config.yaml.framework.\n');
    process.stdout.write('  - REGISTRY-VERIFIED: install via `npm install @massu/adapter-<name>` then `massu adapters install <name>`.\n');
    process.stdout.write('  - LOCAL-EXPLICIT:    add via `massu adapters add-local <path>`.\n');
    return;
  }
  // Header
  process.stdout.write(['ID', 'ORIGIN', 'VERSION', 'PACKAGE_DIR'].join('\t') + '\n');
  for (const a of adapters) {
    const row = [a.id, a.origin, a.version ?? '-', a.packageDir ?? '-'];
    process.stdout.write(row.join('\t') + '\n');
  }
}

/**
 * `npx massu adapters refresh [--force] [--check]` — re-fetch manifest from
 * registry.massu.ai. Plan 3c gap-55 UX semantics:
 *   exit 0 = refreshed (or cache was current and --force not passed)
 *   exit 1 = signature mismatch / verification failed
 *   exit 2 = network unreachable
 *   exit 3 = cache write failure
 *   exit 4 = pubkey rotation desync detected (gap-54 path)
 *
 * Flags:
 *   --force  Force refresh even when cache <24h old.
 *   --check  Dry-run: print what would happen, don't write.
 */
export async function runAdaptersRefresh(args: string[]): Promise<AdaptersResult> {
  const flags = new Set(args);
  const force = flags.has('--force');
  const check = flags.has('--check');

  process.stderr.write('Refreshing adapter manifest from registry.massu.ai...\n');

  if (check) {
    // Dry-run: load cache, report state, exit without write.
    const result = await getManifest({ force: false });
    if (result.kind === 'ok') {
      process.stderr.write(
        `[--check] cache state: ${result.source}; ` +
        `would ${result.source === 'cache-fresh' ? 'NOT ' : ''}refresh.\n`,
      );
      return { exitCode: 0 };
    }
    process.stderr.write(`[--check] cache absent / stale; would refresh. Reasons: ${result.reasons.join('; ')}\n`);
    return { exitCode: 0 };
  }

  const result = await getManifest({ force });
  if (result.kind === 'ok' && result.source === 'refreshed') {
    process.stderr.write(
      `Refreshed: ${result.envelope.manifest.adapters.length} adapter entries from registry.\n`,
    );
    return { exitCode: 0 };
  }
  if (result.kind === 'ok' && result.source === 'cache-fresh' && !force) {
    process.stderr.write('Cache is fresh (< 24h); skipping refresh. Use --force to override.\n');
    return { exitCode: 0 };
  }
  if (result.kind === 'ok' && result.source === 'cache-stale') {
    process.stderr.write(
      `Refresh failed; existing cache retained. Reason: ${result.staleReason ?? 'unknown'}\n`,
    );
    return { exitCode: 2 };
  }
  if (result.kind === 'fail') {
    const reasonText = result.reasons.join('; ');
    if (/signature/i.test(reasonText) || /verify/i.test(reasonText)) {
      process.stderr.write(`Refresh aborted: signature verification failed: ${reasonText}\n`);
      return { exitCode: 1 };
    }
    if (/rotation/i.test(reasonText)) {
      process.stderr.write(
        `Refresh aborted: pubkey rotation desync. Upgrade @massu/core to a release ` +
        `bundling the current registry pubkey, then retry. Detail: ${reasonText}\n`,
      );
      return { exitCode: 4 };
    }
    if (/cache.*write|write.*cache|atomicWrite/i.test(reasonText)) {
      process.stderr.write(`Refresh failed: cache write error: ${reasonText}\n`);
      return { exitCode: 3 };
    }
    process.stderr.write(`Refresh failed: ${reasonText}\n`);
    return { exitCode: 2 };
  }

  return { exitCode: 0 };
}

/**
 * `npx massu adapters search <query>` — list manifest entries matching the
 * query (substring match, case-insensitive on package name). Useful for
 * operators discovering what's available before running `massu adapters install`.
 */
export async function runAdaptersSearch(args: string[]): Promise<AdaptersResult> {
  const query = args[0];
  if (!query) {
    process.stderr.write('Usage: massu adapters search <query>\n');
    return { exitCode: 1 };
  }
  const result = await getManifest();
  if (result.kind !== 'ok') {
    process.stderr.write(`Cannot search: registry manifest unavailable. ${result.reasons.join('; ')}\n`);
    return { exitCode: 2 };
  }
  const needle = query.toLowerCase();
  const matches = result.envelope.manifest.adapters.filter((e) =>
    e.package.toLowerCase().includes(needle),
  );
  if (matches.length === 0) {
    process.stdout.write(`No adapters matching '${query}'.\n`);
    return { exitCode: 0 };
  }
  process.stdout.write(['PACKAGE', 'VERSION', 'STATUS'].join('\t') + '\n');
  for (const m of matches) {
    let status = 'available';
    if (m.unpublished) status = 'unpublished (REFUSE)';
    else if (m.deprecated) status = `deprecated (since ${m.deprecated.since})`;
    process.stdout.write([m.package, m.version, status].join('\t') + '\n');
  }
  return { exitCode: 0 };
}

/**
 * `npx massu adapters add-local <path>` (Plan 3c gap-32 + gap-58).
 *
 * Validates <path> through AdapterLocalPathSchema (rejects absolute,
 * rejects parent-traversal, normalizes to POSIX). Reads massu.config.yaml,
 * appends the normalized path to adapters.local, writes the file back
 * preserving comments via yaml.parseDocument, and updates the
 * fingerprint sentinel with source="cli".
 *
 * Exit codes:
 *   0 = added; 1 = bad usage / invalid path; 2 = config / fs error
 */
export async function runAdaptersAddLocal(args: string[]): Promise<AdaptersResult> {
  const userPath = args[0];
  if (!userPath) {
    process.stderr.write('Usage: massu adapters add-local <path>\n');
    return { exitCode: 1 };
  }
  const validated = AdapterLocalPathSchema.safeParse(userPath);
  if (!validated.success) {
    const issues = validated.error.issues.map((i) => i.message).join('; ');
    process.stderr.write(`add-local refused: ${issues}\n`);
    return { exitCode: 1 };
  }
  const normalizedPath = validated.data;

  return mutateLocalArray((current) => {
    if (current.includes(normalizedPath)) {
      process.stderr.write(`adapters.local already contains '${normalizedPath}'; nothing to do.\n`);
      return null; // signal no-op
    }
    return [...current, normalizedPath];
  }, 'add-local');
}

/**
 * `npx massu adapters remove-local <path>` — remove from adapters.local
 * + update fingerprint sentinel.
 */
export async function runAdaptersRemoveLocal(args: string[]): Promise<AdaptersResult> {
  const userPath = args[0];
  if (!userPath) {
    process.stderr.write('Usage: massu adapters remove-local <path>\n');
    return { exitCode: 1 };
  }
  // Run the user input through the same normalization so 'adapters\foo.js'
  // input matches a stored 'adapters/foo.js' entry.
  const validated = AdapterLocalPathSchema.safeParse(userPath);
  if (!validated.success) {
    process.stderr.write(`remove-local: path is malformed; nothing matches.\n`);
    return { exitCode: 1 };
  }
  const normalizedPath = validated.data;

  return mutateLocalArray((current) => {
    if (!current.includes(normalizedPath)) {
      process.stderr.write(`adapters.local does not contain '${normalizedPath}'; nothing to do.\n`);
      return null;
    }
    return current.filter((p) => p !== normalizedPath);
  }, 'remove-local');
}

/**
 * `npx massu adapters resync-local-fingerprint` — operator escape hatch
 * to acknowledge an out-of-band edit to adapters.local. Recomputes the
 * fingerprint over whatever the current config says + writes the
 * sentinel with source='cli-resync'. Use after manually editing
 * massu.config.yaml.
 *
 * Does NOT touch the yaml — only the sentinel. The intent is "I edited
 * the yaml directly + I trust the result; please stop refusing my local
 * adapters."
 */
export async function runAdaptersResyncLocalFingerprint(_args: string[]): Promise<AdaptersResult> {
  resetConfig();
  let cfg;
  let projectRoot: string;
  try {
    projectRoot = getProjectRoot();
    cfg = getConfig();
  } catch (err) {
    process.stderr.write(`resync-local-fingerprint: config invalid: ${err instanceof Error ? err.message : String(err)}\n`);
    return { exitCode: 2 };
  }
  const localPaths = cfg.adapters?.local ?? [];
  const result = writeFingerprintSentinel(localPaths, 'cli-resync', projectRoot);
  if (!result.written) {
    process.stderr.write(`resync-local-fingerprint: sentinel write failed: ${result.error}\n`);
    return { exitCode: 2 };
  }
  process.stderr.write(
    `Sentinel updated: ${localPaths.length} local adapter(s) acknowledged.\n`,
  );
  return { exitCode: 0 };
}

/**
 * Shared yaml-mutation logic for add-local / remove-local. The mutator
 * callback receives the current adapters.local array and returns either
 * the new array OR null to signal "no-op" (e.g. trying to add a duplicate
 * or remove a non-existent entry).
 */
function mutateLocalArray(
  mutator: (current: string[]) => string[] | null,
  command: 'add-local' | 'remove-local',
): AdaptersResult {
  let projectRoot: string;
  try {
    projectRoot = getProjectRoot();
  } catch (err) {
    process.stderr.write(
      `${command}: cannot resolve project root: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return { exitCode: 2 };
  }
  const yamlPath = resolve(projectRoot, 'massu.config.yaml');
  if (!existsSync(yamlPath)) {
    process.stderr.write(
      `${command}: massu.config.yaml not found at ${yamlPath}. Run \`massu init\` first.\n`,
    );
    return { exitCode: 2 };
  }
  let yamlText: string;
  try {
    yamlText = readFileSync(yamlPath, 'utf-8');
  } catch (err) {
    process.stderr.write(`${command}: failed to read ${yamlPath}: ${err instanceof Error ? err.message : String(err)}\n`);
    return { exitCode: 2 };
  }
  const doc = parseDocument(yamlText);

  // Read current adapters.local. yaml-Document's toJS on a node returns the
  // plain JS value; we use this to feed the mutator.
  const currentNode = doc.getIn(['adapters', 'local']) as { toJSON?: () => unknown } | unknown[] | undefined;
  let current: string[] = [];
  if (Array.isArray(currentNode)) {
    current = currentNode.filter((x): x is string => typeof x === 'string');
  } else if (currentNode && typeof currentNode === 'object' && 'toJSON' in currentNode && typeof currentNode.toJSON === 'function') {
    const jsArr = currentNode.toJSON() as unknown;
    if (Array.isArray(jsArr)) {
      current = jsArr.filter((x): x is string => typeof x === 'string');
    }
  }

  const next = mutator(current);
  if (next === null) {
    // Mutator decided no-op; sentinel stays in sync because nothing changed.
    return { exitCode: 0 };
  }

  // iter-2 MED-NEW-3 fix: wrap the yaml-write + getConfig-revalidate +
  // fingerprint-sentinel-write in a single file lock. Without it, a
  // concurrent same-user process could swap a local adapter file
  // between `doc.setIn` (yaml mutation) and `writeFingerprintSentinel`
  // (which reads the file content for hashing) — locking in attacker-
  // controlled content as the operator-acked baseline. The lock is on
  // the project's `.massu/adapters-local-mutate.lock` which is per-
  // project, NOT per-user, so multiple operator-launched massu CLI
  // processes against the same project serialize on this lock.
  const lockPath = resolve(projectRoot, '.massu', 'adapters-local-mutate.lock');
  return withFileLockSync(lockPath, () => {
    // Write back the mutated array. doc.setIn auto-creates intermediate
    // nodes (adapters: {} → adapters: { local: [...] }) when they don't exist.
    doc.setIn(['adapters', 'local'], next);
    const newYaml = doc.toString();
    const writeResult = atomicWrite(yamlPath, newYaml);
    if (!writeResult.written) {
      process.stderr.write(`${command}: yaml write failed: ${writeResult.error}\n`);
      return { exitCode: 2 };
    }

    // Re-parse via getConfig() to validate the mutated yaml against the
    // full schema (catches malformations the partial parsing might have missed).
    resetConfig();
    try {
      getConfig();
    } catch (err) {
      process.stderr.write(
        `${command}: yaml mutation produced invalid config: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return { exitCode: 2 };
    }

    // Update fingerprint sentinel — source='cli' marks this as an
    // operator-acknowledged change so the loader's gap-32 check passes.
    const fpResult = writeFingerprintSentinel(next, 'cli', projectRoot);
    if (!fpResult.written) {
      process.stderr.write(
        `${command}: yaml updated but sentinel write failed: ${fpResult.error}. ` +
        `Run \`massu adapters resync-local-fingerprint\` to retry.\n`,
      );
      return { exitCode: 2 };
    }

    process.stderr.write(`${command}: success — adapters.local now has ${next.length} entry(ies).\n`);
    return { exitCode: 0 };
  });
}

/**
 * `npx massu adapters install <package>` (Plan 3c gap-37).
 *
 * Operator workflow:
 *   $ npm install @massu/adapter-rails
 *   $ npx massu adapters install @massu/adapter-rails
 *
 * The npm install step is the operator's responsibility; this command
 * registers the freshly-installed package in the install-tracking
 * sidecar so the loader's load-time integrity check (verifyInstalledIntegrity
 * in discover.ts) accepts it on next startup. Concretely:
 *
 * 1. Look up <package> in the cached registry manifest. Refuse if not
 *    found OR unpublished.
 * 2. Locate the package in node_modules at the project root.
 * 3. Compute sha256OfDir of the package directory (content-addressed,
 *    stable across machines).
 * 4. Compare to the manifest entry's sha256. Refuse on mismatch
 *    (tampering OR wrong-version-installed condition).
 * 5. Write the install entry to ~/.massu/adapter-manifest-installed.json.
 *
 * Exit codes:
 *   0 = registered; 1 = bad usage / package not in manifest / not installed;
 *   2 = sha mismatch (tampering or wrong version); 3 = sidecar write failed
 */
/**
 * CR-9 audit H4 fix: validate package name against npm's strict naming
 * spec BEFORE using it as path segments OR writing to stderr. Rejects:
 *   - control characters (would log-inject if echoed to stderr)
 *   - path traversal segments (.., absolute paths, embedded slashes
 *     beyond the single scope/name boundary)
 *   - non-npm-spec characters
 */
const NPM_PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

function validatePackageName(name: string): { ok: true; name: string } | { ok: false; reason: string } {
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, reason: 'package name is empty' };
  }
  // Reject control characters explicitly — npm name regex below also
  // does this implicitly, but a more specific message helps operators.
  if (/[\x00-\x1f\x7f]/.test(name)) {
    return { ok: false, reason: 'package name contains control characters' };
  }
  if (!NPM_PACKAGE_NAME_RE.test(name)) {
    return {
      ok: false,
      reason:
        `package name '${name}' does not match npm spec ` +
        `(^(@scope/)?name$ where each component matches [a-z0-9][a-z0-9._-]*). ` +
        `Refusing to use as path segment.`,
    };
  }
  return { ok: true, name };
}

export async function runAdaptersInstall(args: string[]): Promise<AdaptersResult> {
  const packageNameRaw = args[0];
  if (!packageNameRaw) {
    process.stderr.write('Usage: massu adapters install <package-name>\n');
    return { exitCode: 1 };
  }
  const validated = validatePackageName(packageNameRaw);
  if (!validated.ok) {
    process.stderr.write(`install refused: ${validated.reason}\n`);
    return { exitCode: 1 };
  }
  const packageName = validated.name;

  let projectRoot: string;
  try {
    projectRoot = getProjectRoot();
  } catch (err) {
    process.stderr.write(`install: cannot resolve project root: ${err instanceof Error ? err.message : String(err)}\n`);
    return { exitCode: 1 };
  }

  // Locate the package in node_modules. Handles scoped names like
  // @massu/adapter-rails by joining at the path level.
  const packageDir = resolve(projectRoot, 'node_modules', ...packageName.split('/'));
  if (!existsSync(packageDir)) {
    process.stderr.write(
      `install: ${packageName} is not installed in node_modules. Run \`npm install ${packageName}\` first.\n`,
    );
    return { exitCode: 1 };
  }

  // Read the package's own version + verify the package looks like an adapter.
  const pkgJsonPath = resolve(packageDir, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    process.stderr.write(`install: ${packageName} has no package.json at ${pkgJsonPath}\n`);
    return { exitCode: 1 };
  }
  let pkgJson: { name?: unknown; version?: unknown; 'massu-adapter'?: unknown };
  try {
    pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
  } catch (err) {
    process.stderr.write(`install: ${packageName} has malformed package.json: ${err instanceof Error ? err.message : String(err)}\n`);
    return { exitCode: 1 };
  }
  if (pkgJson.name !== packageName || typeof pkgJson.version !== 'string') {
    process.stderr.write(`install: ${packageName}'s package.json name/version mismatch.\n`);
    return { exitCode: 1 };
  }
  const installedVersion = pkgJson.version;

  // Look up in cached registry manifest.
  const manifestResult = await getManifest();
  if (manifestResult.kind !== 'ok') {
    process.stderr.write(
      `install: registry manifest unavailable. Run \`massu adapters refresh\` first. Reasons: ${manifestResult.reasons.join('; ')}\n`,
    );
    return { exitCode: 1 };
  }
  const manifestEntry = manifestResult.envelope.manifest.adapters.find((e) => e.package === packageName);
  if (!manifestEntry) {
    process.stderr.write(
      `install: refusing — ${packageName} is not in the signed registry manifest. ` +
      `Submit a PR per AUTHORING-ADAPTERS.md before installing.\n`,
    );
    return { exitCode: 1 };
  }
  if (manifestEntry.unpublished === true) {
    process.stderr.write(
      `install: refusing — ${packageName} is marked unpublished in the manifest. ` +
      `Run \`npm uninstall ${packageName}\` to remove it.\n`,
    );
    return { exitCode: 1 };
  }
  if (manifestEntry.version !== installedVersion) {
    process.stderr.write(
      `install: WARNING — installed version ${installedVersion} differs from manifest entry ${manifestEntry.version}. ` +
      `The sha256 check below uses the manifest's hash; if the installed package was tampered to look like a different ` +
      `version, the check will catch it.\n`,
    );
  }

  // CR-9 audit M5 fix (+ iter-2 MED-NEW-1/-2: shared helper used at install,
  // resign, and discovery load-time). Refuse any package whose tree
  // contains hidden directories. Published npm tarballs should not ship
  // these; sha256OfDir excludes them from hashing, so a payload there
  // would be invisible to install + load checks. Single source of truth:
  // containsHiddenDirs in security/install-tracking.ts.
  const hiddenDir = containsHiddenDirs(packageDir);
  if (hiddenDir !== null) {
    process.stderr.write(
      `install refused: ${packageName} contains a '${hiddenDir}' subdirectory. ` +
      `Published npm tarballs should not ship these directories — refusing as a ` +
      `precaution against payload smuggling.\n`,
    );
    return { exitCode: 1 };
  }

  // Compute sha256OfDir + compare.
  let computedSha: string;
  try {
    computedSha = sha256OfDir(packageDir);
  } catch (err) {
    process.stderr.write(`install: sha256OfDir failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return { exitCode: 2 };
  }

  // Note: per gap-37 spec, the manifest entry's sha256 is the
  // CONTENT-ADDRESSED hash of the published package (same algorithm
  // sha256OfDir computes here). For the registry's currently empty
  // manifest, no entries exist yet; once Phase 9 ships the 5
  // first-party adapters, their manifest entries' sha256 will be
  // computed via the same sha256OfDir at publish time.
  if (computedSha !== manifestEntry.sha256) {
    process.stderr.write(
      `install: refusing — ${packageName} content sha256 (${computedSha.slice(0, 16)}...) ` +
      `does not match manifest entry sha256 (${manifestEntry.sha256.slice(0, 16)}...). ` +
      `This indicates either (a) tampering of the installed files, or (b) a different version installed than the manifest pins.\n`,
    );
    return { exitCode: 2 };
  }

  // Write to install-tracking sidecar.
  const entry: InstallEntry = {
    version: installedVersion,
    installed_sha256: computedSha,
    manifest_sha256: manifestEntry.sha256,
    ts: new Date().toISOString(),
  };
  const writeResult = writeInstalledManifestEntry(packageName, entry);
  if (!writeResult.written) {
    process.stderr.write(`install: sidecar write failed: ${writeResult.error}\n`);
    return { exitCode: 3 };
  }

  process.stderr.write(`install: registered ${packageName}@${installedVersion} (sha ${computedSha.slice(0, 16)}...)\n`);
  return { exitCode: 0 };
}

/**
 * `npx massu adapters resign` (Plan 3c gap-37 + gap-54).
 *
 * Re-fetches the registry manifest under the currently-bundled @massu/core
 * pubkey + walks every entry in the install-tracking sidecar:
 *   - If still in the new manifest with matching sha256 → refresh `ts`
 *   - If sha256 mismatches OR no longer in manifest → REMOVE from sidecar
 *     + emit operator-actionable warning (recover via npm uninstall +
 *     npm install + massu adapters install)
 *
 * Used after a key rotation event when the cached manifest's
 * bundled_pubkey_fingerprint != current pubkey: the operator reinstalls
 * the affected packages, then runs `resign` to re-link them to the new
 * manifest's signatures.
 */
export async function runAdaptersResign(_args: string[]): Promise<AdaptersResult> {
  const refreshed = await getManifest({ force: true });
  if (refreshed.kind !== 'ok') {
    process.stderr.write(
      `resign: refresh failed. Cannot reconcile install-tracking sidecar without a verified manifest. ` +
      `Reasons: ${refreshed.reasons.join('; ')}\n`,
    );
    return { exitCode: 1 };
  }

  const installed = readInstalledManifest();
  const manifestByName = new Map(refreshed.envelope.manifest.adapters.map((e) => [e.package, e]));
  let kept = 0;
  let removed = 0;
  const warnings: string[] = [];

  let projectRoot: string;
  try {
    projectRoot = getProjectRoot();
  } catch (err) {
    process.stderr.write(`resign: cannot resolve project root: ${err instanceof Error ? err.message : String(err)}\n`);
    return { exitCode: 1 };
  }

  for (const [name, entry] of Object.entries(installed)) {
    // iter-2 audit LOW-NEW-1 fix: re-validate sidecar keys via the same
    // npm-name regex used at install. A same-user filesystem write to
    // ~/.massu/adapter-manifest-installed.json could embed control chars
    // in a key, which would log-inject when echoed to stderr below.
    // Refusing to process malformed keys catches this BEFORE any
    // process.stderr.write that includes `name`.
    const nameValidation = validatePackageName(name);
    if (!nameValidation.ok) {
      removed++;
      // Render the sidecar key in JSON.stringify form so any control
      // characters are escaped — the warning is operator-readable + safe
      // to put in CI logs.
      warnings.push(
        `sidecar key ${JSON.stringify(name)} (rendered safely) is malformed: ${nameValidation.reason} — REMOVED from sidecar`,
      );
      removeInstalledManifestEntry(name);
      continue;
    }
    const newEntry = manifestByName.get(name);
    if (!newEntry) {
      removed++;
      warnings.push(`${name}@${entry.version}: no longer in manifest after resign — REMOVED from sidecar`);
      removeInstalledManifestEntry(name);
      continue;
    }
    const packageDir = resolve(projectRoot, 'node_modules', ...name.split('/'));
    if (!existsSync(packageDir)) {
      removed++;
      warnings.push(`${name}@${entry.version}: not present in node_modules — REMOVED from sidecar`);
      removeInstalledManifestEntry(name);
      continue;
    }
    // iter-2 MED-NEW-1 fix: same hidden-dir refusal that runAdaptersInstall
    // applies — without this, an attacker could install a clean package,
    // get registered, swap in a malicious version with `.git/payload.js`,
    // then have resign re-record it.
    const hiddenDirAtResign = containsHiddenDirs(packageDir);
    if (hiddenDirAtResign !== null) {
      removed++;
      warnings.push(
        `${name}@${entry.version}: contains '${hiddenDirAtResign}' subdirectory ` +
        `— REMOVED from sidecar. Recover via \`npm uninstall ${name} && ` +
        `npm install ${name} && massu adapters install ${name}\``,
      );
      removeInstalledManifestEntry(name);
      continue;
    }
    let computedSha: string;
    try {
      computedSha = sha256OfDir(packageDir);
    } catch (err) {
      removed++;
      warnings.push(`${name}: sha256OfDir failed: ${err instanceof Error ? err.message : String(err)} — REMOVED from sidecar`);
      removeInstalledManifestEntry(name);
      continue;
    }
    if (computedSha !== newEntry.sha256) {
      removed++;
      warnings.push(
        `${name}: post-resign sha mismatch (manifest ${newEntry.sha256.slice(0, 16)}... vs ` +
        `installed ${computedSha.slice(0, 16)}...) — REMOVED from sidecar. Recover via ` +
        `\`npm uninstall ${name} && npm install ${name} && massu adapters install ${name}\``,
      );
      removeInstalledManifestEntry(name);
      continue;
    }
    // Refresh ts so the operator sees the resign happened.
    writeInstalledManifestEntry(name, {
      ...entry,
      manifest_sha256: newEntry.sha256,
      ts: new Date().toISOString(),
    });
    kept++;
  }

  for (const w of warnings) {
    process.stderr.write(`resign: ${w}\n`);
  }
  process.stderr.write(`resign: kept ${kept} entries; removed ${removed} entries.\n`);
  return { exitCode: 0 };
}

function printAdaptersHelp(): void {
  console.log(`
Massu adapters — third-party adapter registry CLI

Usage:
  massu adapters <subcommand>

Subcommands (read-only operational):
  list                       Show all discovered adapters + their origin class
  refresh [--force --check]  Refresh the cached registry manifest
  search <query>             List registry manifest entries matching <query>

Subcommands (config-mutation; in-flight Phase 5 follow-up):
  add-local <path>           Add a project-local adapter file to massu.config.yaml
  remove-local <path>        Remove a project-local adapter from massu.config.yaml
  resync-local-fingerprint   Acknowledge an out-of-band edit to adapters.local
  install <package>          Record install-time sha256 for a freshly-installed adapter
  resign                     Re-fetch + re-trust adapters under a rotated registry key

Documentation: https://massu.ai/docs/adapters
`);
}
