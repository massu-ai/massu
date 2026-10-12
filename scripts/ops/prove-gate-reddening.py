#!/usr/bin/env python3
# X-6a of docs/plans/2026-07-26-anti-vacuity-9-unproven-gates.md
#
# prove-gate-reddening — does each registered plant still make its guard go RED?
#
# ⛔ WHY THIS EXISTS. A plant can go inert two ways, and until now only one of them had a
# detector cheap enough to run per commit:
#
#   pattern stops MATCHING its target  -> gate-plant-liveness-drift-guard, in `npm test`, ms
#   pattern matches, the test does not -> the anti-vacuity DEFEAT sweep, ~1 hour, CI only
#   NOTICE the defect
#
# Measured 2026-09-21: seven newly registered gates passed `--completeness-only` (exit 0) and
# the liveness guard (`dead plants: 0`), and TWO of them stayed GREEN under their own plants.
# Both plants matched perfectly. Neither proved anything. `--completeness-only` asks "does
# every guard carry a can-fail proof?" — a PRESENCE question about the registry — and cannot
# ask "does that proof prove anything?". The two return the same green, which is the
# blind-gate law aimed at the system that certifies every other gate in this repo.
#
# ⛔ WHY A LEDGER RATHER THAN RUNNING THE SWEEP MORE OFTEN. 453 gates x (plant + full vitest +
# restore) is the hour. A routine commit does not change 453 gates; it changes one or two. The
# expensive thing is re-proving what has not moved. So a gate's RED verdict is PINNED to the
# triple that can invalidate it — the gate's own plant spec, the PLANT-RELEVANT SLICE of every
# file the plant writes (see `target_digest`: the matched regions and their count, NOT the whole
# file), and the content of the test it reddens. If none moved, the verdict still holds. If any
# moved, the proof is STALE and the gate reads as UNPROVEN until re-proved.
#
# ⛔ THE SLICE IS THE POINT, AND IT WAS WHOLE-FILE UNTIL 2026-09-21. Whole-file hashing made the
# key a CORRELATE of "can this plant still redden this test" rather than that property itself
# (G28/CR-91), so any unrelated edit to a shared target — `package.json` above all — invalidated
# verdicts it could not affect. Measured across the two open Dependabot PRs: 6 of 7 stale proofs
# had an UNCHANGED matched region. Every dependency bump therefore demanded re-proves that
# measured nothing, and Dependabot cannot run the prover — the exact friction that gets a gate
# disabled (CR-72). Note the remaining 1 of 7 SHOULD be stale and still is: that bump moved
# `@upstash/redis`, which is the very line its plant rewrites.
#
# This is not a new pattern. `scripts/lib/exempt-reasons.json` + `stamp-exempt.py` already pin
# a RULING to a CONTENT HASH, and the sweep's invariant (iv) fails on "content-hash mismatch —
# file edited since ruling". X-6 is that pattern applied to GATE rows instead of EXEMPT rows.
#
# ⛔ REUSE, DO NOT REIMPLEMENT (Rule 25). The per-gate prover already exists —
# `scripts/tests/_run_guard_defeat.py:run()` — and its exit codes are already the G26/CR-89
# trichotomy that this ledger depends on:
#
#       0  proved RED — the guard can fail
#       1  stayed GREEN under its own plant -> DECORATION, a defect
#       2  COULD NOT MEASURE (dirty tree, PLANT TARGET ABSENT, unknown recipe, restore leak)
#
# ONLY EXIT 0 MAY WRITE A PROOF, AND EXIT 2 MAY NEVER CLEAR A STALE ONE. Could-not-measure and
# proved-good are precisely the two states that must not share a value.
#
# ⛔ PRIOR ART, AND THE LIMITATION IT HANDED US. This is INCREMENTAL MUTATION TESTING, settled
# for a decade: a reddening proof is a KILLED MUTANT, a DECORATION finding is a SURVIVED
# MUTANT, and this ledger is a HISTORY FILE. PIT reuses a result when "neither the class under
# test OR THE KILLING TEST has changed" (pitest.org/quickstart/incremental_analysis); StrykerJS
# does the same over mutated and test files. The TEST half is load-bearing and is the half that
# is easy to omit — StrykerJS carries a reported bug of exactly that shape — and it is the half
# the two 2026-09-21 failures needed, because both plants matched and the defect lived in the
# test.
#
# StrykerJS states the limitation plainly, and THIS TOOL INHERITS IT EXACTLY:
#
#     "Stryker will not detect any changes you've made in files other than mutated files and
#      test files. Other changes to your environment are not detected..."
#
# So the key below does NOT cover a helper module the test imports, vitest.config.ts,
# massu.config.yaml, an environment variable, or a dependency bump. A proof can therefore read
# CURRENT while the reddening no longer holds. That is a FINDING, not a disclosure (G20), and
# it is the precise reason this tool DOES NOT REPLACE the full DEFEAT sweep (plan item Z-1):
# the periodic sweep is the only thing that catches the axes a content key cannot see.
import argparse, hashlib, json, os, re, subprocess, sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
REGISTRY = os.path.join(REPO, "scripts", "lib", "gate-registry.json")
LEDGER = os.path.join(REPO, "scripts", "lib", "gate-proofs.json")

sys.path.insert(0, os.path.join(REPO, "scripts", "tests"))
sys.path.insert(0, os.path.join(REPO, "scripts", "lib"))

# Every phrase a caller may assert on comes from ONE definition, so a reworded message
# cannot silently de-arm an assertion typed at the consumer. See scripts/lib/gate_sentinels.py.
from gate_sentinels import sentinel  # noqa: E402  (path prepended above)


def sha_file(path):
    """Content hash of a repo-relative file, or a distinct marker when it is absent.

    An ABSENT file must hash differently from an empty one: a plant target that vanished is
    exactly the condition that invalidates a proof, and returning the empty-string hash for it
    would let a deleted target keep a stale verdict alive.
    """
    full = os.path.join(REPO, path)
    if not os.path.isfile(full):
        return "ABSENT"
    with open(full, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def plant_ops_by_path(gate):
    """Every plant op, grouped by the file it writes, in declared order.

    Derived from the plant spec rather than from a list, so a plant that grows a second target
    is covered on its first commit (G32). Returns {path: [op, ...]}; `plant_targets` is the
    key set, kept as a helper so callers that only need paths stay unchanged.
    """
    plant = gate.get("plant")
    ops = plant if isinstance(plant, list) else ([plant] if isinstance(plant, dict) else [])
    by = {}
    for op in ops:
        if not isinstance(op, dict):
            continue
        paths = []
        if "path" in op:
            paths.append(op["path"])
        if "write" in op:
            paths += list(op["write"].keys())
        if "delete" in op:
            paths += op["delete"]
        for pth in paths:
            by.setdefault(pth, []).append(op)
    return by


def plant_targets(gate):
    """Every file the gate's plant writes — the same extraction _run_guard_defeat.py does."""
    return sorted(plant_ops_by_path(gate))


def target_digest(path, ops):
    """The PLANT-RELEVANT SLICE of a plant target — never the whole file.

    ⛔ WHY NOT `sha_file`. Hashing the whole target made the key a CORRELATE of the property
    instead of the property itself (G28/CR-91). The plant for
    `website/src/__tests__/security-packages-pinned.test.ts` rewrites ONE line of
    `website/package.json`, but the key covered all ~120 lines — so bumping an unrelated
    dependency invalidated a verdict it could not possibly affect. Measured 2026-09-21 across
    the two open Dependabot PRs: 6 of 7 stale proofs had an UNCHANGED matched region, i.e.
    six of seven re-proves were pure friction. Friction is how a gate gets disabled (CR-72).

    The slice is: for each pattern op, the ordered text of every region the pattern MATCHES,
    plus the MATCH COUNT. That is exactly what determines whether the plant still applies and
    what it would write. A second occurrence appearing, an occurrence vanishing, or the planted
    line's own content moving all change the digest; an unrelated line does not.

    An op that is not a pattern substitution (`write` / `delete`) replaces or removes the file
    wholesale, so nothing narrower than the whole content is sound for those — they keep
    whole-file hashing. An ABSENT target keeps its distinct marker: a plant target that vanished
    is exactly the condition that must invalidate a proof.

    Fails CLOSED: a pattern that does not compile is a FATAL error, never a skipped part that
    would silently shrink the key (BLIND-GATE LAW / M2).
    """
    full = os.path.join(REPO, path)
    if not os.path.isfile(full):
        return "ABSENT"
    with open(full, "rb") as fh:
        raw = fh.read()
    if any("pattern" not in op for op in ops):
        return "whole:" + hashlib.sha256(raw).hexdigest()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return "whole:" + hashlib.sha256(raw).hexdigest()
    parts = []
    for op in ops:
        try:
            # re.M mirrors `_run_guard_defeat.py:130`, which is what APPLIES the plant. A
            # different flag set here would digest regions the planter never touches.
            rx = re.compile(op["pattern"], re.M)
        except re.error as exc:
            sys.stderr.write(
                f"FATAL: plant pattern for '{path}' does not compile: {exc}\n"
                f"       Refusing to derive a proof key from a pattern that cannot be applied.\n"
            )
            raise SystemExit(2)
        found = [m.group(0) for m in rx.finditer(text)]
        parts.append("n=%d" % len(found))
        parts.extend(found)
    return "slice:" + hashlib.sha256("\x00".join(parts).encode("utf-8")).hexdigest()


def proof_key(gate):
    """The triple whose change invalidates a RED verdict.

    (1) the gate's own plant/test/oracle spec — retuning the plant is a new claim;
    (2) the content of every file the plant writes — the defect may no longer be a defect;
    (3) the content of the test — the assertion that noticed it may have moved or been parked.

    (3) is the one the two 2026-09-21 failures needed: both plants matched their targets
    perfectly, and what was wrong lived in the test.
    """
    spec = json.dumps(
        {"plant": gate.get("plant"), "test": gate.get("test"), "oracle": gate.get("oracle")},
        sort_keys=True, separators=(",", ":"),
    )
    parts = ["spec:" + hashlib.sha256(spec.encode()).hexdigest()]
    for t, ops in sorted(plant_ops_by_path(gate).items()):
        parts.append(f"target:{t}:{target_digest(t, ops)}")
    test = gate.get("test")
    if test:
        parts.append(f"test:{test}:{sha_file(test)}")
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()


def provable_gates(reg):
    """The candidate set, DERIVED from the registry — never a roster.

    Scoped to `source-plant`, because that is the recipe whose can-fail proof is a MUTATION
    that a test must notice. `companion` / `self-proving` gates name a script that IS the
    proof and whose exit code is already the verdict; `dist-artifact` requires a build step
    and belongs to the sweep. Those exclusions are stated here rather than left implicit —
    every exclusion is a blind spot someone chose (G18).
    """
    return [
        g for g in reg["gates"]
        if g.get("kind") == "vitest-guard" and g.get("recipe") == "source-plant"
    ]


def load_ledger():
    if not os.path.isfile(LEDGER):
        return {"proofs": {}}
    with open(LEDGER, encoding="utf-8") as fh:
        return json.load(fh)


def save_ledger(led):
    with open(LEDGER, "w", encoding="utf-8") as fh:
        json.dump(led, fh, indent=1, sort_keys=True)
        fh.write("\n")


LEDGER_REL = os.path.relpath(LEDGER, REPO)


def git_dirty():
    """Paths that would make a restore-leak assertion unreadable.

    ⛔ THE LEDGER ITSELF IS EXCLUDED, AND THAT EXCLUSION IS LOAD-BEARING. This tool WRITES
    `gate-proofs.json` and also READS the tree before planting. Without this exclusion the
    first successful run dirties the tree with its own output and every subsequent run
    refuses — a ONE-SHOT ADJUDICATOR whose first success disables it (G26/CR-89). Measured
    2026-09-21: run 1 proved a gate, run 2 exited 2 naming `?? scripts/lib/gate-proofs.json`.
    The same trap already bit this plan's X-1 probe.

    The exclusion is SAFE for the reason the check exists: the ledger is never a plant
    target, so a modification to it cannot be confused with a leaked plant. Every other path
    still counts — and `_run_guard_defeat.py` independently re-checks the specific files each
    plant touches, before and after, which is the precise half of this guarantee.
    """
    r = subprocess.run(["git", "status", "--porcelain"], cwd=REPO,
                       capture_output=True, text=True)
    if r.returncode != 0:
        return None  # M2: could not ask -> caller fails closed, never assumes clean.
    out = []
    for l in r.stdout.split("\n"):
        if not l.strip():
            continue
        # porcelain v1: XY<space>path ; a rename carries " -> ", whose destination is the path
        path = l[3:].split(" -> ")[-1].strip().strip('"')
        if path == LEDGER_REL:
            continue
        out.append((l, path))
    return out


def main():
    ap = argparse.ArgumentParser(description="Prove each registered plant still reddens its guard.")
    ap.add_argument("--all", action="store_true",
                    help="re-prove every gate, ignoring a current proof (establishes the ledger)")
    ap.add_argument("--list", action="store_true", help="show each gate's proof state; write nothing")
    ap.add_argument("--dry-run", action="store_true", help="name what would be re-proved; write nothing")
    ap.add_argument("--gates", default="", help="comma-separated gate ids to restrict to")
    a = ap.parse_args()

    if not os.path.isfile(REGISTRY):
        print(f"FATAL: registry not found: {REGISTRY}", file=sys.stderr)
        return 2
    with open(REGISTRY, encoding="utf-8") as fh:
        reg = json.load(fh)

    gates = provable_gates(reg)
    total_registry = len(reg.get("gates", []))

    # M1/M2 — a candidate set that collapsed to zero reports "0 unproven" and reads healthy.
    if not gates:
        print(f"FATAL: 0 source-plant gates derived from {total_registry} registry gate(s) — "
              f"refusing. A census over an empty candidate set cannot distinguish "
              f"'all proved' from 'I could not look'.", file=sys.stderr)
        return 2

    if a.gates:
        want = {x.strip() for x in a.gates.split(",") if x.strip()}
        unknown = want - {g["id"] for g in gates}
        if unknown:
            # R-011 — an unmatched argument is refused, never resolved to a likely candidate.
            print(f"FATAL: not source-plant gates in this registry: {sorted(unknown)}", file=sys.stderr)
            return 2
        gates = [g for g in gates if g["id"] in want]

    led = load_ledger()
    proofs = led.setdefault("proofs", {})

    current, stale, missing = [], [], []
    for g in gates:
        key = proof_key(g)
        rec = proofs.get(g["id"])
        if rec is None:
            missing.append((g, key))
        elif rec.get("proof_key") != key:
            stale.append((g, key))
        else:
            current.append((g, key))

    # M1 — the denominator, every run, before any verdict.
    print(f"registry gates                 : {total_registry}")
    print(f"source-plant gates (derived)   : {len(gates)}")
    print(f"  proof CURRENT                : {len(current)}")
    print(f"  proof {sentinel('proof-stale')} (content moved)  : {len(stale)}")
    print(f"  proof MISSING (never proved) : {len(missing)}")

    if a.list:
        for g, _ in sorted(missing, key=lambda x: x[0]["id"]):
            print(f"  MISSING  {g['id']}")
        for g, _ in sorted(stale, key=lambda x: x[0]["id"]):
            print(f"  {sentinel('proof-stale')}    {g['id']}")
        return 0

    todo = [(g, proof_key(g)) for g in gates] if a.all else (missing + stale)
    if not todo:
        print(f"\n{sentinel('nothing-to-prove')} — every derived gate carries a proof "
              f"pinned to its current content.")
        return 0

    if a.dry_run:
        print(f"\nwould re-prove {len(todo)} gate(s):")
        for g, _ in sorted(todo, key=lambda x: x[0]["id"]):
            print(f"  {g['id']}")
        return 0

    # The prover plants into the REAL tree and restores; a pre-existing dirty tree makes a
    # restore-leak check unreadable, and the executor refuses anyway (exit 2). Say so here,
    # once, instead of letting every gate fail the same way.
    dirty = git_dirty()
    if dirty is None:
        print("FATAL: `git status` failed — refusing rather than assuming a clean tree.", file=sys.stderr)
        return 2
    # ⛔ SCOPED TO WHAT THIS RUN TOUCHES, not to the whole tree (2026-09-21).
    #
    # A whole-tree refusal has NO LEGAL ORDERING for registering a new gate, and a gate you
    # cannot reach a passing state for is a brick (G26/CR-89): proving needs a clean tree, and
    # committing the registration needs the proof, because the drift guard fails on MISSING.
    # Measured: registering one gate made `npm test` red, which blocked the commit, which was
    # the only way to clean the tree the prover demanded.
    #
    # The scoped predicate is the PROPERTY rather than a correlate of it (G28/CR-91): the check
    # exists so a pre-existing edit cannot be mistaken for a leaked plant, which can only happen
    # in a file this run actually plants into or reads as a test. This is the SAME reasoning the
    # ledger exclusion above already relies on — "the ledger is never a plant target, so a
    # modification to it cannot be confused with a leaked plant" — and that docstring already
    # names `_run_guard_defeat.py`'s per-plant before/after check as "the precise half of this
    # guarantee". That half is unchanged and still runs for every plant.
    in_scope = set()
    for g, _k in todo:
        in_scope.update(plant_targets(g))
        if g.get("test"):
            in_scope.add(g["test"])
    blocking = [(l, pth) for (l, pth) in dirty if pth in in_scope]
    print(f"dirty paths                    : {len(dirty)} "
          f"(in scope for this run: {len(blocking)} of {len(in_scope)} touched path(s))")
    if blocking:
        print(f"FATAL: {len(blocking)} path(s) THIS RUN PLANTS INTO or READS "
              f"{sentinel('dirty-tree')}\n"
              f"  Each proof mutates a real source file and restores it; a pre-existing\n"
              f"  modification to one of THESE files makes the restore-leak assertion\n"
              f"  unreadable. Commit or stash just these, then re-run.",
              file=sys.stderr)
        for l, _pth in blocking[:10]:
            print(f"    {l}", file=sys.stderr)
        return 2

    import _run_guard_defeat  # noqa: E402  (path prepended above)

    proved = decoration = unmeasurable = 0
    for g, key in sorted(todo, key=lambda x: x[0]["id"]):
        gid = g["id"]
        print(f"\n── proving {gid} ──", flush=True)
        rc = _run_guard_defeat.run(REGISTRY, REPO, gid)
        if rc == 0:
            proofs[gid] = {
                "proof_key": key,
                "verdict": "RED",
                "proved_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }
            proved += 1
        elif rc == 1:
            # A DEFECT, and the whole reason this tool exists. The prior proof is left exactly
            # as it was: this run did not disprove the old content, it disproved the new.
            print(f"DECORATION [{gid}] stayed GREEN under its own plant — the gate proves nothing.",
                  file=sys.stderr)
            decoration += 1
        else:
            # ⛔ EXIT 2 IS NOT A VERDICT. Leave any existing proof untouched: overwriting it
            # would let "I could not look" erase a real RED, and clearing it would let a
            # missing build masquerade as a defect.
            print(f"UNMEASURABLE [{gid}] the prover could not measure this gate (exit 2) — "
                  f"any existing proof is left unchanged.", file=sys.stderr)
            unmeasurable += 1

    save_ledger(led)

    print(f"\nattempted    : {len(todo)}")
    print(f"  proved RED : {proved}")
    print(f"  DECORATION : {decoration}")
    print(f"  UNMEASURABLE: {unmeasurable}")

    if decoration:
        print(f"\nFAIL: {decoration} gate(s) stayed GREEN under their own plant.", file=sys.stderr)
        return 1
    if unmeasurable:
        print(f"\nFAIL: {unmeasurable} gate(s) could not be measured — that is not a pass.",
              file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
