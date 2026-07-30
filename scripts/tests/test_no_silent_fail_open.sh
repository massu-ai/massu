#!/usr/bin/env bash
# test_no_silent_fail_open — P3-1: no publication-boundary gate may pass by not
# running.
#
# Two distinct failures share one shape, and this closes both.
#
# (A) FAIL-OPEN BRANCHES. A gate that tests for a missing file and then `exit 0`
#     reports success having checked nothing. `install-hooks.sh:43` did exactly
#     that -- guard script absent, exit 0, nothing installed, nothing said.
#     Every such branch must either fail closed or carry an explicit
#     `# fail-open-approved: <reason>` on the exiting line or the one above it.
#
# (B) MISSING PATTERN SOURCES, RESOLVED TRANSITIVELY. This is the subtle half.
#     `massu-public-leak-guard.sh` sources `lib/leak-patterns.sh`, which at its
#     line 82 sources `lib/leak-patterns-operator.sh`. A one-level grep of the
#     entrypoint never sees the operator file, so a check written that way
#     cannot notice when the file carrying the operator-specific literals has
#     gone missing -- and the guard would then run with a silently reduced
#     vocabulary while still printing green.
#
#     CONTEXT SPLIT, and it is load-bearing. `leak-patterns-operator.sh` is
#     DELIBERATELY and permanently absent from the public mirror: publishing
#     those detection literals would itself disclose what they detect. Marking
#     it universally required would make the public guard and four CI workflows
#     permanently RED, and a permanently-red gate gets switched off. So sources
#     are tagged `required-internal` or `expected-absent-public`, and the
#     requirement is enforced only in the context that can satisfy it.
#
#     RECORDED, not fixed: the public-side guard is DECORATIVE BY CONSTRUCTION.
#     It runs with the reduced vocabulary and cannot be repaired in place,
#     because repairing it means publishing the literals. The authoritative
#     scan is the internal one, at the sync boundary.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || exit 2

# --- ANTI-VACUITY (--self-test) -------------------------------------------
# The plan's stated acceptance: rename leak-patterns-operator.sh in an
# internal-context scratch copy and require this gate to go RED naming that
# file. Run against a COPY so the real tree is never mutated.
if [ "${1:-}" = "--self-test" ]; then
  SCRATCH="$(mktemp -d)"
  trap 'rm -rf "$SCRATCH"' EXIT
  cp -R "$REPO_ROOT/scripts" "$SCRATCH/scripts"
  st_pass=0; st_fail=0
  st_ok()  { printf '  ok   %s\n' "$1"; st_pass=$((st_pass+1)); }
  st_bad() { printf '  FAIL %s\n' "$1"; st_fail=$((st_fail+1)); }

  echo "=== SELF-TEST 1: a missing transitive pattern source must go RED ==="
  mv "${SCRATCH:?SCRATCH is empty - refusing to build a destructive path (G17)}/scripts/lib/leak-patterns-operator.sh" \
     "$SCRATCH/scripts/lib/leak-patterns-operator.sh.renamed"
  OUT="$(bash "${BASH_SOURCE[0]}" "$SCRATCH" 2>&1)"; RC=$?
  if [ "$RC" -ne 0 ]; then st_ok "exits non-zero (rc=$RC)"; else st_bad "exited 0 — the gate is blind to a missing pattern source"; fi
  if grep -q 'leak-patterns-operator.sh' <<<"$OUT"; then st_ok "names the missing file"; else st_bad "did not name leak-patterns-operator.sh"; fi
  mv "${SCRATCH:?SCRATCH is empty - refusing to build a destructive path (G17)}/scripts/lib/leak-patterns-operator.sh.renamed" \
     "$SCRATCH/scripts/lib/leak-patterns-operator.sh"
  OUT="$(bash "${BASH_SOURCE[0]}" "$SCRATCH" 2>&1)"; RC=$?
  if [ "$RC" -eq 0 ]; then st_ok "restored -> GREEN again (rc=$RC)"; else st_bad "still RED after restore (rc=$RC)"; fi

  echo "=== SELF-TEST 2: removing an approval marker must go RED ==="
  python3 - "$SCRATCH/scripts/sync-public.sh" <<'INNER'
import sys
p=sys.argv[1]; s=open(p).read()
s=s.replace("  # fail-open-approved: no exempt file means no registration to undo. This is\n  # bookkeeping for the machine's deletion breaker, not a publication gate.\n","")
open(p,'w').write(s)
INNER
  OUT="$(bash "${BASH_SOURCE[0]}" "$SCRATCH" 2>&1)"; RC=$?
  if [ "$RC" -ne 0 ]; then st_ok "exits non-zero when an approval marker is removed (rc=$RC)"; else st_bad "exited 0 — the approval requirement is not enforced"; fi
  if grep -q 'sync-public.sh' <<<"$OUT"; then st_ok "names the now-unapproved script"; else st_bad "did not name sync-public.sh"; fi

  echo
  printf '  self-test passed: %d   failed: %d\n' "$st_pass" "$st_fail"
  [ "$st_fail" -eq 0 ]
  exit $?
fi

ANALYSIS_ROOT="${1:-$REPO_ROOT}"

python3 - "$ANALYSIS_ROOT" <<'PY'
import os, re, sys

root = sys.argv[1]
failures = []

# ---------------------------------------------------------------------------
# DISCOVER the candidate set. Never a hand-typed list: a boundary script is one
# that references a publication-gate component. A list here could not grow when
# a new gate appears, which is the drift this exists to catch.
# ---------------------------------------------------------------------------
COMPONENTS = (
    'private_content_scan.py', 'home-path-guard.sh', 'leak-patterns.sh',
    'npm-publish-guard.sh', 'sync-public.sh', 'install-hooks.sh',
)

candidates = []
for dirpath, dirnames, filenames in os.walk(os.path.join(root, 'scripts')):
    dirnames[:] = [d for d in dirnames if d not in ('node_modules', '__pycache__')]
    for fn in filenames:
        if not fn.endswith('.sh'):
            continue
        p = os.path.join(dirpath, fn)
        try:
            text = open(p, encoding='utf-8', errors='replace').read()
        except OSError:
            continue
        if any(c in text for c in COMPONENTS):
            candidates.append(p)
candidates.sort()

print("=" * 74)
print("  P3-1: publication-boundary gates that could pass by not running")
print("=" * 74)
print(f"\n  discovered boundary scripts: {len(candidates)}")

# P-A: absence is never a pass. A discovery that finds nothing means the
# discovery broke, not that the repo is clean.
if not candidates:
    print("  FAIL: discovered ZERO boundary scripts — the discovery is broken.")
    sys.exit(1)

# ---------------------------------------------------------------------------
# (A) FAIL-OPEN BRANCHES
# ---------------------------------------------------------------------------
ABSENCE = re.compile(
    r'(\[\s*!\s*-[fdxesr]\s)'            # [ ! -f X ]
    r'|(\[\s*-[fdxesr]\s[^]]*\]\s*\|\|)'  # [ -f X ] || ...
    r'|(command -v [^\s]+ >/dev/null 2>&1 \|\|)'
)
BENIGN_EXIT = re.compile(r'exit\s+0|return\s+0|return\b\s*$')
APPROVED = re.compile(r'#\s*fail-open-approved:\s*\S')

open_findings = []
for p in candidates:
    lines = open(p, encoding='utf-8', errors='replace').read().splitlines()
    for i, line in enumerate(lines):
        if not ABSENCE.search(line):
            continue
        # Look ahead a few lines for a benign exit reached FROM this absence test.
        for j in range(i, min(i + 5, len(lines))):
            probe = lines[j]
            if not BENIGN_EXIT.search(probe):
                continue
            window = '\n'.join(lines[max(0, i - 2): j + 2])
            if APPROVED.search(window):
                break
            rel = os.path.relpath(p, root)
            open_findings.append(f"{rel}:{j + 1}: {probe.strip()[:88]}")
            break

print(f"  fail-open branches without an approval marker: {len(open_findings)}")
for f in open_findings:
    print(f"      {f}")
if open_findings:
    failures.append("unapproved fail-open branch(es)")

# ---------------------------------------------------------------------------
# (B) TRANSITIVE PATTERN SOURCES
# ---------------------------------------------------------------------------
# NOT anchored to line start. `leak-patterns.sh` sources the operator patterns
# CONDITIONALLY and mid-line:
#     [ -f "$_massu_op_patterns" ] && source "$_massu_op_patterns"
# so a line-anchored matcher misses it even when recursing to the right depth.
# That is two independent reasons the operator file stayed invisible: depth AND
# position.
SOURCE_RE = re.compile(r'(?:^|&&|\|\||;|\bthen\b)\s*(?:source|\.)\s+"?([^"\s;]+)')

# Files that are DELIBERATELY absent in the public mirror. Publishing their
# contents would disclose exactly what they detect.
EXPECTED_ABSENT_PUBLIC = {'leak-patterns-operator.sh'}

ASSIGN_RE = re.compile(r'^\s*([A-Za-z_][A-Za-z0-9_]*)=(.+?)\s*$')

# Every .sh under scripts/, indexed by basename, so an expansion we cannot
# evaluate statically still resolves when the basename is unambiguous. Without
# this, `source "$INTERNAL_REPO/scripts/lib/home-path-guard.sh"` resolved to a
# path that does not exist and was reported as a MISSING required source — a
# false alarm, which in a gate is just as corrosive as a false pass.
BY_BASENAME = {}
for dp, dn, fns in os.walk(os.path.join(root, 'scripts')):
    dn[:] = [d for d in dn if d not in ('node_modules', '__pycache__')]
    for fn in fns:
        if fn.endswith(('.sh', '.bash')):
            BY_BASENAME.setdefault(fn, []).append(os.path.join(dp, fn))


def _expand(raw, here, entry, varmap):
    cand = raw
    for _ in range(4):  # a var may hold another var
        before = cand
        for name, val in varmap.items():
            cand = cand.replace(f'${{{name}}}', val).replace(f'${name}', val)
        cand = re.sub(r'\$\((?:cd\s+)?"?\$\(dirname[^)]*\)"?(?:\s*&&\s*pwd)?\)', here, cand)
        cand = re.sub(r'\$\{?BASH_SOURCE\[0\]\}?', entry, cand)
        cand = cand.replace('$REPO_ROOT', root).replace('${REPO_ROOT}', root)
        cand = cand.replace('$SCRIPT_DIR', here).replace('${SCRIPT_DIR}', here)
        cand = cand.replace('$INTERNAL_REPO', root).replace('${INTERNAL_REPO}', root)
        if cand == before:
            break
    cand = cand.strip('"\'')
    if not os.path.isabs(cand):
        cand = os.path.normpath(os.path.join(here, cand))
    if not os.path.exists(cand):
        hits = BY_BASENAME.get(os.path.basename(cand), [])
        if len(hits) == 1:
            cand = hits[0]
    return cand


def resolve_sources(entry, seen):
    """Follow `source`/`.` to FIXPOINT, not one level.

    One level is what misses `leak-patterns-operator.sh`: the entrypoint sources
    `leak-patterns.sh`, and only THAT file sources the operator patterns.
    """
    if entry in seen:
        return
    seen.add(entry)
    try:
        lines = open(entry, encoding='utf-8', errors='replace').read().splitlines()
    except OSError:
        return
    here = os.path.dirname(entry)

    # Track simple assignments so `X=".../foo.sh"; source "$X"` resolves. The
    # operator pattern file is sourced exactly that way.
    varmap = {}
    for line in lines:
        a = ASSIGN_RE.match(line)
        if a and '.sh' in a.group(2):
            varmap[a.group(1)] = _expand(a.group(2).strip('"\''), here, entry, {})

    for line in lines:
        for m in SOURCE_RE.finditer(line):
            target = _expand(m.group(1), here, entry, varmap)
            if os.path.basename(target).endswith(('.sh', '.bash')):
                results.append((entry, target))
                resolve_sources(target, seen)

results = []
entrypoints = [p for p in candidates if 'leak-patterns.sh' in open(p, encoding='utf-8', errors='replace').read()]
for e in entrypoints:
    resolve_sources(e, set())

resolved = sorted({t for _, t in results})
print(f"\n  transitively resolved pattern/source files: {len(resolved)}")
if not resolved:
    print("  FAIL: resolved ZERO sources — the transitive resolver is broken.")
    failures.append("transitive resolver found nothing")

missing_required = []
for t in resolved:
    base = os.path.basename(t)
    tag = 'expected-absent-public' if base in EXPECTED_ABSENT_PUBLIC else 'required-internal'
    exists = os.path.exists(t)
    rel = os.path.relpath(t, root) if t.startswith(root) else t
    print(f"      [{tag:22}] {'present' if exists else 'MISSING'}  {rel}")
    # In THIS repo (internal) every source must exist, including the
    # deliberately-public-absent one -- absent here means genuinely lost.
    if not exists:
        missing_required.append(rel)

if missing_required:
    print("\n  FAIL: pattern source(s) missing in the INTERNAL context:")
    for m in missing_required:
        print(f"      {m}")
    print("  The guard would run with a SILENTLY REDUCED vocabulary and still print green.")
    failures.append("missing pattern source")

# ---------------------------------------------------------------------------
print("\n" + "=" * 74)
if failures:
    print("  FAIL: " + "; ".join(failures))
    print("=" * 74)
    sys.exit(1)
print("  PASS: no unapproved fail-open branch; all pattern sources resolve.")
print("=" * 74)
PY
