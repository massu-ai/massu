// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/*
 * GATE-PLANT LIVENESS drift-guard (G-6 hardening, incident 2026-07-23).
 *
 * THE BUG CLASS THIS CLOSES — "the fixture rots, and only a 1-hour sweep notices."
 *
 * Every `source-plant` gate in `scripts/lib/gate-registry.json` proves its guard can FAIL by
 * planting a defect into a target source file: it regex-matches `pattern` and rewrites it to
 * `replace`. If the target source LEGITIMATELY changes (a constant is retuned, an import gains a
 * symbol, a version is bumped, a check is deleted), the pattern silently stops matching. The plant
 * then mutates NOTHING, the guarded test stays GREEN under the "planted defect", and the sweep
 * reports `PLANT changed nothing — the mutation is inert`.
 *
 * An inert plant is WORSE than a missing one: the registry still lists the gate as proven, so the
 * gate reads as can-fail when it has actually stopped being exercised at all.
 *
 * Until now the ONLY thing that detected this was the full anti-vacuity DEFEAT sweep — which takes
 * ~1 hour, runs only in CI, and was itself masked by other CI failures. That is how FIVE plants
 * rotted unnoticed across the 1.16.3 → 2.0.0 → 2.2.0 releases (incident 2026-07-23):
 *   - cloud-sync-timeout-budget   : pattern `8_000`,  source retuned to `15_000`
 *   - node-compat-drift-guard     : pattern `>=20.0.0`, engines floor moved to `>=22.16.0`
 *   - node-bootstrap-exec-safety  : fs import gained `realpathSync`
 *   - plan-token-changelog-coverage: pattern pinned the LITERAL version `1.16.3` (rots EVERY release)
 *   - truthful-doctor             : its mutation target was DELETED outright (CR-69 native-free)
 *
 * This guard makes that failure LOUD and FAST: it asserts every plant pattern still matches its
 * target, so rot fails in `npm test` (pre-commit) the moment the source moves — instead of an hour
 * into CI, or not at all. It is a static liveness check; it does NOT replace the DEFEAT sweep
 * (which proves the mutation actually reddens the test), it makes the sweep's precondition
 * enforceable cheaply.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const REGISTRY = resolve(REPO_ROOT, 'scripts', 'lib', 'gate-registry.json');

interface PlantEntry {
  path?: string;
  pattern?: string;
  replace?: string;
}
interface Defect {
  name?: string;
  replace?: PlantEntry[];
}
interface Gate {
  id?: string;
  fail_point?: string;
  plant?: PlantEntry[];
  defects?: Defect[];
}

function loadGates(): Gate[] {
  const raw = JSON.parse(readFileSync(REGISTRY, 'utf-8')) as { gates?: Gate[] };
  return raw.gates ?? [];
}

/**
 * Collect EVERY pattern-bearing mutation in the registry, from BOTH shapes:
 *   (1) `gates[].plant[]`              — vitest-guard / source-plant recipes
 *   (2) `gates[].defects[].replace[]`  — shell-failpoint (pattern-scanner) recipes
 *
 * Covering only (1) is how `inject-shell-true-exec` and `inject-windows-path-resolver-read`
 * stayed inert after this guard's first version shipped: both are shape (2), both re-used the
 * SAME stale `fs`-import anchor as the vitest exec-safety plant, and the guard silently skipped
 * them. A liveness check that inspects only one plant shape has the same blind spot it exists to
 * eliminate — so this collector is the load-bearing part of the guard.
 */
function collectMutations(): Array<{ owner: string; entry: PlantEntry }> {
  const out: Array<{ owner: string; entry: PlantEntry }> = [];
  for (const gate of loadGates()) {
    const owner = gate.id ?? gate.fail_point ?? '<unnamed gate>';
    for (const p of gate.plant ?? []) out.push({ owner, entry: p });
    for (const d of gate.defects ?? []) {
      for (const r of d.replace ?? []) {
        out.push({ owner: `${owner} :: defect ${d.name ?? '<unnamed>'}`, entry: r });
      }
    }
  }
  return out;
}

describe('gate-registry plant liveness (G-6 hardening, incident 2026-07-23)', () => {
  it('the registry is present and declares plant-bearing gates (anti-vacuity of THIS guard)', () => {
    // A guard that silently scans zero gates would pass forever. Refuse an empty universe.
    expect(existsSync(REGISTRY), `gate-registry.json missing at ${REGISTRY}`).toBe(true);
    const muts = collectMutations();
    expect(
      muts.length,
      'ZERO pattern-bearing mutations discovered — the registry moved or its shape changed; ' +
        'this guard would be vacuous. Fix the collector, do not delete the assertion.',
    ).toBeGreaterThan(50);
    // BOTH shapes must be represented, or the collector has regressed to a single-shape blind spot.
    const gates = loadGates();
    expect(gates.filter((g) => (g.plant ?? []).length > 0).length, 'no `plant[]` gates found').toBeGreaterThan(50);
    expect(
      gates.filter((g) => (g.defects ?? []).some((d) => (d.replace ?? []).length > 0)).length,
      'no `defects[].replace[]` fail-points found — the shell-failpoint shape is not being scanned',
    ).toBeGreaterThan(5);
  });

  it('EVERY source-plant pattern still matches its target file (no inert plants)', () => {
    const inert: string[] = [];
    const missing: string[] = [];
    const badRegex: string[] = [];
    let live = 0;

    for (const { owner, entry } of collectMutations()) {
      const { path: target, pattern } = entry;
      if (!target || pattern === undefined) continue;

      const abs = resolve(REPO_ROOT, target);
      if (!existsSync(abs)) {
        missing.push(`${owner}\n    target file does not exist: ${target}`);
        continue;
      }

      let re: RegExp;
      try {
        re = new RegExp(pattern, 'm');
      } catch (e) {
        badRegex.push(`${owner}\n    invalid regex: ${pattern}\n    ${String(e)}`);
        continue;
      }

      if (re.test(readFileSync(abs, 'utf-8'))) live += 1;
      else inert.push(`${owner}\n    target : ${target}\n    pattern: ${pattern}`);
    }

    expect(missing, `Plant target file(s) missing:\n\n${missing.join('\n\n')}\n`).toEqual([]);
    expect(badRegex, `Plant pattern(s) are not valid regex:\n\n${badRegex.join('\n\n')}\n`).toEqual([]);
    expect(
      inert,
      `\n${inert.length} INERT PLANT(S) — the pattern matches NOTHING in its target, so the ` +
        `"planted defect" mutates nothing and the guard is NOT actually proven can-fail:\n\n` +
        `${inert.join('\n\n')}\n\n` +
        `FIX: re-derive each pattern from the CURRENT source. Prefer a pattern that is stable ` +
        `against benign edits (avoid pinning a literal version/constant that changes every ` +
        `release — that rots by design). Then re-prove with:\n` +
        `  bash scripts/massu-gate-anti-vacuity.sh --gate "<gate id>"\n`,
    ).toEqual([]);

    // Anti-vacuity: having found no inert plants must mean we actually checked a real corpus.
    expect(live, 'no live plants were verified — the scan matched nothing at all').toBeGreaterThan(50);
  });
});
