#!/usr/bin/env python3
"""Evidence for plan-2026-07-26-anti-vacuity-9-unproven-gates §8 item 7 (X-1's detector).

WHY THIS EXISTS. X-1 annotates gates with `requires[]`. The question a detector must
answer is "does running this gate's proof REQUIRE artifact X". Two static detectors were
proposed. This script measures both against ground truth and shows that BOTH fail, in
OPPOSITE directions — which is why X-1's adjudicator is a differential execution probe
(G2: observe EXECUTION, not text) and not a grep.

  TEXTUAL   any `dist/` / `$HOME/massu` occurrence in the gate's source files.
            Its ANSWER IS AN ARTIFACT OF WHICH FILES YOU CHOOSE TO READ. Run with
            --source-set to see 17/55/177 fall out of the same predicate.
  DECLARED  paths the executor provably needs, from the registry's OWN execution-input
            fields — no regex over prose. Grounded in scripts/tests/_run_guard_defeat.py:
            a `replace` plant target that is absent raises PlantTargetAbsent (:120-121);
            `artifact` is asserted after build (:174-175).

Neither is used to author `requires[]`. TEXTUAL survives only as TRIAGE — ranking which
unadjudicated gates the probe should visit first — where over-firing costs a prompt to
run the probe rather than a bricked sweep.

Usage:
  python3 scripts/ops/compare-gate-requires-detectors.py [--source-set narrow|wide|scanner]
  python3 scripts/ops/compare-gate-requires-detectors.py --json
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter

REGISTRY = "scripts/lib/gate-registry.json"

# Ground truth: the gates plan §2 PROVED need a precondition, with §3 evidence.
# This is a measured set, not a hypothesis, and it is what gives "recall" meaning.
GROUND_TRUTH = {
    "scripts/tests/test-native-abi-selfheal.sh": "dist",
    "packages/core/src/__tests__/adapter-bundle-reproducibility.test.ts": "dist",
    "packages/core/src/__tests__/core-bundled-files-presence.test.ts": "dist",
    "packages/core/src/__tests__/session-start-drift.test.ts": "dist",
    "scripts/tests/test_boundary_guard_goes_red.sh": "public-mirror",
    "scripts/tests/test_private_boundary_files_never_shipped.sh": "public-mirror",
    "scripts/tests/test_publication_gates_anti_vacuity.sh": "public-mirror",
    "scripts/tests/test_install_hooks_context.sh": "full-git-history",
    "scripts/tests/test_leak_guard_ci_redaction.sh": "clean-ci-env",
}

DIST_PATH_RE = re.compile(r"(^|/)dist(/|$)")
DIST_TEXT_RE = re.compile(r"\bdist/")
MIRROR_TEXT_RE = re.compile(r"\$HOME/massu\b|\$\{HOME\}/massu\b|~/massu\b|PUBLIC_REPO")

# The three source sets that produce three different answers to one question.
SOURCE_SETS = {
    "narrow": ("test", "proof_script", "companion_script"),
    "wide": ("test", "proof_script", "companion_script", "path"),
    "scanner": ("test", "proof_script", "companion_script", "path", "scanner"),
}


def load_registry(path: str) -> list[dict]:
    """Fail CLOSED: an unreadable registry is an ERROR, never an empty gate list (M2)."""
    try:
        with open(path, encoding="utf-8") as fh:
            reg = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        sys.exit(f"FATAL: cannot read {path}: {exc} — refusing to report over 0 gates (M2).")
    gates = reg.get("gates")
    if not gates:
        sys.exit(f"FATAL: {path} holds no gates — 'scanned 0, found 0' is not a pass (M1).")
    return gates


def declared(gate: dict) -> set[str]:
    """Classes derivable from the registry's DECLARED execution inputs. No prose is read."""
    out: set[str] = set()
    plant = gate.get("plant")
    if isinstance(plant, list):
        for op in plant:
            if "write" in op:
                continue  # the plant CREATES it; absence is not a precondition
            targets = op.get("delete", []) if "delete" in op else [op.get("path", "")]
            for target in targets:
                if target and DIST_PATH_RE.search(target):
                    out.add("dist")
    if gate.get("artifact") and DIST_PATH_RE.search(gate["artifact"]):
        out.add("dist")
    if gate.get("recipe") == "dist-artifact":
        out.add("dist")
    return out


def textual(gate: dict, fields: tuple[str, ...]) -> tuple[set[str], int, int]:
    """Classes from a regex over the gate's source files. Returns (classes, read, unreadable)."""
    out: set[str] = set()
    read = unreadable = 0
    paths = [gate[f] for f in fields if gate.get(f)]
    if isinstance(gate.get("plant"), list):
        paths += [op["path"] for op in gate["plant"] if "path" in op]
    for rel in dict.fromkeys(paths):
        if not os.path.isfile(rel):
            continue
        try:
            src = open(rel, encoding="utf-8", errors="replace").read()
        except OSError:
            unreadable += 1
            continue
        read += 1
        if DIST_TEXT_RE.search(src):
            out.add("dist")
        if MIRROR_TEXT_RE.search(src):
            out.add("public-mirror")
    return out, read, unreadable


def gate_files(gate: dict) -> list[str]:
    return [gate[f] for f in ("test", "proof_script", "companion_script", "path") if gate.get(f)]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source-set", choices=sorted(SOURCE_SETS), default=None,
                    help="run ONE source set instead of all three")
    ap.add_argument("--registry", default=REGISTRY)
    ap.add_argument("--json", action="store_true", help="machine-readable summary")
    args = ap.parse_args()

    gates = load_registry(args.registry)
    sets_to_run = [args.source_set] if args.source_set else list(SOURCE_SETS)

    # Resolve ground truth to registry ids, and FAIL if any is missing — a recall figure
    # over a silently shrunken ground truth is the blind gate this plan is about.
    truth_ids: dict[str, str] = {}
    for path, cls in GROUND_TRUTH.items():
        hits = [g for g in gates if path in gate_files(g)]
        if not hits:
            sys.exit(f"FATAL: ground-truth gate has no registry row: {path} (M1/M2).")
        for g in hits:
            truth_ids[g["id"]] = cls

    print(f"registry              : {args.registry}")
    print(f"gates                 : {len(gates)}")
    print(f"ground-truth gates    : {len(truth_ids)} rows for {len(GROUND_TRUTH)} proven files")
    print()

    result: dict[str, object] = {"gates": len(gates), "textual": {}, "declared": {}}

    print("TEXTUAL — one predicate, three answers, differing only by which files it opens")
    print(f"  {'source set':<10} {'flagged':>8} {'files read':>11} {'unreadable':>11}   by class")
    for name in sets_to_run:
        fields = SOURCE_SETS[name]
        flagged, read, bad = {}, 0, 0
        for g in gates:
            cls, r, u = textual(g, fields)
            read += r
            bad += u
            if cls:
                flagged[g["id"]] = cls
        by = dict(Counter(c for s in flagged.values() for c in s))
        print(f"  {name:<10} {len(flagged):>8} {read:>11} {bad:>11}   {by}")
        recall = sum(1 for gid, c in truth_ids.items() if c in flagged.get(gid, set()))
        result["textual"][name] = {"flagged": len(flagged), "recall": recall,
                                   "of": len(truth_ids), "by_class": by}
        if bad:
            print(f"     *** {bad} unreadable source file(s) — a textual verdict over these is void (M2)")

    dec = {g["id"]: declared(g) for g in gates if declared(g)}
    dec_recall = sum(1 for gid, c in truth_ids.items() if c in dec.get(gid, set()))
    result["declared"] = {"flagged": len(dec), "recall": dec_recall, "of": len(truth_ids)}

    print()
    print("DECLARED — exact (no prose read), and under-selects")
    print(f"  flagged {len(dec)} gate(s); by class {dict(Counter(c for s in dec.values() for c in s))}")
    print()
    print("RECALL against the 9 gates §2 already PROVED need a precondition")
    for name in sets_to_run:
        r = result["textual"][name]
        print(f"  TEXTUAL/{name:<8} {r['recall']}/{r['of']}   (flags {r['flagged']} of {len(gates)} gates)")
    print(f"  DECLARED         {dec_recall}/{len(truth_ids)}   (flags {len(dec)} of {len(gates)} gates)")
    print()
    for gid, cls in sorted(truth_ids.items()):
        have = dec.get(gid, set())
        got = ",".join(sorted(have)) or "-"
        print(f"  {'HIT ' if cls in have else 'MISS'}  {cls:<17} {got:<10} {gid}")

    print()
    print("CONCLUSION — neither static detector may author `requires[]`.")
    print("  TEXTUAL  over-selects, and its count is a free parameter (see the table above).")
    print("  DECLARED under-selects: it misses gates whose precondition lives in the RUNTIME")
    print("           behaviour of a `self-proving` script, which is declared nowhere on disk.")
    print("  => the adjudicator is a differential execution probe (G2). See plan §8 item 7.")

    if args.json:
        print()
        print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
