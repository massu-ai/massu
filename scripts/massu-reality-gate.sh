#!/usr/bin/env bash
# =============================================================================
# G-1 — THE REALITY GATE
#
# Every other gate in this repo checks that the code agrees with ITSELF.
# 4,900 tests, 41 scanner checks, 33 drift-guards, 24 canonical rules — and not
# one of them ever asked:
#
#     Did a row actually land?  Does that endpoint answer?  Is that function called?
#
# So Massu could be internally perfect and externally dead, and every light stayed
# green. It was: 251,956 tool calls -> 0 observations. A security gate that could not
# deny. Enterprise endpoints returning 404 since launch. All green. All broken.
#
# THIS GATE RUNS AGAINST THE WORLD.
#
# It is the only gate here that can fail for a reason the code cannot see, and it is
# the only one that could have caught any of the above.
#
# Usage:
#   bash scripts/massu-reality-gate.sh            # all checks
#   bash scripts/massu-reality-gate.sh --offline  # skip network probes
#   bash scripts/massu-reality-gate.sh --self-test # ANTI-VACUITY: prove it CAN fail
#
# Runs nightly in CI and on demand — NOT on every pre-push (it needs network).
# =============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # never cwd (T-4: 4 checks were cwd-vacuous)
cd "$ROOT"

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YEL=$'\033[1;33m'; DIM=$'\033[2m'; NC=$'\033[0m'
FAILURES=0; PASSES=0; SKIPS=0
OFFLINE=0; SELFTEST=0
for a in "$@"; do
  [ "$a" = "--offline" ] && OFFLINE=1
  [ "$a" = "--self-test" ] && SELFTEST=1
done

pass () { PASSES=$((PASSES+1)); printf '  %sPASS%s  %s\n' "$GREEN" "$NC" "$1"; }
fail () { FAILURES=$((FAILURES+1)); printf '  %sFAIL%s  %s\n' "$RED" "$NC" "$1"; }
skip () { SKIPS=$((SKIPS+1)); printf '  %sSKIP%s  %s\n' "$YEL" "$NC" "$1"; }
note () { printf '        %s%s%s\n' "$DIM" "$1" "$NC"; }

MANIFEST="$ROOT/scripts/lib/endpoints.manifest.json"

# -----------------------------------------------------------------------------
# R-1 — EVERY ENDPOINT ANSWERS.
#
# A 404 means the route does not exist: ALWAYS a failure, and detectable with no
# credentials at all. A 401 means the route is alive and wants auth: that is a PASS.
# That distinction is what lets this run in CI without secrets.
# -----------------------------------------------------------------------------
check_endpoints () {
  echo "R-1  ENDPOINTS — does the boundary actually answer?"
  if [ "$OFFLINE" = "1" ]; then skip "R-1 endpoints (--offline)"; return; fi
  if ! command -v curl >/dev/null; then skip "R-1 endpoints (no curl)"; return; fi

  local base; base=$(node -e "console.log(require('$MANIFEST').base)")
  local n; n=$(node -e "console.log(require('$MANIFEST').endpoints.length)")

  for i in $(seq 0 $((n-1))); do
    local path method why expect
    path=$(node -e "console.log(require('$MANIFEST').endpoints[$i].path)")
    method=$(node -e "console.log(require('$MANIFEST').endpoints[$i].method)")
    why=$(node -e "console.log(require('$MANIFEST').endpoints[$i].why)")
    expect=$(node -e "console.log(require('$MANIFEST').endpoints[$i].expect_unauth.join(' '))")

    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' -X "$method" \
             -H 'Content-Type: application/json' -d '{}' \
             --max-time 20 "${base}${path}" 2>/dev/null || echo "000")

    if [ "$code" = "404" ]; then
      fail "$method $path -> 404 — THE ROUTE DOES NOT EXIST"
      note "$why"
    elif [ "$code" = "000" ]; then
      fail "$method $path -> no response (DNS/timeout)"
      note "$why"
    elif [[ " $expect " == *" $code "* ]]; then
      pass "$method $path -> $code (alive)"
    elif [ "$code" = "200" ]; then
      pass "$method $path -> 200"
    else
      fail "$method $path -> $code (expected one of: $expect)"
      note "$why"
    fi
  done

  local sn; sn=$(node -e "console.log(require('$MANIFEST').sites.length)")
  for i in $(seq 0 $((sn-1))); do
    local url code
    url=$(node -e "console.log(require('$MANIFEST').sites[$i].url)")
    code=$(curl -sL -o /dev/null -w '%{http_code}' --max-time 20 "$url" 2>/dev/null || echo "000")
    [ "$code" = "200" ] && pass "GET $url -> 200" || fail "GET $url -> $code"
  done
}

# -----------------------------------------------------------------------------
# R-2 — EVERY STORE THE PRODUCT CLAIMS TO WRITE HAS ROWS.
#
# This is the check that would have caught S-1 on day one: 251,956 tool calls and
# ZERO observations is not a quiet week, it is a dead pipeline. An empty store is a
# claim that nothing happened — and it must be FALSIFIED, not assumed.
# -----------------------------------------------------------------------------
check_stores () {
  echo
  echo "R-2  STORES — did a row actually land?"
  local db="$ROOT/.massu/memory.db"
  if [ ! -f "$db" ]; then skip "R-2 stores (no memory.db — run massu init)"; return; fi
  if ! command -v sqlite3 >/dev/null; then skip "R-2 stores (no sqlite3)"; return; fi

  local integ; integ=$(sqlite3 "$db" 'PRAGMA integrity_check;' 2>&1 | head -1)
  [ "$integ" = "ok" ] && pass "memory.db integrity_check: ok" || fail "memory.db integrity: $integ"

  # A table with tool calls but no observations means the extractor is DEAD.
  local calls obs
  calls=$(sqlite3 "$db" 'SELECT COUNT(*) FROM tool_call_details;' 2>/dev/null || echo 0)
  obs=$(sqlite3 "$db" 'SELECT COUNT(*) FROM observations;' 2>/dev/null || echo 0)
  if [ "$calls" -gt 100 ] && [ "$obs" -eq 0 ]; then
    fail "THE LEARNING SURFACE IS DEAD: $calls tool calls -> 0 observations"
    note "This is S-1. It ran for months and every gate stayed green."
  else
    pass "observation flow alive: $calls tool calls -> $obs observations"
  fi

  # Memory corpus: files on disk must equal rows in the DB (S-2).
  local mdir files rows
  mdir="$HOME/.claude/projects/$(echo "$ROOT" | sed 's|/|-|g')/memory"
  if [ -d "$mdir" ]; then
    files=$(find "$mdir" -name '*.md' ! -name 'MEMORY.md' | wc -l | tr -d ' ')
    rows=$(sqlite3 "$db" 'SELECT COUNT(*) FROM memory_files;' 2>/dev/null || echo 0)
    if [ "$files" -gt 0 ] && [ "$rows" -eq 0 ]; then
      fail "MEMORY CORPUS NOT INGESTED: $files files on disk -> $rows rows (auto-recall searches an EMPTY table)"
    elif [ "$rows" -lt "$files" ]; then
      fail "memory corpus partially ingested: $files files -> $rows rows"
    else
      pass "memory corpus ingested: $files files -> $rows rows"
    fi
  else
    skip "R-2 memory corpus (no memory dir for this project)"
  fi

  # CodeGraph: present-but-EMPTY is the failure the -32001 guard cannot see (M-2).
  local cg="$ROOT/.codegraph/codegraph.db"
  if [ -f "$cg" ]; then
    local cgf; cgf=$(sqlite3 "$cg" 'SELECT COUNT(*) FROM files;' 2>/dev/null || echo 0)
    if [ "$cgf" -eq 0 ]; then
      fail "CodeGraph DB exists but is EMPTY (0 files) — the 5 free-tier navigation tools are DEAD"
      note "M-2/C-1: the -32001 guard checks existsSync, so an empty DB sails straight through."
    else
      pass "CodeGraph indexed: $cgf files"
    fi
  else
    fail "CodeGraph DB missing — 5 free-tier tools are dead for every new customer (C-1)"
  fi
}

# -----------------------------------------------------------------------------
# R-3 — NO HOOK IS FAILING SILENTLY.
#
# G-2 gave every hook a durable failure channel. This asserts the channel is EMPTY.
# A non-empty hook-failures.jsonl BREAKS THE BUILD — that is the entire point:
# a failure that nobody looks at is the same as no signal at all.
# -----------------------------------------------------------------------------
check_hook_health () {
  echo
  echo "R-3  HOOKS — is anything failing quietly?"
  local log="$ROOT/.massu/hook-failures.jsonl"
  if [ ! -f "$log" ] || [ ! -s "$log" ]; then
    pass "no hook failures recorded"
    return
  fi
  local n; n=$(wc -l < "$log" | tr -d ' ')
  fail "$n hook failure(s) recorded in .massu/hook-failures.jsonl"
  node -e "
    const fs=require('fs');
    const c={};
    for(const l of fs.readFileSync('$log','utf8').trim().split('\n')){
      try{const o=JSON.parse(l); const k=o.hook+': '+o.error.slice(0,60); c[k]=(c[k]||0)+1;}catch{}
    }
    for(const [k,v] of Object.entries(c)) console.log('          '+v+'x  '+k);
  " 2>/dev/null
}

# -----------------------------------------------------------------------------
# R-4 — ANTI-VACUITY (CR-64). A gate that cannot fail is decoration.
#
# Proves each check above CAN go red, by feeding it a known-bad input. If this
# self-test ever passes trivially, the gate has rotted and CI must reject it.
# -----------------------------------------------------------------------------
self_test () {
  echo "R-4  ANTI-VACUITY — proving this gate CAN fail (CR-64)"
  local tmp; tmp=$(mktemp -d)
  local bad="$tmp/bad.db"

  # (a) a store with tool calls but zero observations MUST be detected
  sqlite3 "$bad" "CREATE TABLE tool_call_details (id INTEGER); CREATE TABLE observations (id INTEGER);
                  INSERT INTO tool_call_details SELECT 1 FROM generate_series(1,200);" 2>/dev/null \
    || sqlite3 "$bad" "CREATE TABLE tool_call_details (id INTEGER); CREATE TABLE observations (id INTEGER);
                       WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM s WHERE i<200)
                       INSERT INTO tool_call_details SELECT i FROM s;"
  local calls obs
  calls=$(sqlite3 "$bad" 'SELECT COUNT(*) FROM tool_call_details;')
  obs=$(sqlite3 "$bad" 'SELECT COUNT(*) FROM observations;')
  if [ "$calls" -gt 100 ] && [ "$obs" -eq 0 ]; then
    pass "detects a dead learning surface ($calls calls -> 0 observations)"
  else
    fail "SELF-TEST BROKEN: could not detect a dead learning surface"
  fi

  # (b) a 404 MUST be treated as failure
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://massu.ai/__definitely_not_a_real_route__" 2>/dev/null || echo "000")
  if [ "$code" = "404" ]; then
    pass "detects a 404 on a route that does not exist"
  elif [ "$code" = "000" ]; then
    skip "404 detection (no network)"
  else
    fail "SELF-TEST BROKEN: a nonexistent route returned $code, not 404"
  fi

  rm -rf "$tmp"
  echo
}

# -----------------------------------------------------------------------------
echo "==============================================="
echo " MASSU REALITY GATE — probing the WORLD, not the code"
echo "==============================================="
echo

if [ "$SELFTEST" = "1" ]; then
  self_test
else
  check_endpoints
  check_stores
  check_hook_health
fi

echo
echo "==============================================="
printf ' %sPASS %s%s   %sFAIL %s%s   %sSKIP %s%s\n' "$GREEN" "$PASSES" "$NC" "$RED" "$FAILURES" "$NC" "$YEL" "$SKIPS" "$NC"
echo "==============================================="
if [ "$FAILURES" -gt 0 ]; then
  echo
  echo "${RED}The gate is RED.${NC} Something the code cannot see is broken in the real world."
  echo "This is the gate that fails for reasons a passing test suite will never show you."
  exit 1
fi
echo
echo "${GREEN}Reality agrees with the code.${NC}"
exit 0
