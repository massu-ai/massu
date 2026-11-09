#!/usr/bin/env bash
# Copyright (c) 2026 Massu. All rights reserved.
# Licensed under BSL 1.1 - see LICENSE file for details.
#
# BEHAVIOURAL proof that IMPORTING a built hook bundle does not run `main()`.
#
# WHY "exit 0" PROVES NOTHING HERE
# --------------------------------
# Every one of these hooks exits 0 whether or not `main()` ran — deliberately, so a
# PostToolUse/SessionStart hook can never block a session. A test asserting the exit
# code would be decoration. The observable difference is what the hook WRITES.
#
# WHAT IS MEASURED: WHETHER THE BRANCH IS TAKEN, NOT WHAT THE HOOK PRINTS
# -----------------------------------------------------------------------
# The property is "importing this module must not reach `main()`". `main()` is
# reachable through exactly one branch — the `isDirectInvocation` guard — so the
# direct measurement is whether that branch is TAKEN.
#
# Two copies are derived from each real bundle by `sed`, and in both the body of the
# guard is replaced by a MARKER WRITE, so neither copy ever calls `main()` and no
# hook side effects occur:
#
#   probe copy   if (isDirectInvocation(import.meta.url)) { <marker> }   marker must be ABSENT
#   forced copy  if (true)                                { <marker> }   marker must be PRESENT
#
# The forced copy is the positive control: without it, "no marker" is also what a
# bundle that failed to load, or a probe pointed at the wrong file, produces.
#
# WHY NOT MEASURE THE HOOK'S OUTPUT — the first design, and why it was wrong
# --------------------------------------------------------------------------
# The original probe imported the real bundle and counted bytes written, using empty
# stdin (which makes 17 of 18 hooks emit `HOOK FAILURE`) and escalating to a prompt
# payload for `memory-recall`, which returns silently on empty input by design.
#
# That escalation worked on this machine and FAILED ON CI, because the prompt payload
# only makes `memory-recall` emit when there is a memory corpus to recall from — 116
# files locally, none on a runner. The signal depended on machine-local state, which
# is the third instance in one day of a probe that passes on the dev platform and
# cannot run on the CI platform.
#
# Bytes written were always a PROXY for "the branch was taken". Measuring the branch
# directly removes the environment dependence, removes the payload roster, and works
# identically for all 18 hooks — including any future hook that prints nothing at all.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DIST="$REPO_ROOT/packages/core/dist/hooks"
SRC="$REPO_ROOT/packages/core/src/hooks"

# G29: hook-reachable — ASSERT the repository, scrub nothing. `--show-toplevel`
# cannot see a GIT_DIR leak (it returns the CWD); only --absolute-git-dir can.
ACTUAL_GIT_DIR="$(cd "$REPO_ROOT" && git rev-parse --absolute-git-dir)"
if [ "$ACTUAL_GIT_DIR" != "$REPO_ROOT/.git" ]; then
  echo "FATAL: git resolves to '$ACTUAL_GIT_DIR', expected '$REPO_ROOT/.git'." >&2
  exit 1
fi

[ -d "$DIST" ] || {
  echo "FATAL: $DIST does not exist. Run: cd packages/core && npm run build:hooks" >&2
  exit 1
}

TMP="$(mktemp -d -t hook-entry-guard-XXXXXX)"

# F2 — REDIRECT THE HOOK-FAILURE LOG BEFORE IMPORTING ANY BUNDLE.
# Every hook below can reach `recordHookFailure()`, which appends to the repo's live
# `.massu/hook-failures.jsonl` unless this seam overrides the path. That file is incident
# evidence — the only surviving record of 9,796 lost hook invocations — and SEVENTEEN rows
# already in it were written by an earlier version of THIS script, back when the probe fed
# empty stdin to real bundles and counted the bytes they emitted.
#
# The current design never calls `main()`, so nothing here is expected to write. That is
# exactly why the export stays: "expected not to write" is a claim about today's code, and
# the whole point of the seam is that the evidence log must not depend on that claim
# remaining true. This script runs OUTSIDE vitest, so the suite-wide byte-identity check in
# `hook-log-untouched.ts` does not cover it — this line is its only protection.
export MASSU_HOOK_FAILURE_LOG="$TMP/hook-failures.jsonl"
# shellcheck disable=SC2329  # invoked indirectly, by the trap below
cleanup() { rm -rf "$TMP"; rm -f "$DIST"/.entry-guard-probe-*.mjs "$DIST"/.entry-guard-forced-*.mjs; }
trap cleanup EXIT INT TERM

IMPORTER="$TMP/importer.mjs"
cat > "$IMPORTER" <<'JS'
await import(process.argv[2]);
JS

# M1 — the denominator is the SOURCE tree (what must be guarded), never whatever
# happens to be in dist. A stale dist must be an ERROR, not a smaller population
# that quietly passes.
SOURCES="$(find "$SRC" -maxdepth 1 -name '*.ts' | LC_ALL=C sort)"
SOURCE_COUNT="$(printf '%s\n' "$SOURCES" | sed '/^$/d' | wc -l | tr -d ' ')"
[ "$SOURCE_COUNT" -gt 0 ] || {
  echo "FATAL: enumerated 0 hook sources — refusing to report clean" >&2
  exit 1
}

MARKER='AV-ENTRY-BRANCH-TAKEN'

# Import $1 and report how many times the marker was written. Empty stdin: no copy
# ever calls main(), so nothing reads stdin and the payload is irrelevant.
marker_hits() {
  local target="$1" out="$TMP/probe.out"
  : | node "$IMPORTER" "$target" > "$out" 2>&1 || true
  grep -c "$MARKER" "$out" 2>/dev/null || true
}

fail=0
checked=0
controls_fired=0

echo "== hook entry-point guard: behavioural proof (mutation-controlled) =="
echo "   hook sources: $SOURCE_COUNT"
echo ""

while IFS= read -r ts; do
  [ -n "$ts" ] || continue
  name="$(basename "$ts" .ts)"
  bundle="$DIST/$name.js"
  checked=$((checked + 1))

  if [ ! -f "$bundle" ]; then
    printf 'FAIL  %-30s no bundle at dist/hooks/%s.js\n' "$name" "$name"
    fail=1
    continue
  fi

  # Both copies live BESIDE the original: these bundles resolve assets from
  # `import.meta.url`, so moving one elsewhere would change its behaviour and the
  # measurement would be of the move rather than of the guard.
  probe="$DIST/.entry-guard-probe-$name.mjs"
  forced="$DIST/.entry-guard-forced-$name.mjs"

  # Guard INTACT, body replaced by the marker — so main() is never called.
  sed "s|^if (isDirectInvocation(import\.meta\.url)) {$|if (isDirectInvocation(import.meta.url)) { process.stderr.write('$MARKER\\\\n'); } else if (false) {|" \
    "$bundle" > "$probe"
  # Guard FORCED OPEN, same marker — the positive control.
  sed "s|^if (isDirectInvocation(import\.meta\.url)) {$|if (true) { process.stderr.write('$MARKER\\\\n'); } else if (false) {|" \
    "$bundle" > "$forced"

  if ! grep -q "$MARKER" "$probe" || ! grep -q "$MARKER" "$forced"; then
    printf 'FAIL  %-30s guard line not found in the bundle — the rewrite produced no marker,\n' "$name"
    printf '      %-30s so both measurements below would be vacuous (emitted shape changed?)\n' ""
    fail=1
    rm -f "$probe" "$forced"
    continue
  fi

  forced_hits="$(marker_hits "$forced")"
  probe_hits="$(marker_hits "$probe")"
  rm -f "$probe" "$forced"

  # POSITIVE CONTROL first. Without it, "the marker did not appear" is also what a
  # bundle that fails to load produces, and the real assertion would prove nothing.
  if [ "${forced_hits:-0}" -lt 1 ]; then
    printf 'FAIL  %-30s forced-open control did NOT write the marker, so this probe cannot\n' "$name"
    printf '      %-30s see a taken branch and its silence on the real bundle proves nothing\n' ""
    fail=1
    continue
  fi
  controls_fired=$((controls_fired + 1))

  if [ "${probe_hits:-0}" -ne 0 ]; then
    printf 'FAIL  %-30s IMPORT TOOK THE ENTRY BRANCH — main() would have run (%s marker hit(s))\n' \
      "$name" "$probe_hits"
    fail=1
  else
    printf 'PASS  %-30s import did not take the entry branch; control fired (%s hit)\n' \
      "$name" "$forced_hits"
  fi
done <<EOF
$SOURCES
EOF

echo ""
echo "checked $checked of $SOURCE_COUNT   positive controls fired: $controls_fired"

if [ "$checked" -ne "$SOURCE_COUNT" ]; then
  echo "FAIL: checked $checked but there are $SOURCE_COUNT hook sources" >&2
  fail=1
fi

if [ "$fail" = "0" ]; then
  echo "RESULT: PASS — importing a hook is inert, and the probe is proven able to see it when it is not."
  exit 0
fi
echo "RESULT: FAIL"
exit 1
