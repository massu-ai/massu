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
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getConfig, getProjectRoot } from '../config.js';
import { getManifest } from '../security/manifest-cache.js';
import { discoverAdapters } from '../detect/adapters/discover.js';
import { CORE_BUNDLED_IDS } from '../detect/adapters/index.js';
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
    case 'remove-local':
    case 'resync-local-fingerprint':
      return notYetImplemented(sub, 'gap-32 adapters.local fingerprint mechanism (next Phase 5 commit)');
    case 'install':
    case 'resign':
      return notYetImplemented(sub, 'gap-37 install-time sha256 tracking (next Phase 5 commit)');
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
