#!/usr/bin/env bash
#
# live-fire-rotate-hook-failure-log.sh — attack rotate-hook-failure-log.sh (CR-72).
#
# The subject's load-bearing claim is that it truncates IN PLACE, so an O_APPEND writer's
# file descriptor keeps pointing at the file we still read. The assertion that can tell
# truncation from move-and-recreate is the INODE check, and a guard you have not attacked
# is decoration -- so this plants move-and-recreate into the REAL script and demands the
# inode assertion go RED for its own declared reason.
#
# The plant operates on a FIXTURE log in a scratch directory, never on the real evidence
# corpus (G25: a test payload must be inert under every plant). The real script is edited
# and restored under a trap, and the restore is proven byte-identical by sha256.
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUBJECT="$REPO/scripts/ops/rotate-hook-failure-log.sh"
SCRATCH="${LIVE_FIRE_SCRATCH:-${TMPDIR:-/tmp}}/rotate-live-fire-$(date -u +%Y%m%dT%H%M%SZ)-$$"
BACKUP="$SCRATCH/rotate-hook-failure-log.sh.orig"

PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); echo "  PASS  $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL  $1"; }

mkdir -p "$SCRATCH"
cp "$SUBJECT" "$BACKUP"
ORIG_SHA="$(shasum -a 256 "$SUBJECT" | awk '{print $1}')"

restore() {
  if [ -f "$BACKUP" ]; then
    cp "$BACKUP" "$SUBJECT"
    chmod +x "$SUBJECT"
  fi
}
trap restore EXIT

inode_of() { stat -f %i "$1" 2>/dev/null || stat -c %i "$1"; }
rows_of()  { wc -l < "$1" | tr -d ' '; }

make_fixture() {
  local dir="$1" n="$2" i
  mkdir -p "$dir/.massu"
  : > "$dir/.massu/hook-failures.jsonl"
  for i in $(seq 1 "$n"); do
    printf '{"hook":"fixture","error":"database is locked","timestamp":"2026-09-21T00:00:%02dZ"}\n' \
      "$i" >> "$dir/.massu/hook-failures.jsonl"
  done
}

echo "subject : $SUBJECT"
echo "scratch : $SCRATCH"
echo

# ---------------------------------------------------------------- 1. GREEN
echo "1. unplanted subject, real fixture -- truncation must PRESERVE the inode"
G="$SCRATCH/green"
make_fixture "$G" 5
GLOG="$G/.massu/hook-failures.jsonl"
GARC="$G/.massu/hook-failures-archive"
PRE_I="$(inode_of "$GLOG")"
PRE_R="$(rows_of "$GLOG")"
set +e
GOUT="$(bash "$SUBJECT" --log "$GLOG" --archive-dir "$GARC" 2>&1)"
RC=$?
set -e
POST_I="$(inode_of "$GLOG")"
POST_R="$(rows_of "$GLOG")"
ARC_FILE="$(find "$GARC" -name '*.jsonl' | head -1)"
ARC_R=0
if [ -n "$ARC_FILE" ]; then ARC_R="$(rows_of "$ARC_FILE")"; fi

if [ "$RC" -eq 0 ]; then ok "exit 0"; else bad "exit $RC, expected 0"; fi
if [ "$PRE_I" = "$POST_I" ]; then ok "inode preserved ($PRE_I)"; else bad "inode moved $PRE_I -> $POST_I"; fi
if [ "$POST_R" -eq 0 ]; then ok "live log truncated to 0 rows"; else bad "live log still has $POST_R rows"; fi
if [ "$ARC_R" -eq "$PRE_R" ]; then ok "archived $ARC_R of $PRE_R rows"; else bad "archived $ARC_R, expected $PRE_R"; fi
if [ $((ARC_R + POST_R)) -eq "$PRE_R" ]; then ok "conservation: $ARC_R + $POST_R == $PRE_R"; else bad "conservation broken"; fi
if echo "$GOUT" | grep -q '^OK:'; then ok "reported OK on its own stdout"; else bad "no OK line in output"; fi
ARC_SHA=""
if [ -n "$ARC_FILE" ]; then ARC_SHA="$(shasum -a 256 "$ARC_FILE" | awk '{print $1}')"; fi
case "$(basename "${ARC_FILE:-none}")" in
  *"-$ARC_SHA.jsonl") ok "archive name carries its own sha256 (${ARC_SHA:0:12}...)" ;;
  *)                  bad "archive name does not carry its digest: $(basename "${ARC_FILE:-none}")" ;;
esac
echo

# ---------------------------------------------------------------- 2. IDEMPOTENT
echo "2. re-run on the now-empty log -- must be a reported NO-OP, not an error"
set +e
OUT2="$(bash "$SUBJECT" --log "$GLOG" --archive-dir "$GARC" 2>&1)"
RC2=$?
set -e
N_ARC="$(find "$GARC" -name '*.jsonl' | wc -l | tr -d ' ')"
if [ "$RC2" -eq 0 ]; then ok "exit 0 on an already-empty log"; else bad "exit $RC2, expected 0"; fi
if echo "$OUT2" | grep -q 'NO-OP'; then ok "reported as a NO-OP"; else bad "did not report NO-OP"; fi
if [ "$N_ARC" -eq 1 ]; then ok "no second archive written ($N_ARC total)"; else bad "$N_ARC archives, expected 1"; fi
echo

# ---------------------------------------------------------------- 3. RED
echo "3. PLANT move-and-recreate into the REAL script -- inode assertion must go RED"
python3 - "$SUBJECT" <<'PY'
import sys, io
p = sys.argv[1]
s = io.open(p, encoding="utf-8").read()
old = ': > "$LOG"\n'
assert s.count(old) == 1, f"expected exactly 1 truncation site, found {s.count(old)}"
s = s.replace(old, 'mv "$LOG" "$LOG.moved-by-plant" && : > "$LOG"\n', 1)
io.open(p, "w", encoding="utf-8").write(s)
PY
PLANTED_SHA="$(shasum -a 256 "$SUBJECT" | awk '{print $1}')"
# NEGATIVE CONTROL: the plant must really have changed the file, or a RED below would be
# a property of the fixture rather than of the plant ("it refused" vs "it never ran").
if [ "$PLANTED_SHA" != "$ORIG_SHA" ]; then
  ok "negative control: the plant changed the script"
else
  bad "negative control: the plant changed NOTHING -- any RED below is meaningless"
fi

R="$SCRATCH/red"
make_fixture "$R" 5
RLOG="$R/.massu/hook-failures.jsonl"
RARC="$R/.massu/hook-failures-archive"
RPRE_I="$(inode_of "$RLOG")"
set +e
ROUT="$(bash "$SUBJECT" --log "$RLOG" --archive-dir "$RARC" 2>&1)"
RRC=$?
set -e
RPOST_I="$(inode_of "$RLOG")"

if [ "$RRC" -eq 2 ]; then ok "planted run exits 2"; else bad "planted run exits $RRC, expected 2"; fi
if echo "$ROUT" | grep -q "inode CHANGED"; then
  ok "RED names the INODE, its own declared reason"
else
  bad "RED did not name the inode; tail was: $(echo "$ROUT" | tail -2 | tr '\n' ' ')"
fi
if [ "$RPRE_I" != "$RPOST_I" ]; then
  ok "the plant really moved the inode ($RPRE_I -> $RPOST_I)"
else
  bad "inode did not move -- the plant never reached the branch it names"
fi
if [ -f "$RLOG.moved-by-plant" ]; then
  ok "the orphaned inode is on disk, exactly as the plant intends"
else
  bad "no orphaned file -- the plant did not execute"
fi
echo

# ---------------------------------------------------------------- 4. RESTORE
echo "4. restore the real script and prove it byte-identical"
restore
trap - EXIT
NOW_SHA="$(shasum -a 256 "$SUBJECT" | awk '{print $1}')"
if [ "$NOW_SHA" = "$ORIG_SHA" ]; then
  ok "sha256 identical to pre-plant ($ORIG_SHA)"
else
  bad "sha256 DRIFTED: $ORIG_SHA -> $NOW_SHA"
fi
set +e
bash "$SUBJECT" --log "$SCRATCH/absent.jsonl" >/dev/null 2>&1
FRC=$?
set -e
if [ "$FRC" -eq 0 ]; then
  ok "restored script still OPENS (a brick gets disabled)"
else
  bad "restored script exits $FRC on a benign input"
fi
echo

# ------------------------------------------- 5. THE COMMITTABLE-PATH REFUSAL
# The guard that refuses to seal an evidence corpus into a path this repo would COMMIT.
# Both directions, because a refusal that also refuses the legitimate case is a brick, and
# a brick gets bypassed. Everything here runs under --dry-run against a FIXTURE log, so no
# archive is written inside the repo and the real corpus is never touched.
echo "5. the archive dir must be REFUSED when this repo would commit it"
F="$SCRATCH/refusal"
make_fixture "$F" 5
FLOG="$F/.massu/hook-failures.jsonl"
cd "$REPO"

# (a) inside the repo and NOT gitignored -> must refuse, naming the reason.
set +e
NOUT="$(bash "$SUBJECT" --dry-run --log "$FLOG" --archive-dir ".massu/live-fire-not-ignored" 2>&1)"
NRC=$?
set -e
if [ "$NRC" -eq 2 ]; then ok "refuses a non-ignored path inside the repo (exit 2)"; else bad "exit $NRC, expected 2"; fi
if echo "$NOUT" | grep -q "NOT gitignored"; then
  ok "REFUSAL names gitignore, its own declared reason"
else
  bad "refusal did not name gitignore; tail: $(echo "$NOUT" | tail -2 | tr '\n' ' ')"
fi
if [ ! -d "$REPO/.massu/live-fire-not-ignored" ]; then
  ok "refused BEFORE creating the directory"
else
  bad "the refused directory was created anyway"
fi
# POSITIVE CONTROL that the path really was un-ignored -- otherwise the RED above could be
# a property of git's config rather than of the guard.
set +e
git check-ignore -q ".massu/live-fire-not-ignored/probe.jsonl"
IGN=$?
set -e
if [ "$IGN" -ne 0 ]; then ok "positive control: that path is genuinely not ignored"; else bad "that path IS ignored -- the refusal tested nothing"; fi

# (b) inside the repo and IGNORED -> must OPEN. This is the branch the real corpus uses.
set +e
YOUT="$(bash "$SUBJECT" --dry-run --log "$FLOG" --archive-dir ".massu/hook-failures-archive" 2>&1)"
YRC=$?
set -e
if [ "$YRC" -eq 0 ]; then
  ok "opens on the ignored archive dir (the real corpus path)"
else
  bad "exit $YRC on the legitimate ignored path -- this guard is a BRICK: $(echo "$YOUT" | tail -2 | tr '\n' ' ')"
fi
if echo "$YOUT" | grep -q "DRY RUN: wrote nothing"; then ok "and still wrote nothing"; else bad "dry run did not report writing nothing"; fi
echo

echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]
