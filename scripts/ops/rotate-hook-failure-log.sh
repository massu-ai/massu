#!/usr/bin/env bash
#
# rotate-hook-failure-log.sh — rotate the hook-failure evidence log IN PLACE.
#
# WHY TRUNCATION AND NOT move-and-recreate:
#   This is `logrotate`'s `copytruncate` strategy, and the reason it exists is that a writer
#   holding a long-lived O_APPEND descriptor keeps writing into the ORPHANED inode after a
#   `mv` -- appending to a file nobody reads while the freshly created log stays empty
#   forever, which is the healthiest-looking possible death of an evidence channel.
#
#   ⚠️ BE PRECISE ABOUT WHICH HAZARD APPLIES HERE, because the two strategies fail in
#   OPPOSITE directions and which is correct is a property of the WRITER, not a preference:
#     mv        corrupts a writer holding a long-lived O_APPEND descriptor (orphaned inode)
#     truncate  corrupts a writer holding a NON-O_APPEND descriptor -- its offset is not
#               reset, so the next write lands at the old offset and the file becomes
#               sparse, NUL-padded up to that point. This is copytruncate's documented
#               failure mode and it is why the strategy has a bad reputation.
#
#   Our writer is `hook-failure-signal.ts:86`, `appendFileSync(path, ...)`: it opens with
#   O_APPEND and CLOSES on every call, holding no descriptor between appends. So NEITHER
#   hazard can bite today -- a `mv` would simply be recreated by the next append. The
#   orphaned-inode risk is LATENT, not active, and saying otherwise would be a claim the
#   code does not support.
#
#   Truncation is still the right choice: it is the strategy that stays correct if the writer
#   ever switches to a held descriptor or a write stream, which is a one-line change nobody
#   would think to re-audit. The inode assertion below is what keeps that property honest.
#
#   The one place we IMPROVE on copytruncate: its documented race loses any line written
#   between the copy and the truncate. We refuse to truncate if the file grew, so the window
#   closes by refusal rather than by data loss.
#
# WHY COPY -> VERIFY -> TRUNCATE and not plain `cp` then `: >`:
#   Truncation is irreversible and this log exists in exactly one copy on disk (it is
#   gitignored and no backup job covers it). We verify the archive byte-for-byte against
#   the source BEFORE destroying the source, and refuse to truncate if anything disagrees.
#   Record -> retain -> retrieve: all three proven, or nothing is destroyed.
#
# WHY THE ARCHIVE NAME CARRIES THE DIGEST:
#   A copy whose name contains its own sha256 makes later truncation or corruption
#   DETECTABLE rather than silent. Every rotation gets this, not just the first one --
#   a later corpus is not less deserving of evidence, and a "is this the first rotation?"
#   branch would be state nobody can re-derive.
#
set -euo pipefail

LOG="${MASSU_HOOK_FAILURE_LOG:-.massu/hook-failures.jsonl}"
ARCHIVE_DIR="${MASSU_HOOK_FAILURE_ARCHIVE_DIR:-.massu/hook-failures-archive}"
MODE="rotate"

usage() {
  cat <<'USAGE'
usage: rotate-hook-failure-log.sh [--dry-run|--list] [--log PATH] [--archive-dir PATH]

  (no flags)          rotate: archive the live log, then truncate it in place
  --dry-run           report exactly what a rotation would do; write nothing
  --list              list the archived corpora with row counts and digest status
  --log PATH          the live log            (default .massu/hook-failures.jsonl)
  --archive-dir PATH  where copies are kept   (default .massu/hook-failures-archive)

exit 0  rotation done, or nothing to do (empty/absent log -- idempotent no-op)
exit 2  refused: could not verify, or could not look. Nothing was destroyed.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)     MODE="dry-run"; shift ;;
    --list)        MODE="list"; shift ;;
    --log)         [ $# -ge 2 ] || { echo "FATAL: --log needs a path" >&2; exit 2; }
                   LOG="$2"; shift 2 ;;
    --archive-dir) [ $# -ge 2 ] || { echo "FATAL: --archive-dir needs a path" >&2; exit 2; }
                   ARCHIVE_DIR="$2"; shift 2 ;;
    -h|--help)     usage; exit 0 ;;
    *)             echo "FATAL: unrecognised argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# R-011: never resolve an ambiguous path to the most likely candidate.
[ -n "$LOG" ]         || { echo "FATAL: --log resolved to the empty string" >&2; exit 2; }
[ -n "$ARCHIVE_DIR" ] || { echo "FATAL: --archive-dir resolved to the empty string" >&2; exit 2; }

inode_of() {
  stat -f %i "$1" 2>/dev/null || stat -c %i "$1" 2>/dev/null || {
    echo "FATAL: cannot read the inode of $1 -- neither BSD nor GNU stat worked" >&2
    exit 2
  }
}
digest_of() { shasum -a 256 "$1" | awk '{print $1}'; }
rows_of()   { wc -l < "$1" | tr -d ' '; }
bytes_of()  { wc -c < "$1" | tr -d ' '; }

# ---------------------------------------------------------------- --list
if [ "$MODE" = list ]; then
  if [ ! -d "$ARCHIVE_DIR" ]; then
    echo "archive dir                    : $ARCHIVE_DIR (does not exist)"
    echo "archived corpora               : 0"
    exit 0
  fi
  echo "archive dir                    : $ARCHIVE_DIR"
  n=0; bad=0
  for f in "$ARCHIVE_DIR"/*.jsonl; do
    [ -e "$f" ] || continue
    n=$((n + 1))
    base="$(basename "$f")"
    claimed="${base##*-}"; claimed="${claimed%.jsonl}"
    actual="$(digest_of "$f")"
    if [ "$claimed" = "$actual" ]; then status="INTACT"; else status="MISMATCH"; bad=$((bad + 1)); fi
    printf '  %-8s %8s rows  %s\n' "$status" "$(rows_of "$f")" "$base"
  done
  echo "archived corpora               : $n"
  echo "digest mismatches              : $bad"
  [ "$bad" -eq 0 ] || { echo "REFUSED: an archived corpus no longer matches its own name." >&2; exit 2; }
  exit 0
fi

# ------------------------------------------------------- absent / empty log
if [ ! -e "$LOG" ]; then
  echo "live log                       : $LOG (ABSENT)"
  echo "rows before                    : 0"
  echo "rows after                     : 0"
  echo "NO-OP: nothing to rotate. The log is created lazily on the first hook failure."
  exit 0
fi

[ -r "$LOG" ] || { echo "FATAL: $LOG exists but is not readable" >&2; exit 2; }

PRE_ROWS="$(rows_of "$LOG")"
PRE_BYTES="$(bytes_of "$LOG")"
PRE_INODE="$(inode_of "$LOG")"
PRE_DIGEST="$(digest_of "$LOG")"

echo "live log                       : $LOG"
echo "rows before                    : $PRE_ROWS"
echo "bytes before                   : $PRE_BYTES"
echo "inode before                   : $PRE_INODE"
echo "sha256 before                  : $PRE_DIGEST"

if [ "$PRE_ROWS" -eq 0 ] && [ "$PRE_BYTES" -eq 0 ]; then
  echo "rows after                     : 0"
  echo "NO-OP: the live log is already empty. Idempotent -- nothing archived, nothing truncated."
  exit 0
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="$ARCHIVE_DIR/$STAMP-$PRE_DIGEST.jsonl"

echo "archive target                 : $TARGET"
echo "local time                     : $(TZ=America/Los_Angeles date '+%Y-%m-%d %H:%M %Z')"

# ---- REFUSE to seal evidence into a path this repo would COMMIT.
# Every row of this corpus carries an absolute operator home path, and this repo publishes
# to a public mirror, so an archive directory that is not gitignored is a leak waiting on
# one `git add -A`. Making it impossible beats making it detectable.
#
# G29: this reads the REAL repository, so it ASSERTS the repo rather than scrubbing --
# `--show-toplevel` is blind to a leaked GIT_DIR, and git_bind_or_die compares the git
# directory, which is the value that actually moves. Scrubbing would be wrong here: the
# question "would THIS repo commit that path" is only answerable of the real repo.
SCRUB_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/lib/git-env-scrub.sh"
if [ -f "$SCRUB_LIB" ]; then
  # shellcheck source=scripts/lib/git-env-scrub.sh
  . "$SCRUB_LIB"
  git_bind_or_die || exit 2
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    REPO_TOP="$(git rev-parse --show-toplevel)"
    ABS_ARCHIVE="$(cd "$(dirname "$ARCHIVE_DIR")" 2>/dev/null && pwd)/$(basename "$ARCHIVE_DIR")"
    case "$ABS_ARCHIVE/" in
      "$REPO_TOP"/*)
        # Inside this repo: the target MUST be ignored. A path that does not exist yet is
        # still a valid check-ignore query, so this works before the first rotation.
        if ! git check-ignore -q "$ARCHIVE_DIR/probe.jsonl"; then
          echo "REFUSED: $ARCHIVE_DIR is inside this repository and is NOT gitignored." >&2
          echo "  Sealing there would stage an evidence corpus that carries absolute" >&2
          echo "  operator home paths, in a repo that publishes to a public mirror." >&2
          echo "  Add it to .gitignore, or pass --archive-dir outside the work tree." >&2
          exit 2
        fi
        ;;
      *) echo "archive location               : outside this work tree (ignore check N/A)" ;;
    esac
  fi
else
  echo "archive location               : git-env-scrub.sh absent; ignore check SKIPPED (named)"
fi

if [ "$MODE" = dry-run ]; then
  echo "rows after                     : $PRE_ROWS (unchanged -- this is a dry run)"
  echo "DRY RUN: would archive $PRE_ROWS row(s) then truncate the live log in place."
  echo "DRY RUN: wrote nothing."
  exit 0
fi

# ---------------------------------------------------------------- rotate
mkdir -p "$ARCHIVE_DIR"

if [ -e "$TARGET" ]; then
  echo "NO-OP: $TARGET already exists -- this exact corpus is already sealed."
  echo "rows after                     : $PRE_ROWS (unchanged)"
  exit 0
fi

cp "$LOG" "$TARGET"

# ---- verify the archive BEFORE destroying the source. Fail closed.
COPY_DIGEST="$(digest_of "$TARGET")"
COPY_ROWS="$(rows_of "$TARGET")"
if [ "$COPY_DIGEST" != "$PRE_DIGEST" ] || [ "$COPY_ROWS" != "$PRE_ROWS" ]; then
  echo "REFUSED: the archive does not match the source. NOTHING WAS TRUNCATED." >&2
  echo "  source sha256=$PRE_DIGEST rows=$PRE_ROWS" >&2
  echo "  copy   sha256=$COPY_DIGEST rows=$COPY_ROWS" >&2
  exit 2
fi

# ---- refuse to truncate rows that arrived after the copy was taken.
NOW_BYTES="$(bytes_of "$LOG")"
if [ "$NOW_BYTES" != "$PRE_BYTES" ]; then
  echo "REFUSED: the live log grew during the copy ($PRE_BYTES -> $NOW_BYTES bytes)." >&2
  echo "  Truncating now would destroy the rows written in that window." >&2
  echo "  The archive is kept and is valid; re-run to rotate the remainder." >&2
  exit 2
fi

# ---- truncate IN PLACE. Not `mv`, not `rm` -- the inode must survive (G16).
: > "$LOG"

# ---- END-STATE assertions (G12/CR-69): re-query, never assume the write happened.
POST_ROWS="$(rows_of "$LOG")"
POST_INODE="$(inode_of "$LOG")"

echo "rows after                     : $POST_ROWS"
echo "inode after                    : $POST_INODE"
echo "archived rows                  : $COPY_ROWS"
echo "archive sha256                 : $COPY_DIGEST"

fail=0
if [ "$POST_INODE" != "$PRE_INODE" ]; then
  echo "FAIL: the live log's inode CHANGED ($PRE_INODE -> $POST_INODE)." >&2
  echo "      The log was replaced rather than truncated in place. Any O_APPEND writer" >&2
  echo "      still holding the old inode is now writing into an orphaned file." >&2
  fail=1
fi
if [ "$POST_ROWS" -ne 0 ]; then
  echo "FAIL: the live log still holds $POST_ROWS row(s) after truncation." >&2
  fail=1
fi
if [ $((COPY_ROWS + POST_ROWS)) -ne "$PRE_ROWS" ]; then
  echo "FAIL: conservation broken -- archived $COPY_ROWS + live $POST_ROWS != $PRE_ROWS before." >&2
  fail=1
fi
[ "$fail" -eq 0 ] || { echo "ROTATION FAILED its own end-state assertions." >&2; exit 2; }

echo "OK: $COPY_ROWS row(s) sealed at $TARGET; live log truncated in place, inode preserved."
