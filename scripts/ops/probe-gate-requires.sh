#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────────────────
# probe-gate-requires.sh — the ADJUDICATOR for X-1's `requires[]` contract.
# plan-2026-07-26-anti-vacuity-9-unproven-gates §4 X-1 change 3, §8 item 7.
#
# WHAT IT ANSWERS, AND WHY BY EXECUTION.
#   "Does running this gate's proof REQUIRE artifact X?" §8 item 7 measured both static
#   detectors over all registry gates and both fail in opposite directions: a textual one
#   returns 17/46/55/180 for ONE predicate purely by which files it opens, with recall
#   stuck at 6 of 9 proven gates at every setting; the exact declared-path one has zero
#   false positives and recall 2 of 9. The property is behavioural, so this probes it:
#
#       baseline sweep  ->  withdraw the artifact  ->  re-sweep  ->  verdict CHANGED?
#
#   A changed verdict IS the requirement. Nothing here greps for `dist/`.
#
# SAFETY (G17/CR-77 — an empty path component widens a delete to its parent).
#   This script MOVES real paths aside. Every withdrawal goes through withdraw_path(),
#   which refuses an empty component, refuses the repo root, refuses anything that is not
#   strictly inside an allowed root, and restores via an EXIT trap. Nothing is ever
#   deleted — withdrawal is a rename into a scratch dir, and restoration is asserted.
#
# Usage:
#   scripts/ops/probe-gate-requires.sh --list                  # vocabulary + candidate set
#   scripts/ops/probe-gate-requires.sh --dry-run               # show what would run
#   scripts/ops/probe-gate-requires.sh --requirement NAME      # probe ONE requirement
#   scripts/ops/probe-gate-requires.sh --write                 # adjudicate all + write SoT
#   scripts/ops/probe-gate-requires.sh --gates ID[,ID...] --write   # adjudicate only these,
#                                                              # MERGING into the ledger
# ─────────────────────────────────────────────────────────────────────────────────────────
set -uo pipefail

# --- G29/CR-92: NEUTRALISE THE CALLER'S GIT ENVIRONMENT - DO NOT REMOVE -------
# `git -C <dir>` DOES NOT SCOPE GIT. GIT_DIR outranks `-C` exactly as it outranks
# `cd` and `cwd:`, and is inherited from any CALLER that sets it — a nested git
# invocation, a wrapper, a harness, a tool. (Git does NOT hand GIT_DIR to the hooks
# it runs; measured, scripts/ops/probe-git-hook-env.sh. Hooks DO inherit
# GIT_INDEX_FILE, which redirects the index by itself.) This script addresses
# repositories BY PATH, so an inherited GIT_DIR makes every one of those reads
# answer about the CALLER's repo instead - silently, with a confident wrong value
# rather than an error. Incident #166.
# Inline, NOT sourced: this script runs without `set -e`, so a failed `source`
# would continue and leave it unprotected. Executed, never sourced, so `unset`
# here cannot mutate a caller's environment.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
      GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX
# ...and a machine-global `init.templateDir` pre-populates .git/hooks in EVERY `git init`,
# so a sandbox is NOT pristine just because it is new. GIT_TEMPLATE_DIR outranks the
# config; empty means "no template". Exported so child processes inherit it.
export GIT_TEMPLATE_DIR=""
# -----------------------------------------------------------------------------


REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || { echo "FATAL: cannot cd to repo root" >&2; exit 2; }

# ── INJECTION POINTS (CR-72: a guard you cannot inject a failure into is decoration) ─────
# This probe shipped with a bash-4 builtin on its hot path and no test could have caught it,
# because the only way to exercise the withdrawal loop was a multi-hour real sweep. These
# three overrides exist so scripts/tests/test-probe-gate-requires-mutation.sh can drive the
# whole control flow against a stub runner in seconds and PLANT the failures that must be
# refused. Defaults are the production paths; an override that names a missing file is FATAL
# below, so a typo'd injection cannot silently fall back to a passing run.
SOT="${MASSU_PROBE_SOT:-scripts/lib/gate-requires.json}"
REGISTRY="${MASSU_PROBE_REGISTRY:-scripts/lib/gate-registry.json}"
RUNNER="${MASSU_PROBE_RUNNER:-scripts/massu-gate-anti-vacuity.sh}"

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; NC=$'\033[0m'

# ── SHELL PORTABILITY PREFLIGHT ──────────────────────────────────────────────────────────
# macOS ships bash 3.2.57 as /bin/bash, and this script's shebang is `env bash`, so on this
# machine it RUNS under 3.2 whatever a developer's interactive shell happens to be.
#
# This is not hypothetical hardening. The first --write run of this probe died on exactly
# this: `mapfile` is a bash-4 builtin, so under 3.2 it printed "command not found", the very
# next line dereferenced the array `set -u` had therefore left unbound, and — the part that
# matters — **an unbound-variable error under `set -u` terminates the enclosing LOOP, not the
# script**. All six withdrawal sweeps were skipped, execution resumed after the loop, the
# adjudication phase found an empty results file, and the probe WROTE `probed: true,
# gates_probed: 409` and exited 0. Reproduced:
#     for n in a b c; do mapfile -t p < <(echo x); echo "${#p[@]}"; done; echo END
#     -> iter a / mapfile: command not found / p: unbound variable / END / exit 0
#
# So the requirement is asserted UP FRONT and LOUDLY rather than discovered mid-run, and the
# script uses no bash-4 construct. Two sibling scripts in this repo
# (massu-website-content-leak-guard.sh:61, test_private_boundary_files_never_shipped.sh:38)
# already carry "macOS ships 3.2, so no mapfile" comments — the knowledge was in the tree and
# this file did not inherit it (G10).
if [ -z "${BASH_VERSINFO:-}" ]; then
  echo "${RED}FATAL${NC}: not running under bash — this script uses bash arrays." >&2; exit 2
fi
for _builtin in read printf; do
  command -v "$_builtin" >/dev/null 2>&1 || {
    echo "${RED}FATAL${NC}: required builtin '$_builtin' unavailable." >&2; exit 2; }
done

# Portable replacement for `mapfile -t ARR < <(cmd)`. bash 3.2 has no mapfile and no
# nameref, so the caller passes a variable name and this eval-assigns a quoted array.
# Reading into an explicitly-emptied array means "the command produced nothing" is an EMPTY
# array rather than an UNBOUND one — the difference between a measurable 0 and a crash.
read_lines_into() {   # $1 = array var name; stdin = lines
  local __name="${1:?read_lines_into needs a variable name}" __line
  eval "$__name=()"
  while IFS= read -r __line; do
    [ -n "$__line" ] || continue
    eval "$__name+=(\"\$__line\")"
  done
}

# Line count of a file, fail-closed.
#
# `grep -c ''` on an EMPTY file prints `0` AND EXITS 1 (nothing matched), so the idiom this
# replaced emitted TWO values — the variable became $'0\n0' and any numeric test on it dies
# (`[ "$V" -gt 0 ]` -> exit 2). It was live at three sites here; one fed `gates_probed` into
# the ledger through python int(), which would have RAISED on an empty baseline rather than
# merely misprinting. A count that can hold two values is not a count.
count_lines() {   # $1 = path
  local _p="${1:?count_lines needs a path}"
  # M2 — an unreadable input is an ERROR, never a silent 0. "I could not count" and
  # "I counted zero" must not produce the same value.
  [ -r "$_p" ] || { echo "FATAL: count_lines cannot read $_p" >&2; return 2; }
  wc -l < "$_p" | tr -d '[:space:]'
}

DRY_RUN=0; LIST=0; WRITE=0; ONLY_REQ=""; GATES_SCOPE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)     DRY_RUN=1 ;;
    --list)        LIST=1 ;;
    --write)       WRITE=1 ;;
    --requirement) ONLY_REQ="${2:?--requirement needs a NAME}"; shift ;;
    --gates)       GATES_SCOPE="${2:?--gates needs a comma-separated ID list}"; shift ;;
    -h|--help)     sed -n '2,32p' "$0"; exit 0 ;;
    *)
      # R-011: refuse an unmatched argument, never resolve it to the likeliest candidate.
      echo "${RED}FATAL${NC}: unknown argument '$1'. Run --help." >&2; exit 2 ;;
  esac
  shift
done

for f in "$SOT" "$REGISTRY" "$RUNNER"; do
  [ -r "$f" ] || { echo "${RED}FATAL${NC}: cannot read $f — refusing to probe over nothing (M2)." >&2; exit 2; }
done

# ── EXCLUSIVE ACCESS. A differential probe is INVALID under concurrency. ─────────────────
# Guard-kind gates plant into the REAL tree. If another sweep is planting while this one
# withdraws an artifact, that foreign plant flips a gate's verdict for reasons unrelated to
# the withdrawal — and this probe would record it as REQUIRED. Several sessions routinely
# work this repo at once, so "someone else is sweeping" is a NORMAL state, not an edge case,
# and per the blind-gate law the ambiguity would resolve to a confident wrong answer.
# Measured 2026-07-27: a concurrent session was running massu-gate-anti-vacuity.sh against
# this same repo root for the whole of a 25-minute probe run.
# Delegates to the single implementation in scripts/lib/foreign-sweep-guard.sh. This used to
# be a second hand-written pgrep — with a THIRD pattern (it omitted probe-gate-requires.sh)
# and a self-exclusion that covered only `$$`, never the ancestor chain. Excluding just the
# self pid is not enough: whatever INVOKED this probe is also not a competitor.
# shellcheck source=scripts/lib/foreign-sweep-guard.sh
. "$REPO_ROOT/scripts/lib/foreign-sweep-guard.sh"
assert_exclusive() {
  assert_no_foreign_sweep "this probe withdraws real build artifacts to measure dependents"
}
assert_exclusive || exit 2

# ── A CLEAN TREE IS A PRECONDITION, NOT A COURTESY ───────────────────────────────────────
# Sibling of assert_exclusive, and for the same reason: this is a DIFFERENTIAL measurement,
# so anything that changes a gate's verdict for reasons other than the withdrawal corrupts
# the result. A dirty tree does exactly that — and SILENTLY, because the corrupted gates
# still produce a verdict.
#
# MEASURED 2026-07-28. A probe run on a dirty tree wrote a ledger annotating 12 gates where
# the previous clean run had 12+2. The two that vanished:
#     shell-gate-script::scripts/tests/test-anti-vacuity-runner-mutation.sh
#     shell-gate-script::scripts/tests/test-gate-requires-drift-guard-mutation.sh
# Both are mutation suites that REFUSE on a dirty tree. They refused identically in the
# baseline AND in the withdrawal, so no verdict CHANGED, so the probe concluded they require
# nothing — silently DOWNGRADING two previously-measured `full-git-history` requirements. The
# answer was wrong in the dangerous direction: fewer declared preconditions means the
# preflight stops protecting those gates.
#
# Note this is NOT caught by the UNPROVEN counters: those fire on the sweep's own plant-target
# checks, whereas these gates refused via their OWN cleanliness check and returned an ordinary
# FAIL. Hence a tree-level precondition rather than a verdict-level one.
assert_clean_tree() {
  # UNDER TEST -> DO NOT FIRE. The injection points exist so the mutation suite can drive
  # this script's whole control flow against a stub runner and fixture ledger; the REAL
  # tree's cleanliness is irrelevant to that, and asserting it there aborts the run before
  # any of the behaviour under test executes.
  #
  # Measured 2026-07-28, immediately after this guard was added: the probe's own mutation
  # suite went 18 RED/0 UNPROVEN -> 13/5, with PLANT 3 reporting "refused without naming
  # WHY" — because THIS check fired first and returned the dirty-tree message instead of
  # the neutralization message the plant was testing for. That is G26/CR-89 (a precondition
  # placed too early aborts everything behind it) committed by the very fix that introduced
  # the law, and it is also how a real dependency vanished from the ledger: the suite then
  # refused identically in the full tree and in the depth-1 clone, so no verdict CHANGED,
  # so it recorded as "requires nothing".
  if [ -n "${MASSU_PROBE_SOT:-}${MASSU_PROBE_REGISTRY:-}${MASSU_PROBE_RUNNER:-}" ]; then
    return 0
  fi

  local dirty
  # IGNORE THIS SCRIPT'S OWN OUTPUT. The probe WRITES $SOT, so a successful run leaves the
  # tree dirty by construction — and a naive check then refuses the NEXT run until someone
  # commits. That is exactly the one-shot-adjudicator defect this plan already fixed once
  # (incident 2026-07-28, the adjudicator was one-shot), recreated by its own repair.
  # Every OTHER modified path still refuses, which is the property that matters: a gate
  # that refuses on a dirty tree must not be silently mis-measured.
  # ALSO ignore the REGISTRY and its authoring SoT. Neither can corrupt a differential: the
  # registry selects the population and supplies plant recipes, and it is applied IDENTICALLY
  # to the baseline and the withdrawn sweep, so it cancels; exempt-reasons.json is only
  # stamped INTO the registry and is read by no sweep at all.
  #
  # Excluding them is what gives this gate stack a LEGAL ORDERING FROM EVERY REACHABLE STATE
  # (G26/CR-89). Without it, adding a gate was a deadlock: the new row makes invariant 3c red,
  # 3c red blocks `npm test`, `npm test` blocks the commit — and the prescribed remedy (this
  # probe) refused on the very uncommitted registry row the commit would have cleaned. That is
  # a brick, and a brick gets bypassed. The sequence is now: commit the code, add the registry
  # row, adjudicate the delta with --gates, commit row + ledger together.
  #
  # Every OTHER modified path still refuses, which is the property that matters: a SOURCE file
  # left dirty can make a gate fail for reasons unrelated to the withdrawal, and that gate's
  # real requirement would then be recorded as NONE — silently, in the dangerous direction.
  dirty="$(git -C "$REPO_ROOT" status --porcelain -- . \
    ":(exclude)$SOT" \
    ":(exclude)$REGISTRY" \
    ":(exclude)scripts/lib/exempt-reasons.json" 2>/dev/null)"
  if [ -n "$dirty" ]; then
    echo "${RED}FATAL${NC}: the working tree is DIRTY. Refusing to probe." >&2
    # Name the evidence (M1) — a refusal that does not say WHAT it saw is unactionable.
    printf '%s\n' "$dirty" >&2
    echo >&2
    echo "       This is a DIFFERENTIAL measurement: it compares a gate's verdict before and" >&2
    echo "       after an artifact is withdrawn. Any gate that refuses on a dirty tree returns" >&2
    echo "       the SAME verdict both times, so its real requirement is recorded as NONE —" >&2
    echo "       silently, and in the dangerous direction. Commit (or revert) first." >&2
    return 1
  fi
  return 0
}
assert_clean_tree || exit 2

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/gate-requires-probe.XXXXXX")" || exit 2
STASH="$SCRATCH/withdrawn"; mkdir -p "$STASH"
MANIFEST="$SCRATCH/manifest.tsv"; : > "$MANIFEST"

# ── restoration is not best-effort: it is asserted, and a failure is LOUD ────────────────
restore_all() {
  local rc=0 src dst
  [ -s "$MANIFEST" ] || return 0
  # Restore in REVERSE order so nested withdrawals unwind correctly.
  while IFS=$'\t' read -r src dst; do
    [ -n "${src:-}" ] && [ -n "${dst:-}" ] || continue
    if [ -e "$dst" ]; then
      # REFUSE A RECREATED TARGET. `mv dst src` where src is an EXISTING DIRECTORY moves
      # dst INSIDE src instead of restoring it — silently, and the existence post-check
      # below still passes because src does exist. Measured 2026-07-28: three probe runs
      # withdrew packages/core/dist/hooks while something (a build) recreated it, and each
      # restore nested the stash one level deeper:
      #   dist/hooks/_Users_…_dist_hooks/_Users_…_dist_hooks/_Users_…_dist_hooks/
      # 54 stale duplicate hooks accumulated, invisible to every check, and the oldest of
      # them then failed the Workspace Build Freshness gate FOREVER — because `npm run
      # build` does not clean dist, so the prescribed remedy could never fix it.
      if [ -e "$src" ]; then
        echo "${RED}FATAL${NC}: refusing to restore $src — it was RECREATED while withdrawn." >&2
        echo "       Moving the stash there would NEST it inside rather than restore it, and" >&2
        echo "       the existence check below would still pass. Stash retained at: $dst" >&2
        rc=1
        continue
      fi
      mkdir -p "$(dirname "$src")"
      if ! mv "$dst" "$src"; then
        echo "${RED}FATAL${NC}: could not restore $src from $dst — TREE IS DIRTY, fix by hand." >&2
        rc=1
      fi
    fi
    if [ ! -e "$src" ]; then
      echo "${RED}FATAL${NC}: $src is STILL MISSING after restore — TREE IS DIRTY." >&2
      rc=1
    fi
  done < <(tac "$MANIFEST" 2>/dev/null || tail -r "$MANIFEST")
  : > "$MANIFEST"
  return $rc
}
# G16 (record -> retain -> retrieve): the original cleanup rm -rf'd the scratch dir on EVERY
# exit path, including failure — so the sweep outputs that would explain WHY a run failed
# were destroyed by the run's own teardown. When this probe crashed, its baseline.out was
# already gone by the time anyone looked, and the verdict counts in it were unrecoverable.
# Restoration of the TREE is still unconditional (that is a safety property); only the
# forensic scratch is now retained when the run did not succeed.
KEEP_SCRATCH=0
cleanup() {
  local rc=$?
  # DISARM FIRST. `trap cleanup EXIT INT TERM` + an `exit` inside cleanup means a signal
  # path runs cleanup, which exits, which re-fires the EXIT trap — cleanup runs TWICE.
  # Observed on the first real SIGTERM: "scratch RETAINED" printed twice. restore_all is
  # idempotent (it truncates the manifest), so nothing was corrupted, but a teardown that
  # double-runs is one nobody can reason about — and the next person to add a non-idempotent
  # step here would get a silent double-execution.
  trap - EXIT INT TERM
  restore_all || rc=1
  if [ "$rc" -ne 0 ] || [ "${KEEP_SCRATCH:-0}" -eq 1 ]; then
    echo "  scratch RETAINED for forensics: $SCRATCH" >&2
  else
    rm -rf "$SCRATCH"
  fi
  exit $rc
}
trap cleanup EXIT INT TERM

# ── G17/CR-77: a withdrawal that cannot name a safe target must REFUSE, not widen ────────
withdraw_path() {
  local raw="${1:?withdraw_path: empty argument is a FATAL bug, not a no-op}"
  local expanded="${raw/#\$HOME/$HOME}"
  expanded="${expanded%/}"                     # strip trailing slash BEFORE any prefix test

  case "$expanded" in
    ""|"/"|"$HOME"|"$REPO_ROOT") echo "${RED}FATAL${NC}: refusing to withdraw '$raw' — resolves to a root." >&2; return 2 ;;
  esac
  # Must live strictly inside the repo, or inside the one declared external root.
  case "$expanded" in
    "$REPO_ROOT"/?*|"$HOME"/massu/?*) : ;;
    /*) echo "${RED}FATAL${NC}: refusing to withdraw '$expanded' — outside every allowed root." >&2; return 2 ;;
    *)  expanded="$REPO_ROOT/$expanded" ;;
  esac
  case "$expanded" in *..*) echo "${RED}FATAL${NC}: refusing '$expanded' — contains '..'." >&2; return 2 ;; esac

  [ -e "$expanded" ] || { echo "    ${YELLOW}already absent${NC}: $raw"; return 1; }

  local dst; dst="$STASH/$(printf '%s' "$expanded" | tr '/' '_')"
  mkdir -p "$(dirname "$dst")"
  mv "$expanded" "$dst" || { echo "${RED}FATAL${NC}: mv failed for $expanded" >&2; return 2; }
  printf '%s\t%s\n' "$expanded" "$dst" >> "$MANIFEST"
  echo "    withdrew: $expanded"
  return 0
}

# ── verdict map: gate id -> OK|FAIL|ABSENT, parsed from a sweep's own output ─────────────
sweep_verdicts() {  # $1 = output file, $2 = destination tsv
  python3 - "$1" "$2" <<'PY'
import re, sys
src, dst = sys.argv[1], sys.argv[2]
try:
    text = open(src, encoding="utf-8", errors="replace").read()
except OSError as e:
    sys.exit(f"FATAL: cannot read sweep output {src}: {e}")
text = re.sub(r"\x1b\[[0-9;]*m", "", text)          # ANSI would defeat ^-anchored patterns
rows = {}
for m in re.finditer(r"^(OK|FAIL)\s+\[([^\]]+)\]", text, re.M):
    rows[m.group(2)] = m.group(1)
for m in re.finditer(r"^── (\S+)$", text, re.M):
    rows.setdefault(m.group(1), "SEEN")
if not rows:
    sys.exit("FATAL: parsed 0 verdicts from the sweep — 'scanned 0, found 0' is not a pass (M1).")
with open(dst, "w", encoding="utf-8") as fh:
    for gid, v in sorted(rows.items()):
        fh.write(f"{gid}\t{v}\n")
print(f"    parsed {len(rows)} verdict(s)")
PY
}

VOCAB_NAMES="$(python3 -c '
import json,sys
sot=json.load(open(sys.argv[1]))
v=sot.get("vocabulary") or {}
if not v: sys.exit("FATAL: vocabulary is EMPTY — refusing to probe (M1/M2).")
print("\n".join(sorted(v)))' "$SOT")" || exit 2

if [ -n "$ONLY_REQ" ]; then
  # R-011 again: an unmatched requirement name is refused, never fuzzy-matched.
  printf '%s\n' "$VOCAB_NAMES" | grep -qx -- "$ONLY_REQ" || {
    echo "${RED}FATAL${NC}: '$ONLY_REQ' is not in the vocabulary. Known:" >&2
    printf '%s\n' "$VOCAB_NAMES" | sed 's/^/  /' >&2; exit 2; }
  VOCAB_NAMES="$ONLY_REQ"
fi

REG_COUNT="$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["gates"]))' "$REGISTRY")" || exit 2

# ── INCREMENTAL ADJUDICATION (--gates) ───────────────────────────────────────────────────
# Adding ONE gate to the registry used to cost a full re-probe: invariant 3c compared the
# registry COUNT against provenance.registry_gates_at_probe, so any growth demanded all six
# withdrawal sweeps over every gate (~2.5-3h) — and that full run is also what re-triggers
# the OPEN incident where a withdrawal disarms live consumers (the Stop retro hook,
# ~/massu/.git/hooks/pre-push) for ~25 min per requirement.
#
# A gate's verdict under a withdrawal depends only on THAT gate, so the delta can be
# adjudicated on its own. The runner already accepts `--gate <id>`; this scopes every sweep
# through it and MERGES the result into the ledger instead of replacing it. Adjudicating a
# 2-gate delta is then 2 x 6 single-gate sweeps — minutes.
#
# Per-gate is also the mode this probe already trusts most: the batch sweep NARROWS and each
# candidate is CONFIRMED individually below, precisely because a truncated batch reads as a
# finding. Scoping simply starts from the confirmation mode.
SCOPED_IDS=""
if [ -n "$GATES_SCOPE" ]; then
  SCOPED_IDS="$(printf '%s' "$GATES_SCOPE" | tr ',' '\n' | sed '/^[[:space:]]*$/d')"
  [ -n "$SCOPED_IDS" ] || { echo "${RED}FATAL${NC}: --gates given an empty list." >&2; exit 2; }
  # R-011: every id must exist in the registry. An unmatched id is REFUSED, never skipped —
  # a silently-dropped id would shrink the adjudicated set while reporting success.
  # The id list travels as ARGV, not stdin: this python block is itself a heredoc on stdin,
  # so a here-string would silently replace the script with the data.
  UNKNOWN="$(python3 - "$REGISTRY" "$SCOPED_IDS" <<'PY'
import json, sys
reg = {g["id"] for g in json.load(open(sys.argv[1]))["gates"]}
want = [ln.strip() for ln in sys.argv[2].splitlines() if ln.strip()]
print("\n".join(w for w in want if w not in reg))
PY
)" || exit 2
  if [ -n "$UNKNOWN" ]; then
    echo "${RED}FATAL${NC}: --gates names $(printf '%s\n' "$UNKNOWN" | grep -c '') id(s) not in $REGISTRY:" >&2
    printf '%s\n' "$UNKNOWN" | sed 's/^/  /' >&2
    exit 2
  fi
  echo "  SCOPED to $(printf '%s\n' "$SCOPED_IDS" | grep -c '') gate(s) — the ledger will be MERGED, not replaced."
fi

echo "══ probe-gate-requires ══"
echo "  repo root       : $REPO_ROOT"
echo "  registry gates  : $REG_COUNT"
echo "  vocabulary      : $(printf '%s\n' "$VOCAB_NAMES" | grep -c '') of $(printf '%s\n' "$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["vocabulary"]))' "$SOT")") entries selected"
echo

if [ "$LIST" -eq 1 ]; then
  python3 - "$SOT" <<'PY'
import json, sys
sot = json.load(open(sys.argv[1]))
print(f"{'requirement':<24} {'satisfied?':<12} remedy")
for name, spec in sorted(sot["vocabulary"].items()):
    print(f"{name:<24} {'(run --dry-run)':<12} {spec['remedy'][:74]}")
print()
prov = sot.get("provenance", {})
print("provenance:", json.dumps(prov, indent=2))
req = sot.get("requires") or {}
print(f"\nadjudicated gates: {len(req)}")
for gid, names in sorted(req.items()):
    print(f"  {gid}\n      requires: {names}")
PY
  exit 0
fi

# ── every vocabulary probe must PASS before we can measure a withdrawal against it ───────
echo "── baseline: every vocabulary probe must be SATISFIED before any withdrawal ──"
UNSAT=0
for name in $VOCAB_NAMES; do
  probe="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["vocabulary"][sys.argv[2]]["probe"])' "$SOT" "$name")"
  if bash -c "$probe" >/dev/null 2>&1; then
    echo "  ${GREEN}SATISFIED${NC}  $name"
  else
    echo "  ${RED}UNMET${NC}      $name  — remedy: $(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["vocabulary"][sys.argv[2]]["remedy"])' "$SOT" "$name")"
    UNSAT=$((UNSAT + 1))
  fi
done
if [ "$UNSAT" -gt 0 ]; then
  echo
  echo "${RED}FATAL${NC}: $UNSAT precondition(s) already unmet — a differential probe needs a" >&2
  echo "       fully provisioned baseline, or 'changed' and 'was already broken' are the same" >&2
  echo "       value and that value is the passing one (blind-gate law)." >&2
  exit 2
fi
echo

if [ "$DRY_RUN" -eq 1 ]; then
  echo "${YELLOW}DRY RUN${NC} — would run 1 baseline sweep + $(printf '%s\n' "$VOCAB_NAMES" | grep -c '') withdrawal sweep(s):"
  for name in $VOCAB_NAMES; do
    echo "  $name"
    python3 - "$SOT" "$name" <<'PY'
import json, sys
spec = json.load(open(sys.argv[1]))["vocabulary"][sys.argv[2]]
paths = spec.get("withdraw", [])
for p in paths:
    print(f"      withdraw {p}")
if not paths:
    method = spec.get("withdraw_method", "")
    if method == "shallow-clone":
        print("      withdraw via depth-1 git clone (history cannot be renamed aside);")
        print("      the clone's depth is asserted, so a failed withdrawal cannot read as 'no gates require it'")
    elif method:
        print(f"      withdraw_method={method} — NO HARNESS IMPLEMENTED; would record UNPROBEABLE (a FINDING)")
    else:
        print("      UNPROBEABLE: no withdraw paths and no withdraw_method (a FINDING, not a skip)")
PY
  done
  echo
  echo "Tree is NOT modified by --dry-run."
  exit 0
fi

# ── the ADJUDICATOR MUST NOT BE CONSTRAINED BY ITS OWN PRIOR CONCLUSIONS ──────────────
#
# This probe measures which gates require which artifacts by WITHDRAWING an artifact and
# seeing which gates go red. The runner's preflight reads the very ledger this script
# writes, and FATALs the whole sweep when a declared-required artifact is absent — which is
# exactly the state every withdrawal deliberately creates. So a populated ledger makes each
# withdrawal sweep abort with ZERO verdicts.
#
# Measured 2026-07-28: the probe succeeded exactly once, against an empty ledger
# (`dc29151b`: requires=0, probed=false). The first re-run after `6c52ae9f` populated 14
# annotations died on the first withdrawal — "parsed 0 verdicts". A one-shot adjudicator
# blocks every future gate addition.
#
# Fix: sweeps run against a NEUTRALIZED copy of the ledger — vocabulary preserved (the probe
# still needs the withdraw specs), `requires` emptied. The copy lives in scratch; the tracked
# file is never mutated.
NEUTRAL_SOT="$SCRATCH/gate-requires.neutralized.json"
python3 - "$SOT" "$NEUTRAL_SOT" <<'PY' || { echo "FATAL: could not build the neutralized ledger" >&2; exit 2; }
import json, sys
src, dst = sys.argv[1], sys.argv[2]
d = json.load(open(src))
d["requires"] = {}                      # the whole point: measure, do not assume
d.setdefault("provenance", {})["probed"] = False
json.dump(d, open(dst, "w"), indent=2, ensure_ascii=True)
PY
# FAIL CLOSED — an unreadable or non-empty neutralized ledger must never be used silently.
python3 - "$NEUTRAL_SOT" <<'PY' || exit 2
import json, sys
d = json.load(open(sys.argv[1]))
n = len(d.get("requires", {}))
if n: sys.exit(f"FATAL: neutralized ledger still declares {n} requirement(s)")
if not d.get("vocabulary"): sys.exit("FATAL: neutralized ledger lost its vocabulary")
PY
export MASSU_REQUIRES_SOT="$NEUTRAL_SOT"

# ONE chokepoint — the runner is invoked from three places (baseline, withdrawal, per-item
# confirmation) and all three must be neutralized. Patching them individually is how a fix
# lands at one site of N (CR-74).
run_sweep() {  # run_sweep <outfile> [extra runner args...]
  local _out="$1"; shift
  MASSU_REQUIRES_SOT="$NEUTRAL_SOT" bash "$RUNNER" "$@" > "$_out" 2>&1
}

# The sweep used by the baseline and every withdrawal. Unscoped it is one whole-registry run;
# under --gates it is one single-gate run per scoped id, concatenated. Concatenating is safe
# because sweep_verdicts parses per-gate `OK|FAIL [id]` lines, and a single-gate run cannot be
# truncated by an unrelated gate's abort — the same property the per-item confirmation below
# already relies on.
#
# The exit status reported is the WORST across the scoped runs, never the last one's: a run
# that aborted must not be masked by a later one that succeeded.
run_sweep_selected() {   # run_sweep_selected <outfile>
  local _out="$1" _gid _one _rc _worst=0 _n=0
  if [ -z "$SCOPED_IDS" ]; then
    run_sweep "$_out"
    return $?
  fi
  : > "$_out"
  while IFS= read -r _gid; do
    [ -n "$_gid" ] || continue
    _one="${_out}.one"
    run_sweep "$_one" --gate "$_gid"; _rc=$?
    [ "$_rc" -gt "$_worst" ] && _worst=$_rc
    cat "$_one" >> "$_out"
    _n=$((_n + 1))
  done <<EOF
$SCOPED_IDS
EOF
  # M1 — a scoped sweep that ran zero gates must not read as a clean sweep.
  if [ "$_n" -eq 0 ]; then
    echo "FATAL: scoped sweep ran 0 gates — refusing to treat that as a result." >&2
    return 2
  fi
  return $_worst
}

if [ -n "$SCOPED_IDS" ]; then
  echo "── baseline sweep (SCOPED to $(printf '%s\n' "$SCOPED_IDS" | grep -c '') of $REG_COUNT gates, everything provisioned) ──"
else
  echo "── baseline sweep (all $REG_COUNT gates, everything provisioned) ──"
fi
BASE_OUT="$SCRATCH/baseline.out"; BASE_TSV="$SCRATCH/baseline.tsv"
run_sweep_selected "$BASE_OUT"; BASE_RC=$?

# POSITIVE CONTROL that the injection actually took effect. The runner announces its own
# preflight scope; with a neutralized ledger it MUST report zero requirements. Without this
# check, an override that silently failed to apply would look exactly like a healthy run
# right up until the first withdrawal aborted (G2 — observe EXECUTION, not configuration).
if ! grep -qE 'preflight[[:space:]]*:[[:space:]]*0 requirement\(s\)' "$BASE_OUT"; then
  echo "${RED}FATAL${NC}: the neutralized ledger did not reach the runner — its preflight did" >&2
  echo "       not report 0 requirement(s). Refusing to measure against a ledger that already" >&2
  echo "       encodes the answer." >&2
  grep -E 'preflight' "$BASE_OUT" >&2 || echo "       (no preflight line in the sweep output)" >&2
  KEEP_SCRATCH=1
  exit 2
fi
echo "  sweep exit: $BASE_RC"
sweep_verdicts "$BASE_OUT" "$BASE_TSV" || exit 2
echo

RESULTS="$SCRATCH/results.tsv"; : > "$RESULTS"

# M1 — the ADJUDICATOR's own denominator. `requires: {}` is a legitimate finding ("nothing
# needs an artifact") and is ALSO what a crashed run produces, so the two must be told apart
# by something other than the results file being empty. Every requirement that completes its
# withdrawal/verdict/restore cycle increments this; the write is gated on it matching the
# selected set, and a shortfall is FATAL. Without this the probe's failure mode is to publish.
REQ_SELECTED=$(printf '%s\n' "$VOCAB_NAMES" | grep -c '')
REQ_ADJUDICATED=0

for name in $VOCAB_NAMES; do
  echo "── withdrawing: $name ──"
  method="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["vocabulary"][sys.argv[2]].get("withdraw_method",""))' "$SOT" "$name")"
  # NOT `mapfile` — bash 3.2 (macOS /bin/bash) has no such builtin; see the portability
  # preflight above for the run this exact line silently destroyed.
  #
  # COMMAND substitution, not PROCESS substitution: `read_lines_into paths < <(python3 …)`
  # discards python's exit status, so a crashed extractor yields an empty list — and an empty
  # list routes to the UNPROBEABLE branch, recording "this requirement cannot be tested" when
  # the truth is "the extractor died". An empty list with rc=0 IS legitimate (full-git-history
  # declares no withdraw paths), so emptiness alone cannot carry the error; the exit code must.
  paths_raw="$(python3 -c 'import json,sys
for p in json.load(open(sys.argv[1]))["vocabulary"][sys.argv[2]].get("withdraw",[]): print(p)' "$SOT" "$name")" || {
    echo "${RED}FATAL${NC}: could not read withdraw paths for '$name' — refusing to treat an" >&2
    echo "       extractor failure as 'no paths to withdraw'." >&2
    exit 2; }
  paths=()
  read_lines_into paths <<< "$paths_raw"

  if [ "${#paths[@]}" -eq 0 ] && [ "$method" = "shallow-clone" ]; then
    # G20: a stated limitation is a FINDING, not a disclosure. `full-git-history` cannot be
    # withdrawn by renaming a path — the repo's history is not a file — so it gets its own
    # harness rather than an UNPROBEABLE label. A depth-1 clone reproduces exactly the CI
    # condition the requirement exists for (actions/checkout without fetch-depth: 0).
    echo "  withdrawal method: shallow-clone (history cannot be renamed aside)"
    SHALLOW="$SCRATCH/shallow"
    rm -rf "$SHALLOW"
    if ! git clone --quiet --depth 1 "file://$REPO_ROOT" "$SHALLOW" 2>"$SCRATCH/clone.err"; then
      echo "  ${RED}FATAL${NC}: depth-1 clone failed — cannot probe $name:" >&2
      cat "$SCRATCH/clone.err" >&2
      exit 2
    fi
    DEPTH="$(git -C "$SHALLOW" rev-list --count HEAD)"
    # POSITIVE CONTROL: the clone must actually be shallow, or "no gate required it" and
    # "the withdrawal never happened" are the same value — and that value passes (M1).
    if [ "$DEPTH" -gt 1 ]; then
      echo "  ${RED}FATAL${NC}: the depth-1 clone has $DEPTH commits — the withdrawal did NOT" >&2
      echo "         take effect, so any verdict from it would be meaningless." >&2
      exit 2
    fi
    echo "    shallow clone depth: $DEPTH commit (full tree has $(git rev-list --count HEAD))"
    CONFIRMED=0; NCAND=0
    # Only gates whose proof READS history can differ; run every guard-kind gate's proof
    # script in the shallow tree and compare against its baseline verdict.
    while IFS=$'\t' read -r gid basev; do
      [ -n "${gid:-}" ] || continue
      case "$gid" in shell-gate-script::*) : ;; *) continue ;; esac
      NCAND=$((NCAND + 1))
      ps="${gid#shell-gate-script::}"
      [ -f "$SHALLOW/$ps" ] || continue
      if ( cd "$SHALLOW" && bash "$ps" >/dev/null 2>&1 ); then onev="OK"; else onev="FAIL"; fi
      if [ "$onev" != "$basev" ]; then
        echo "      REQUIRED  $gid   ($basev -> $onev in a depth-1 clone)"
        printf '%s\tREQUIRED\t%s\n' "$name" "$gid" >> "$RESULTS"
        CONFIRMED=$((CONFIRMED + 1))
      fi
    done < <(cut -f1,2 "$BASE_TSV")
    echo "    probed $NCAND shell-gate-script proof(s) in the shallow clone; confirmed $CONFIRMED"
    if [ "$NCAND" -eq 0 ]; then
      # AN EMPTY INTERSECTION IS NOT A BLIND ZERO, AND CONFLATING THEM BRICKED THE REMEDY.
      #
      # This harness can only detect the requirement in a shell-gate-script proof — it runs each
      # such script inside the depth-1 clone. So NCAND counts the SELECTED gates of that kind,
      # and `--gates <a vitest-guard>` legitimately selects none. Aborting then made the
      # documented delta remedy at :196 unusable for exactly the case it exists for: adding ONE
      # vitest guard makes 3c red, and the prescribed `--gates <id> --write` FATAL'd here on a
      # zero that means "this requirement cannot apply to what you selected" (G26/CR-89 — a
      # per-item precondition failure must be reported, never abort the batch).
      #
      # Hit 2026-07-29 registering ci-mirror-provisioning-parity-drift-guard.
      #
      # The M1 assertion still bites where it should. A FULL run always selects shell-gate-script
      # gates, so a harness that stopped finding them still aborts — the guard below distinguishes
      # "the selection contains none" from "the selection contains some and I found none".
      SEL_SHELL_TOTAL="$(cut -f1 "$BASE_TSV" | grep -c '^shell-gate-script::' || true)"
      if [ "${SEL_SHELL_TOTAL:-0}" -ne 0 ]; then
        echo "  ${RED}FATAL${NC}: probed 0 proofs while $SEL_SHELL_TOTAL shell-gate-script gate(s)" >&2
        echo "         were selected — scanned 0 over a non-empty candidate set is not a pass (M1)." >&2
        exit 2
      fi
      # NEITHER NO_GATES NOR UNPROBEABLE — both would be a claim this run did not earn.
      #   NO_GATES      asserts "nothing requires full git history", about gates this method
      #                 never examines. Unmeasured, in the dangerous direction.
      #   UNPROBEABLE   asserts the requirement is unprobeable IN GENERAL. It is not — a full
      #                 run probes it fine. Writing it here let a DELTA overwrite a FULL run's
      #                 verdict, which is how the first delta flipped the ledger's
      #                 unprobeable_requirements from [] to ['full-git-history'].
      # NOT_IN_SELECTION says only what is true: this selection had nothing it could apply to.
      # It counts as adjudicated (the denominator stays coherent) and the writer carries the
      # PRIOR global verdict forward instead of replacing it.
      echo "  ${YELLOW}NOT APPLICABLE${NC}: '$name' is only detectable in a shell-gate-script proof,"
      echo "  and this selection contains none. Recorded NOT_IN_SELECTION — the prior global"
      echo "  verdict is kept, because a delta that examined nothing has learned nothing."
      printf '%s\tNOT_IN_SELECTION\t%s\n' "$name" "${method:-none}" >> "$RESULTS"
      rm -rf "$SHALLOW"
      REQ_ADJUDICATED=$((REQ_ADJUDICATED + 1))
      echo
      continue
    fi
    [ "$CONFIRMED" -eq 0 ] && printf '%s\tNO_GATES\t-\n' "$name" >> "$RESULTS"
    rm -rf "$SHALLOW"
    REQ_ADJUDICATED=$((REQ_ADJUDICATED + 1))
    echo
    continue
  fi

  if [ "${#paths[@]}" -eq 0 ]; then
    # No withdraw paths AND no dedicated method: this is UNPROBEABLE and is recorded as such,
    # never as "no gates require it". A requirement nobody can test is an open finding.
    echo "  ${RED}UNPROBEABLE${NC}: no withdraw paths and no withdraw_method for '$name'."
    echo "  Recorded UNPROBEABLE. This is a FINDING — a requirement that cannot be adjudicated"
    echo "  must not be silently reported as requiring nothing."
    printf '%s\tUNPROBEABLE\t%s\n' "$name" "${method:-none}" >> "$RESULTS"
    # UNPROBEABLE is an ADJUDICATED outcome — the probe reached a verdict about it (namely
    # that it cannot be tested, which the ledger records as a finding). It is not a skip, so
    # it counts toward the denominator; what must never count is a requirement the loop never
    # reached at all.
    REQ_ADJUDICATED=$((REQ_ADJUDICATED + 1))
    echo
    continue
  fi

  WITHDREW=0
  for p in "${paths[@]}"; do
    withdraw_path "$p"; wrc=$?
    [ "$wrc" -eq 2 ] && { echo "${RED}FATAL${NC}: withdrawal refused for $name" >&2; exit 2; }
    [ "$wrc" -eq 0 ] && WITHDREW=$((WITHDREW + 1))
  done
  if [ "$WITHDREW" -eq 0 ]; then
    echo "  ${RED}FATAL${NC}: withdrew 0 of ${#paths[@]} path(s) for $name — a probe that changed" >&2
    echo "         nothing cannot distinguish 'no gate requires this' from 'the probe did not run'." >&2
    exit 2
  fi

  # Re-assert exclusivity BEFORE every sweep, not just at startup. A start-only check leaves
  # the whole multi-hour run unguarded against a session that begins sweeping at minute two —
  # which is the same contamination, arriving slightly later.
  assert_exclusive || { echo "${RED}FATAL${NC}: a foreign sweep started mid-run — aborting before $name." >&2; exit 2; }

  OUT="$SCRATCH/$name.out"; TSV="$SCRATCH/$name.tsv"
  run_sweep_selected "$OUT"; RC=$?

  # ...and AFTER, because a sweep that began while this one ran would have interleaved its
  # plants with our withdrawal. Detecting it afterwards still beats writing the result.
  assert_exclusive || { echo "${RED}FATAL${NC}: a foreign sweep ran DURING $name's sweep — its verdicts are contaminated, discarding." >&2; exit 2; }
  echo "  sweep exit: $RC (baseline was $BASE_RC)"
  sweep_verdicts "$OUT" "$TSV" || exit 2

  # A withdrawal sweep can ABORT EARLY (exit 2 is the FATAL channel), and every gate after
  # the abort then vanishes from the output. Diffing naively would mark all of them
  # REQUIRED — a truncated sweep read as a finding, which is the very confusion X-2 exists
  # to end. So: the sweep NARROWS, and each candidate is then CONFIRMED individually.
  CAND="$SCRATCH/$name.candidates"
  python3 "$REPO_ROOT/scripts/lib/probe-diff-verdicts.py" "$BASE_TSV" "$TSV" "$CAND" || {
    echo "${RED}FATAL${NC}: verdict diff failed for $name — refusing to adjudicate." >&2; exit 2; }

  # CONFIRM each candidate on its own, still in the withdrawn state. A single-gate run
  # cannot be truncated by an unrelated gate's abort, so its verdict is attributable.
  NCAND=$(count_lines "$CAND") || exit 2
  echo "    confirming $NCAND candidate(s) individually..."
  CONFIRMED=0
  while IFS=$'\t' read -r gid basev _after; do
    [ -n "${gid:-}" ] || continue
    one="$SCRATCH/one.out"
    run_sweep "$one" --gate "$gid"; orc=$?
    onev="$(python3 - "$one" "$gid" <<'PY'
import re, sys
try:
    t = re.sub(r"\x1b\[[0-9;]*m", "", open(sys.argv[1], encoding="utf-8", errors="replace").read())
except OSError:
    print("UNREADABLE"); raise SystemExit(0)
m = re.search(r"^(OK|FAIL)\s+\[" + re.escape(sys.argv[2]) + r"\]", t, re.M)
print(m.group(1) if m else ("PRECONDITION" if "PRECONDITION MISSING" in t else "NO_VERDICT"))
PY
)"
    if [ "$onev" != "$basev" ]; then
      echo "      REQUIRED  $gid   ($basev -> $onev, single-gate exit $orc)"
      printf '%s\tREQUIRED\t%s\n' "$name" "$gid" >> "$RESULTS"
      CONFIRMED=$((CONFIRMED + 1))
    else
      echo "      refuted   $gid   (sweep said differing, single-gate says $onev — truncation artefact)"
    fi
  done < "$CAND"
  echo "    confirmed $CONFIRMED of $NCAND candidate(s)"
  [ "$CONFIRMED" -eq 0 ] && printf '%s\tNO_GATES\t-\n' "$name" >> "$RESULTS"

  restore_all || { echo "${RED}FATAL${NC}: restore failed after $name" >&2; exit 2; }
  echo "  restored."
  REQ_ADJUDICATED=$((REQ_ADJUDICATED + 1))
  echo
done

echo "══ ADJUDICATION ══"
echo "  requirements adjudicated : $REQ_ADJUDICATED of $REQ_SELECTED selected"
echo "  baseline verdicts        : $(count_lines "$BASE_TSV") over $REG_COUNT registry gates"
echo
awk -F'\t' '{print}' "$RESULTS" | LC_ALL=C sort
echo

# ── THE WRITE IS GATED ON THE DENOMINATOR (M1/M2) ────────────────────────────────────────
# A run that adjudicated fewer requirements than it selected has NOT measured the property,
# and `requires: {}` from such a run is indistinguishable from the genuine finding "nothing
# requires an artifact" — except that this check can tell them apart. The first --write run
# of this probe adjudicated 0 of 6, wrote `probed: true, gates_probed: 409`, and exited 0;
# the drift-guard then passed 10/10 over that fabrication because a provenance block claiming
# a probe was the one thing nothing verified. Refusing here is the primary fix; the guard's
# coherence assertion is the second layer.
if [ "$REQ_ADJUDICATED" -lt "$REQ_SELECTED" ]; then
  echo "${RED}FATAL${NC}: adjudicated $REQ_ADJUDICATED of $REQ_SELECTED requirement(s)." >&2
  echo "       The run did not complete, so its result is not a measurement. REFUSING to" >&2
  echo "       write $SOT — publishing a partial probe as an adjudication is how 'the probe" >&2
  echo "       crashed' becomes 'nothing requires an artifact' (blind-gate law)." >&2
  echo "       Scratch RETAINED for forensics: $SCRATCH" >&2
  KEEP_SCRATCH=1
  exit 2
fi

if [ "$WRITE" -eq 1 ]; then
  HEAD_SHA="$(git rev-parse HEAD)"
  BASE_VERDICTS="$(count_lines "$BASE_TSV")" || exit 2
  python3 - "$SOT" "$RESULTS" "$HEAD_SHA" "$REG_COUNT" "$REQ_SELECTED" "$REQ_ADJUDICATED" "$BASE_VERDICTS" "$BASE_TSV" "$SCOPED_IDS" <<'PY'
import json, subprocess, sys
sot_p, res_p, head = sys.argv[1], sys.argv[2], sys.argv[3]
reg_count, req_selected, req_adjudicated, base_verdicts = (int(x) for x in sys.argv[4:8])
base_tsv, scoped_raw = sys.argv[8], sys.argv[9]
scoped = [ln.strip() for ln in scoped_raw.splitlines() if ln.strip()]
sot = json.load(open(sot_p))
req = {}
unprobeable = []
not_in_selection = []
# CLOSED VOCABULARY (G3). An unrecognised verdict used to fall through this chain silently,
# which is the "malformed and skipped" hole: a typo in a verdict string would drop a real
# finding and the tally would never notice. Every verdict must be handled by name or be fatal.
KNOWN_VERDICTS = {"REQUIRED", "UNPROBEABLE", "NO_GATES", "NOT_IN_SELECTION"}
for line in open(res_p, encoding="utf-8"):
    name, verdict, gid = line.rstrip("\n").split("\t")
    if verdict not in KNOWN_VERDICTS:
        sys.exit(f"FATAL: unrecognised verdict {verdict!r} for requirement {name!r}. "
                 f"Known: {sorted(KNOWN_VERDICTS)}. A verdict this writer cannot interpret must "
                 f"never be silently skipped — that drops a real finding invisibly (G3).")
    if verdict == "REQUIRED":
        req.setdefault(gid, [])
        if name not in req[gid]:
            req[gid].append(name)
    elif verdict == "UNPROBEABLE":
        unprobeable.append(name)
    elif verdict == "NOT_IN_SELECTION":
        # "This delta selected no gate this requirement can apply to" — NOT a global claim.
        not_in_selection.append(name)
for gid in req:
    req[gid].sort()

# The gates this run actually returned a baseline verdict for. This is the ADJUDICATED SET —
# the thing invariant 3c needs and never had. Until 2026-07-29 the ledger recorded only a
# COUNT (registry_gates_at_probe), so 3c could say "2 gates were never probed" but not WHICH,
# and any registry growth forced a full re-probe.
measured = set()
try:
    with open(base_tsv, encoding="utf-8") as fh:
        for line in fh:
            gid = line.split("\t")[0].strip()
            if gid:
                measured.add(gid)
except OSError as e:
    sys.exit(f"FATAL: cannot read baseline verdicts {base_tsv}: {e}")
if not measured:
    sys.exit("FATAL: baseline produced 0 gate verdicts — refusing to record an empty adjudicated set (M1).")

prior_requires = sot.get("requires") or {}
prior_adjudicated = set(sot.get("provenance", {}).get("adjudicated_gate_ids") or [])
prior_unprobeable = set(sot.get("provenance", {}).get("unprobeable_requirements") or [])

if scoped:
    # MERGE. Out-of-scope gates keep their prior adjudication; in-scope gates are REPLACED by
    # this run's finding — including being DROPPED when they now require nothing, which is a
    # real result and must not be masked by the old entry surviving.
    merged = {gid: names for gid, names in prior_requires.items() if gid not in set(scoped)}
    merged.update(req)
    sot["requires"] = dict(sorted(merged.items()))
    adjudicated = prior_adjudicated | measured
else:
    sot["requires"] = dict(sorted(req.items()))
    adjudicated = measured
utc = subprocess.run(["date", "-u", "+%Y-%m-%dT%H:%M:%SZ"], capture_output=True, text=True).stdout.strip()
# `gates_probed` used to be set to reg_count unconditionally — a number that says only "the
# registry had N rows", asserted as if it were a measurement. It now carries the count of
# gates the BASELINE SWEEP actually returned a verdict for, which is what the withdrawal
# sweeps were diffed against, and the requirement-level denominator sits beside it.
sot["provenance"].update({
    "probed": True, "probed_at_head": head, "probed_at_utc": utc,
    "registry_gates_at_probe": reg_count, "gates_probed": base_verdicts,
    "requirements_selected": req_selected,
    "requirements_adjudicated": req_adjudicated,
    # A DELTA MUST NOT DOWNGRADE A FULL RUN'S VERDICT. `unprobeable_requirements` is a GLOBAL
    # claim about the whole registry. A `--gates` run that selected no gate a requirement can
    # apply to has learned NOTHING about it, so it carries the prior value forward instead of
    # asserting its own narrower view — measured 2026-07-29, when the first delta run flipped
    # this field from [] to ['full-git-history'] purely because the one selected gate was a
    # vitest guard, overwriting a full run that HAD probed it. That is the "a tool that writes a
    # source of truth it also reads" hazard: each narrow run erodes what a broad one established.
    "unprobeable_requirements": sorted(
        (set(unprobeable) | (prior_unprobeable & set(not_in_selection))) if scoped
        else set(unprobeable)
    ),
    # The SET, not just the count. Invariant 3c reads this to name exactly which registry
    # gates have never been adjudicated, and `--gates` unions into it so a delta costs a
    # delta-sized run.
    "adjudicated_gate_ids": sorted(adjudicated),
})
with open(sot_p, "w", encoding="utf-8") as fh:
    json.dump(sot, fh, indent=2, ensure_ascii=False)
    fh.write("\n")
print(f"wrote {sot_p}: {len(sot['requires'])} gate(s) annotated, "
      f"{len(set(unprobeable))} unprobeable requirement(s)"
      + (f" (+{len(not_in_selection)} not applicable to this selection, prior verdict kept)"
         if scoped and not_in_selection else "") + ", "
      f"{len(adjudicated)} gate(s) in the adjudicated set"
      + (f" (+{len(adjudicated - prior_adjudicated)} new this run)" if scoped else ""))
PY
else
  echo "${YELLOW}NOT WRITTEN${NC} — re-run with --write to update $SOT."
fi
