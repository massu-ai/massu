#!/usr/bin/env bash
# Copyright (c) 2026 Massu. All rights reserved.
# Licensed under BSL 1.1 - see LICENSE file for details.
#
# Attacks scripts/lib/safe-sandbox-paths.sh — the chokepoint for destructive path
# operations (G17 / CR-77).
#
# Every REFUSAL assertion is paired with a POSITIVE CONTROL that the same call
# SUCCEEDS on a legitimate input. Without that pair, "it refused" and "it never ran
# / it always refuses" are the same observation, and a function that returned 1
# unconditionally would score a perfect result.
#
# Every refusal also asserts the target STILL EXISTS afterwards. Exit code 1 with
# the directory already gone would be a catastrophic pass.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/lib/safe-sandbox-paths.sh
. "$REPO_ROOT/scripts/lib/safe-sandbox-paths.sh"

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; }
check() { if [ "$2" = "yes" ]; then ok "$1"; else bad "$1"; fi; }

# Run a command, capture its status on its OWN line (never through a pipe or inside
# a substitution), and report whether it matched the expectation.
#   refuses <desc> -- cmd...   expects NON-ZERO
#   accepts <desc> -- cmd...   expects ZERO
_run_expect() {
  local want="$1" desc="$2"; shift 3   # shift past want, desc, and the -- separator
  "$@" 2>/dev/null
  local rc=$?
  if [ "$want" = "zero" ]; then
    check "$desc" "$([ "$rc" -eq 0 ] && echo yes || echo no)"
  else
    check "$desc" "$([ "$rc" -ne 0 ] && echo yes || echo no)"
  fi
}
refuses() { _run_expect nonzero "$@"; }
accepts() { _run_expect zero "$@"; }

SANDBOX="$(mktemp -d)"
trap 'rm -rf "${SANDBOX:?}"' EXIT INT TERM

ROOT="$SANDBOX/root"
mkdir -p "$ROOT"

# A canary OUTSIDE the root. Nothing in this file may ever remove it; it is checked
# at the end, so a refusal that "worked" while deleting something else still fails.
CANARY="$SANDBOX/canary-outside-root"
mkdir -p "$CANARY"

fresh() { local p="$ROOT/$1"; mkdir -p "$p"; printf 'x' > "$p/file"; printf '%s' "$p"; }

printf -- '--- 1. require_path_component ---\n'
accepts 'accepts a normal value (positive control)' -- require_path_component 'x' 'ok-value'
refuses 'refuses an EMPTY value' -- require_path_component 'x' ''
refuses 'refuses a value containing ..' -- require_path_component 'x' '../escape'

printf -- '\n--- 2. rm_under_root_safely REMOVES a legitimate child (positive control) ---\n'
T="$(fresh child-a)"
accepts 'exits 0 on a legitimate direct child' -- rm_under_root_safely "$ROOT" "$T"
check "the child is actually GONE"            "$([ ! -e "$T" ] && echo yes || echo no)"
check "the ROOT itself survives"              "$([ -d "$ROOT" ] && echo yes || echo no)"

printf -- '\n--- 3. refusals — each asserts the target SURVIVES ---\n'
# An empty component is the whole defect class: "$ROOT/$ENC" with ENC="" degenerates
# to the root, and the composed string is non-empty so `[ -n ... ]` cannot see it.
EMPTY_COMPONENT=""
T="$(fresh child-b)"
refuses 'refuses a target that degenerates to the ROOT' -- rm_under_root_safely "$ROOT" "$ROOT/$EMPTY_COMPONENT"
check "  ... and the root's contents survive"         "$([ -e "$T" ] && echo yes || echo no)"

refuses 'refuses target == root' -- rm_under_root_safely "$ROOT" "$ROOT"
check "  ... root still exists"                       "$([ -d "$ROOT" ] && echo yes || echo no)"

# Trailing slash: "$ROOT/" would otherwise compare as DEEPER than "$ROOT" and slip
# straight through the containment test.
refuses 'refuses target == root with a trailing slash' -- rm_under_root_safely "$ROOT" "$ROOT/"
check "  ... root still exists"                        "$([ -d "$ROOT" ] && echo yes || echo no)"

refuses 'refuses a target OUTSIDE the root' -- rm_under_root_safely "$ROOT" "$CANARY"
check "  ... the outside target survives"              "$([ -d "$CANARY" ] && echo yes || echo no)"

refuses 'refuses an EMPTY root' -- rm_under_root_safely '' "$ROOT/child-b"
refuses 'refuses an EMPTY target' -- rm_under_root_safely "$ROOT" ''
refuses 'refuses root == /' -- rm_under_root_safely '/' '/etc'
check "  ... /etc still exists"                        "$([ -d /etc ] && echo yes || echo no)"

mkdir -p "$ROOT/deep/nested"
SSP_MIN_DEPTH=2 refuses 'refuses a target shallower than SSP_MIN_DEPTH' -- rm_under_root_safely "$ROOT" "$ROOT/deep"
check "  ... the shallow target survives"              "$([ -d "$ROOT/deep" ] && echo yes || echo no)"
SSP_MIN_DEPTH=2 accepts 'accepts a target AT SSP_MIN_DEPTH (control)' -- rm_under_root_safely "$ROOT" "$ROOT/deep/nested"

accepts 'already-absent is a NO-OP, not an error' -- rm_under_root_safely "$ROOT" "$ROOT/never-existed"

printf -- '\n--- 4. capture_required_output ---\n'
# shellcheck disable=SC2329  # invoked indirectly, as "$@" inside _run_expect
_emit()    { printf 'value'; }
# shellcheck disable=SC2329
_silent()  { return 0; }
# shellcheck disable=SC2329
_failing() { printf 'partial'; return 3; }

V="$(capture_required_output 'emit' _emit 2>/dev/null)"
check "returns the value on success (positive control)" "$([ "$V" = "value" ] && echo yes || echo no)"
refuses 'refuses EMPTY output even when exit is 0' -- capture_required_output 'silent' _silent
refuses 'refuses a NON-ZERO exit even with output' -- capture_required_output 'failing' _failing

printf -- '\n--- 5. blast radius ---\n'
check "canary outside the root is untouched"            "$([ -d "$CANARY" ] && echo yes || echo no)"
check "sandbox root still exists"                       "$([ -d "$ROOT" ] && echo yes || echo no)"

printf '\n=== RESULT: %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
