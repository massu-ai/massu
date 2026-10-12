#!/usr/bin/env bash
# CR-72 live-fire: plant the ORIGINAL defect in the REAL tree, run the REAL tests, demand
# RED for its own declared reason, restore, prove byte-identical, prove they OPEN again.
#
# SUBJECT: `parseCRTable` in packages/core/src/knowledge-indexer.ts.
#
# THE DEFECT, measured 2026-09-21. The parser used ONE `/g` regex requiring four
# pipe-delimited groups, and `[^|]+` matches NEWLINES — so against a THREE-column table the
# fourth group ran past the end of its row and swallowed the next one:
#
#     .claude/CLAUDE.md     rows declared: 41     rules extracted: 21
#                           ids: CR-1, CR-3, CR-5, CR-7, CR-9, CR-11, ...
#
# Half of this project's canonical rules had never been indexed, and every customer whose
# table is three-column lost the same half. Three columns is not an edge case: it is the
# shape this repo's own CLAUDE.md uses, and therefore the shape massu teaches.
#
# ⛔ WHY IT NEEDED A LIVE-FIRE. The loss is SILENT — fewer rules looks exactly like a
# smaller table. Nothing failed; a query just returned less. That is the blind-gate shape,
# so the only proof the fix is load-bearing is putting the old parser back and watching the
# suite go red.
#
# ⛔ NO `rm -rf`, NO INTERPOLATED DELETE PATH (G17); cleanup lives in a FUNCTION, not inside
# a `trap '...'` string, because this machine's payload-safety guard refuses a shell
# metacharacter beside a destructive token inside one literal (G25/CR-88).
set -uo pipefail
# G29: never inherit a caller's git environment. Not hook-reachable; never reads the index.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
      GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" || exit 2

TARGET="packages/core/src/knowledge-indexer.ts"
TESTS="src/__tests__/knowledge-indexer.test.ts"
[ -f "$TARGET" ] || { echo "FATAL: $TARGET not found" >&2; exit 2; }

BEFORE_SHA="$(shasum -a 256 "$TARGET" | cut -d' ' -f1)"
BACKUP="$(mktemp)" || exit 2
cp "$TARGET" "$BACKUP" || exit 2
restore_target() {
  cp "$BACKUP" "$TARGET" 2>/dev/null
}
cleanup() {
  restore_target
  rm -f "$BACKUP"
}
trap cleanup EXIT INT TERM

PASS=0; FAIL=0
ok()  { printf '  ✓ %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  ✗ %s\n' "$1"; [ -n "${2:-}" ] && printf '%s\n' "$2" | sed 's/^/      /' | tail -10; FAIL=$((FAIL+1)); }
run() { OUT="$(cd packages/core && npx vitest run "$TESTS" 2>&1)"; RC=$?; }

echo "=== 0. BASELINE — the parser tests pass (a brick gets disabled) ==="
run
if [ "$RC" -eq 0 ]; then ok "parser tests green"; else bad "RED before any plant" "$OUT"; exit 1; fi

echo "=== 1. MEASURE the real corpus through the CURRENT parser ==="
BEFORE_COUNT="$(node -e "
const {readFileSync}=require('fs');
const s=readFileSync('.claude/CLAUDE.md','utf8');
const declared=(s.match(/^\| CR-\d+ \|/gm)||[]).length;
process.stdout.write(String(declared));
")"
echo "      rows declared in .claude/CLAUDE.md: $BEFORE_COUNT"
if [ "$BEFORE_COUNT" -gt 0 ] 2>/dev/null; then ok "positive control: the corpus has a CR table"
else bad "no CR table found — the rest proves nothing"; exit 1; fi

echo "=== 2. PLANT: restore the cross-line regex that swallowed every other row ==="
python3 - "$TARGET" <<'PY'
import io, re, sys
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()
start = s.index('export function parseCRTable(content: string): CRRule[] {')
end = s.index('\n}', s.index('return rules;', start)) + 2
old = '''export function parseCRTable(content: string): CRRule[] {
  const rules: CRRule[] = [];
  const tableRegex = /\\|\\s*(CR-\\d+)\\s*\\|\\s*([^|]+)\\|\\s*([^|]+)\\|\\s*\\[?([^\\]|]+)\\]?[^|]*\\|/g;
  let match: RegExpExecArray | null;
  while ((match = tableRegex.exec(content)) !== null) {
    rules.push({
      rule_id: match[1].trim(),
      rule_text: match[2].trim(),
      vr_type: match[3].trim(),
      reference_path: match[4].trim().replace(/\\(.*\\)/, '').trim(),
    });
  }
  return rules;
}'''
io.open(p, 'w', encoding='utf-8').write(s[:start] + old + s[end:])
print('  planted: the original cross-line regex is back')
PY
[ $? -eq 0 ] || exit 1
run
if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -qE 'CR-1.*CR-3|every other|expected .* to (deeply )?equal'; then
  ok "the old parser drives the suite RED"
else
  bad "the old parser did NOT fail the suite — the tests are decoration (rc=$RC)" "$OUT"
fi

echo "=== 3. and the REAL corpus loses half its rules under the plant ==="
PLANTED_COUNT="$(cd packages/core && npx tsx -e "
import { parseCRTable } from './src/knowledge-indexer.ts';
import { readFileSync } from 'fs';
process.stdout.write(String(parseCRTable(readFileSync('../../.claude/CLAUDE.md','utf8')).length));
" 2>/dev/null || echo "?")"
if [ "$PLANTED_COUNT" != "?" ] && [ "$PLANTED_COUNT" -lt "$BEFORE_COUNT" ] 2>/dev/null; then
  ok "planted parser extracts $PLANTED_COUNT of $BEFORE_COUNT declared — the silent loss, reproduced"
else
  bad "could not reproduce the loss (got '$PLANTED_COUNT' of $BEFORE_COUNT)"
fi
restore_target

echo "=== 4. RESTORE — byte-identical, tests OPEN, corpus fully extracted ==="
AFTER_SHA="$(shasum -a 256 "$TARGET" | cut -d' ' -f1)"
if [ "$BEFORE_SHA" = "$AFTER_SHA" ]; then ok "restored byte-identical"
else bad "RESTORE FAILED ($BEFORE_SHA -> $AFTER_SHA)"; fi
run
if [ "$RC" -eq 0 ]; then ok "parser tests OPEN again"; else bad "still RED after restore" "$OUT"; fi
FIXED_COUNT="$(cd packages/core && npx tsx -e "
import { parseCRTable } from './src/knowledge-indexer.ts';
import { readFileSync } from 'fs';
process.stdout.write(String(parseCRTable(readFileSync('../../.claude/CLAUDE.md','utf8')).length));
" 2>/dev/null || echo "?")"
if [ "$FIXED_COUNT" = "$BEFORE_COUNT" ]; then ok "fixed parser extracts all $FIXED_COUNT declared rules"
else bad "fixed parser extracts $FIXED_COUNT of $BEFORE_COUNT"; fi

echo "----"
echo "live-fire: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
