#!/usr/bin/env python3
"""DISCOVER the full candidate set of scanner checks — never a hand-typed list.

CR-52 rule 2: "A universal claim requires a DISCOVERED candidate set. A set typed by hand
is your memory wearing a script's clothes — the command proves nothing no matter how it exits."

G-6's central claim is a universal one: *every* scanner check ships a proof that it can fail.
That claim is only worth anything if the word "every" is computed from the tree, so a check
added tomorrow is in the candidate set tomorrow — without anyone remembering to add it.

A hand-typed list here would defeat the entire gate. This module is the reason it can't be.

Emits JSON on stdout:
    {"checks": [{"id", "scanner", "check", "title", "line"}...],
     "symbol_greps": [{"scanner", "check", "line", "symbol", "target", "sense"}...]}

Usage:
    python3 scripts/tests/_discover_scanner_checks.py [--repo-root PATH]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

# A scanner is any shell script whose name marks it as a scanner or a drift-guard.
# DISCOVERED by pattern from the scripts dir — not enumerated by hand.
SCANNER_NAME_RE = re.compile(r"(scanner|drift)\.sh$")

# A check announces itself:   echo "Check 12: <title>"
CHECK_HDR_RE = re.compile(r'^echo\s+"Check\s+([0-9]+[a-z]?)\s*:\s*(.*?)"')

# A bare identifier: the shape of a symbol-grep predicate (T-3). If a check's pass/fail
# hinges on `grep -q "someSymbol" <file>`, then a COMMENT containing that symbol satisfies
# it — the gate can be deleted from the code and the check still reports "intact".
IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

# grep predicate:  [!] grep [-flags] -q[E] "PATTERN" <target>
GREP_PRED_RE = re.compile(
    r"""(?P<neg>!\s*)?grep\s+(?:-[A-Za-z]+\s+)*-q[A-Za-z]*\s+
        (?P<quote>["'])(?P<pat>[^"']+)(?P=quote)\s+
        (?P<target>\S+)""",
    re.VERBOSE,
)


def discover_scanners(repo_root: str) -> list[str]:
    scripts_dir = os.path.join(repo_root, "scripts")
    if not os.path.isdir(scripts_dir):
        # FAIL CLOSED. "I cannot see the scripts dir" must never read as "there are no scanners."
        # That conflation is the exact bug this whole workstream exists to kill.
        raise SystemExit(f"FATAL: no scripts/ dir under {repo_root} — refusing to report zero scanners.")
    found = sorted(
        os.path.join("scripts", f)
        for f in os.listdir(scripts_dir)
        if SCANNER_NAME_RE.search(f)
    )
    if not found:
        raise SystemExit(f"FATAL: discovered ZERO scanners under {scripts_dir} — that cannot be right.")
    return found


def _is_file_target(target: str) -> bool:
    """The grep target must be a file we could read: a shell var or a path."""
    return target.startswith('"$') or target.startswith("$") or "/" in target


def discover(repo_root: str) -> dict:
    checks: list[dict] = []
    symbol_greps: list[dict] = []

    for rel in discover_scanners(repo_root):
        path = os.path.join(repo_root, rel)
        lines = open(path, encoding="utf-8", errors="replace").read().split("\n")

        headers = [
            (i, m.group(1), m.group(2))
            for i, line in enumerate(lines)
            for m in [CHECK_HDR_RE.match(line)]
            if m
        ]

        for idx, (ln, num, title) in enumerate(headers):
            end = headers[idx + 1][0] if idx + 1 < len(headers) else len(lines)
            checks.append(
                {
                    "id": f"{os.path.basename(rel).replace('massu-', '').replace('.sh', '')}-{num}",
                    "scanner": rel,
                    "check": num,
                    "title": title,
                    "line": ln + 1,
                }
            )

            # Within this check's block, find bare-symbol grep predicates (T-3).
            for off, body in enumerate(lines[ln:end]):
                m = GREP_PRED_RE.search(body)
                if not m:
                    continue
                target = m.group("target").strip()
                if not _is_file_target(target):
                    continue
                core = m.group("pat").strip("^$").replace("\\", "")
                if IDENT_RE.match(core):
                    symbol_greps.append(
                        {
                            "scanner": rel,
                            "check": num,
                            "line": ln + 1 + off,
                            "symbol": core,
                            "target": target,
                            "sense": "MISSING_FAILS" if m.group("neg") else "PRESENT_FAILS",
                        }
                    )

    return {"checks": checks, "symbol_greps": symbol_greps}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--repo-root",
        default=os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")),
    )
    args = ap.parse_args()
    json.dump(discover(args.repo_root), sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
