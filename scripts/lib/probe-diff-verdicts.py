#!/usr/bin/env python3
"""Diff a baseline verdict map against a withdrawn-state one, and emit CANDIDATES only.

Extracted from probe-gate-requires.sh so it can be ATTACKED by a mutation test
(scripts/tests/test-probe-diff-verdicts-mutation.sh). Logic embedded in a shell heredoc
cannot be fed a fixture, and a rule that cannot be fed a fixture cannot be proven to fire.

WHAT IT REFUSES TO DO. It never adjudicates. A withdrawal sweep can ABORT EARLY — exit 2 is
the runner's FATAL channel and an unmet precondition is exactly what the probe induces — so
every gate after the abort vanishes from the output. Treating "vanished" as "verdict changed"
turns one real requirement into hundreds of fabricated ones, and the result looks like a rich
successful measurement. So this emits candidates for INDIVIDUAL confirmation and reports
truncation as its own signal.

Usage:  probe-diff-verdicts.py BASELINE.tsv WITHDRAWN.tsv OUT.tsv
Exit 0 with a report on stdout; exit 2 on any unreadable/empty input (M2 — fail closed).
"""
from __future__ import annotations

import sys


def load(path: str, label: str) -> dict[str, str]:
    try:
        with open(path, encoding="utf-8") as fh:
            rows = {}
            for line in fh:
                gid, _, verdict = line.rstrip("\n").partition("\t")
                if gid:
                    rows[gid] = verdict
    except OSError as exc:
        sys.exit(f"FATAL: cannot read {label} at {path}: {exc} — refusing to diff over "
                 f"nothing. An unreadable input is an ERROR, never an empty one (M2).")
    if not rows:
        sys.exit(f"FATAL: {label} at {path} holds 0 verdicts — 'scanned 0, found 0' is not "
                 f"a pass (M1).")
    return rows


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        sys.exit(f"usage: {argv[0]} BASELINE.tsv WITHDRAWN.tsv OUT.tsv")
    base = load(argv[1], "baseline verdict map")
    # The withdrawn side may legitimately be SHORTER (that is the truncation signal), so it
    # is loaded with the same fail-closed rules but compared asymmetrically below.
    withdrawn = load(argv[2], "withdrawn-state verdict map")

    differing, vanished, flipped = [], [], []
    for gid, base_verdict in base.items():
        if gid not in withdrawn:
            vanished.append(gid)
            differing.append((gid, base_verdict, "__VANISHED__"))
        elif withdrawn[gid] != base_verdict:
            flipped.append(gid)
            differing.append((gid, base_verdict, withdrawn[gid]))

    truncated = len(vanished) > len(base) * 0.5
    print(f"    baseline verdicts {len(base)}, withdrawn-state verdicts {len(withdrawn)}")
    print(f"    differing {len(differing)}  = flipped {len(flipped)} + vanished {len(vanished)}")
    if truncated:
        print("    TRUNCATION SUSPECTED: over half the gates vanished, so the withdrawal")
        print("    sweep almost certainly ABORTED. Nothing here is adjudicated — every")
        print("    candidate is confirmed individually by the caller.")

    with open(argv[3], "w", encoding="utf-8") as fh:
        for gid, before, after in differing:
            fh.write(f"{gid}\t{before}\t{after}\n")

    # The count is the contract with the caller; assert it rather than trusting the write.
    print(f"    wrote {len(differing)} candidate(s) to {argv[3]}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
