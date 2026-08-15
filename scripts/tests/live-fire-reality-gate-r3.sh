#!/usr/bin/env bash
# Copyright (c) 2026 Massu. All rights reserved.
# Licensed under BSL 1.1 - see LICENSE file for details.
#
# B-004 — CR-72 LIVE-FIRE FOR R-3, THE HOOK-LIVENESS CHECK
# (plan-2026-08-11-hook-failure-signal-truthfulness-and-durable-ingestion, Phase B).
#
# R-3 used to fail on the LIFETIME row count of .massu/hook-failures.jsonl. That log is
# append-only and retained on purpose (CR-66), so once a single failure had ever been
# recorded the gate was red forever and could only be greened by DESTROYING the evidence
# it exists to preserve. Phase B re-keys the verdict onto a bounded RECENCY window.
#
# A recency gate has three ways to be worthless, and every one of them looks healthy:
#
#   it never closes   -> a hook failing right now ships undetected, exactly as before.
#   it never opens    -> still red forever; a brick gets disabled (CR-72) and we have
#                        merely moved the no-legal-ordering defect, not removed it.
#   it cannot look    -> an absent/garbage log reported as "0 failures in window" is the
#                        blind-gate value: could-not-look and looked-and-found-nothing
#                        produce the same PASS.
#
# All three are attacked here, against the REAL gate, plus the window override itself
# (CR-68: a constant about the world is a claim — measure it) and the two branches that
# adjudicate an ABSENT log.
#
#   PROOF 1  500 rows, ALL out-of-window -> PASS. Proves the gate OPENS, and proves the
#            verdict does NOT key on the lifetime count (500 rows and still green is
#            exactly what the old implementation could never produce).
#   PROOF 2  those 500 + ONE row timestamped now -> FAIL, NAMING that row's timestamp and
#            hook, and NOT reporting the 501 lifetime total. Naming is B-005(a).
#   PROOF 3  fail-closed, three ways: an explicitly-seamed path that does not exist; a
#            file of non-JSON garbage; a file that cannot be read.
#   PROOF 4  the SAME out-of-window fixture with MASSU_HOOK_FAILURE_WINDOW_HOURS=100 ->
#            FAIL. The rows did not move; the window did. Proves recency is genuinely the
#            predicate and the override is wired, rather than inferred from a comment.
#   PROOF 5  an ABSENT default log, both branches, in a synthetic root: with no
#            corroborating hook_health rows -> SKIP (a fresh checkout has nothing to
#            measure); with hook_health rows present -> FAIL, because the DB proves
#            failures were recorded here and the file's absence means the evidence was
#            destroyed (CR-66/G16).
#
# WHY PROOFS 1/2/4 RUN AGAINST A COPY BEHIND THE SEAM, NOT THE REAL LOG.
# The plan's stated reason was that the real log is "legitimately RED on landing" so it
# could not also demonstrate PASS. MEASURED 2026-08-12, that premise is false: the live
# §1.8 auto-learning-pipeline family last fired 2026-08-11T00:33:53Z, so the 24h window is
# EMPTY and the real log is green. The real reason is stronger and outlives the premise:
# the real log's window state depends on whether that family happened to fire in the last
# 24 hours, so a proof asserted against it would be a coin flip — the environment-dependent
# class of G27/§1.7. A proof must be deterministic, so each proof builds the exact corpus
# its claim is about.
#
# THE REAL LOG IS NEVER WRITTEN, AND DELIBERATELY NEVER RESTORED. Restoring from a
# snapshot would be actively dangerous here: several sessions work this repo at once, and
# a hook failing during this run appends legitimately. Rolling that back would destroy a
# real signal to satisfy a test. So the safety assertion is APPEND-ONLY-ness, which is the
# property CR-66 actually cares about: the pre-run prefix must be byte-identical and the
# file must not shrink. A concurrent append is reported, not punished.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GATE="$REPO_ROOT/scripts/massu-reality-gate.sh"
REAL_LOG="$REPO_ROOT/.massu/hook-failures.jsonl"

# G29: hook-reachable -- ASSERT the repository, scrub nothing. `--show-toplevel` cannot see
# a GIT_DIR leak (it returns the CWD); only --absolute-git-dir can.
ACTUAL_GIT_DIR="$(cd "$REPO_ROOT" && git rev-parse --absolute-git-dir)"
if [ "$ACTUAL_GIT_DIR" != "$REPO_ROOT/.git" ]; then
  echo "FATAL: git resolves to '$ACTUAL_GIT_DIR', expected '$REPO_ROOT/.git'." >&2
  exit 1
fi
[ -x "$GATE" ] || [ -f "$GATE" ] || { echo "FATAL: gate not found at $GATE" >&2; exit 1; }

# G17/CR-77: a temp root that could be empty widens every rm below to its parent.
WORK="$(mktemp -d -t r3-livefire-XXXXXX)"
: "${WORK:?mktemp -d returned an empty path}"
case "$WORK" in
  /tmp/*|/private/var/*|/var/folders/*) : ;;
  *) echo "FATAL: refusing to operate on unexpected temp root '$WORK'" >&2; exit 1 ;;
esac

fail=0
cleanup() { [ -n "${WORK:-}" ] && [ -d "$WORK" ] && rm -rf "$WORK"; }
trap cleanup EXIT

# --- the real log's pre-run identity (append-only assertion, see header) ---------------
REAL_EXISTED=0; REAL_SIZE_BEFORE=0; REAL_PREFIX_SHA_BEFORE=""
if [ -f "$REAL_LOG" ]; then
  REAL_EXISTED=1
  REAL_SIZE_BEFORE=$(wc -c < "$REAL_LOG" | tr -d ' ')
  REAL_PREFIX_SHA_BEFORE=$(head -c "$REAL_SIZE_BEFORE" "$REAL_LOG" | shasum -a 256 | cut -d' ' -f1)
fi

PASSED=0; FAILED=0
# Checks that exist only where the operator's real log does (the SAFETY section).
CONDITIONAL=0
ok ()   { PASSED=$((PASSED+1)); printf '  \033[0;32mOK\033[0m    %s\n' "$1"; }
bad ()  { FAILED=$((FAILED+1)); printf '  \033[0;31mBAD\033[0m   %s\n' "$1"; fail=1; }
info () { printf '        \033[2m%s\033[0m\n' "$1"; }

# Run the REAL gate and return ONLY R-3's section, ANSI-stripped.
# The verdict is judged from R-3's own lines, never from the gate's exit code: the other
# checks probe unrelated reality and must not be able to colour this proof.
r3 () { # $1 = seam value ("" to leave unset); remaining args = extra `VAR=value` env
  local seam="$1"; shift
  local out=""
  if [ -n "$seam" ]; then
    out=$(env "$@" MASSU_HOOK_FAILURE_LOG="$seam" bash "$GATE" --offline 2>&1) || true
  else
    out=$(env "$@" -u MASSU_HOOK_FAILURE_LOG bash "$GATE" --offline 2>&1) || true
  fi
  printf '%s\n' "$out" | sed $'s/\033\\[[0-9;]*m//g' | sed -n '/^R-3 /,/^====/p'
}

# Emit a fixture log: $1=path  $2=count of rows at (now - 72h)  $3=count at (now - 1h)
mk_log () {
  MK_OUT="$1" MK_OLD="$2" MK_NEW="$3" node -e '
    const fs = require("fs");
    const out = process.env.MK_OUT;
    const nOld = Number(process.env.MK_OLD), nNew = Number(process.env.MK_NEW);
    const rows = [];
    for (let i = 0; i < nOld; i++) {
      rows.push(JSON.stringify({
        hook: "historical-hook",
        error: "an old failure, long since fixed #" + i,
        timestamp: new Date(Date.now() - 72 * 3600e3 - i * 1000).toISOString(),
      }));
    }
    for (let i = 0; i < nNew; i++) {
      rows.push(JSON.stringify({
        hook: "r3-livefire-canary",
        error: "PLANTED in-window failure, live-fire B-004",
        timestamp: new Date(Date.now() - 3600e3).toISOString(),
      }));
    }
    fs.writeFileSync(out, rows.join("\n") + "\n");
  '
}

echo "==============================================="
echo " B-004 LIVE-FIRE — R-3 hook liveness (CR-72)"
echo "==============================================="

# --- PROOF 1 — the gate OPENS, and does not key on the lifetime count ------------------
echo
echo "PROOF 1  500 rows, all OUT of window -> R-3 must PASS"
OLDLOG="$WORK/backlog.jsonl"
mk_log "$OLDLOG" 500 0
P1="$(r3 "$OLDLOG")"
if grep -q "PASS  no hook failure in the last 24h" <<<"$P1"; then
  ok "gate OPENS on a 500-row out-of-window backlog"
else
  bad "expected PASS on an out-of-window backlog; got:"; printf '%s\n' "$P1"
fi
if grep -q "500 historical row(s) retained" <<<"$P1"; then
  ok "backlog REPORTED as context (B-002): 500 rows named, not truncated"
else
  bad "expected the retained backlog denominator in the PASS line"
fi
if grep -q "scanned 500 row(s)" <<<"$P1"; then
  ok "denominator printed on a PASSING run (M1)"
else
  bad "expected 'scanned 500 row(s)' note on the passing run"
fi
AFTER1=$(wc -l < "$OLDLOG" | tr -d ' ')
[ "$AFTER1" = "500" ] && ok "log untruncated after the run: 500 rows (CR-66)" \
                      || bad "log was modified by the gate: $AFTER1 rows, expected 500"

# --- PROOF 2 — the gate CLOSES, and NAMES the row (B-005a) -----------------------------
echo
echo "PROOF 2  same 500 + ONE row timestamped now -> R-3 must FAIL and NAME it"
NEWLOG="$WORK/backlog-plus-live.jsonl"
mk_log "$NEWLOG" 500 1
PLANTED_TS=$(node -e '
  const fs=require("fs");
  const ls=fs.readFileSync(process.argv[1],"utf8").trim().split("\n");
  for(const l of ls){const o=JSON.parse(l); if(o.hook==="r3-livefire-canary"){console.log(o.timestamp);break;}}
' "$NEWLOG")
[ -n "$PLANTED_TS" ] || { echo "FATAL: fixture did not contain the planted row" >&2; exit 1; }
info "planted row timestamp: $PLANTED_TS"
P2="$(r3 "$NEWLOG")"
if grep -q "FAIL  1 hook failure(s) in the last 24h" <<<"$P2"; then
  ok "gate CLOSES on one in-window failure"
else
  bad "expected FAIL naming 1 in-window failure; got:"; printf '%s\n' "$P2"
fi
# B-005(a) — the verdict must name the OFFENDING ROW. Assert the timestamp and the hook
# TOGETHER, in the row-line shape the gate emits ("<ts>  <hook>  <error>").
#
# Asserting the bare timestamp here was VACUOUS and the anti-vacuity plant caught it: the
# planted row is also the NEWEST row, so its timestamp appears in the "newest …" M1
# denominator note even when row-naming is deleted outright. A substring that another line
# can satisfy is decoration — the assertion must be pinned to the line it is about.
if grep -qF "$PLANTED_TS  r3-livefire-canary" <<<"$P2"; then
  ok "names the offending ROW — timestamp and hook on one line (B-005a)"
else
  bad "verdict did not name the planted row ($PLANTED_TS  r3-livefire-canary)"
fi
# Negative control for the assertion above: prove the row line is a DIFFERENT line from
# the denominator note, so a future change cannot make it pass via the note again.
# Captured, not piped into `grep -q`: a matching `grep -q` exits early, the producer takes
# SIGPIPE, and under `set -o pipefail` the pipeline returns 141 — so a REAL match reads as
# no-match. That broken-pipe class has its own drift guard in this repo, and it caught this
# exact line.
NAMING_LINES="$(grep -F "$PLANTED_TS" <<<"$P2" | grep -v "newest" || true)"
if [ -n "$NAMING_LINES" ]; then
  ok "the naming line is distinct from the 'newest …' note"
else
  bad "the only mention of the planted timestamp is the denominator note — naming is vacuous"
fi
# The whole point of Phase B: the number in the verdict is the WINDOW count, not lifetime.
if grep -qE "FAIL  501 hook failure" <<<"$P2"; then
  bad "verdict reported the LIFETIME total (501) — this is the defect Phase B removes"
else
  ok "verdict is the WINDOW count, not the 501-row lifetime total"
fi

# --- PROOF 3 — fail-closed, three ways -------------------------------------------------
echo
echo "PROOF 3  a check that cannot look must not report clean"
P3A="$(r3 "$WORK/no-such-dir/missing.jsonl")"
if grep -q "FAIL  hook-failure log ABSENT at MASSU_HOOK_FAILURE_LOG" <<<"$P3A"; then
  ok "explicitly-seamed but absent path -> FAIL"
else
  bad "an absent explicitly-seamed path did not fail closed; got:"; printf '%s\n' "$P3A"
fi

GARBAGE="$WORK/garbage.jsonl"
printf 'this is not json\n{{{ neither is this\n<<<>>>\n' > "$GARBAGE"
P3B="$(r3 "$GARBAGE")"
if grep -q "NONE parseable" <<<"$P3B"; then
  ok "bytes present but nothing parseable -> FAIL (not '0 failures in window')"
else
  bad "an unparseable log did not fail closed; got:"; printf '%s\n' "$P3B"
fi

UNREADABLE="$WORK/unreadable.jsonl"
mk_log "$UNREADABLE" 3 0
chmod 000 "$UNREADABLE"
if [ -r "$UNREADABLE" ]; then
  # Running as root (or an ACL): chmod cannot create the condition, so the proof did not
  # run. G26/CR-89 — a proof that did not run is never a pass.
  bad "INCONCLUSIVE: cannot make a file unreadable in this environment (running as root?)"
  chmod 644 "$UNREADABLE"
else
  P3C="$(r3 "$UNREADABLE")"
  chmod 644 "$UNREADABLE"
  if grep -q "FAIL  hook-failure log UNREADABLE" <<<"$P3C"; then
    ok "unreadable log -> FAIL"
  else
    bad "an unreadable log did not fail closed; got:"; printf '%s\n' "$P3C"
  fi
fi

# --- PROOF 4 — recency really is the predicate (CR-68) ---------------------------------
echo
echo "PROOF 4  same out-of-window fixture, window widened to 100h -> R-3 must FAIL"
P4="$(r3 "$OLDLOG" MASSU_HOOK_FAILURE_WINDOW_HOURS=100)"
if grep -qE "FAIL  [0-9]+ hook failure\(s\) in the last 100h" <<<"$P4"; then
  ok "the rows did not move; the WINDOW did -> recency is the predicate, override wired"
else
  bad "widening the window to 100h did not turn the same corpus red; got:"; printf '%s\n' "$P4"
fi
# Negative control (CR-49B): the identical corpus must still pass at 24h, or PROOF 4
# proved nothing about the window -- it would just be a log that always fails.
P4N="$(r3 "$OLDLOG")"
if grep -q "PASS  no hook failure in the last 24h" <<<"$P4N"; then
  ok "negative control: the same corpus is GREEN at 24h"
else
  bad "negative control failed — the corpus is red at 24h too, so PROOF 4 is vacuous"
fi

# --- PROOF 5 — the two ABSENT-log branches, in a synthetic root -------------------------
echo
echo "PROOF 5  an ABSENT default log: SKIP without corroboration, FAIL with it"
FAKE="$WORK/fakerepo"
mkdir -p "$FAKE/scripts/lib" "$FAKE/.massu"
cp "$GATE" "$FAKE/scripts/massu-reality-gate.sh"
# CR-72: the copy must be the REAL gate, byte for byte, or this proves nothing.
SHA_REAL=$(shasum -a 256 "$GATE" | cut -d' ' -f1)
SHA_COPY=$(shasum -a 256 "$FAKE/scripts/massu-reality-gate.sh" | cut -d' ' -f1)
[ "$SHA_REAL" = "$SHA_COPY" ] && ok "synthetic root runs the REAL gate (sha256 match)" \
                              || bad "gate copy differs from the real gate — proof void"

fake_r3 () {
  local out=""
  out=$(env -u MASSU_HOOK_FAILURE_LOG bash "$FAKE/scripts/massu-reality-gate.sh" --offline 2>&1) || true
  printf '%s\n' "$out" | sed $'s/\033\\[[0-9;]*m//g' | sed -n '/^R-3 /,/^====/p'
}

P5A="$(fake_r3)"
if grep -q "SKIP  R-3 hooks (no hook-failure log" <<<"$P5A"; then
  ok "absent log + no hook_health rows -> SKIP (a fresh checkout has nothing to measure)"
else
  bad "expected a named SKIP for an absent log in a fresh root; got:"; printf '%s\n' "$P5A"
fi
if grep -q "PASS  no hook failure" <<<"$P5A"; then
  bad "an absent log reported a PASS — that is the blind-gate value"
else
  ok "absent log did NOT report clean"
fi

# SEED THE CORROBORATING ROWS WITH `node:sqlite`, NOT THE `sqlite3` CLI.
#
# This proof was INCONCLUSIVE on every CI run — `sqlite3` is not installed on the GitHub
# runner, so the branch could not be exercised and the harness exited non-zero. Measured
# 2026-08-12 in a non-root node:22 container (the runner's shape): `passed: 16 failed: 1`,
# which is exactly the 17 checks CI reported against a floor of 18.
#
# The CLI was also the outlier: CR-69 makes Node's built-in `node:sqlite` this repo's DEFAULT
# engine and the Node floor is >=22.13, so the runtime the harness already depends on can do
# this with no undeclared external dependency. A proof that needs a tool nobody installs is a
# proof that does not run.
node --input-type=module -e '
  import { DatabaseSync } from "node:sqlite";
  const db = new DatabaseSync(process.argv[1]);
  // PARAMETERISED, and not for style: SQLite reads "a" as an IDENTIFIER, so the CLI form
  // `VALUES ("a","x")` raises `no such column: "a"` under node:sqlite. The sqlite3 CLI accepts
  // it only through a legacy double-quoted-string compatibility mode. Binding the values needs
  // no SQL string literals at all, so it survives the shell and JS quoting layers unchanged.
  db.exec(`CREATE TABLE hook_health (id INTEGER PRIMARY KEY AUTOINCREMENT, hook TEXT NOT NULL,
           error TEXT NOT NULL, context_json TEXT,
           occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  const ins = db.prepare(`INSERT INTO hook_health (hook, error) VALUES (?, ?)`);
  for (const [h, e] of [["a", "x"], ["b", "y"], ["c", "z"]]) ins.run(h, e);
  db.close();
' "$FAKE/.massu/memory.db"
P5B="$(fake_r3)"
if grep -q "FAIL  hook-failure log ABSENT at .* but hook_health records 3 failure(s)" <<<"$P5B"; then
  ok "absent log + 3 corroborating hook_health rows -> FAIL (evidence destroyed, CR-66)"
else
  bad "a destroyed log with corroborating DB rows did not fail; got:"; printf '%s\n' "$P5B"
fi

# --- the real log was never written ----------------------------------------------------
echo
echo "SAFETY  the operator's real log"
if [ "$REAL_EXISTED" = "1" ]; then
  # The two checks below exist ONLY on a machine that has the operator's real log. A consumer
  # asserting a floor on the raw total would be asserting the environment (G27/CR-90).
  CONDITIONAL=2
  SIZE_AFTER=$(wc -c < "$REAL_LOG" | tr -d ' ')
  PREFIX_SHA_AFTER=$(head -c "$REAL_SIZE_BEFORE" "$REAL_LOG" | shasum -a 256 | cut -d' ' -f1)
  if [ "$PREFIX_SHA_AFTER" = "$REAL_PREFIX_SHA_BEFORE" ]; then
    ok "pre-run prefix byte-identical (sha256 ${REAL_PREFIX_SHA_BEFORE:0:16}…) — nothing rewritten"
  else
    bad "the real log's existing bytes CHANGED — something rewrote history"
  fi
  if [ "$SIZE_AFTER" -lt "$REAL_SIZE_BEFORE" ]; then
    bad "the real log SHRANK ($REAL_SIZE_BEFORE -> $SIZE_AFTER bytes) — CR-66 violated"
  elif [ "$SIZE_AFTER" -gt "$REAL_SIZE_BEFORE" ]; then
    ok "append-only preserved; grew by $((SIZE_AFTER - REAL_SIZE_BEFORE)) byte(s) — a concurrent hook wrote a real failure, which is not ours to roll back"
  else
    ok "unchanged at $SIZE_AFTER bytes"
  fi
else
  info "no real log on this machine — nothing to protect"
fi

echo
echo "==============================================="
# Machine-readable summary. A caller asserts a FLOOR on `passed` so that a harness which
# silently runs fewer checks — "ran fewer, failed none" — cannot read as a clean run (M1).
# CONDITIONAL vs UNCONDITIONAL, reported separately. The SAFETY section only runs where the
# operator's real hook-failure log exists, so the TOTAL varies by machine: 19 here, 17 on a
# fresh CI checkout. A consumer asserting a fixed floor on the total is asserting the
# ENVIRONMENT, not the harness — the same shape as a wall-clock budget (G27/CR-90), and it is
# what made this harness read as "ran fewer checks" on every CI run. Subtract `conditional`
# and the floor becomes a statement about the proofs themselves.
echo "passed: $PASSED failed: $FAILED conditional: $CONDITIONAL"
if [ "$fail" -ne 0 ]; then
  echo " B-004 LIVE-FIRE: FAILED"
  echo "==============================================="
  exit 1
fi
echo " B-004 LIVE-FIRE: ALL PROOFS PASSED"
echo "==============================================="
exit 0
