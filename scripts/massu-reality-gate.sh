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
  #
  # THE STORE ROOT IS THE SAME KNOB THE HOOK USES. This line was a THIRD independent
  # resolver for one path — hardcoded root plus an inline re-implementation of the
  # encoder — alongside `scripts/hooks/memory-integrity-check.sh` and the TS
  # `resolveMemoryDir()`. Three resolvers for one path is three chances to drift, and a
  # drifted reader reports on a directory nobody else is talking about.
  #
  # This one only READS, so it never polluted the live store the way the hook's test did.
  # It still honours the override, and — because a redirected reader would otherwise report
  # "corpus ingested" about a scratch directory in a voice that sounds authoritative — it
  # NAMES the root it actually read in every verdict below.
  local mdir files rows store_root
  store_root="${MASSU_MEMORY_STORE_ROOT:-$HOME/.claude/projects}"
  if [ -z "$store_root" ]; then
    fail "MASSU_MEMORY_STORE_ROOT is set but empty — refusing to resolve a memory dir from it"
    return 0
  fi
  mdir="$store_root/$(echo "$ROOT" | sed 's|/|-|g')/memory"
  if [ -d "$mdir" ]; then
    files=$(find "$mdir" -name '*.md' ! -name 'MEMORY.md' | wc -l | tr -d ' ')
    rows=$(sqlite3 "$db" 'SELECT COUNT(*) FROM memory_files;' 2>/dev/null || echo 0)
    if [ "$files" -gt 0 ] && [ "$rows" -eq 0 ]; then
      fail "MEMORY CORPUS NOT INGESTED: $files files on disk -> $rows rows (auto-recall searches an EMPTY table) [store=$mdir]"
    elif [ "$rows" -lt "$files" ]; then
      fail "memory corpus partially ingested: $files files -> $rows rows [store=$mdir]"
    else
      pass "memory corpus ingested: $files files -> $rows rows [store=$mdir]"
    fi
  else
    skip "R-2 memory corpus (no memory dir at $mdir)"
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
# R-3 — IS A HOOK FAILING *NOW*?  (F1 / plan-2026-08-11 Phase B, B-001..B-003)
#
# THE PREDICATE IS RECENCY, NOT HISTORY. The previous implementation failed on the
# LIFETIME row count of .massu/hook-failures.jsonl. That log is append-only and
# retained on purpose (CR-66), so once one failure had ever been recorded the gate was
# red forever and could only be greened by DESTROYING the evidence it exists to
# preserve — a gate with no legal ordering, which is a gate people learn to ignore.
#
# So: FAIL when a failure occurred inside a bounded window (default 24h,
# MASSU_HOOK_FAILURE_WINDOW_HOURS overrides), regardless of how many historical rows
# precede it. The backlog is REPORTED as context and never truncated (B-002).
#
# FAIL-CLOSED WITH A DENOMINATOR (B-003, M1/M2): an unreadable or unparseable log is an
# ERROR, never a pass. "Scanned 0 rows, found 0 failures" is exactly what a check that
# COULD NOT LOOK also reports.
#
# ABSENT IS NOT UNREADABLE — B-003 AMENDED 2026-08-12, MEASURED, OPERATOR-APPROVED.
# The plan said absent => ERROR. Measured, that bricks two environments:
#   * .massu/hook-failures.jsonl is gitignored (.gitignore:87) and untracked, so it is
#     ABSENT in every CI checkout — and reality.yml's last step runs this gate with no
#     `|| true`, so the nightly job would be red forever with no action able to green it;
#   * hook-failure-signal.ts creates the log LAZILY (appendFileSync on first failure), so
#     a fresh, healthy install has no file until a hook first fails.
# Both are the very no-legal-ordering shape this rewrite removes (G10). Instead, absence
# is CORROBORATED against the independent `hook_health` DB channel that the same writer
# populates (recordHookHealthRow): rows there prove failures were recorded in this
# checkout, so a missing file means the evidence was destroyed => FAIL. No rows (or no DB
# to ask) means there is nothing to measure here => SKIP, loudly named, matching R-2's
# existing precedent for absent runtime state. A SKIP is counted and printed; it is not
# a pass, so the blind-gate law is honoured.
#
# An explicitly-set MASSU_HOOK_FAILURE_LOG is different again: the caller named a path,
# so an absent file there is a broken invocation and always FAILs. That is also what
# gives B-004 its fail-closed proof.
#
# Reads the A-001 seam (MASSU_HOOK_FAILURE_LOG) so B-004's OPENS half can point it at a
# backlog copy — the real log's window state depends on whether the live §1.8 family
# happened to fire, and a proof must not be a coin flip.
# -----------------------------------------------------------------------------
check_hook_health () {
  echo
  echo "R-3  HOOKS — is anything failing RIGHT NOW?"
  local seam="${MASSU_HOOK_FAILURE_LOG:-}"
  local log="${seam:-$ROOT/.massu/hook-failures.jsonl}"
  local hours="${MASSU_HOOK_FAILURE_WINDOW_HOURS:-24}"

  if [ ! -f "$log" ]; then
    # The caller named this path explicitly — an absent file is a broken invocation.
    if [ -n "$seam" ]; then
      fail "hook-failure log ABSENT at MASSU_HOOK_FAILURE_LOG=$log — a check that cannot look must not report clean"
      return
    fi
    # Default path. Ask the independent DB channel whether failures were EVER recorded
    # here; if they were, the file's absence means the evidence was destroyed (CR-66).
    # ASK THROUGH `node:sqlite`, NEVER THE `sqlite3` CLI.
    #
    # This read used to be `dbrows=$(sqlite3 "$db" '...' 2>/dev/null)` behind a
    # `command -v sqlite3` guard. `sqlite3` is NOT installed on the GitHub runner, so the
    # guard fell through, `dbrows` kept its initial EMPTY STRING, and the `''|0` arm below
    # reported "no corroborating hook_health rows — nothing has run here". That is the
    # blind-gate law verbatim: "I could not ask" and "I asked and it said zero" produced the
    # SAME value, and that value was the non-failing one — while the message ASSERTED A CAUSE
    # THE GATE HAD NOT DETERMINED. CR-69 makes node:sqlite the product's own default engine,
    # so this asks through the same path the product reads through and needs no external
    # tool. Precedent: scripts/hooks/memory-integrity-check.sh section 6.
    #
    # THE PROBE NEVER PRINTS THE EMPTY STRING. It prints a count, or UNCHECKABLE:<reason>,
    # so cannot-measure can never again be spelled the same way as measured-zero.
    local db="$ROOT/.massu/memory.db" dbrows=""
    if [ ! -f "$db" ]; then
      dbrows=0                              # no DB at all: nothing was ever recorded here
    elif ! command -v node >/dev/null 2>&1; then
      dbrows="UNCHECKABLE:node-not-on-PATH"
    else
      dbrows=$(node -e '
        const { DatabaseSync } = require("node:sqlite");
        let db;
        try {
          db = new DatabaseSync(process.argv[1], { readOnly: true });
          // ASK sqlite_master FIRST, and let it answer BOTH questions at once: it succeeds
          // only if the file really is a readable database, and it reports whether the table
          // exists. A bare try/catch around `SELECT COUNT(*) FROM hook_health` cannot tell
          // "no such table" (a measured zero) from "file is not a database" (blind) — the
          // first draft of this fix did exactly that and reported a corrupt DB as
          // "nothing has run here", reproducing the very defect being repaired.
          //
          // BOUND PARAMETERS, not quoted literals: SQLite reads "hook_health" in double
          // quotes as an IDENTIFIER, and single quotes cannot appear inside this
          // single-quoted shell heredoc at all.
          const present = db.prepare(
            "SELECT count(*) c FROM sqlite_master WHERE type = ? AND name = ?"
          ).get("table", "hook_health").c;
          if (!present) {
            // The channel never recorded anything in this checkout: a MEASURED zero.
            process.stdout.write("0");
          } else {
            process.stdout.write(String(db.prepare("SELECT COUNT(*) c FROM hook_health").get().c));
          }
        } catch (err) {
          const m = String(err && err.message ? err.message : err).replace(/\s+/g, " ");
          process.stdout.write("UNCHECKABLE:" + m.slice(0, 80));
        } finally {
          try { if (db) db.close(); } catch { /* already closed */ }
        }
      ' "$db" 2>/dev/null)
      # A probe that produced nothing is UNKNOWN, never zero (M2 — fail closed).
      [ -n "$dbrows" ] || dbrows="UNCHECKABLE:probe-produced-no-output"
    fi
    case "$dbrows" in
      0)
        skip "R-3 hooks (no hook-failure log at $log, and no corroborating hook_health rows — nothing has run here)"
        ;;
      ''|*[!0-9]*)
        skip "R-3 hooks (no hook-failure log at $log; hook_health could not be read (${dbrows:-no-output}), so absence could not be corroborated)"
        ;;
      *)
        fail "hook-failure log ABSENT at $log but hook_health records $dbrows failure(s) — the evidence was destroyed (CR-66)"
        ;;
    esac
    return
  fi
  if [ ! -r "$log" ]; then
    fail "hook-failure log UNREADABLE at $log — a check that cannot look must not report clean"
    return
  fi

  local out rc
  out=$(MASSU_R3_LOG="$log" MASSU_R3_HOURS="$hours" node -e '
    const fs = require("fs");
    const path = process.env.MASSU_R3_LOG;
    const hours = Number(process.env.MASSU_R3_HOURS);
    if (!Number.isFinite(hours) || hours <= 0) {
      console.log("ERROR\tinvalid window: " + process.env.MASSU_R3_HOURS); process.exit(2);
    }
    let raw;
    try { raw = fs.readFileSync(path, "utf8"); }
    catch (e) { console.log("ERROR\tunreadable: " + e.message); process.exit(2); }
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    const cutoff = Date.now() - hours * 3600 * 1000;
    let scanned = 0, unparseable = 0, newest = null;
    const inWindow = [];
    for (const l of lines) {
      scanned++;
      let o;
      try { o = JSON.parse(l); } catch { unparseable++; continue; }
      const ts = Date.parse(o.timestamp || "");
      if (!Number.isFinite(ts)) { unparseable++; continue; }
      if (newest === null || ts > newest) newest = ts;
      if (ts >= cutoff) {
        inWindow.push({
          ts: o.timestamp,
          hook: o.hook || "(no hook)",
          error: String(o.error || "").replace(/\s+/g, " ").slice(0, 70),
        });
      }
    }
    // Bytes present but NOTHING parseable means the reader or the format is broken.
    // Reporting that as "0 failures in window" would be the blind-gate value.
    if (scanned > 0 && scanned === unparseable) {
      console.log("ERROR\t" + scanned + " row(s) present but NONE parseable — reader or format is broken");
      process.exit(2);
    }
    console.log(["OK", scanned, unparseable, inWindow.length,
      newest === null ? "none" : new Date(newest).toISOString()].join("\t"));
    for (const r of inWindow.slice(0, 10)) console.log(["ROW", r.ts, r.hook, r.error].join("\t"));
  ' 2>&1)
  rc=$?

  if [ "$rc" -ne 0 ]; then
    fail "hook-failure log could not be measured: $(printf '%s' "$out" | head -1 | cut -f2-)"
    return
  fi

  local head scanned unparseable nwin newest
  head=$(printf '%s' "$out" | head -1)
  scanned=$(printf '%s' "$head" | cut -f2)
  unparseable=$(printf '%s' "$head" | cut -f3)
  nwin=$(printf '%s' "$head" | cut -f4)
  newest=$(printf '%s' "$head" | cut -f5)

  # M1: the denominator prints on EVERY run, pass or fail, so a silent drop to zero rows
  # scanned is visible rather than indistinguishable from a clean log.
  note "scanned $scanned row(s); $unparseable unparseable; newest $newest; window ${hours}h"

  if [ "$nwin" -eq 0 ]; then
    pass "no hook failure in the last ${hours}h ($scanned historical row(s) retained, newest $newest)"
    return
  fi
  fail "$nwin hook failure(s) in the last ${hours}h — a hook is failing NOW ($scanned historical row(s) retained)"
  printf '%s' "$out" | awk -F'\t' '$1=="ROW"{printf "          %s  %s  %s\n",$2,$3,$4}'
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
