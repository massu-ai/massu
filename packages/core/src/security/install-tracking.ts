/**
 * Install-time + load-time sha256 verification of REGISTRY-VERIFIED adapter
 * package contents (Plan 3c gap-37).
 *
 * Two checks defend against post-install tampering:
 *
 * 1. INSTALL-time: when the operator runs `npx massu adapters install <pkg>`,
 *    this module walks the installed package's directory, computes a content-
 *    addressed sha256, AND verifies it equals the sha256 the signed registry
 *    manifest entry pinned. On match → record in
 *    ~/.massu/adapter-manifest-installed.json with the version + timestamp.
 *    Mismatch → refuse to register; the operator should `npm uninstall` the
 *    suspicious package.
 *
 * 2. LOAD-time: discovery (detect/adapters/discover.ts) re-computes the
 *    package's sha256 on every startup, compares to the install-time recorded
 *    hash from the sidecar file. Mismatch → REFUSE to load (post-install
 *    tampering of unpacked files in node_modules). The load-time check
 *    compares to the LOCAL sidecar, NOT the live registry — re-fetching
 *    from the registry every startup would be a network dependency on the
 *    boot path (per Plan 3c gap-3 deliverable: NO network on boot).
 *
 * Why content-addressed (not tarball sha256):
 * The published tarball's sha256 is a moving target — npm tarballs include
 * timestamps + permission bits that vary across operating systems. The
 * SAME tarball extracted to two different machines produces different
 * tarball hashes but identical FILE CONTENT hashes. Content-addressed
 * hashing (sha256 of canonical-stringified path:fileSha pairs, sorted by
 * path) is stable across machines + filesystems.
 *
 * Per CR-46 / Rule 0 single-source-of-truth: this is the ONLY recursive
 * directory hashing in @massu/core. Future modules that need to hash
 * directories MUST consume sha256OfDir from here, not re-implement.
 */
import { readFileSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { atomicWrite } from './atomic-write.js';

export const INSTALLED_MANIFEST_PATH = resolve(homedir(), '.massu', 'adapter-manifest-installed.json');

/**
 * Compute a content-addressed sha256 of a directory recursively. Stable
 * across machines + filesystems: sorts files by relative POSIX path,
 * hashes each file's bytes, concatenates `<path>\0<sha256-hex>\n` per
 * file, then sha256s the whole concatenation.
 *
 * Symlinks are NOT followed (they're hashed as their target path content).
 * Directory entries (themselves) are NOT hashed (their content is implied
 * by the files inside). Files exceeding `maxFileBytes` (default 64 MB)
 * abort with an error — adapter packages should not ship huge binary
 * blobs; the cap is a sanity ceiling against accidental misuse.
 *
 * Excluded patterns (NEVER hashed; they are install-time artifacts that
 * vary across machines):
 *   - .git/
 *   - node_modules/  (transitive deps; their integrity is npm's concern)
 *   - any path containing /.cache/ or /.tmp/
 */
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
/**
 * Directory names that sha256OfDir EXCLUDES from hashing — these are
 * install-time artifacts that vary across machines (.git history,
 * transitive deps, build caches, scratch dirs). Their CONTENT is not
 * part of the adapter package's content-addressable hash.
 *
 * CR-9 audit M5 + iter-2 audit MED-NEW-1/-2 enforcement: a published
 * npm tarball MUST NOT ship these directories. Any package that does
 * is refused at install + resign + load-time discovery via
 * `containsHiddenDirs()` below. Without these refusals, a malicious
 * tarball could smuggle payload files under `.git/payload.js` (excluded
 * from the hash) and have them require()'d by the legitimate adapter
 * at runtime — hash matches, payload runs.
 */
export const EXCLUDED_DIR_NAMES: ReadonlySet<string> = new Set(['.git', 'node_modules', '.cache', '.tmp']);

/**
 * Returns the first hidden-dir name found in `packageDir`, or null if
 * none are present. Caller (install / resign / discovery) refuses the
 * package on non-null return.
 */
export function containsHiddenDirs(packageDir: string): string | null {
  for (const hidden of EXCLUDED_DIR_NAMES) {
    if (existsSync(`${packageDir}/${hidden}`)) {
      return hidden;
    }
  }
  return null;
}

export interface Sha256OfDirOpts {
  /** Override the file-size cap (test-only). */
  maxFileBytes?: number;
}

export function sha256OfDir(dir: string, opts: Sha256OfDirOpts = {}): string {
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const files: Array<{ relativePath: string; absPath: string }> = [];

  function walk(currentDir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(currentDir);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      const absPath = join(currentDir, entry);
      let lst;
      try {
        // CR-9 audit H1 fix: lstatSync (not statSync) so symlinks are
        // detected + skipped without following. Following symlinks would
        // expose a read-anywhere primitive (a malicious dist/x.js -> /etc/shadow
        // would have the target's content captured into the hash) AND would
        // cause readFileSync to block on named-pipe targets.
        lst = lstatSync(absPath);
      } catch {
        continue;
      }
      if (lst.isSymbolicLink()) {
        // Skip symlinks entirely — they're not part of the package's
        // content-addressable hash. A package author who legitimately wants
        // to ship a symlink (rare) must replace it with a real file at
        // publish time.
        continue;
      }
      if (lst.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry)) continue;
        walk(absPath);
        continue;
      }
      if (!lst.isFile()) continue;
      if (lst.size > maxFileBytes) {
        throw new Error(
          `sha256OfDir: file ${absPath} exceeds maxFileBytes (${lst.size} > ${maxFileBytes}); ` +
          `adapter packages should not ship files this large.`,
        );
      }
      const rel = relative(dir, absPath).split(sep).join('/');
      files.push({ relativePath: rel, absPath });
    }
  }
  walk(dir);

  // Sort by relative POSIX path so the hash is stable regardless of
  // readdir order (some filesystems return entries in inode order).
  files.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));

  const top = createHash('sha256');
  for (const f of files) {
    const fileHash = createHash('sha256').update(readFileSync(f.absPath)).digest('hex');
    top.update(f.relativePath, 'utf-8');
    top.update('\0', 'utf-8');
    top.update(fileHash, 'utf-8');
    top.update('\n', 'utf-8');
  }
  return top.digest('hex');
}

/**
 * Per-package install record. Keyed by package name in the sidecar's
 * top-level object.
 */
const InstallEntrySchema = z.object({
  // CR-9 iter-3 audit LOW-NEW3-1 fix: reject control characters in version.
  // Without this, a same-user attacker writing the install-tracking
  // sidecar could embed ANSI escapes (or other control chars) in version,
  // log-injecting via runAdaptersResign's `${name}@${entry.version}`
  // stderr emits. The regex permits printable ASCII (0x20-0x7e) plus
  // common semver characters; control chars (0x00-0x1f, 0x7f) are
  // rejected at parse time. Schema-level validation closes the vector
  // at every callsite that reads the sidecar — no per-callsite escaping
  // gymnastics needed.
  version: z.string().min(1).regex(/^[\x20-\x7e]+$/, 'version must be printable ASCII (no control characters)'),
  installed_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  manifest_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  ts: z.string().min(1).regex(/^[\x20-\x7e]+$/, 'ts must be printable ASCII (no control characters)'),
}).strict();
export type InstallEntry = z.infer<typeof InstallEntrySchema>;

const InstalledManifestSchema = z.record(z.string(), InstallEntrySchema);
export type InstalledManifest = z.infer<typeof InstalledManifestSchema>;

/**
 * Read the install-tracking sidecar at ~/.massu/adapter-manifest-installed.json.
 * Returns an empty object when the file is absent OR fails parse / schema —
 * caller should treat absent + corrupt the same way (no install records, so
 * REGISTRY-VERIFIED adapters cannot satisfy the load-time check + are refused
 * until reinstalled via `npx massu adapters install`).
 */
export function readInstalledManifest(path: string = INSTALLED_MANIFEST_PATH): InstalledManifest {
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
  const parsed = InstalledManifestSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

export type InstallTrackingWriteResult = { written: true } | { written: false; error: string };

/**
 * Write a single package's install entry to the sidecar (additive). Reads
 * the current sidecar, updates the named key, writes back atomically with
 * mode 0o600. Concurrent calls to this function for DIFFERENT package
 * names are NOT serialized — the manifest cache lock at
 * ~/.massu/.adapter-manifest.lock applies only to the cache, not this
 * sidecar. Since the install flow runs interactively (one CLI invocation
 * at a time per shell), racing writes are not a practical concern.
 */
export function writeInstalledManifestEntry(
  packageName: string,
  entry: InstallEntry,
  path: string = INSTALLED_MANIFEST_PATH,
): InstallTrackingWriteResult {
  const current = readInstalledManifest(path);
  current[packageName] = entry;
  const result = atomicWrite(path, JSON.stringify(current, null, 2), {
    mode: 0o600,
    ensureParentDirMode: 0o700,
  });
  if (!result.written) {
    return { written: false, error: result.error ?? 'unknown atomicWrite error' };
  }
  return { written: true };
}

/**
 * Remove a single package's install entry from the sidecar. Used by
 * `npx massu adapters resign --uninstall` (or by future cleanup tooling).
 * No-op if the entry is absent; sidecar file persists.
 */
export function removeInstalledManifestEntry(
  packageName: string,
  path: string = INSTALLED_MANIFEST_PATH,
): InstallTrackingWriteResult {
  const current = readInstalledManifest(path);
  if (!(packageName in current)) {
    return { written: true };
  }
  delete current[packageName];
  const result = atomicWrite(path, JSON.stringify(current, null, 2), {
    mode: 0o600,
    ensureParentDirMode: 0o700,
  });
  if (!result.written) {
    return { written: false, error: result.error ?? 'unknown atomicWrite error' };
  }
  return { written: true };
}

export type IntegrityCheckResult =
  | { kind: 'ok'; entry: InstallEntry }
  | { kind: 'no-entry'; reason: string }
  | { kind: 'drift'; entry: InstallEntry; computedSha: string; reason: string };

/**
 * Load-time integrity check for an installed REGISTRY-VERIFIED adapter
 * package. Compares the package directory's CURRENT sha256OfDir output
 * to the install-time hash recorded in the sidecar. Mismatch → drift,
 * caller refuses to load.
 *
 * Caller (typically discoverAdapters) interprets:
 *   - 'ok'        → load is safe
 *   - 'no-entry'  → package is in node_modules but never registered via
 *                    `massu adapters install`; refuse + tell operator to run install
 *   - 'drift'     → contents tampered after install; REFUSE; tell operator
 *                    to `npm uninstall` + `npm install` + `massu adapters install`
 */
export function verifyInstalledIntegrity(
  packageName: string,
  packageDir: string,
  sidecarPath: string = INSTALLED_MANIFEST_PATH,
): IntegrityCheckResult {
  const installed = readInstalledManifest(sidecarPath);
  const entry = installed[packageName];
  if (!entry) {
    return {
      kind: 'no-entry',
      reason:
        `${packageName} is in node_modules but has no install-tracking entry in ~/.massu/adapter-manifest-installed.json. ` +
        `Run \`npx massu adapters install ${packageName}\` to register it.`,
    };
  }
  const computedSha = sha256OfDir(packageDir);
  if (computedSha !== entry.installed_sha256) {
    return {
      kind: 'drift',
      entry,
      computedSha,
      reason:
        `${packageName}@${entry.version} contents changed after install: ` +
        `expected sha256 ${entry.installed_sha256.slice(0, 16)}..., got ${computedSha.slice(0, 16)}.... ` +
        `This indicates post-install tampering of the package files. Recover by running ` +
        `\`npm uninstall ${packageName} && npm install ${packageName} && npx massu adapters install ${packageName}\`.`,
    };
  }
  return { kind: 'ok', entry };
}
