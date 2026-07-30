#!/usr/bin/env python3
"""Real-tree can-fail proof executor for the P4 guard kinds (plan-2026-07-15 Wave 1b, CR-72/M4).

vitest-guards, shell-gate-scripts and eslint rules assert invariants that need `node_modules`
(excluded from the anti-vacuity runner's rsync scratch tree). So — unlike shell fail-points, which
run in a scratch copy — a guard's can-fail proof runs the CR-72 REAL-TREE pattern IN PLACE:

    snapshot (content+mtime) → PLANT the defect → ORACLE-confirm it is present →
    run the guard → assert it goes RED → RESTORE (content+mtime) → assert git-clean.

"PROVE BEFORE YOU DESTROY": every touched file is snapshotted (content AND mtime — the
mutation-mtime memory) and restored in a `finally`, and `git status --porcelain` for the touched
paths is asserted EMPTY at the START and the END (a hard SIGKILL will not run the finally, so the
start assertion is the only way to tell "my plant leaked" from "the tree was already dirty").

Recipes (one per dependency class, R11-2):
  vitest-guard / source-plant   — plant a defect in a SOURCE file the guard reads/imports →
                                  `npx vitest run <test>` must exit NON-ZERO (RED).
  vitest-guard / dist-artifact  — BUILD the dist artifact from clean source → baseline-assert it
                                  EXISTS and the test is GREEN → plant the tracked pre-image source
                                  → REBUILD → `npx vitest run` NON-ZERO → restore source + rebuild.
  vitest-guard / companion      — a companion shell mutation script IS the proof: run it, exit 0.
  shell-gate-script / self-proving — the script self-plants + asserts RED: run it, exit 0.
  shell-gate-script / companion — a companion mutation script proves it: run it, exit 0.
  eslint / companion            — the RuleTester test (planted invalid fixtures) is the proof.

Exit 0 = the guard's can-fail proof PASSED (it went RED on the planted defect / the proof script
succeeded). Exit 1 = the proof FAILED (decoration, or the proof did not confirm). Exit 2 = FATAL
(dirty tree, unreadable spec, leaked restore) — fail closed.

Usage: python3 scripts/tests/_run_guard_defeat.py --registry R --repo-root ROOT --gate GID
"""
from __future__ import annotations
import argparse, json, os, re, shutil, subprocess, sys, tempfile

def sh(cmd, cwd, env=None, timeout=1200):
    e = dict(os.environ); e.setdefault("NODE_PATH", os.path.join(cwd, "node_modules"))
    if env: e.update(env)
    return subprocess.run(cmd, cwd=cwd, env=e, shell=isinstance(cmd, str),
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)

def porcelain(repo, paths):
    if not paths: return ""
    r = subprocess.run(["git", "-C", repo, "status", "--porcelain", "--"] + list(paths),
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return r.stdout.decode("utf-8", "replace").strip()

class Snap:
    """Content+mtime snapshot / restore of a set of tracked files (never git checkout — CR-70)."""
    def __init__(self, repo):
        self.repo = repo; self.tmp = tempfile.mkdtemp(prefix="guard-defeat-"); self.files = {}
        self.created_dirs = []   # dirs a write-plant newly created; removed on restore (else an
                                 # empty dir leaks — git does not track it, so the file-scoped clean
                                 # check misses it, and it poisons the next run's tree)
    def add(self, rel):
        if rel in self.files: return
        p = os.path.join(self.repo, rel)
        key = os.path.join(self.tmp, rel.replace("/", "__"))
        if os.path.exists(p):
            shutil.copy2(p, key); st = os.stat(p)
            self.files[rel] = (key, (st.st_atime, st.st_mtime), True)
        else:
            self.files[rel] = (None, None, False)   # did not exist → restore = delete
    def restore(self):
        for rel, (key, times, existed) in self.files.items():
            p = os.path.join(self.repo, rel)
            if existed:
                os.makedirs(os.path.dirname(p), exist_ok=True)
                shutil.copy2(key, p); os.utime(p, times)   # content AND mtime (mutation-mtime memory)
            elif os.path.exists(p):
                os.remove(p)
        # Remove directories the plant newly created, deepest first, only if now empty. A leaked
        # empty dir (e.g. packages/adapter-avplant/ from an orphan-adapter plant) is invisible to
        # git but poisons filesystem-walking guards on the next run.
        for d in sorted(set(self.created_dirs), key=len, reverse=True):
            try:
                if os.path.isdir(d) and not os.listdir(d):
                    os.rmdir(d)
            except OSError:
                pass
    def cleanup(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

class PlantTargetAbsent(Exception):
    """The file a `replace` plant targets does not exist.

    X-3 (plan-2026-07-26-anti-vacuity-9-unproven-gates): this used to `continue`, so an
    ABSENT plant target and an INERT pattern both arrived at the caller as changed==0 and
    were reported "the mutation is inert". Gate #7 was filed as a rotted pin on that
    basis when it was a missing BUILD. The two states now have different words."""


def apply_plant(repo, plant, snap):
    """plant: list of {path,pattern,replace} OR {write:{path:content}} OR {delete:[paths]}.
    Returns the number of files actually changed (0 = the mutation was inert → caller FAILs).
    Raises PlantTargetAbsent when a `replace` target is missing (X-3)."""
    changed = 0
    ops = plant if isinstance(plant, list) else [plant]
    for op in ops:
        if "write" in op:
            for rel, content in op["write"].items():
                snap.add(rel); p = os.path.join(repo, rel)
                d = os.path.dirname(p)
                # record the dirs this write will newly create (deepest-existing ancestor up to d)
                probe, to_make = d, []
                while probe and probe != repo and not os.path.exists(probe):
                    to_make.append(probe); probe = os.path.dirname(probe)
                snap.created_dirs.extend(to_make)
                os.makedirs(d, exist_ok=True)
                before = open(p).read() if os.path.exists(p) else None
                open(p, "w").write(content)
                if before != content: changed += 1
        elif "delete" in op:
            for rel in op["delete"]:
                snap.add(rel); p = os.path.join(repo, rel)
                if os.path.isdir(p) and not os.path.islink(p): shutil.rmtree(p); changed += 1
                elif os.path.exists(p) or os.path.islink(p): os.remove(p); changed += 1
        else:  # replace
            rel = op["path"]; snap.add(rel); p = os.path.join(repo, rel)
            if not os.path.exists(p):
                raise PlantTargetAbsent(rel)
            s = open(p).read(); new = re.sub(op["pattern"], op["replace"], s, flags=re.M)
            if new != s: open(p, "w").write(new); changed += 1
    return changed

def run(reg_path, repo, gid):
    reg = json.load(open(reg_path))
    g = next((x for x in reg["gates"] if x["id"] == gid), None)
    if g is None: print(f"FATAL: no gate {gid}", file=sys.stderr); return 2
    kind = g.get("kind"); recipe = g.get("recipe")

    # Pre-compute the touched-file set for the git-clean guard (source plant targets).
    touched = []
    if isinstance(g.get("plant"), list):
        for op in g["plant"]:
            if "path" in op: touched.append(op["path"])
            if "write" in op: touched += list(op["write"].keys())
            if "delete" in op: touched += op["delete"]
    elif isinstance(g.get("plant"), dict):
        if "write" in g["plant"]: touched += list(g["plant"]["write"].keys())
        if "delete" in g["plant"]: touched += g["plant"]["delete"]

    dirty0 = porcelain(repo, touched)
    if dirty0:
        print(f"FATAL: target tree already dirty before the proof:\n{dirty0}", file=sys.stderr); return 2

    snap = Snap(repo)
    try:
        # ── companion / proof-script / self-proving: the named script IS the can-fail proof ──
        if recipe in ("companion", "self-proving"):
            script = g.get("companion_script") or g.get("proof_script")
            if not script:
                print(f"FAIL [{gid}] recipe={recipe} but no companion_script/proof_script", file=sys.stderr); return 1
            if not os.path.exists(os.path.join(repo, script)):
                print(f"FAIL [{gid}] proof script not found: {script}", file=sys.stderr); return 1
            r = sh(["bash", script], repo)
            if r.returncode == 0:
                print(f"OK   [{gid}] {kind}/{recipe}: {script} proved the guard can fail (exit 0)")
                return 0
            print(f"FAIL [{gid}] {kind}/{recipe}: {script} exited {r.returncode}:\n{r.stdout.decode('utf-8','replace')[-2000:]}", file=sys.stderr)
            return 1

        # ── vitest source-plant / dist-artifact ──
        if kind == "vitest-guard" and recipe in ("source-plant", "dist-artifact"):
            test = g["test"]
            def vitest():
                return sh(["npx", "vitest", "run", test], repo)
            if recipe == "dist-artifact":
                build = g["build"]; bcwd = os.path.join(repo, g.get("build_cwd", "."))
                b = sh(build, bcwd)
                if b.returncode != 0:
                    print(f"FAIL [{gid}] dist build failed:\n{b.stdout.decode('utf-8','replace')[-1500:]}", file=sys.stderr); return 1
                artifact = g.get("artifact")
                if artifact and not os.path.exists(os.path.join(repo, artifact)):
                    print(f"FAIL [{gid}] dist artifact missing after build: {artifact}", file=sys.stderr); return 1
                base = vitest()
                if base.returncode != 0:
                    # X-3: print the tail, as the dist-build (:161) and rebuild (:180)
                    # branches already do. Without it a CI failure of this shape is
                    # undiagnosable from the log — gate #9's cause had to be recovered
                    # by an independent route.
                    print(f"FAIL [{gid}] BASELINE: test is RED before planting (a proof against an already-red test proves nothing):\n{base.stdout.decode('utf-8','replace')[-1500:]}", file=sys.stderr); return 1
            changed = apply_plant(repo, g["plant"], snap)
            if changed == 0:
                print(f"FAIL [{gid}] PLANT changed nothing — the mutation is inert", file=sys.stderr); return 1
            oracle = g.get("oracle")
            if not oracle:
                print(f"FAIL [{gid}] no ORACLE — 'bogus fixture' and 'blind check' are indistinguishable (CR-65)", file=sys.stderr); return 1
            orc = sh(oracle, repo)
            if orc.returncode != 0:
                print(f"FAIL [{gid}] ORACLE did not confirm the planted defect — fixture is bogus:\n  {oracle}", file=sys.stderr); return 1
            if recipe == "dist-artifact":
                rb = sh(g["build"], os.path.join(repo, g.get("build_cwd", ".")))
                if rb.returncode != 0:
                    print(f"FAIL [{gid}] REBUILD after plant failed:\n{rb.stdout.decode('utf-8','replace')[-1500:]}", file=sys.stderr); return 1
            red = vitest()
            ok = red.returncode != 0
            # restore source, and for dist rebuild from clean source so gitignored dist is left clean
            snap.restore()
            if recipe == "dist-artifact":
                sh(g["build"], os.path.join(repo, g.get("build_cwd", ".")))
            if ok:
                print(f"OK   [{gid}] {kind}/{recipe}: went RED on the planted defect (exit {red.returncode}). This is a guard.")
                return 0
            print(f"FAIL [{gid}] {kind}/{recipe}: stayed GREEN with the defect planted + ORACLE-confirmed. IT IS DECORATION.", file=sys.stderr)
            return 1

        # ── eslint rule: its RuleTester `invalid` cases ARE "plant a violating fixture → the linter
        #    errors on it." Running the RuleTester (exit 0) proves the rule fires on a violation. We
        #    also assert the RuleTester actually HAS invalid cases — else it proves nothing (anti-laundering).
        if kind == "eslint" and recipe == "eslint-ruletester":
            test = g["test"]
            tp = os.path.join(repo, test)
            if not os.path.exists(tp):
                print(f"FAIL [{gid}] rule test not found: {test}", file=sys.stderr); return 1
            # anti-laundering: the test must exercise the rule against a VIOLATION and assert it fires
            # (a RuleTester `invalid` array, or a custom harness asserting a "violation reported").
            if not re.search(r"\binvalid\b|violation|toHaveLength\(\s*[1-9]", open(tp).read()):
                print(f"FAIL [{gid}] {test} shows no violation-assertion (invalid cases / 'violation reported') — it cannot prove the rule fires on a violation", file=sys.stderr); return 1
            r = sh(["npx", "vitest", "run", test], repo)
            if r.returncode == 0:
                print(f"OK   [{gid}] eslint/eslint-ruletester: {test} exercises the rule against invalid fixtures and it errors (exit 0)")
                return 0
            print(f"FAIL [{gid}] eslint/eslint-ruletester: {test} exited {r.returncode}:\n{r.stdout.decode('utf-8','replace')[-1500:]}", file=sys.stderr)
            return 1

        # ── shell-gate-script with an external plant (plant → run script → assert RED → restore) ──
        if kind == "shell-gate-script" and recipe == "plant":
            script = g["path"]
            changed = apply_plant(repo, g["plant"], snap)
            if changed == 0:
                print(f"FAIL [{gid}] PLANT changed nothing", file=sys.stderr); return 1
            orc = sh(g["oracle"], repo) if g.get("oracle") else None
            if orc is not None and orc.returncode != 0:
                print(f"FAIL [{gid}] ORACLE did not confirm the planted defect", file=sys.stderr); return 1
            r = sh(["bash", script], repo)
            snap.restore()
            if r.returncode != 0:
                print(f"OK   [{gid}] shell-gate-script/plant: {script} went RED on the planted defect (exit {r.returncode})")
                return 0
            print(f"FAIL [{gid}] shell-gate-script/plant: {script} stayed GREEN with the defect planted — DECORATION", file=sys.stderr)
            return 1

        print(f"FATAL: gate {gid} has unknown kind/recipe: {kind}/{recipe}", file=sys.stderr); return 2
    except PlantTargetAbsent as e:
        # X-3: a DISTINCT `FATAL:` prefix, because the consumer discriminates on this
        # text. Exit 2 already carries four meanings on this channel (no gate :127,
        # tree already dirty :143, unknown kind/recipe :244, restore leak :256); this
        # is the fifth, and it is the one that means "rebuild", not "something broke".
        print(f"FATAL: PLANT TARGET ABSENT: {e} — the gate's plant target does not exist, "
              f"so the mutation could not be applied. This is a MISSING BUILD or a moved "
              f"file, NOT an inert pattern and NOT a dirty tree. Build the artifact (e.g. "
              f"`npm run build`) and re-run, or correct the gate's plant path in the registry.",
              file=sys.stderr)
        return 2
    finally:
        snap.restore()
        leak = porcelain(repo, touched)
        snap.cleanup()
        if leak:
            print(f"FATAL: the proof LEAKED changes into the working tree (restore incomplete):\n{leak}", file=sys.stderr)
            # A leak is a hard failure regardless of the proof outcome.
            os._exit(2)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--registry", required=True)
    ap.add_argument("--repo-root", required=True)
    ap.add_argument("--gate", required=True)
    a = ap.parse_args()
    sys.exit(run(a.registry, os.path.abspath(a.repo_root), a.gate))

if __name__ == "__main__":
    main()
