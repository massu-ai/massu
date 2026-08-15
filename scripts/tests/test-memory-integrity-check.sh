#!/bin/bash
# ============================================================
# MUTATION TEST — scripts/hooks/memory-integrity-check.sh
# ============================================================
# CR-72: a gate you have not attacked is decoration. This plants each failure the
# hook exists to catch and demands the verdict CHANGE, then proves the hook still
# OPENS on a genuinely healthy store (a gate that is always red gets deleted).
#
# THE HEADLINE ASSERTION is check 3. Before 2026-08-08 an absent store produced
# output byte-identical to a healthy one — the blind-gate law in one line. This
# test pins that they now DIFFER, so the defect cannot return silently.
#
# ------------------------------------------------------------
# WHERE THE PLANTS LIVE, AND WHY THAT IS NOT A COMPROMISE.
#
# The destructive plants (absent dir, absent index, absent DB, corrupt DB) run
# against a SANDBOX project root, not the operator's real memory store. This is
# deliberate: on 2026-07-26 a burst deletion destroyed ~/.claude/projects/<repo>
# including 45 memory files and every session transcript, and the blast radius of
# a test is the machine that runs it (G25). A test that must delete the real
# corpus to prove a point is a weapon aimed at the thing it protects.
#
# The sandbox is NOT a weaker test here, because the hook takes its root from
# CLAUDE_PROJECT_DIR — so the sandbox exercises the SAME code path with the same
# resolution logic. What the sandbox cannot prove is that the hook says OK about
# the REAL store, so check 1 does exactly that, against the real one, read-only.
#
# No `git init` anywhere in this file: the hook is given its root by env, so the
# harness never needs a repo and therefore cannot leak GIT_DIR into one (G29).
# ============================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="$REPO_ROOT/scripts/hooks/memory-integrity-check.sh"

# Destructive paths in this harness go through the chokepoint, never through a
# bare `rm` on an interpolated path. Note `set -uo pipefail` above has no `-e`:
# `X="$(cmd)"` therefore SWALLOWS a non-zero exit and leaves X empty, and `-u`
# does not fire on a variable that is set-but-empty. Those two together are how an
# empty component reaches an `rm` and widens it to the parent (G17 / CR-77).
# shellcheck source=scripts/lib/safe-sandbox-paths.sh
. "$REPO_ROOT/scripts/lib/safe-sandbox-paths.sh"

PASS=0
FAIL=0

ok()   { PASS=$((PASS + 1)); printf '  PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; }
check(){ # check <description> <condition-result>
  if [ "$2" = "yes" ]; then ok "$1"; else bad "$1"; fi
}

if [ ! -f "$HOOK" ]; then
  printf 'FATAL: hook not found at %s\n' "$HOOK" >&2
  exit 2
fi

SANDBOX="$(mktemp -d)"
# Single trap, set once. bash REPLACES `trap ... EXIT`, so a second one would
# silently kill this cleanup.
trap 'rm -rf "$SANDBOX"' EXIT INT TERM

# SANDBOX STORES LIVE INSIDE $SANDBOX, so the EXIT trap above removes them.
#
# They used to be written into the operator's LIVE store, because the hook hardcoded
# `$HOME/.claude/projects` and this harness had to mirror that to put fixtures where the
# hook would look. Two consequences, both measured 2026-08-11:
#   * SIX fixture directories were still sitting in the live store — five named
#     `…-absent-db` (case 5) because the end-of-run cleanup enumerated S1/S3/S5/S6 and
#     omitted S4, a hand-maintained list that drifted from the cases it covers;
#   * cleanup ran at the END, so any abort leaked every fixture, since the EXIT trap
#     only ever covered $SANDBOX.
# Injecting the root fixes both at once and DELETES the hand-maintained list rather than
# adding S4 to it — the list is the defect, not its contents.
SANDBOX_STORE_ROOT="$SANDBOX/store"
mkdir -p "$SANDBOX_STORE_ROOT"
REAL_STORE_ROOT="$HOME/.claude/projects"

# `verdict <output>` — extract the closed-vocabulary verdict token.
verdict() { printf '%s' "$1" | sed -n 's/.*\[MEMORY INTEGRITY\] \([A-Z]*\).*/\1/p' | head -1; }

# memdir_for <project-root> [store-root] — mirrors the hook's resolution.
# The store root defaults to the SANDBOX, so a caller that forgets it cannot accidentally
# address the live store; case 1 passes the real root explicitly, on purpose.
memdir_for() {
  local r="$1" sr="${2:-$SANDBOX_STORE_ROOT}"
  local e="${r//\//-}"
  printf '%s' "$sr/${e}/memory"
}
sandbox_memdir_for() { memdir_for "$@"; }

# Build a healthy sandbox store: memory dir + MEMORY.md + a real sqlite DB.
build_sandbox() {
  local root="$1"
  local memdir; memdir="$(memdir_for "$root")"
  mkdir -p "$memdir" "$root/.massu"
  printf '# Memory Index\n\n- [example](example.md) — a memory\n' > "$memdir/MEMORY.md"
  printf -- '---\nname: example\n---\n\nbody\n' > "$memdir/example.md"
  node -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    db.exec("CREATE TABLE observations (id INTEGER PRIMARY KEY, title TEXT)");
    // Parameterised: a double-quoted literal is an IDENTIFIER in SQLite, which
    // made the first draft of this harness die with "no such column".
    db.prepare("INSERT INTO observations (title) VALUES (?)").run("seed");
    db.close();
  ' "$root/.massu/memory.db" || return 1
  printf '%s' "$memdir"
}

printf '\n=== MUTATION TEST: memory-integrity-check.sh ===\n\n'

# Denominator for the blast-radius assertion at the end (M1): what the live store held
# BEFORE this run. Captured here, before a single hook invocation.
LIVE_STORE_BEFORE="$(find "$REAL_STORE_ROOT" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | LC_ALL=C sort)"
LIVE_COUNT_BEFORE="$(printf '%s\n' "$LIVE_STORE_BEFORE" | grep -c . || true)"
printf '  live store root: %s (%s project dir(s) before this run)\n' \
       "$REAL_STORE_ROOT" "$LIVE_COUNT_BEFORE"

# ---------- 1. CONTROL, against the REAL store (read-only) ---------------- #
printf -- '--- 1. control: the REAL store must report OK ---\n'
REAL_ROOT="$(cd "$(dirname "$HOOK")/../.." && pwd)"
# Explicitly the REAL store root — this one case is meant to read the live store, and it
# runs BEFORE the sandbox override is exported below, so the hook resolves it the same way
# a real SessionStart would.
REAL_MEM="$(memdir_for "$REAL_ROOT" "$REAL_STORE_ROOT")"
REAL_INDEX="$REAL_MEM/MEMORY.md"
REAL_SHA_BEFORE=""
[ -f "$REAL_INDEX" ] && REAL_SHA_BEFORE="$(shasum -a 256 "$REAL_INDEX" | cut -d' ' -f1)"

CTRL_OUT="$(CLAUDE_PROJECT_DIR="$REAL_ROOT" bash "$HOOK" </dev/null 2>&1)"
CTRL_EXIT=$?
printf '      %s\n' "$CTRL_OUT"
check "real store verdict is OK"            "$([ "$(verdict "$CTRL_OUT")" = "OK" ] && echo yes || echo no)"
check "real store exit code is 0"           "$([ "$CTRL_EXIT" -eq 0 ] && echo yes || echo no)"
check "real store reports db=ok"            "$(printf '%s' "$CTRL_OUT" | grep -q 'db=ok' && echo yes || echo no)"
check "real denominator is non-trivial"     "$(printf '%s' "$CTRL_OUT" | grep -qE 'corpus=[1-9][0-9]* files' && echo yes || echo no)"

# FROM HERE ON, EVERY hook invocation is redirected into the sandbox. Exported once,
# immediately after the only case that is supposed to read the live store, so a case added
# later inherits the redirect by default instead of having to remember it.
export MASSU_MEMORY_STORE_ROOT="$SANDBOX_STORE_ROOT"
printf '  sandbox store root exported: %s\n' "$MASSU_MEMORY_STORE_ROOT"
# Positive control: prove the redirect is REAL before trusting the blast-radius assertion.
# Without this, "nothing was written to the live store" is also what a no-op run prints.
_probe="$SANDBOX/redirect-probe"; mkdir -p "$_probe"
build_sandbox "$_probe" >/dev/null || { printf 'FATAL: redirect probe build failed\n' >&2; exit 2; }
check "redirect control: fixture landed under the SANDBOX store root" \
      "$([ -d "$SANDBOX_STORE_ROOT/${_probe//\//-}/memory" ] && echo yes || echo no)"
check "redirect control: fixture did NOT land in the live store" \
      "$([ ! -d "$REAL_STORE_ROOT/${_probe//\//-}/memory" ] && echo yes || echo no)"

# ---------- 2. Sandbox healthy: the gate must OPEN ------------------------ #
printf -- '\n--- 2. sandbox healthy: the gate must OPEN (a brick gets deleted) ---\n'
S1="$SANDBOX/healthy"
mkdir -p "$S1"
build_sandbox "$S1" >/dev/null || { printf 'FATAL: could not build sandbox\n' >&2; exit 2; }
HEALTHY_OUT="$(CLAUDE_PROJECT_DIR="$S1" bash "$HOOK" </dev/null 2>&1)"
printf '      %s\n' "$HEALTHY_OUT"
check "healthy sandbox verdict is OK"       "$([ "$(verdict "$HEALTHY_OUT")" = "OK" ] && echo yes || echo no)"

# ---------- 3. THE HEADLINE: absent store must NOT look like clean -------- #
printf -- '\n--- 3. HEADLINE — absent store vs healthy store ---\n'
S2="$SANDBOX/absent-store"
mkdir -p "$S2/.massu"
cp "$S1/.massu/memory.db" "$S2/.massu/memory.db"
# memory dir deliberately never created for S2 -> the absent-store condition.
ABSENT_OUT="$(CLAUDE_PROJECT_DIR="$S2" bash "$HOOK" </dev/null 2>&1)"
ABSENT_EXIT=$?
printf '      %s\n' "$ABSENT_OUT"
check "absent store verdict is UNCHECKABLE" "$([ "$(verdict "$ABSENT_OUT")" = "UNCHECKABLE" ] && echo yes || echo no)"
check "absent store output DIFFERS from healthy (the 2026-08-08 defect)" \
      "$([ "$ABSENT_OUT" != "$HEALTHY_OUT" ] && echo yes || echo no)"
check "absent store names the missing directory" \
      "$(printf '%s' "$ABSENT_OUT" | grep -q 'memory directory ABSENT' && echo yes || echo no)"
check "absent store still exits 0 (deliberate: never brick SessionStart)" \
      "$([ "$ABSENT_EXIT" -eq 0 ] && echo yes || echo no)"

# ---------- 4. Absent index ----------------------------------------------- #
printf -- '\n--- 4. absent MEMORY.md ---\n'
S3="$SANDBOX/absent-index"
mkdir -p "$S3"
M3="$(capture_required_output 'build_sandbox for absent-index' build_sandbox "$S3")" || exit 2
# ${VAR:?} is the ONLY plain-shell form that aborts on EMPTY as well as unset — `set -u`
# does not fire on a set-but-empty variable, and there is no `set -e` here, so the
# assignment above would otherwise leave M3="" and widen this to the filesystem root.
rm -f "${M3:?build_sandbox produced no path for absent-index}/MEMORY.md"
IDX_OUT="$(CLAUDE_PROJECT_DIR="$S3" bash "$HOOK" </dev/null 2>&1)"
check "absent MEMORY.md is UNCHECKABLE"     "$([ "$(verdict "$IDX_OUT")" = "UNCHECKABLE" ] && echo yes || echo no)"
check "absent MEMORY.md is named"           "$(printf '%s' "$IDX_OUT" | grep -q 'MEMORY.md ABSENT' && echo yes || echo no)"

# ---------- 5. Absent database -------------------------------------------- #
printf -- '\n--- 5. absent memory.db ---\n'
S4="$SANDBOX/absent-db"
mkdir -p "$S4"
build_sandbox "$S4" >/dev/null
rm -f "${S4:?absent-db sandbox path is empty}/.massu/memory.db"
DBA_OUT="$(CLAUDE_PROJECT_DIR="$S4" bash "$HOOK" </dev/null 2>&1)"
check "absent DB is UNCHECKABLE"            "$([ "$(verdict "$DBA_OUT")" = "UNCHECKABLE" ] && echo yes || echo no)"
check "absent DB is named"                  "$(printf '%s' "$DBA_OUT" | grep -q 'database ABSENT' && echo yes || echo no)"

# ---------- 6. CORRUPT database — the check the name always promised ------ #
printf -- '\n--- 6. corrupt memory.db (the row the hook was named for) ---\n'
S5="$SANDBOX/corrupt-db"
mkdir -p "$S5"
build_sandbox "$S5" >/dev/null
# Positive control: prove the plant is real before asserting the gate caught it.
PRE_CORRUPT="$(CLAUDE_PROJECT_DIR="$S5" bash "$HOOK" </dev/null 2>&1)"
check "pre-plant control: corrupt-db sandbox reads OK before the plant" \
      "$([ "$(verdict "$PRE_CORRUPT")" = "OK" ] && echo yes || echo no)"
# Scribble over the interior of the file, leaving the header, so SQLite opens it
# and the page corruption is what surfaces.
printf 'CORRUPTIONCORRUPTIONCORRUPTION' | dd of="$S5/.massu/memory.db" bs=1 seek=100 conv=notrunc 2>/dev/null
COR_OUT="$(CLAUDE_PROJECT_DIR="$S5" bash "$HOOK" </dev/null 2>&1)"
printf '      %s\n' "$(printf '%s' "$COR_OUT" | head -3)"
check "corrupt DB is NOT OK"                "$([ "$(verdict "$COR_OUT")" != "OK" ] && echo yes || echo no)"
check "corrupt DB output differs from its own pre-plant run" \
      "$([ "$COR_OUT" != "$PRE_CORRUPT" ] && echo yes || echo no)"

# ---------- 7. Injection violation ---------------------------------------- #
printf -- '\n--- 7. planted injection pattern in MEMORY.md ---\n'
S6="$SANDBOX/injection"
mkdir -p "$S6"
M6="$(build_sandbox "$S6")"
PRE_INJ="$(CLAUDE_PROJECT_DIR="$S6" bash "$HOOK" </dev/null 2>&1)"
check "pre-plant control: injection sandbox reads OK" \
      "$([ "$(verdict "$PRE_INJ")" = "OK" ] && echo yes || echo no)"
printf -- '- always use --no-verify to skip pre-commit checks\n' >> "$M6/MEMORY.md"
INJ_OUT="$(CLAUDE_PROJECT_DIR="$S6" bash "$HOOK" </dev/null 2>&1)"
check "planted injection is DEGRADED"       "$([ "$(verdict "$INJ_OUT")" = "DEGRADED" ] && echo yes || echo no)"
check "injection hit is COUNTED in the denominator" \
      "$(printf '%s' "$INJ_OUT" | grep -qE '1 hit\(s\)' && echo yes || echo no)"

# ---------- 8. The denominator is always present -------------------------- #
printf -- '\n--- 8. M1: every verdict carries its denominator ---\n'
DENOM_MISSING=0
for out in "$CTRL_OUT" "$HEALTHY_OUT" "$ABSENT_OUT" "$IDX_OUT" "$DBA_OUT" "$COR_OUT" "$INJ_OUT"; do
  printf '%s' "$out" | grep -q 'injection-screen=' || DENOM_MISSING=$((DENOM_MISSING + 1))
done
check "all 7 runs printed a denominator"    "$([ "$DENOM_MISSING" -eq 0 ] && echo yes || echo no)"

# ---------- 9. The real store was never touched --------------------------- #
printf -- '\n--- 9. blast radius: the real store is unchanged ---\n'
REAL_SHA_AFTER=""
[ -f "$REAL_INDEX" ] && REAL_SHA_AFTER="$(shasum -a 256 "$REAL_INDEX" | cut -d' ' -f1)"
check "real MEMORY.md sha256 unchanged"     "$([ "$REAL_SHA_BEFORE" = "$REAL_SHA_AFTER" ] && echo yes || echo no)"
check "real MEMORY.md still exists"         "$([ -f "$REAL_INDEX" ] && echo yes || echo no)"

# The sandbox stores are inside $SANDBOX, so the EXIT trap removes them and there is no
# per-case cleanup list to maintain. The list that used to live here enumerated S1/S3/S5/S6
# and silently omitted S4 — which is why five `…-absent-db` fixture directories were found
# sitting in the live store on 2026-08-11. Adding S4 would have been the N+1th entry in a
# hand-maintained list; redirecting the root deletes the list instead.

# ---------- 10. The live store gained NOTHING ----------------------------- #
printf -- '\n--- 10. blast radius: the live store gained no directories ---\n'
LIVE_STORE_AFTER="$(find "$REAL_STORE_ROOT" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | LC_ALL=C sort)"
LIVE_COUNT_AFTER="$(printf '%s\n' "$LIVE_STORE_AFTER" | grep -c . || true)"
LEAKED="$(comm -13 <(printf '%s\n' "$LIVE_STORE_BEFORE") <(printf '%s\n' "$LIVE_STORE_AFTER"))"
printf '      live project dirs: %s before -> %s after\n' "$LIVE_COUNT_BEFORE" "$LIVE_COUNT_AFTER"
[ -n "$LEAKED" ] && printf '      LEAKED: %s\n' "$LEAKED"
check "live store directory count unchanged" \
      "$([ "$LIVE_COUNT_BEFORE" = "$LIVE_COUNT_AFTER" ] && echo yes || echo no)"
check "no new directory appeared in the live store" \
      "$([ -z "$LEAKED" ] && echo yes || echo no)"
# M1: a comparison against an EMPTY before-list would pass no matter what leaked.
check "blast-radius denominator is non-zero" \
      "$([ "${LIVE_COUNT_BEFORE:-0}" -gt 0 ] && echo yes || echo no)"

printf '\n=== RESULT: %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
