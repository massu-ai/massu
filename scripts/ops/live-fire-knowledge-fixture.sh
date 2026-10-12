#!/usr/bin/env bash
# CR-72 live-fire: plant the defect in the REAL tree, run the REAL test, demand RED for its
# own declared reason, restore, prove byte-identical, prove it OPENS again.
#
# SUBJECT: the split between `knowledge-tools.test.ts` (30 handler tests, now against a
# COMMITTED FIXTURE corpus) and `knowledge-live-corpus.test.ts` (the live tree, asserted by
# COUNT rather than clock).
#
# ⛔ WHY THIS NEEDS ATTACKING. Moving a test off the live corpus makes it FASTER AND
# QUIETER, which is what a test that stopped asserting anything also looks like. The
# property under attack is therefore not "does it pass" but "CAN IT STILL FAIL" — the
# fixture must be load-bearing, not scenery.
#
# ⛔ NO `rm -rf` AND NO INTERPOLATED DELETE PATH (G17). Every removal names a literal
# variable holding a mktemp path, and the cleanup lives in a FUNCTION rather than inside a
# `trap '...'` string: this machine's payload-safety guard refuses a shell metacharacter
# beside a destructive token inside one literal, and it is right to (G25/CR-88). It blocked
# the first draft of this file at write time.
set -uo pipefail
# G29: never inherit a caller's git environment. Not hook-reachable; never reads the index.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
      GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" || exit 2

CLAUDE_MD="packages/core/src/__tests__/fixtures/knowledge-corpus/.claude/CLAUDE.md"
HANDLERS="src/__tests__/knowledge-tools.test.ts"
LIVE="src/__tests__/knowledge-live-corpus.test.ts"
[ -f "$CLAUDE_MD" ] || { echo "FATAL: $CLAUDE_MD not found" >&2; exit 2; }

BEFORE_SHA="$(shasum -a 256 "$CLAUDE_MD" | cut -d' ' -f1)"
BACKUP="$(mktemp)" || exit 2
cp "$CLAUDE_MD" "$BACKUP" || exit 2
# ⛔ RESTORE THE MTIME, NOT ONLY THE BYTES.
#
# "Restored byte-identical" is the usual CR-72 obligation and it is NOT sufficient here.
# The knowledge indexer decides whether to re-index by comparing corpus mtimes against
# `last_index_epoch` (`isKnowledgeStale`), so a file with identical content but a NEWER
# mtime still changes the system's behaviour — the next dispatch re-indexes, and it does so
# against the ambient cwd rather than the fixture.
#
# MEASURED 2026-09-20: with a plain `cp` restore this harness left the tree sha256-identical
# and the full suite then failed `massu_knowledge_effectiveness` while the same file passed
# 30/30 in isolation. `touch -r` puts the timestamps back too, so the harness leaves NO
# trace by any measure the system under test actually reads.
#
# The general form: a harness must restore every property its subject is sensitive to, and
# "the bytes" is only the property we usually remember.
restore_fixture() {
  cp "$BACKUP" "$CLAUDE_MD" 2>/dev/null
  touch -r "$BACKUP" "$CLAUDE_MD" 2>/dev/null
}
cleanup() {
  restore_fixture
  rm -f "$BACKUP"
}
trap cleanup EXIT INT TERM

PASS=0; FAIL=0
ok()  { printf '  ✓ %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  ✗ %s\n' "$1"; [ -n "${2:-}" ] && printf '%s\n' "$2" | sed 's/^/      /' | tail -8; FAIL=$((FAIL+1)); }
run_handlers() { OUT="$(cd packages/core && npx vitest run "$HANDLERS" 2>&1)"; RC=$?; }
run_live()     { OUT="$(cd packages/core && npx vitest run "$LIVE" 2>&1)"; RC=$?; }

echo "=== 0. BASELINE — both suites green (a brick gets disabled) ==="
run_handlers
if [ "$RC" -eq 0 ]; then ok "handler suite passes against the fixture"; else bad "handlers RED before any plant" "$OUT"; exit 1; fi
run_live
if [ "$RC" -eq 0 ]; then ok "live-corpus suite passes"; else bad "live suite RED before any plant" "$OUT"; exit 1; fi

echo "=== 1. PLANT: the fixture stops declaring CR-1 — the handler tests must NOTICE ==="
# If they do not, the fixture is scenery and the 30 assertions are measuring nothing.
perl -0pi -e 's{^\| CR-1 \|.*\n}{}m' "$CLAUDE_MD"
if grep -q '^| CR-1 |' "$CLAUDE_MD"; then echo "  PLANT FAILED: CR-1 row still present" >&2; exit 1; fi
run_handlers
if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -qF 'CR-1'; then
  ok "a missing CR-1 drives the handler suite RED, naming it"
else
  bad "the fixture is not load-bearing — CR-1 vanished and nothing failed (rc=$RC)" "$OUT"
fi
restore_fixture

echo "=== 2. PLANT: the fixture declares no VR-BUILD command ==="
perl -0pi -e 's{^\| VR-BUILD \|.*\n}{}m' "$CLAUDE_MD"
run_handlers
if [ "$RC" -ne 0 ]; then ok "a missing VR-BUILD drives the handler suite RED"
else bad "VR-BUILD vanished and nothing failed (rc=$RC)" "$OUT"; fi
restore_fixture

echo "=== 3. PLANT: the fixture corpus indexes NOTHING — a loud error, not a pass ==="
# The blind-gate case: an empty corpus makes all 30 assertions vacuous, and "0 found" is
# exactly what a broken indexer returns. The beforeAll guard must refuse to proceed.
#
# THE FIRST DRAFT OF THIS CHECK EMPTIED ONLY CLAUDE.md and then reported the GUARD as
# broken — the other five corpus files were still there, so the corpus was not empty and
# the guard was right not to fire. An attack must be able to tell its own bug from its
# subject's; emptying the corpus means emptying the CORPUS.
CORPUS_DIR="packages/core/src/__tests__/fixtures/knowledge-corpus"
CORPUS_BAK="$(mktemp -d)" || exit 2
cp -R "$CORPUS_DIR/." "$CORPUS_BAK/" || exit 2
restore_corpus() {
  cp -R "$CORPUS_BAK/." "$CORPUS_DIR/" 2>/dev/null
  # mtimes too — see the note on restore_fixture. `cp -R` sets them to NOW.
  while IFS= read -r f; do
    rel="${f#"$CORPUS_BAK"/}"
    touch -r "$f" "$CORPUS_DIR/$rel" 2>/dev/null
  done < <(/usr/bin/find "$CORPUS_BAK" -type f)
}
while IFS= read -r md; do
  : > "$md"
done < <(/usr/bin/find "$CORPUS_DIR" -type f -name '*.md')
REMAINING="$(/usr/bin/find "$CORPUS_DIR" -type f -name '*.md' -size +0 | wc -l | tr -d ' ')"
if [ "$REMAINING" != "0" ]; then
  echo "  PLANT FAILED: $REMAINING corpus file(s) still non-empty" >&2
  restore_corpus
  exit 1
fi
run_handlers
if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -qiE 'indexed nothing|refusing to run'; then
  ok "an empty corpus REFUSES, naming the denominator"
else
  bad "an empty corpus did not fail closed (rc=$RC)" "$OUT"
fi
restore_corpus
restore_fixture

echo "=== 4. RESTORE — byte-identical, and both suites OPEN again ==="
AFTER_SHA="$(shasum -a 256 "$CLAUDE_MD" | cut -d' ' -f1)"
if [ "$BEFORE_SHA" = "$AFTER_SHA" ]; then ok "fixture restored byte-identical"
else bad "RESTORE FAILED ($BEFORE_SHA -> $AFTER_SHA)"; fi
run_handlers
if [ "$RC" -eq 0 ]; then ok "handler suite OPENS"; else bad "handlers still RED after restore" "$OUT"; fi
run_live
if [ "$RC" -eq 0 ]; then ok "live-corpus suite OPENS"; else bad "live suite still RED" "$OUT"; fi

echo "----"
echo "live-fire: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
