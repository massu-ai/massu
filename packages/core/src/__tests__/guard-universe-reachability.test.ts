/**
 * The two-tier entry-point denominator and the transitive closure.
 *
 * The tiers exist because `.git/hooks/*` and the machine-wide managed registry are MACHINE
 * STATE: `git clone` recreates them, so a CI runner and a working copy see different sets.
 * Blending them into one number hides which — and the error direction is the dangerous one,
 * since a script reachable only through a local hook would read REACHABLE here and DEAD in CI.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  enumerateEntryPoints,
  referencesFromSource,
  resolveStaticReferences,
} from '../guard-universe/resolve-static-references.ts';

const REPO_ROOT = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('entry-point enumeration — DERIVED, and TIERED', () => {
  it('enumerates both tiers and labels every entry point', () => {
    const eps = enumerateEntryPoints({ repoRoot: REPO_ROOT });
    expect(eps.length, 'enumerated no entry points at all').toBeGreaterThan(0);
    const tiers = new Set(eps.map((e) => e.tier));
    expect(tiers.has('tracked')).toBe(true);
    // Every entry point carries a tier and a kind; an unlabelled one would let the two
    // populations blend silently.
    for (const e of eps) {
      expect(['tracked', 'local-hook']).toContain(e.tier);
      expect(['shell', 'workflow-run', 'package-script', 'hook', 'claude-hook']).toContain(e.kind);
    }
  });

  it('the tracked tier includes workflows and BOTH settings files, discovered not listed', () => {
    const eps = enumerateEntryPoints({ repoRoot: REPO_ROOT });
    const kinds = eps.filter((e) => e.tier === 'tracked').map((e) => e.kind);
    expect(kinds).toContain('workflow-run');
    expect(kinds).toContain('package-script');
    // THE THIRD MECHANISM. Omitting the Claude Code settings source reported 11 live hook
    // scripts as unreachable residue — a false CR-71 finding.
    expect(kinds).toContain('claude-hook');
  });

  it('includeLocalHooks:false yields ONLY the reproducible tier', () => {
    const eps = enumerateEntryPoints({ repoRoot: REPO_ROOT, includeLocalHooks: false });
    expect(eps.length).toBeGreaterThan(0);
    expect(eps.every((e) => e.tier === 'tracked')).toBe(true);
  });
});

describe('the closure over the real repo', () => {
  it('reports its denominators and they are internally consistent', async () => {
    const r = await resolveStaticReferences({ repoRoot: REPO_ROOT });
    const d = r.denominator;
    // M1: every denominator asserted. "scanned 0, found 0" must never read as health.
    expect(d.entryPoints).toBeGreaterThan(0);
    expect(d.trackedShellFiles).toBeGreaterThan(100);
    expect(d.unitsParsed).toBeGreaterThan(0);
    expect(d.fixpointIterations).toBeGreaterThan(1); // more than one level, or it is not a closure
    expect(d.byTier.tracked + d.byTier['local-hook']).toBe(d.entryPoints);

    // Reachable-in-either-tier plus residue must exactly partition the tracked population.
    const union = new Set([...r.reachable.tracked, ...r.reachable['local-hook']]);
    expect(union.size + r.residue.length).toBe(d.trackedShellFiles);
  });

  it('THE STANDING COUNTEREXAMPLE is reachable and NOT in the residue', async () => {
    // Sourced one level BELOW an entry point via BASH_SOURCE indirection. A one-level sweep
    // reports it caller-less, which is exactly the false CR-71 finding this module must not
    // produce — and a first search in this repo did produce it.
    //
    // ⛔ THAT COMPANION FILE DOES NOT EXIST IN EVERY CHECKOUT. Its own loader documents the
    // arrangement: the operator-pattern companion may be absent, in which case the `source` is
    // skipped — "graceful absence by design". A test that simply asserted its presence
    // therefore failed in a checkout without it, caught by the Sync Check gate, which assembles
    // the other tree and runs its suite.
    //
    // The assertion is made conditional on EXISTENCE, never skipped silently: when the file is
    // present it MUST be reachable, and when it is absent the test still asserts something
    // real — that it is absent from the tracked population too, so a vanished file cannot
    // quietly turn this fixture into a no-op.
    const r = await resolveStaticReferences({ repoRoot: REPO_ROOT });
    const L = 'scripts/lib/leak-patterns-operator.sh';
    const tracked = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-z', '--', L], {
      encoding: 'utf8',
    })
      .split('\0')
      .filter(Boolean);

    if (tracked.length > 0) {
      expect(r.residue, `${L} is tracked here but was reported as dead`).not.toContain(L);
      expect(r.reachable.tracked).toContain(L);
    } else {
      // The public mirror. It must not appear anywhere, including the residue — a residue
      // entry for a file that does not exist would be its own defect.
      expect(r.residue).not.toContain(L);
      expect(r.reachable.tracked).not.toContain(L);
      expect(r.reachable['local-hook']).not.toContain(L);
    }
  });

  it('every unresolved reference is REPORTED with its raw text, never dropped', async () => {
    const r = await resolveStaticReferences({ repoRoot: REPO_ROOT });
    for (const u of r.unresolved) {
      expect(u.to).toBeNull();
      expect(u.unresolved, `an unresolved edge carried no raw text: ${JSON.stringify(u)}`).toBeTruthy();
    }
  });

  it('edges are DEDUPLICATED — both tiers walk overlapping files', async () => {
    const r = await resolveStaticReferences({ repoRoot: REPO_ROOT });
    const keys = r.edges.map((e) => `${e.from}\u0000${e.line}\u0000${e.to ?? ''}\u0000${e.kind}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('fail-closed', () => {
  it('a directory it cannot enumerate THROWS rather than reporting an empty clean result', async () => {
    // A non-repository makes `git ls-files` fail. The function must refuse rather than return
    // a well-formed report with zero entry points and an empty residue, which would read as
    // "nothing to see". Two explicit zero-denominator guards sit behind this as well.
    const d = mkdtempSync(join(tmpdir(), 'massu-reach-'));
    dirs.push(d);
    await expect(resolveStaticReferences({ repoRoot: d })).rejects.toThrow();
  });
});

describe('detection paths the closure depends on', () => {
  it('MUST FIRE — an ENV-PREFIXED invocation resolves to the script, not the assignment', async () => {
    // `MASSU_X=1 bash scripts/y.sh` parses with the variable_assignment BEFORE the command
    // name. Leaving it in the argument list made the first "argument" the assignment text, so
    // env-prefixed invocations resolved to nothing and were reported as unresolved references
    // to `NODE_PATH="$REPO_ROOT/node_modules"`.
    const refs = await referencesFromSource('MASSU_X=1 bash scripts/y.sh\n', 'f.sh', REPO_ROOT);
    expect(refs.map((r) => r.to)).toContain('scripts/y.sh');
  });

  it('MUST FIRE — $CLAUDE_PROJECT_DIR resolves to the repo root', async () => {
    const refs = await referencesFromSource(
      'bash "$CLAUDE_PROJECT_DIR/scripts/hooks/h.sh"\n',
      '.claude/settings.json',
      REPO_ROOT
    );
    expect(refs.map((r) => r.to)).toContain('scripts/hooks/h.sh');
  });

  it('the closure follows a chain TRANSITIVELY, not one level', async () => {
    // Asserted structurally on the real repo: the fixpoint ran more than one round, and a
    // file only reachable via another file is present.
    const r = await resolveStaticReferences({ repoRoot: REPO_ROOT });
    expect(r.denominator.fixpointIterations).toBeGreaterThan(2);
    // pre-push-light.sh is an entry point; the leak-patterns library is hops beyond it. This
    // one is present in BOTH the internal repo and the public mirror, so it is the portable
    // witness that the closure is transitive rather than one-level.
    expect(r.reachable.tracked).toContain('scripts/lib/leak-patterns.sh');
  });
});
