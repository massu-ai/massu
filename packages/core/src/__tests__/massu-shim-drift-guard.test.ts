/**
 * Phase B shim drift-guard (plan-2026-08-01).
 *
 * THE CONFLICT THIS RESOLVES. P-003 (v1.9.4, `init-hook-paths-no-absolute.test.ts`) moved
 * hooks to npx expressly to eliminate baked absolute paths, because such a path is
 * "invalidated by cache clears, global-install relocations, or npx upgrades — silently
 * 404-ing the hooks ... without any visible signal to the customer."
 *
 * Emitting `node ~/.massu/runtime/<version>/…/cli.js` would reintroduce that: probing at EMIT
 * time says nothing about INVALIDATION AFTER EMIT. The shim resolves it — a VERSION-STABLE
 * path that re-resolves AT FIRE TIME and falls back to npx when the runtime is gone, so a
 * stale registration degrades to "slower" and self-heals instead of dying.
 *
 * THE LOAD-BEARING PROPERTY IS THE FALLBACK. If the shim's npx branch ever breaks, every
 * repo pinned to a deleted runtime dies silently — the exact class this plan exists to end.
 * `(d)` therefore executes the real shim against a version with NO runtime and demands it
 * still succeed, and `(e)` mutates the runtime probe to prove the branch is reachable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { installMassuShim, resolveMassuShim, massuShimPath, massuShimBody } from '../commands/init.ts';

const isWin = process.platform === 'win32';
const d = isWin ? describe.skip : describe;

/**
 * EVERY install in this file goes into a SANDBOX home, never the operator's.
 *
 * This suite used to call `installMassuShim()` with no argument, which resolved `homedir()`
 * and wrote a live `~/.massu/bin/massu-hook` onto the developer's machine every time
 * `npm test` ran. Measured 2026-08-11: the real shim carried an mtime from the middle of a
 * test run. The file already isolated HOME for RUNNING the shim (see `runShim` below) and
 * missed the INSTALL — the write half is the half that gets missed.
 *
 * That write was not merely untidy. Once the shim exists, `resolveMassuShim()` returns
 * non-null, `hookCmd` takes the shim branch, and the anti-vacuity plant aimed at the npx
 * branch stops reaching any emitted command — which is exactly how
 * `init-hook-paths-no-absolute.test.ts` was found to be DECORATION. A test that mutates the
 * machine can silently change which code path every OTHER test exercises.
 *
 * Same class as `d76ab2c8` (memory-store root), one commit earlier in the same repo.
 */
let SANDBOX_HOME: string;

/** Existence + mtime of the operator's REAL shim, captured before anything runs. */
let realShimBefore: { existed: boolean; mtimeMs: number };

function realShimState(): { existed: boolean; mtimeMs: number } {
  const p = massuShimPath(homedir());
  try {
    return { existed: true, mtimeMs: statSync(p).mtimeMs };
  } catch {
    return { existed: false, mtimeMs: 0 };
  }
}

/** Run a shim copy in an isolated HOME so the real runtime tree is never consulted. */
function runShim(shimPath: string, args: string[], home: string): { status: number; stdout: string } {
  try {
    const stdout = execFileSync(shimPath, args, {
      encoding: 'utf-8',
      timeout: 120_000,
      env: { ...process.env, HOME: home },
    });
    return { status: 0, stdout };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { status: err.status ?? -1, stdout: err.stdout ?? '' };
  }
}

d('phase B — version-stable launcher shim', () => {
  beforeAll(() => {
    realShimBefore = realShimState();
    SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'massu-shim-sandbox-'));
    expect(installMassuShim(SANDBOX_HOME), 'installMassuShim() did not self-verify').toBe(true);
  });

  afterAll(() => {
    if (SANDBOX_HOME) rmSync(SANDBOX_HOME, { recursive: true, force: true });
  });

  it('(a) the shim path is VERSION-STABLE (contains no version token)', () => {
    // The whole point: a bump must not invalidate the emitted command.
    const p = massuShimPath(SANDBOX_HOME);
    expect(p).toMatch(/\.massu[/\\]bin[/\\]massu-hook$/);
    expect(p, 'shim path embeds a version — it would rot on the next bump').not.toMatch(/\d+\.\d+\.\d+/);
  });

  it('(b) it is installed, executable, and resolves', () => {
    expect(existsSync(massuShimPath(SANDBOX_HOME))).toBe(true);
    expect(resolveMassuShim(SANDBOX_HOME)).toBe(massuShimPath(SANDBOX_HOME));
  });

  it('(h) BLAST RADIUS: this suite installs a shim, and NOT into the real home', () => {
    // POSITIVE CONTROL FIRST. "The real home was untouched" is also what a suite that
    // installed NOTHING would report, so assert the write actually happened somewhere
    // before asserting where it did not happen (M1 — prove it looked).
    const sandboxShim = massuShimPath(SANDBOX_HOME);
    expect(existsSync(sandboxShim), 'no shim was installed anywhere — the check below is vacuous').toBe(true);
    expect(sandboxShim.startsWith(SANDBOX_HOME), 'the sandbox shim escaped its sandbox root').toBe(true);

    // Now the property: this run neither created nor rewrote the operator's shim.
    const after = realShimState();
    expect(after.existed, 'this suite CREATED a shim in the real home').toBe(realShimBefore.existed);
    if (realShimBefore.existed) {
      expect(after.mtimeMs, 'this suite REWROTE the shim in the real home').toBe(realShimBefore.mtimeMs);
    }
  });

  it('(c) the arg guard fires: no version argument exits 2', () => {
    const r = runShim(massuShimPath(SANDBOX_HOME), [], process.env.HOME ?? '');
    expect(r.status).toBe(2);
  });

  it('(d) FALLBACK: with NO runtime for the requested version, the shim still succeeds via npx', () => {
    // Isolated HOME => ~/.massu/runtime/<v> cannot exist => the npx branch MUST carry it.
    const home = mkdtempSync(join(tmpdir(), 'massu-shim-home-'));
    try {
      const r = runShim(massuShimPath(SANDBOX_HOME), ['2.4.0', '--version'], home);
      expect(r.status, 'the shim FAILED when the runtime was absent — a stale registration would die silently').toBe(0);
      expect(r.stdout).toContain('massu');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);

  it('(e) CAN-FAIL PROOF: a shim whose npx fallback is removed FAILS the same case', () => {
    // Mutate the body: drop the npx branch. If (d) still passed with this mutant, (d) would
    // be vacuous — it would not actually be testing the fallback.
    const home = mkdtempSync(join(tmpdir(), 'massu-shim-mut-'));
    const mutant = join(home, 'massu-hook-mutant');
    try {
      const broken = massuShimBody().replace(
        /exec npx -y "@massu\/core@\$\{MASSU_VERSION\}" "\$@"/,
        'echo "massu-hook: runtime missing and fallback removed" >&2; exit 27',
      );
      expect(broken, 'mutation target not found — the fallback line changed shape').toContain('exit 27');
      mkdirSync(dirname(mutant), { recursive: true });
      writeFileSync(mutant, broken, 'utf-8');
      chmodSync(mutant, 0o755);

      const r = runShim(mutant, ['2.4.0', '--version'], home);
      expect(r.status, 'the mutant SUCCEEDED — case (d) is not really exercising the fallback').toBe(27);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  it('(f) exit-code fidelity: a failing subcommand propagates a non-zero status', () => {
    const r = runShim(massuShimPath(SANDBOX_HOME), ['2.4.0', 'definitely-not-a-subcommand'], process.env.HOME ?? '');
    expect(r.status).not.toBe(0);
  }, 120_000);

  it('(g) idempotent: reinstalling is a no-op that still verifies', () => {
    expect(installMassuShim(SANDBOX_HOME)).toBe(true);
    expect(installMassuShim(SANDBOX_HOME)).toBe(true);
  });
});
