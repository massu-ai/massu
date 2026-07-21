#!/usr/bin/env python3
"""Stamp the NON-GUARD exempt allowlist into gate-registry.json (plan-2026-07-15 Wave 1b, P4b).

The RULING (path -> one-line cited reason) is authored in `scripts/lib/exempt-reasons.json` — the
committed source-of-truth for every candidate ruled NON-GUARD. This tool mechanically stamps each
entry's current content-hash and writes the `exempt` array. The hash is a PIN, not the ruling:
invariant (iv) makes any later EDIT to an exempted test go RED in the completeness gate, forcing a
fresh human ruling (re-run this tool only after re-confirming the file is still a non-guard).

It VALIDATES (fail-closed) before writing — an exempt entry may NEVER:
  (i)  be a CR-named enforcement guard (the T-3 laundering hatch),
  (ii) name a path that is not a current guard candidate (stale),
  (v)  also be a registered guard gate (double-ruling),
  (iii)have an empty reason.
(iv) [hash] is stamped here; the runner re-checks it every run.

Usage: python3 scripts/lib/stamp-exempt.py            # stamp + validate + write
       python3 scripts/lib/stamp-exempt.py --check     # validate only (no write), exit nonzero on problems
"""
from __future__ import annotations
import hashlib, json, os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
REG = os.path.join(ROOT, "scripts", "lib", "gate-registry.json")
REASONS = os.path.join(ROOT, "scripts", "lib", "exempt-reasons.json")

def discover_candidates():
    out = subprocess.run(["node", os.path.join(ROOT, "scripts", "tests", "_discover_guard_universe.mjs"),
                          "--repo-root", ROOT], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         env={**os.environ, "NODE_PATH": os.path.join(ROOT, "node_modules")})
    if out.returncode != 0:
        sys.exit(f"FATAL: guard discovery failed:\n{out.stderr.decode('utf-8','replace')}")
    d = json.loads(out.stdout)
    paths = {c["path"] for c in d["candidates"]}
    return paths, set(d["cr_named"])

def main():
    check_only = "--check" in sys.argv[1:]
    reasons = json.load(open(REASONS)) if os.path.exists(REASONS) else {}
    reg = json.load(open(REG))
    guard_gate_paths = {g.get("path") for g in reg["gates"] if g.get("kind") != "shell-failpoint"}
    cand_paths, cr_named = discover_candidates()

    problems, exempt = [], []
    for path, reason in reasons.items():
        if path in cr_named: problems.append(f"(i) CR-named guard cannot be exempt: {path}")
        if path not in cand_paths: problems.append(f"(ii) stale — not a current candidate: {path}")
        if path in guard_gate_paths: problems.append(f"(v) also a registered guard gate: {path}")
        if not (reason or "").strip(): problems.append(f"(iii) empty reason: {path}")
        fp = os.path.join(ROOT, path)
        try:
            h = "sha256:" + hashlib.sha256(open(fp, "rb").read()).hexdigest()
        except Exception as e:
            problems.append(f"(iv) cannot hash {path}: {e}"); continue
        exempt.append({"path": path, "reason": reason.strip(), "hash": h})

    if problems:
        print("EXEMPT VALIDATION PROBLEMS:", file=sys.stderr)
        for p in problems: print("  -", p, file=sys.stderr)
        sys.exit(1)

    print(f"validated {len(exempt)} exempt entr(ies): 0 CR-named, 0 stale, 0 double-ruled, all reasons non-empty.")
    if check_only:
        return
    reg["exempt"] = sorted(exempt, key=lambda e: e["path"])
    json.dump(reg, open(REG, "w"), indent=2)
    print(f"wrote {len(exempt)} exempt entries to {os.path.relpath(REG, ROOT)}")

if __name__ == "__main__":
    main()
