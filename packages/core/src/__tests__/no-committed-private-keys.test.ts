// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * SEC-1 drift-guard (audit 2026-07-14): no tracked file may contain a private
 * key. A live Ed25519 license-signing private key was committed inside a runbook
 * — anyone with repo/history read could forge Enterprise license responses.
 *
 * The check flags a `-----BEGIN … PRIVATE KEY-----` marker that is followed by a
 * base64 KEY BODY (the real thing), NOT a bare marker used as a test fixture
 * (e.g. detect.source-dir-detector.test.ts touches a `private.pem` whose content
 * is only the marker string). That distinction is structural, so no per-file
 * allowlist is needed — an allowlist is a valve, and a valve is how a gate rots.
 */

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const MARKER = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const B64_BODY = /^[A-Za-z0-9+/]{40,}={0,2}$/;

/** True if a private-key marker is followed (within 3 lines) by a base64 body. */
function containsRealPrivateKey(content: string): boolean {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (MARKER.test(lines[i])) {
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        if (B64_BODY.test(lines[j].trim())) return true;
      }
    }
  }
  return false;
}

describe('no committed private keys (SEC-1 drift-guard)', () => {
  it('detector flags a real key body but NOT a bare marker (anti-vacuity)', () => {
    // Synthetic, obviously-fake key body (repeated chars) — never a real key.
    const fakeKey =
      '-----BEGIN PRIVATE KEY-----\n' +
      'A'.repeat(64) + '\n' +
      '-----END PRIVATE KEY-----\n';
    expect(containsRealPrivateKey(fakeKey)).toBe(true); // MUST catch a real body

    const bareMarker = "touch(root, 'apps/web/private.pem', '-----BEGIN PRIVATE KEY-----');";
    expect(containsRealPrivateKey(bareMarker)).toBe(false); // MUST NOT flag the fixture
  });

  it('no tracked file contains a private key body', () => {
    // Fail-closed denominator (M1/M2): if git can't enumerate, ERROR — never
    // let an unreadable file list masquerade as "scanned nothing, all clean".
    let files: string[];
    try {
      const out = execSync('git ls-files', { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      files = out.split('\n').map(f => f.trim()).filter(Boolean);
    } catch (err) {
      throw new Error(`SEC-1 guard could not enumerate tracked files: ${(err as Error).message}`);
    }
    expect(files.length).toBeGreaterThan(100); // prove it actually looked

    const offenders: string[] = [];
    let scanned = 0;
    for (const rel of files) {
      const abs = resolve(REPO_ROOT, rel);
      let content: string;
      try {
        if (statSync(abs).size > 4 * 1024 * 1024) continue; // skip huge/binary
        content = readFileSync(abs, 'utf8');
      } catch {
        continue; // unreadable individual file (e.g. submodule) — not a key leak
      }
      scanned++;
      if (containsRealPrivateKey(content)) offenders.push(rel);
    }
    expect(scanned).toBeGreaterThan(100); // denominator assertion
    expect(offenders, `Committed private key(s) found: ${offenders.join(', ')}`).toEqual([]);
  });
});
