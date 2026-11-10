#!/usr/bin/env node
// CR-64 — A PUBLISHED VERSION NUMBER IS IMMUTABLE.
//
// Incident 2026-07-14 (npm publish decoupled from the release ceremony — see the internal
// incident records):
// `@massu/core@1.16.0` was published to npm from commit aed5264 with NO git tag and NO
// release-ceremony commit, and then 6 more commits (incl. security/robustness fixes) landed
// under the SAME `1.16.0` version and were never republished — so the version number stopped
// being a truthful pointer to what shipped, and committed fixes read as "SHIPPED" while
// undelivered.
//
// INVARIANT (strict form operator-chosen 2026-07-14; widened by operator decision 2026-11-08):
//   IF packages/core/package.json `version` V is ALREADY PUBLISHED on npm,
//   THEN a git tag `vV` MUST exist, AND either
//     (a) HEAD is exactly that tag's commit, or
//     (b) the tag is an ancestor of HEAD AND what HEAD would ship is BYTE-IDENTICAL to what npm
//         serves for V: the gate builds the package itself, packs it, and compares every file's
//         sha256 against the published tarball's (same file set, same bytes).
//   Otherwise you have commits on top of an already-published version that change what it
//   ships → BUMP the version. (A version that is NOT yet published is fine: in-progress release.)
//
// WHY (b): the strict form made the newest release's own record uncommittable. A master-plan
// row's publish evidence exists only after the publish, and any commit after the tag failed, so
// the row could only be corrected inside the NEXT release, whose row then had the same problem
// (2.5.3 and 2.5.4, 2026-11-08). The 1.16.0 incident this rule closes was SHIPPED CONTENT drifting
// under a published version; (b) still makes that impossible, because any change to the shipped
// bytes fails it. Measured before adopting: a local pack of 2.5.4 matched the published tarball
// in all 190 files. Prior art: npm's own reproduce tool (npmjs.com/reproduce) verifies a package
// the same way, by rebuilding and comparing against the registry.
//
// The build is run BY THE GATE, never trusted from disk: a stale dist/ would match the published
// tarball while the source had changed. Per-file payload hashes are compared, not the tarball's
// bytes, so an archive-format difference between machines cannot cause a false verdict.
//
// BLIND-GATE LAW compliance:
//   M1 (prove it looked): prints the denominator — V, npm latest, #published versions, tag
//      presence, HEAD sha, tag sha — and asserts the published-version list is non-empty.
//   M2 (fail closed): if the published-version list cannot be fetched (npm unreachable / empty
//      / parse error), this EXITS NON-ZERO (code 3), never silently passes. Override only via
//      MASSU_SKIP_RELEASE_INTEGRITY_CHECK=1 (logged to stderr).
//   M4 (mutation-testable): the decision is a pure function `evaluateReleaseIntegrity(...)`
//      exercised by the unit test with the exact defect shape, plus a real-tree mutation test.

import { readFileSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PKG = '@massu/core';

/**
 * Pure decision core. No I/O. Returns { ok, code, reason, denominator }.
 *  - code 0 = pass, 1 = integrity violation (bump required / tag drift), 3 = cannot-verify (fail-closed).
 *
 * @param {object} i
 * @param {string} i.version            local packages/core version, e.g. "1.16.1"
 * @param {string[]|null} i.publishedVersions  all published npm versions, or null if unfetchable
 * @param {boolean} i.tagExists         does a `v<version>` git tag exist
 * @param {string|null} i.headSha       HEAD commit sha (full)
 * @param {string|null} i.tagSha        the `v<version>` tag's commit sha (full), or null
 * @param {boolean} [i.tagIsAncestor]   is the tag's commit an ancestor of HEAD
 * @param {null|{identical:boolean, files:number, differing:string[]}|{error:string}} [i.contentIdentity]
 *        result of comparing HEAD's packed payload with the published tarball (computed only
 *        when HEAD is past the tag); `{error}` when it could not be measured.
 */
export function evaluateReleaseIntegrity(i) {
  const { version, publishedVersions, tagExists, headSha, tagSha, tagIsAncestor, contentIdentity } = i;

  // M2 fail-closed: an unfetchable / empty published set is an ERROR, not an empty "clean".
  if (!Array.isArray(publishedVersions) || publishedVersions.length === 0) {
    return {
      ok: false,
      code: 3,
      reason:
        `CANNOT VERIFY release integrity: npm published-version list for ${PKG} is empty or unfetchable. ` +
        `Refusing to pass (fail-closed). If offline, re-run with network, or set ` +
        `MASSU_SKIP_RELEASE_INTEGRITY_CHECK=1 (logged) to override.`,
      denominator: { version, published: 0, tagExists, headSha, tagSha },
    };
  }

  const isPublished = publishedVersions.includes(version);
  const denominator = {
    version,
    published: publishedVersions.length,
    versionIsPublished: isPublished,
    tagExists,
    headSha,
    tagSha,
  };

  if (!isPublished) {
    // In-progress release: version not yet on npm. Fine.
    return {
      ok: true,
      code: 0,
      reason: `OK: version ${version} is not yet published (in-progress release). ${publishedVersions.length} published versions checked.`,
      denominator,
    };
  }

  // Version IS published → it is immutable. Require a matching tag AT HEAD.
  if (!tagExists) {
    return {
      ok: false,
      code: 1,
      reason:
        `RELEASE INTEGRITY VIOLATION: version ${version} is ALREADY PUBLISHED on npm but has NO git tag \`v${version}\`. ` +
        `You are about to push commits under an already-shipped version number. BUMP the version in ` +
        `packages/core/package.json and complete the release ceremony (CR-64).`,
      denominator,
    };
  }
  if (!headSha || !tagSha) {
    return {
      ok: false,
      code: 3,
      reason: `CANNOT VERIFY release integrity: HEAD (${headSha ?? 'unknown'}) or tag v${version} (${tagSha ?? 'unknown'}) did not resolve. Refusing to pass (fail-closed).`,
      denominator,
    };
  }
  if (headSha !== tagSha) {
    const past = { ...denominator, tagIsAncestor: Boolean(tagIsAncestor), contentIdentity: contentIdentity ?? null };
    if (!tagIsAncestor) {
      return {
        ok: false,
        code: 1,
        reason:
          `RELEASE INTEGRITY VIOLATION: version ${version} is ALREADY PUBLISHED and tagged \`v${version}\` at ${tagSha}, ` +
          `but HEAD ${headSha} does not descend from that tag. BUMP the version in packages/core/package.json (CR-64).`,
        denominator: past,
      };
    }
    if (!contentIdentity || 'error' in contentIdentity) {
      return {
        ok: false,
        code: 3,
        reason:
          `CANNOT VERIFY release integrity: HEAD is past the published tag \`v${version}\`, and whether it ships the same bytes ` +
          `could not be measured (${contentIdentity && 'error' in contentIdentity ? contentIdentity.error : 'not computed'}). ` +
          `Refusing to pass (fail-closed).`,
        denominator: past,
      };
    }
    if (!contentIdentity.identical) {
      const shown = contentIdentity.differing.slice(0, 10).join(', ');
      return {
        ok: false,
        code: 1,
        reason:
          `RELEASE INTEGRITY VIOLATION: version ${version} is ALREADY PUBLISHED, and HEAD (${headSha}) would ship different ` +
          `content: ${contentIdentity.differing.length} file(s) differ from the published tarball (${shown}). ` +
          `BUMP the version in packages/core/package.json (CR-64).`,
        denominator: past,
      };
    }
    return {
      ok: true,
      code: 0,
      reason:
        `OK: version ${version} is published; HEAD is past its tag \`v${version}\` (${tagSha}) but ships byte-identical content ` +
        `(${contentIdentity.files} file(s) compared against the published tarball).`,
      denominator: past,
    };
  }

  return {
    ok: true,
    code: 0,
    reason: `OK: version ${version} is published and HEAD is exactly its tag \`v${version}\` (${tagSha}).`,
    denominator,
  };
}

// ---- main (I/O boundary) ----------------------------------------------------


/** sha256 of every regular file under `dir`, keyed by its path relative to `dir`. */
function hashTree(dir) {
  const out = new Map();
  const walk = (d, rel) => {
    for (const name of readdirSync(d)) {
      const abs = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs, r);
      else if (st.isFile()) out.set(r, createHash('sha256').update(readFileSync(abs)).digest('hex'));
    }
  };
  walk(dir, '');
  return out;
}

function packAndExtract(cwd, spec, dest) {
  execFileSync('npm', ['pack', ...(spec ? [spec] : []), '--pack-destination', dest], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tgz = readdirSync(dest).filter((f) => f.endsWith('.tgz'));
  if (tgz.length !== 1) throw new Error(`expected 1 tarball in ${dest}, found ${tgz.length}`);
  execFileSync('tar', ['-xzf', tgz[0]], { cwd: dest });
  return join(dest, 'package');
}

/**
 * Build the package from HEAD, pack it, and compare every file with the published tarball.
 * Returns { identical, files, differing } or { error } — never throws.
 */
export function measureContentIdentity(repoRoot, version) {
  const work = mkdtempSync(join(tmpdir(), 'massu-cr64-'));
  try {
    const run = (args, cwd) => execFileSync('npm', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    run(['run', 'build:types'], repoRoot);
    run(['run', 'build:adapters'], repoRoot);
    run(['run', 'build'], join(repoRoot, 'packages', 'core'));
    const localDir = join(work, 'local');
    const pubDir = join(work, 'published');
    execFileSync('mkdir', ['-p', localDir, pubDir]);
    const local = hashTree(packAndExtract(join(repoRoot, 'packages', 'core'), null, localDir));
    const published = hashTree(packAndExtract(work, `${PKG}@${version}`, pubDir));
    if (local.size === 0 || published.size === 0) {
      return { error: `an empty file set (local ${local.size}, published ${published.size}) is blind, not identical` };
    }
    const differing = [];
    for (const [f, h] of published) if (local.get(f) !== h) differing.push(f);
    for (const f of local.keys()) if (!published.has(f)) differing.push(`${f} (not in published)`);
    return { identical: differing.length === 0, files: published.size, differing: differing.sort() };
  } catch (err) {
    const msg = String(err && err.stderr ? err.stderr : err && err.message ? err.message : err).trim().split('\n').slice(-3).join(' | ');
    return { error: msg || 'unknown failure' };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function gitOrNull(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

function fetchPublishedVersions() {
  // Returns string[] or null (unfetchable). Never throws.
  try {
    const raw = execFileSync('npm', ['view', PKG, 'versions', '--json'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === 'string') return [parsed]; // npm returns a bare string for a single version
    return null;
  } catch {
    return null;
  }
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  // MASSU_RELEASE_INTEGRITY_PKG_PATH is a TEST-ONLY seam so the real-tree mutation test can
  // point the gate at a temp package.json copy without mutating the tracked file (CR-70).
  const pkgPath =
    process.env.MASSU_RELEASE_INTEGRITY_PKG_PATH ||
    join(here, '..', 'packages', 'core', 'package.json');
  const version = JSON.parse(readFileSync(pkgPath, 'utf-8')).version;

  if (process.env.MASSU_SKIP_RELEASE_INTEGRITY_CHECK === '1') {
    console.error(
      `[release-integrity] OVERRIDE: MASSU_SKIP_RELEASE_INTEGRITY_CHECK=1 set — skipping CR-64 check for version ${version} (logged).`,
    );
    process.exit(0);
  }

  const publishedVersions = fetchPublishedVersions();
  const tagRef = `refs/tags/v${version}`;
  const tagExists = gitOrNull(['rev-parse', '-q', '--verify', tagRef]) !== null;
  const headSha = gitOrNull(['rev-parse', 'HEAD']);
  const tagSha = tagExists ? gitOrNull(['rev-parse', `v${version}^{commit}`]) : null;

  let tagIsAncestor = false;
  let contentIdentity = null;
  const isPublished = Array.isArray(publishedVersions) && publishedVersions.includes(version);
  if (isPublished && tagExists && headSha && tagSha && headSha !== tagSha) {
    tagIsAncestor = gitOrNull(['merge-base', '--is-ancestor', tagSha, headSha]) !== null;
    if (tagIsAncestor) {
      console.error(`[release-integrity] HEAD is past published v${version}: building and comparing what it would ship…`);
      contentIdentity = measureContentIdentity(join(here, '..'), version);
    }
  }

  const result = evaluateReleaseIntegrity({ version, publishedVersions, tagExists, headSha, tagSha, tagIsAncestor, contentIdentity });

  // M1: always print the denominator (proves it looked).
  console.error(`[release-integrity] ${JSON.stringify(result.denominator)}`);
  if (result.ok) {
    console.log(`[release-integrity] PASS — ${result.reason}`);
  } else {
    console.error(`[release-integrity] FAIL (exit ${result.code}) — ${result.reason}`);
  }
  process.exit(result.code);
}

// Only run main when invoked directly (not when imported by the unit test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
