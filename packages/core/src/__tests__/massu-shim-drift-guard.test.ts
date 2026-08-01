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
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { installMassuShim, resolveMassuShim, massuShimPath, massuShimBody } from '../commands/init.ts';

const isWin = process.platform === 'win32';
const d = isWin ? describe.skip : describe;

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
    expect(installMassuShim(), 'installMassuShim() did not self-verify').toBe(true);
  });

  it('(a) the shim path is VERSION-STABLE (contains no version token)', () => {
    // The whole point: a bump must not invalidate the emitted command.
    const p = massuShimPath();
    expect(p).toMatch(/\.massu[/\\]bin[/\\]massu-hook$/);
    expect(p, 'shim path embeds a version — it would rot on the next bump').not.toMatch(/\d+\.\d+\.\d+/);
  });

  it('(b) it is installed, executable, and resolves', () => {
    expect(existsSync(massuShimPath())).toBe(true);
    expect(resolveMassuShim()).toBe(massuShimPath());
  });

  it('(c) the arg guard fires: no version argument exits 2', () => {
    const r = runShim(massuShimPath(), [], process.env.HOME ?? '');
    expect(r.status).toBe(2);
  });

  it('(d) FALLBACK: with NO runtime for the requested version, the shim still succeeds via npx', () => {
    // Isolated HOME => ~/.massu/runtime/<v> cannot exist => the npx branch MUST carry it.
    const home = mkdtempSync(join(tmpdir(), 'massu-shim-home-'));
    try {
      const r = runShim(massuShimPath(), ['2.4.0', '--version'], home);
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
    const r = runShim(massuShimPath(), ['2.4.0', 'definitely-not-a-subcommand'], process.env.HOME ?? '');
    expect(r.status).not.toBe(0);
  }, 120_000);

  it('(g) idempotent: reinstalling is a no-op that still verifies', () => {
    expect(installMassuShim()).toBe(true);
    expect(installMassuShim()).toBe(true);
  });
});
