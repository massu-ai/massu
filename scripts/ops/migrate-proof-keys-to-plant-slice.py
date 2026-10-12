#!/usr/bin/env python3
"""ONE-SHOT migration: re-stamp gate-proofs.json onto the plant-slice proof key.

⛔ WHY A MIGRATION AT ALL, AND WHY IT IS NOT AN AUTO-REFRESH.

`proof_key` changed on 2026-09-21 from hashing each plant target's WHOLE CONTENT to hashing
only the PLANT-RELEVANT SLICE (the regions its pattern matches, plus the match count) — see
`prove-gate-reddening.py:target_digest`. A hash-function change makes every one of the 272
stored fingerprints mismatch, so without a migration the entire ledger would read STALE and
demand a full ~1-hour DEFEAT re-prove of gates that nothing has touched.

The sound migration — and the ONLY one that preserves the guarantee — is:

    recompute the OLD key from the CURRENT tree.
      == stored key  -> the exact tree state that was PROVED RED is still in place, so the
                        verdict still holds. Re-stamp it with the NEW fingerprint of that same
                        verified state. No claim is created that was not already measured.
      != stored key  -> the proof was ALREADY stale before this migration. LEAVE IT ALONE. It
                        must be re-proved by measurement, not by re-stamping.

That distinction is the whole file. Re-stamping unconditionally would be the disarm: a proof
that refreshes itself whenever content moves can never go red (CR-72), which is precisely the
failure mode this ledger exists to prevent.

⛔ THE OLD KEY IS LOADED FROM GIT, NOT RE-IMPLEMENTED. Re-implementing it here would let this
script drift into agreement with its own misreading of the function it is checking (G15). So
the pre-migration module is read out of `--old-ref`, imported, and ITS OWN `proof_key` is
called. If that import fails this script EXITS 2 rather than migrating on a guess (M2). It also
refuses to run when the two derivations are byte-identical, so a migration that would change
nothing cannot masquerade as one that did something.

Note the failure direction is safe either way: if the old derivation were somehow wrong here,
NO key would match and NOTHING would be re-stamped — a loud zero, not a silent pass.

Usage:
    python3 scripts/ops/migrate-proof-keys-to-plant-slice.py --dry-run   # default
    python3 scripts/ops/migrate-proof-keys-to-plant-slice.py --write
    python3 scripts/ops/migrate-proof-keys-to-plant-slice.py --list
"""
import argparse
import importlib.util
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
LEDGER = os.path.join(REPO, "scripts", "lib", "gate-proofs.json")
REGISTRY = os.path.join(REPO, "scripts", "lib", "gate-registry.json")
PROVER_REL = "scripts/ops/prove-gate-reddening.py"


def die(msg, code=2):
    sys.stderr.write("FATAL: [migrate-proof-keys] %s\n" % msg)
    raise SystemExit(code)


def import_module_file(path, name):
    """Import a module by path, without running its __main__ block. Fails CLOSED."""
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        die("cannot build an import spec for %s" % path)
    mod = importlib.util.module_from_spec(spec)
    # the prover imports its per-gate prover from scripts/tests/
    sys.path.insert(0, os.path.join(REPO, "scripts", "tests"))
    try:
        spec.loader.exec_module(mod)
    except Exception as exc:  # noqa: BLE001 - never migrate on a guess (M2)
        die("could not import %s (%s): %s" % (name, path, exc))
    if not hasattr(mod, "proof_key"):
        die("%s exposes no proof_key() — refusing to migrate" % name)
    # The prover derives REPO from its OWN `__file__`. A copy staged outside the repo therefore
    # resolves every plant target to a path that does not exist, and `sha_file` returns "ABSENT"
    # for all of them — which silently makes every key mismatch. Pin the real locations.
    # (Caught by this script's own refuse-on-zero check rather than by review: the first run
    # reported 0 of 272 verifying. That is the fail-closed path earning its keep.)
    mod.REPO = REPO
    mod.REGISTRY = REGISTRY
    mod.LEDGER = LEDGER
    if not os.path.isdir(os.path.join(mod.REPO, "scripts", "lib")):
        die("%s: pinned REPO %r does not look like the repo root" % (name, mod.REPO))
    return mod


def old_prover(ref, workdir):
    """The PRE-migration prover, read out of git rather than re-implemented here (G15)."""
    out = subprocess.run(
        ["git", "-C", REPO, "show", "%s:%s" % (ref, PROVER_REL)],
        capture_output=True, text=True,
    )
    if out.returncode != 0 or not out.stdout.strip():
        die("cannot read %s:%s — %s" % (ref, PROVER_REL, out.stderr.strip()))
    staged = os.path.join(workdir, "prover_old.py")
    with open(staged, "w", encoding="utf-8") as fh:
        fh.write(out.stdout)
    return import_module_file(staged, "prover_old")


def new_prover():
    path = os.path.join(REPO, PROVER_REL)
    if not os.path.isfile(path):
        die("working-tree prover missing at %s" % path)
    return import_module_file(path, "prover_new")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--old-ref", default="HEAD",
                    help="git ref holding the PRE-migration prover (default: HEAD)")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--write", action="store_true", help="apply the migration")
    g.add_argument("--list", action="store_true", help="list per-gate disposition and exit")
    ap.add_argument("--dry-run", action="store_true",
                    help="report without writing (the default)")
    args = ap.parse_args()
    write = args.write

    for path in (LEDGER, REGISTRY):
        if not os.path.isfile(path):
            die("missing %s" % path)

    with open(LEDGER, encoding="utf-8") as fh:
        ledger = json.load(fh)
    with open(REGISTRY, encoding="utf-8") as fh:
        registry = json.load(fh)

    proofs = ledger.get("proofs")
    if not isinstance(proofs, dict) or not proofs:
        die("ledger has no proofs to migrate — refusing to report success over an empty set")
    gates = {g["id"]: g for g in registry.get("gates", []) if "id" in g}
    if not gates:
        die("registry yielded 0 gates — the read could not have worked")

    with tempfile.TemporaryDirectory(prefix="massu-proofkey-migrate-") as workdir:
        old = old_prover(args.old_ref, workdir)
        new = new_prover()
        if old.proof_key.__code__.co_code == new.proof_key.__code__.co_code:
            die("the %s prover and the working-tree prover derive keys IDENTICALLY — there is "
                "nothing to migrate, so this run would be a no-op dressed as a migration"
                % args.old_ref)
        return migrate(ledger, proofs, gates, old, new, args, write)


def migrate(ledger, proofs, gates, old, new, args, write):

    restamp, already_stale, orphan = [], [], []
    for gid, rec in sorted(proofs.items()):
        gate = gates.get(gid)
        if gate is None:
            orphan.append(gid)
            continue
        stored = rec.get("proof_key")
        if old.proof_key(gate) == stored:
            restamp.append((gid, stored, new.proof_key(gate)))
        else:
            already_stale.append(gid)

    total = len(proofs)
    print("DENOMINATOR proofs in ledger        : %d" % total)
    print("  re-stampable (old key verifies)   : %d" % len(restamp))
    print("  ALREADY STALE before migration    : %d  (left untouched — must be re-proved)"
          % len(already_stale))
    print("  orphaned (no registry gate)       : %d" % len(orphan))
    if len(restamp) + len(already_stale) + len(orphan) != total:
        die("dispositions do not sum to the denominator — refusing to write")
    if not restamp:
        die("0 of %d proofs verify under the %s key. Either --old-ref is wrong or the tree "
            "moved; re-stamping nothing rather than guessing." % (total, args.old_ref))

    if args.list:
        for gid in already_stale:
            print("  STALE   %s" % gid)
        for gid, _, _ in restamp:
            print("  RESTAMP %s" % gid)
        for gid in orphan:
            print("  ORPHAN  %s" % gid)
        return 0

    if not write:
        print("\nDRY RUN — nothing written. Re-run with --write to apply.")
        return 0

    for gid, _, newkey in restamp:
        proofs[gid]["proof_key"] = newkey
    # Serialise through the PROVER'S OWN writer, never a second json.dump here. A re-implemented
    # write path drifts from the real one and both still produce a plausible file: the first
    # draft of this script used indent=2 where `save_ledger` uses indent=1, so the very next
    # prover run rewrote every byte of the ledger. The live-fire caught it as "the ledger CHANGED
    # on an unmeasurable run" — a formatting difference wearing the costume of a broken
    # exit-2 invariant.
    new.save_ledger(ledger)

    # ASSERT THE END STATE (CR-69) — never infer it from having written the file.
    with open(LEDGER, encoding="utf-8") as fh:
        back = json.load(fh)["proofs"]
    bad = [gid for gid, _, newkey in restamp if back.get(gid, {}).get("proof_key") != newkey]
    if bad:
        die("re-read shows %d proof(s) did not persist: %s" % (len(bad), bad[:5]))
    print("\nWROTE %s — %d proof(s) re-stamped, %d left stale, re-read verified."
          % (os.path.relpath(LEDGER, REPO), len(restamp), len(already_stale)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
