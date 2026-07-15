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
// INVARIANT (the strict form, operator-chosen 2026-07-14):
//   IF packages/core/package.json `version` V is ALREADY PUBLISHED on npm,
//   THEN a git tag `vV` MUST exist AND HEAD MUST be exactly that tag's commit.
//   Otherwise you have commits on top of an already-published version → BUMP the version.
//   (A version that is NOT yet published is fine — it's an in-progress release.)
//
// This makes reuse of a published version number STRUCTURALLY IMPOSSIBLE: the moment anyone
// commits on top of a published release without bumping, the next `git push` fails.
//
// BLIND-GATE LAW compliance:
//   M1 (prove it looked): prints the denominator — V, npm latest, #published versions, tag
//      presence, HEAD sha, tag sha — and asserts the published-version list is non-empty.
//   M2 (fail closed): if the published-version list cannot be fetched (npm unreachable / empty
//      / parse error), this EXITS NON-ZERO (code 3), never silently passes. Override only via
//      MASSU_SKIP_RELEASE_INTEGRITY_CHECK=1 (logged to stderr).
//   M4 (mutation-testable): the decision is a pure function `evaluateReleaseIntegrity(...)`
//      exercised by the unit test with the exact defect shape, plus a real-tree mutation test.

import { readFileSync } from 'node:fs';
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
 */
export function evaluateReleaseIntegrity(i) {
  const { version, publishedVersions, tagExists, headSha, tagSha } = i;

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
  if (!headSha || !tagSha || headSha !== tagSha) {
    return {
      ok: false,
      code: 1,
      reason:
        `RELEASE INTEGRITY VIOLATION: version ${version} is ALREADY PUBLISHED and tagged \`v${version}\` at ${tagSha ?? '(unknown)'}, ` +
        `but HEAD is ${headSha ?? '(unknown)'}. You have commits on top of a published release. ` +
        `BUMP the version in packages/core/package.json (CR-64).`,
      denominator,
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

  const result = evaluateReleaseIntegrity({ version, publishedVersions, tagExists, headSha, tagSha });

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
