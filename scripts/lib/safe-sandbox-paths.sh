# Copyright (c) 2026 Massu. All rights reserved.
# Licensed under BSL 1.1 - see LICENSE file for details.
#
# Chokepoint for destructive path operations in test harnesses and ops scripts.
#
# THE DEFECT CLASS (G17 / CR-77)
# ------------------------------
#   ENC="$(encode_dir "$R")"          # helper fails -> prints nothing -> ENC=""
#   rm -rf "$ROOT/$ENC"               # -> rm -rf "$ROOT/"
#
# An empty path component does not error — it silently WIDENS the delete to the
# parent. A real harness destroyed one project's memory store outright and got 250
# files into a second before a circuit breaker stopped it.
#
# WHY THE OBVIOUS DEFENCES DO NOT WORK
# ------------------------------------
#   set -u              fires on an UNSET variable. A variable set to "" is set.
#                       The form that actually fires is "${VAR:?message}".
#   X="$(cmd)"          swallows a non-zero exit without `set -e`, so a helper's
#                       failure signal is discarded and X is left empty.
#   [ -n "$COMPOSED" ]  is ALWAYS true when the string has a literal prefix:
#                       "$ROOT/$ENC" is non-empty even when $ENC is not. A guard on
#                       a COMPOSED path is blind to a hole in any of its parts —
#                       validate the COMPONENT, before assembly.
#
# So discipline is not the control. These functions cannot express the unsafe form:
# an empty component, a path equal to or above the root, or a path outside it, is
# refused rather than deleted.
#
# Source it, do not execute it:
#   . "$REPO_ROOT/scripts/lib/safe-sandbox-paths.sh"

# Die unless $2 is a usable path COMPONENT. Call this on each part BEFORE building
# a path out of it — that is the whole point.
#
#   $1  human name, used in the message
#   $2  the value
require_path_component() {
  local name="$1" value="${2-}"
  if [ -z "$value" ]; then
    printf 'FATAL: path component %s is EMPTY — refusing to build a destructive path.\n' \
      "$name" >&2
    printf '       An empty component widens the operation to the parent directory.\n' >&2
    return 1
  fi
  case "$value" in
    */../*|*/..|../*|..)
      printf 'FATAL: path component %s contains "..": %s\n' "$name" "$value" >&2
      return 1
      ;;
  esac
  return 0
}

# Strip trailing slashes. Load-bearing: "$ROOT/" compares as DEEPER than "$ROOT",
# so a containment check done without this lets the root itself through.
_ssp_strip_trailing_slash() {
  local p="$1"
  while [ "${#p}" -gt 1 ] && [ "${p%/}" != "$p" ]; do p="${p%/}"; done
  printf '%s' "$p"
}

# Delete $2, but only if it is genuinely inside $1.
#
#   $1  the root everything must live under (must exist, must not be "/")
#   $2  the target
#
# Refuses: an empty root, an empty target, a target equal to the root, a target
# that is not under the root, "/" in either position, and any target fewer than
# $SSP_MIN_DEPTH components below the root (default 1 — a direct child).
rm_under_root_safely() {
  local root="${1-}" target="${2-}" min_depth="${SSP_MIN_DEPTH:-1}"

  require_path_component 'root' "$root" || return 1
  require_path_component 'target' "$target" || return 1

  root="$(_ssp_strip_trailing_slash "$root")"
  target="$(_ssp_strip_trailing_slash "$target")"

  if [ "$root" = "/" ] || [ "$target" = "/" ]; then
    printf 'FATAL: refusing to operate on "/" (root=%s target=%s)\n' "$root" "$target" >&2
    return 1
  fi
  if [ "$target" = "$root" ]; then
    printf 'FATAL: target IS the root, which would remove the root: %s\n' "$root" >&2
    return 1
  fi
  case "$target" in
    "$root"/*) : ;;
    *)
      printf 'FATAL: target is OUTSIDE the root — refusing.\n  root:   %s\n  target: %s\n' \
        "$root" "$target" >&2
      return 1
      ;;
  esac

  # Depth check: with an empty component the target degenerates toward the root,
  # and this is what catches that even when the prefix makes it look well-formed.
  # Two `local`s on purpose: within a single `local a=... b="$a"`, `$a` still reads
  # the OUTER scope, so `rest` would silently be empty and the loop below would
  # count a depth of 1 for every path — the check would pass over everything.
  local rel="${target#"$root"/}"
  local depth=1
  local rest="$rel"
  while [ "${rest#*/}" != "$rest" ]; do
    rest="${rest#*/}"
    depth=$((depth + 1))
  done
  if [ "$depth" -lt "$min_depth" ]; then
    printf 'FATAL: target is %s level(s) below the root, minimum is %s: %s\n' \
      "$depth" "$min_depth" "$target" >&2
    return 1
  fi

  # Nothing there is a reported NO-OP, never an error: an already-clean sandbox is
  # the normal state on a re-run.
  [ -e "$target" ] || return 0
  rm -rf -- "$target"
}

# Capture a helper's stdout, but die if the helper FAILED or printed nothing.
#
#   VALUE="$(capture_required_output 'sandbox memdir' build_sandbox "$S3")" || exit 1
#
# This is the assignment form that does NOT swallow the exit status. `X="$(cmd)"`
# on its own discards a non-zero exit and leaves X empty, which is precisely how an
# empty component reaches a delete.
capture_required_output() {
  local what="$1"; shift
  local out rc
  out="$("$@")"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    printf 'FATAL: %s failed (exit %s): %s\n' "$what" "$rc" "$*" >&2
    return 1
  fi
  if [ -z "$out" ]; then
    printf 'FATAL: %s produced NO OUTPUT (exit 0): %s\n' "$what" "$*" >&2
    printf '       An empty result here becomes an empty path component.\n' >&2
    return 1
  fi
  printf '%s' "$out"
}
