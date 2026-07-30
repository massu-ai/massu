#!/usr/bin/env bash
#
# home-path-guard.sh — refuse ANY real operator/user home path in a publication set.
#
# WHY (incident 2026-07-20, CR-62): the publication gate's deny-list
# (scripts/lib/private_content_scan.py) is generated from the current machine's
# $HOME, so it knows exactly ONE operator identity. A second operator identity on
# the same machine — or any teammate's real username — is NOT in that deny-list,
# so a file carrying only such a home path passes the gate clean.
#
# This guard is DENY-LIST-INDEPENDENT and INVERTED: instead of enumerating the
# private names to refuse (which can never be complete), it enumerates the small,
# documented set of SYNTHETIC placeholder usernames that legitimately appear in
# public docs and test fixtures, and REFUSES every other `/Users/<name>`. That
# fails closed: an unknown, real-looking username is refused by default, which is
# the only safe bias for "NONE of the operator's personal paths may EVER reach
# public."
#
# It is intentionally generic and repo-agnostic (it contains only placeholder
# names, never any operator name), so it is itself safe to sync public.
#
# USAGE
#   Sourced:   . scripts/lib/home-path-guard.sh; home_path_guard "$PUBLIC_REPO"
#   Standalone: bash scripts/lib/home-path-guard.sh <repo-root>
#              exit 0 = clean, exit 1 = home path(s) found (hits printed to stderr)
#
# It scans the GIT-TRACKED set under <repo-root> (i.e. exactly what is about to be
# committed once `git add` has staged the tree), so gitignored artifacts (coverage/,
# local .massu caches) are correctly out of scope.
#
# Extend the placeholder allowlist ONLY with generic, obviously-synthetic names,
# and prefer `<user>`-style angle-bracket placeholders in docs (those never match
# this guard's `/Users/<name>` regex at all). The allowlist can also be extended at
# call time via MASSU_HOME_PATH_PLACEHOLDERS (space-separated), for a reviewed,
# repo-specific synthetic name.

# Documented synthetic placeholder usernames. A `/Users/<name>` whose <name> is in
# this set is treated as a generic example, not a real home path.
HOME_PATH_PLACEHOLDERS_DEFAULT="dev foo bar baz qux test tests example examples someone user users you youruser username me my myuser myproject john jane doe alice bob home Shared probe name path project sample demo placeholder"

home_path_guard() {
  local root="${1:?home_path_guard: <repo-root> required}"
  local mode="${2:-auto}"

  [ -d "$root" ] || { echo "home_path_guard: '$root' is not a directory." >&2; return 2; }

  # --- Mode selection (P2-4's sibling problem: C4's tarballs are not git trees) ---
  # This guard used to REQUIRE a git repo and return 2 otherwise, so it could not
  # run over an extracted npm tarball at all. That is why it had exactly one call
  # site (sync-public.sh) and why the tarball channel was covered by the deny-list
  # alone — never by this deny-list-INDEPENDENT check, which is the only layer
  # that catches a SECOND operator's home path.
  #
  # tree = git-tracked set (what is about to be committed).
  # dir  = plain filesystem walk (an extracted tarball, a staging directory).
  if [ "$mode" = "auto" ]; then
    if [ -d "$root/.git" ] || git -C "$root" rev-parse --git-dir >/dev/null 2>&1; then
      mode="tree"
    else
      mode="dir"
    fi
  fi

  case "$mode" in
    tree)
      if [ ! -d "$root/.git" ] && ! git -C "$root" rev-parse --git-dir >/dev/null 2>&1; then
        echo "home_path_guard: --tree requested but '$root' is not a git repo." >&2
        return 2
      fi
      ;;
    dir) : ;;
    *) echo "home_path_guard: unknown mode '$mode' (expected tree|dir|auto)." >&2; return 2 ;;
  esac

  # Build an anchored alternation of allowed placeholder names.
  # Split on whitespace via `tr` (NOT unquoted word-splitting) so the result is
  # independent of the caller's ambient IFS — when this file is SOURCED into a
  # shell whose IFS is non-default, `$placeholders` would not split and the
  # alternation would silently collapse to one literal, passing every real path.
  local placeholders="${HOME_PATH_PLACEHOLDERS_DEFAULT} ${MASSU_HOME_PATH_PLACEHOLDERS:-}"
  local allow_alt
  allow_alt="$(printf '%s' "$placeholders" | tr ' \t' '\n\n' | sed '/^$/d' | sort -u | paste -sd'|' -)"

  # LIVENESS (P-A). Count what is actually in scope BEFORE scanning. A guard that
  # prints GREEN because it examined nothing is the failure this plan exists to
  # end, and "no hits" is indistinguishable from "no files" without this.
  local scanned=0
  if [ "$mode" = "tree" ]; then
    scanned="$(git -C "$root" ls-files | wc -l | tr -d ' ')"
  else
    scanned="$(find "$root" -type f -not -path '*/.git/*' -not -path '*/node_modules/*' | wc -l | tr -d ' ')"
  fi
  if [ "$scanned" -eq 0 ]; then
    echo "home_path_guard: scanned 0 files under '$root' (mode=$mode) — refusing to report clean." >&2
    return 2
  fi
  echo "home_path_guard: mode=$mode, scanning $scanned file(s) under $root" >&2

  # All /Users/<name> occurrences. `-I` skips binary files. The name class
  # deliberately requires a leading alphanumeric/underscore, so angle-bracket
  # placeholders like `/Users/<user>/` never match.
  local raw
  if [ "$mode" = "tree" ]; then
    raw="$(git -C "$root" grep -nEI "/Users/[A-Za-z0-9_][A-Za-z0-9._-]*" -- . 2>/dev/null || true)"
  else
    # Paths are printed relative to $root so `dir` and `tree` output read alike.
    raw="$(cd "$root" && grep -rnEI \
             --exclude-dir='.git' --exclude-dir='node_modules' \
             "/Users/[A-Za-z0-9_][A-Za-z0-9._-]*" . 2>/dev/null \
           | sed 's|^\./||' || true)"
  fi
  local hits
  hits="$(printf '%s' "$raw" | grep -vE "/Users/(${allow_alt})\\b" || true)"

  if [ -n "$hits" ]; then
    echo "" >&2
    echo "╔════════════════════════════════════════════════════════════════════════════╗" >&2
    echo "║  HOME-PATH GUARD — a real user home path is in the publication set.          ║" >&2
    echo "╚════════════════════════════════════════════════════════════════════════════╝" >&2
    echo "  These /Users/<name> paths are NOT documented synthetic placeholders:" >&2
    printf '%s\n' "$hits" | sed 's/^/    /' >&2
    echo "" >&2
    echo "  Fix the SOURCE in massu-internal (never the public mirror). Use an angle-" >&2
    echo "  bracket placeholder (/Users/<user>/…) or a name from the placeholder set" >&2
    echo "  in scripts/lib/home-path-guard.sh. If a name is a genuine, reviewed generic" >&2
    echo "  example, add it there (or via MASSU_HOME_PATH_PLACEHOLDERS) with a reason." >&2
    return 1
  fi
  return 0
}

# Standalone invocation
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  home_path_guard "${1:?usage: home-path-guard.sh <root> [tree|dir|auto]}" "${2:-auto}"
fi
