#!/usr/bin/env python3
"""Ingest authored guard gate specs + demotions into the registry (plan-2026-07-15 Wave 1b, P4b).

Reads a workflow result file (its `result` has {gates:[...], demoted:[...]}), constructs registry
guard gate objects (parsing each gate's plant_json), merges them into gate-registry.json (keeping
shell-failpoint gates + any already-present guard gates), routes demotions into exempt-reasons.json,
and re-stamps the exempt allowlist. A gate whose plant_json is malformed is SKIPPED and reported —
it then stays un-ruled and the completeness gate catches it (fail-loud, never a silent accept).

Usage: python3 scripts/lib/apply-guard-rulings.py <workflow-output.json>
"""
import json, os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
REG = os.path.join(ROOT, "scripts", "lib", "gate-registry.json")
REASONS = os.path.join(ROOT, "scripts", "lib", "exempt-reasons.json")

def kind_for(path):
    if path.startswith("eslint-rules/"): return "eslint"
    if path.startswith("scripts/tests/") and path.endswith(".sh"): return "shell-gate-script"
    return "vitest-guard"

def build_gate(g):
    path = g["path"]; recipe = g["recipe"]; kind = kind_for(path)
    gate = {"id": f"{kind}::{path}", "kind": kind, "path": path, "recipe": recipe,
            "guards": g.get("confirm_reason", "")}
    if recipe in ("source-plant", "dist-artifact"):
        plant = json.loads(g["plant_json"])         # raises on malformed -> caller skips
        if not isinstance(plant, list) or not plant: raise ValueError("empty/invalid plant")
        gate["test"] = path; gate["plant"] = plant; gate["oracle"] = g["oracle"]
        if recipe == "dist-artifact":
            gate["build"] = g.get("build", "npm run build:hooks")
            gate["build_cwd"] = g.get("build_cwd", "packages/core")
            if g.get("artifact"): gate["artifact"] = g["artifact"]
    elif recipe == "companion":
        gate["companion_script"] = g["companion_script"]
    elif recipe == "eslint-ruletester":
        gate["test"] = g.get("test", path)
    else:
        raise ValueError(f"unknown recipe {recipe}")
    return gate

def main():
    out = json.load(open(sys.argv[1]))
    res = out.get("result", out)
    gates_in = res.get("gates", []); demoted = res.get("demoted", [])

    reg = json.load(open(REG))
    # keep shell-failpoint gates + already-proven guard gates NOT being re-authored
    reauthored = {kind_for(g["path"]) + "::" + g["path"] for g in gates_in}
    kept = [g for g in reg["gates"] if g.get("kind") == "shell-failpoint" or g["id"] not in reauthored]

    built, skipped = [], []
    for g in gates_in:
        try:
            built.append(build_gate(g))
        except Exception as e:
            skipped.append((g.get("path", "?"), str(e)))
    reg["gates"] = kept + built
    json.dump(reg, open(REG, "w"), indent=2)

    # demotions -> exempt reasons (route to the SoT; stamper validates + hashes)
    reasons = json.load(open(REASONS)) if os.path.exists(REASONS) else {}
    for d in demoted:
        reasons[d["path"]] = d["reason"][:300]
    json.dump(reasons, open(REASONS, "w"), indent=1, sort_keys=True)

    print(f"applied {len(built)} guard gate(s); demoted {len(demoted)} -> exempt; SKIPPED {len(skipped)} malformed:")
    for p, why in skipped: print("  SKIP", p, "—", why)

    # re-stamp exempt (validates i/ii/iii/v + hashes)
    r = subprocess.run(["python3", os.path.join(ROOT, "scripts", "lib", "stamp-exempt.py")], cwd=ROOT)
    sys.exit(r.returncode)

if __name__ == "__main__":
    main()
