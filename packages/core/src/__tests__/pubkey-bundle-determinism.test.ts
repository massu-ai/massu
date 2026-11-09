// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Every vendored Ed25519 pubkey module is a pure function of its pem, and is in sync.
 *
 * Until 2.5.4 the four `scripts/bundle-*pubkey.mjs` bundlers stamped the wall clock into
 * line 1 of their output, so every `npm publish` (prepublishOnly runs all four) dirtied
 * four tracked files and `sync-public.sh` refused to mirror the release (2.5.3,
 * 2026-11-08). Their `--check` modes, documented as a "CI gate", had no caller at all.
 * This test is that caller. The bundlers are DISCOVERED from the tracked tree, so a fifth
 * key is covered on its first commit.
 *
 * Incident 2026-11-08: a successful publish was reported FAIL, and every publish left the tree dirty.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, relative } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { gitSafeEnv } from './helpers/git-safe-env.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

interface Spec {
  script: string;
  pem: string;
  out: string;
  knownFingerprints: Set<string>;
  missingPemHelp: string;
  renderBody: (a: { numbers: string; fingerprint: string; knownFingerprintsLiteral: string }) => string;
}
interface CheckResult { ok: boolean; code: number; message: string }
interface Lib {
  checkPubkeyBundle: (s: Spec) => CheckResult;
  renderPubkeyModule: (s: Spec) => { text: string; fingerprint: string };
}

const lib = (await import(pathToFileURL(join(REPO_ROOT, 'scripts/lib/ed25519-pubkey-bundle.mjs')).href)) as Lib;

const bundlers = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '--', 'scripts/bundle-*pubkey.mjs'], {
  encoding: 'utf-8',
  env: gitSafeEnv(),
})
  .split('\n')
  .filter(Boolean);

const specs: Spec[] = [];
for (const b of bundlers) {
  const mod = (await import(pathToFileURL(join(REPO_ROOT, b)).href)) as { SPEC?: Spec };
  if (mod.SPEC) specs.push(mod.SPEC);
}

describe('vendored pubkey modules', () => {
  it('discovered the bundlers, and every one declares a SPEC on the shared library (a zero scope is blind)', () => {
    expect(bundlers.length).toBeGreaterThanOrEqual(4);
    expect(specs.map((s) => s.script).sort()).toEqual([...bundlers].sort());
  });

  for (const spec of specs) {
    it(`${spec.script}: the committed module is byte-identical to what the bundler renders`, () => {
      const res = lib.checkPubkeyBundle(spec);
      expect(res, res.message).toMatchObject({ ok: true, code: 0 });
    });

    it(`${spec.script}: output is a pure function of the pem (no clock, two renders agree)`, () => {
      const a = lib.renderPubkeyModule(spec).text;
      const b = lib.renderPubkeyModule(spec).text;
      expect(a).toBe(b);
      expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  }
});

describe('the check can fail (each refusal path fires)', () => {
  const spec = specs[0];

  it('MUST FIRE code 5 when the committed module differs from the render', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pubkey-bundle-'));
    try {
      const out = join(dir, 'drifted.generated.ts');
      writeFileSync(out, readFileSync(join(REPO_ROOT, spec.out), 'utf-8') + '// drift\n');
      const res = lib.checkPubkeyBundle({ ...spec, out: relative(REPO_ROOT, out) });
      expect(res).toMatchObject({ ok: false, code: 5 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('MUST FIRE code 3 when the pem fingerprint is not on the allowlist', () => {
    const res = lib.checkPubkeyBundle({ ...spec, knownFingerprints: new Set(['0'.repeat(64)]) });
    expect(res).toMatchObject({ ok: false, code: 3 });
  });

  it('MUST FIRE code 2 when the pem is missing', () => {
    const res = lib.checkPubkeyBundle({ ...spec, pem: 'packages/core/security/does-not-exist.pem' });
    expect(res).toMatchObject({ ok: false, code: 2 });
  });
});
