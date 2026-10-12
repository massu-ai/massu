#!/usr/bin/env python3
"""ONE definition of every diagnostic phrase a gate tool EMITS and another ASSERTS on.

WHY THIS FILE EXISTS
--------------------
`scripts/ops/live-fire-reddening-proof-guard.sh` asserted its 4a scenario by grepping the
prover's output for `working tree is DIRTY`. The prover has NEVER printed that phrase — it
belongs to `scripts/ops/probe-gate-requires.sh`. So the check could only ever fail, and it
did, silently, until a full 462-gate sweep surfaced it. The two other assertions in that
same scenario passed (exit 2 was correct, the ledger was untouched), which made a DEAD PIN
look like a near-miss rather than an assertion that can never hold.

This is the SECOND occurrence of a pinned-expectation defect in that one file; the first is
recorded in memory `a-positive-control-must-reach-the-branch-it-names`, where a check
demanded exit 2 for one reason using an input that could only produce another. A pin is the
RIGHT kind of assertion (CR-72/G2 — observe execution, not text), but a pin whose literal is
typed at the CONSUMER has no link to the PRODUCER, so a reworded message de-arms the check
with no diff, no error and no log line.

THE PROPERTY THIS ESTABLISHES: an asserter cannot name a phrase its emitter does not print,
because both read the phrase from HERE. Renaming a message is then a one-line change that
updates every assertion with it, and an unknown key is a LOUD failure rather than a grep
that quietly matches nothing.

Consumers in shell read a phrase with:

    P="$(python3 scripts/lib/gate_sentinels.py --print dirty-tree)" || exit 2

and must FAIL CLOSED on an empty value — a sentinel that could not be read must never
degrade into `grep -q ''`, which matches every line and turns the assertion green.
"""
from __future__ import annotations

import sys

# CLOSED VOCABULARY (G3): an unknown key is an ERROR, never a skipped row that reads as a
# pass. Keys are stable identities; the VALUES are what the tools print and may be reworded.
SENTINELS: dict[str, str] = {
    # prove-gate-reddening.py — refuses to plant into a path that is already modified
    "dirty-tree": "are DIRTY. Refusing to plant.",
    # _run_guard_defeat.py — the gate's plant target does not exist (could-not-measure)
    "plant-target-absent": "PLANT TARGET ABSENT",
    # prove-gate-reddening.py — a recorded proof no longer matches its subject's content
    "proof-stale": "STALE",
    # prove-gate-reddening.py — every derived gate already carries a current proof
    "nothing-to-prove": "nothing to prove",
}


def sentinel(key: str) -> str:
    """The phrase for `key`. Raises KeyError — never returns '' — on an unknown key.

    Returning a default here would be the blind gate: `grep -q ''` matches everything, so a
    typo'd key would turn every assertion that uses it permanently green.
    """
    try:
        value = SENTINELS[key]
    except KeyError:
        raise KeyError(
            f"unknown gate sentinel {key!r}; known keys: {sorted(SENTINELS)}"
        ) from None
    if not value:
        raise ValueError(f"gate sentinel {key!r} is empty — refusing to hand back a "
                         "pattern that matches every line")
    return value


def main(argv: list[str]) -> int:
    if len(argv) == 2 and argv[0] == "--print":
        try:
            sys.stdout.write(sentinel(argv[1]))
        except (KeyError, ValueError) as exc:
            print(f"FATAL: {exc}", file=sys.stderr)
            return 2
        return 0
    if len(argv) == 1 and argv[0] == "--list":
        for k in sorted(SENTINELS):
            print(f"{k}\t{SENTINELS[k]}")
        print(f"sentinels: {len(SENTINELS)}")          # M1 — report the denominator
        return 0
    print("usage: gate_sentinels.py --print <key> | --list", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
