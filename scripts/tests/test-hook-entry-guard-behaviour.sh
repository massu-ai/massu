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
# WHY EACH ASSERTION IS PAIRED WITH A MUTATION
# --------------------------------------------
# "The import produced no output" is also what a bundle that fails to load produces,
# and what a probe pointed at the wrong file produces. So every hook is measured
# TWICE: once as shipped, and once against a copy whose guard has been forced open
# (`if (isDirectInvocation(...))` -> `if (true)`). The forced-open copy MUST produce
# output. If it does not, the probe cannot see a running `main()` and its silence on
# the real bundle means nothing — that is reported as a FAILURE, not a pass.
#
# ESCALATION INSTEAD OF AN EXEMPTION ROSTER
# -----------------------------------------
# Empty stdin distinguishes 17 of 18 hooks: `main()` runs, fails to parse the
# payload, and writes a `HOOK FAILURE` line. `memory-recall` handles empty input by
# design (`if (!input.trim()) return void process.exit(0)`) and writes nothing, so
# empty stdin cannot tell its two states apart. Rather than exempt it — an exemption
# is a hole someone else inherits — the probe ESCALATES to a real prompt payload,
# which makes it emit its recall block. A hook that neither payload can distinguish
# FAILS LOUDLY and needs a human, so a future silent hook cannot slip through as
# "clean".
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

TMP="$(mktemp -d -t hook-entry-guard)"
# shellcheck disable=SC2329  # invoked indirectly, by the trap below
cleanup() { rm -rf "$TMP"; rm -f "$DIST"/.entry-guard-probe-*.mjs; }
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

# Bytes written to stdout+stderr by importing $1 with $2 on stdin.
import_output_bytes() {
  local target="$1" payload="$2" out="$TMP/probe.out"
  printf '%s' "$payload" | node "$IMPORTER" "$target" > "$out" 2>&1 || true
  wc -c < "$out" | tr -d ' '
}

PAYLOAD_EMPTY=''
PAYLOAD_PROMPT='{"prompt":"entry-guard probe","session_id":"entry-guard-probe","hook_event_name":"UserPromptSubmit"}'

fail=0
checked=0
distinguished_by_empty=0
distinguished_by_prompt=0

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

  # The forced-open copy lives BESIDE the original: these bundles resolve assets
  # from `import.meta.url`, so moving one elsewhere would change its behaviour and
  # the control would be measuring the move rather than the guard.
  forced="$DIST/.entry-guard-probe-$name.mjs"
  sed 's/^if (isDirectInvocation(import\.meta\.url)) {$/if (true) {/' "$bundle" > "$forced"

  if ! grep -q '^if (true) {$' "$forced"; then
    printf 'FAIL  %-30s guard line not found in the bundle — cannot force it open, so the\n' "$name"
    printf '      %-30s control below would be vacuous (has the emitted shape changed?)\n' ""
    fail=1
    rm -f "$forced"
    continue
  fi

  used=""
  for payload_name in EMPTY PROMPT; do
    case "$payload_name" in
      EMPTY)  payload="$PAYLOAD_EMPTY" ;;
      PROMPT) payload="$PAYLOAD_PROMPT" ;;
    esac
    forced_bytes="$(import_output_bytes "$forced" "$payload")"
    if [ "$forced_bytes" -gt 0 ]; then
      used="$payload_name"
      break
    fi
  done
  rm -f "$forced"

  if [ -z "$used" ]; then
    printf 'FAIL  %-30s NEITHER payload made the forced-open copy write anything, so this\n' "$name"
    printf '      %-30s probe cannot detect a running main() and its silence proves nothing\n' ""
    fail=1
    continue
  fi
  [ "$used" = "EMPTY" ] && distinguished_by_empty=$((distinguished_by_empty + 1))
  [ "$used" = "PROMPT" ] && distinguished_by_prompt=$((distinguished_by_prompt + 1))

  case "$used" in
    EMPTY)  payload="$PAYLOAD_EMPTY" ;;
    PROMPT) payload="$PAYLOAD_PROMPT" ;;
  esac
  real_bytes="$(import_output_bytes "$bundle" "$payload")"

  if [ "$real_bytes" -ne 0 ]; then
    printf 'FAIL  %-30s IMPORT RAN THE HOOK — %s byte(s) written (payload: %s)\n' \
      "$name" "$real_bytes" "$used"
    fail=1
  else
    printf 'PASS  %-30s import inert (0 bytes); forced-open control wrote %s byte(s) via %s\n' \
      "$name" "$forced_bytes" "$used"
  fi
done <<EOF
$SOURCES
EOF

echo ""
echo "checked $checked of $SOURCE_COUNT   distinguished by: empty=$distinguished_by_empty prompt=$distinguished_by_prompt"

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
