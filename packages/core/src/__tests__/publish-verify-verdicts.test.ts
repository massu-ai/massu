// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * scripts/ops/publish-and-verify-release.sh must not call an ACCEPTED-but-not-yet-visible
 * publish a FAIL.
 *
 * It did twice, on the same code path: 2.5.1 (2026-08-10, after a `sleep 2`) and 2.5.3
 * (2026-11-08, after the fix's 90 s deadline expired; the script printed "this is not
 * propagation lag" over a publish that became visible minutes later). A deadline cannot
 * tell "not yet" from "not ever"; this run's own publish status can. So:
 *   accepted + not visible   -> PENDING, exit 3, "do NOT re-publish"
 *   refused  + not visible   -> FAIL, exit 1
 *   --verify-only + absent   -> FAIL, exit 1
 *
 * Driven against a FIXTURE package (version 9.9.9-test) with a stub `npm` first on PATH
 * and npm's registry pointed at a closed local port, so no case can reach the real
 * registry. The stub's resolution is asserted before any case runs.
 *
 * Incident 2026-11-08: a successful publish was reported FAIL, and every publish left the tree dirty.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts/ops/publish-and-verify-release.sh');
const VERSION = '9.9.9-test';

let work: string;
let stubDir: string;
let pkgDir: string;

const STUB_NPM = `#!/usr/bin/env bash
# Test stub for npm. Answers only what the verifier asks; anything else is an error.
case "$1" in
  whoami)  echo stub-user ;;
  publish) exit "\${FAKE_NPM_PUBLISH_RC:-0}" ;;
  view)
    if [ "$2" = "@massu/core" ]; then echo 0.0.1; exit 0; fi
    if [ -n "\${FAKE_NPM_VISIBLE:-}" ]; then echo "\${FAKE_NPM_VISIBLE}"; exit 0; fi
    exit 1 ;;
  *) echo "stub npm: unexpected '$*'" >&2; exit 99 ;;
esac
`;

function env(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${stubDir}:${process.env.PATH ?? ''}`,
    npm_config_registry: 'http://127.0.0.1:9/',
    MASSU_RELEASE_PKG_DIR: pkgDir,
    MASSU_PUBLISH_VERIFY_DEADLINE_SECS: '0',
    ...extra,
  };
}

function run(args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf-8', env: env(extra) });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'publish-verdicts-'));
  stubDir = join(work, 'bin');
  pkgDir = join(work, 'pkg');
  mkdirSync(stubDir);
  mkdirSync(join(pkgDir, 'dist', 'hooks'), { recursive: true });
  writeFileSync(join(stubDir, 'npm'), STUB_NPM);
  chmodSync(join(stubDir, 'npm'), 0o755);
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@massu/core', version: VERSION }));
  // A hook that carries the fix's markers, so the local-artifact step passes and the
  // verdict step is what each case exercises.
  writeFileSync(
    join(pkgDir, 'dist', 'hooks', 'h.js'),
    'function f(){ process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "X", additionalContext: "" } })); }\n',
  );
});

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('publish-and-verify-release.sh verdicts', () => {
  it('precondition: `npm` resolves to the stub, so no case can reach a real registry', () => {
    const r = spawnSync('bash', ['-c', 'command -v npm'], { encoding: 'utf-8', env: env({}) });
    expect(r.stdout.trim()).toBe(join(stubDir, 'npm'));
  });

  it('accepted publish, not yet visible -> PENDING (exit 3), never FAIL, and says not to re-publish', () => {
    const r = run(['--publish'], { FAKE_NPM_PUBLISH_RC: '0' });
    expect(r.out).toContain('npm publish exited 0');
    expect(r.out).toContain('RESULT: PENDING');
    expect(r.out).toContain('Do NOT re-publish');
    expect(r.out).not.toContain('RESULT: FAIL');
    expect(r.out).not.toContain('not propagation lag');
    expect(r.status).toBe(3);
  });

  it('refused publish, not visible -> FAIL (exit 1) naming the refusal', () => {
    const r = run(['--publish'], { FAKE_NPM_PUBLISH_RC: '1' });
    expect(r.out).toContain('npm publish exited 1');
    expect(r.out).toContain('refused the write');
    expect(r.out).toContain('RESULT: FAIL');
    expect(r.status).toBe(1);
  });

  it('--verify-only with the version absent -> FAIL (exit 1), not PENDING', () => {
    const r = run(['--verify-only']);
    expect(r.out).toContain('RESULT: FAIL');
    expect(r.out).not.toContain('RESULT: PENDING');
    expect(r.status).toBe(1);
  });
});
