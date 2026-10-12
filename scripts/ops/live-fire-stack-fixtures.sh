#!/usr/bin/env bash
# CR-72 live-fire for P7.1: plant each defect in the REAL tree, run the REAL test, demand
# RED *for its own declared reason*, restore, prove the tree byte-identical, and prove the
# test still OPENS on a clean tree — a gate that only ever refuses gets disabled.
#
# SUBJECT: packages/core/src/__tests__/stack-fixtures.test.ts
#
# ⛔ NO `rm -rf` AND NO INTERPOLATED DELETE PATH ANYWHERE IN THIS FILE (G17). Every removal
# below names a LITERAL file and uses `rm -f` or `rmdir`, so "if every variable in this path
# were the empty string, what does it point at?" has no bad answer — there are no variables
# in it. This machine has lost ~83 GB to the alternative.
#
# ⛔ G25: every plant is `touch`-shaped — a file written with inert content. No plant puts a
# destructive token beside a shell metacharacter, in any language, anywhere.
set -uo pipefail
# G29: never inherit a caller's git environment. Not hook-reachable; never reads the index.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
      GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" || exit 2

# shellcheck source-path=SCRIPTDIR/../lib source=vitest-verdict.sh
. "$(pwd)/scripts/lib/vitest-verdict.sh"
TEST_REL="src/__tests__/stack-fixtures.test.ts"
VICTIM="packages/core/src/__tests__/fixtures/stacks/python-fastapi/app/main.py"
[ -f "packages/core/$TEST_REL" ] || { echo "FATAL: subject test not found" >&2; exit 2; }
[ -f "$VICTIM" ]                 || { echo "FATAL: $VICTIM not found" >&2; exit 2; }

# Literal plant paths. Named once, as constants, so the removals below can be literals too.
PLANT_TPL_DIR="packages/core/templates/zz-live-fire-stack"
PLANT_TPL_CFG="packages/core/templates/zz-live-fire-stack/massu.config.yaml"
PLANT_CFG="packages/core/src/__tests__/fixtures/stacks/python-fastapi/massu.config.yaml"
PLANT_GIT="packages/core/src/__tests__/fixtures/stacks/python-fastapi/.git"
PLANT_GIT_FILE="packages/core/src/__tests__/fixtures/stacks/python-fastapi/.git/HEAD"
for p in "$PLANT_TPL_DIR" "$PLANT_CFG" "$PLANT_GIT"; do
  [ -e "$p" ] && { echo "FATAL: $p already exists — refusing to clobber" >&2; exit 2; }
done

# RESTORE FROM THE BYTES WE SAW, NOT FROM GIT (CR-70 — never discard uncommitted work).
BEFORE_SHA="$(shasum -a 256 "$VICTIM" | cut -d' ' -f1)"
BACKUP="$(mktemp)" || exit 2
cp "$VICTIM" "$BACKUP" || { echo "FATAL: could not back up $VICTIM" >&2; exit 2; }

clean_plants() {
  rm -f -- packages/core/templates/zz-live-fire-stack/massu.config.yaml
  rmdir     packages/core/templates/zz-live-fire-stack 2>/dev/null
  rm -f -- packages/core/src/__tests__/fixtures/stacks/python-fastapi/massu.config.yaml
  rm -f -- packages/core/src/__tests__/fixtures/stacks/python-fastapi/.git/HEAD
  rmdir     packages/core/src/__tests__/fixtures/stacks/python-fastapi/.git 2>/dev/null
}
cleanup() { cp "$BACKUP" "$VICTIM" 2>/dev/null; rm -f "$BACKUP"; clean_plants; }
trap cleanup EXIT INT TERM

PASS=0; FAIL=0
# Through scripts/lib/vitest-verdict.sh: colour OFF, and OUT is the ANSI-STRIPPED text. The old
# form captured raw output and `check` matched the literal "Test Files  1 passed" against it —
# which CI's coloured summary can never contain, so this attacker's baseline and post-restore
# cases were both destined to fail there while passing on a laptop.
run() {
  local _log
  _log="$(mktemp -t stackfix-XXXXXX)" || return 2
  vv_run packages/core "$_log" "$TEST_REL"
  RC=$?
  OUT="$(vv_strip_ansi "$_log")"
  rm -f "$_log"
}
check() {  # check <label> <expected-rc> <must-contain>
  # A HERE-STRING, not `printf … | grep -qF`: under `pipefail` a body past the pipe buffer makes
  # printf take SIGPIPE when grep exits early, and the pipeline returns 141 — a size-dependent
  # false negative in the assertion itself.
  if [ "$RC" -eq "$2" ] && grep -qF -- "$3" <<<"$OUT"; then
    printf '  ✓ %s\n' "$1"; PASS=$((PASS+1))
  else
    printf '  ✗ %s\n      wanted rc=%s containing: %s\n      got rc=%s:\n' "$1" "$2" "$3" "$RC"
    printf '%s\n' "$OUT" | sed 's/^/        /' | tail -14
    FAIL=$((FAIL+1))
  fi
}

echo "=== 0. BASELINE — the test must OPEN on a clean tree (a brick gets disabled) ==="
run; check "clean tree passes" 0 "Test Files  1 passed"

echo "=== 1. PLANT: a 14th shipped stack with no fixture ==="
# THE property P7.1 exists for: a new stack is covered on its FIRST COMMIT, not when
# somebody remembers. Written with printf, not a heredoc, so this file contains no
# column-0 text that any discovery mechanism could mistake for a declaration.
mkdir -p "$PLANT_TPL_DIR"
{ printf 'framework:\n  type: elixir\n  primary: elixir\npaths:\n  source: lib\n'
  printf 'verification:\n  elixir:\n    test: mix test\n    type: mix dialyzer\n    lint: mix credo\n'
} > "$PLANT_TPL_CFG"
[ -s "$PLANT_TPL_CFG" ] || { echo "  PLANT FAILED: template config not written" >&2; exit 1; }
run; check "a stack with no fixture -> RED, naming it" 1 "zz-live-fire-stack"
clean_plants

echo "=== 2. PLANT: a fixture loses the file under its template's declared paths.source ==="
rm -f -- packages/core/src/__tests__/fixtures/stacks/python-fastapi/app/main.py
[ -f "$VICTIM" ] && { echo "  PLANT FAILED: victim still present" >&2; exit 1; }
run; check "empty declared source dir -> RED, naming paths.source" 1 "declared paths.source"
cp "$BACKUP" "$VICTIM"

echo "=== 3. PLANT: a fixture grows its own massu.config.yaml (a second copy of the template) ==="
printf 'framework:\n  type: python\n' > "$PLANT_CFG"
run; check "committed config in a fixture -> RED" 1 "second copy of the template"
clean_plants

echo "=== 4. PLANT: a fixture becomes a git repository (the removed hazard returns) ==="
mkdir -p "$PLANT_GIT"
printf 'ref: refs/heads/main\n' > "$PLANT_GIT_FILE"
run; check "a .git in a fixture -> RED" 1 "NOT a git repository"
clean_plants

echo "=== 5. PLANT: a G25-shaped payload in a fixture byte ==="
# A destructive token sharing a line with a shell metacharacter — the exact shape that
# executed `rm -rf ~` on this machine when a mutation harness disabled the property that
# made it inert. Assembled from fragments so this HARNESS never contains the shape itself.
{ cat "$BACKUP"; printf '# %s %s %s\n' 'echo ok ;' 'r''m' '-rf /tmp/x'; } > "$VICTIM"
grep -q 'rf /tmp/x' "$VICTIM" || { echo "  PLANT FAILED: payload not written" >&2; exit 1; }
run; check "destructive token + metacharacter -> RED" 1 "payload-safety violation"
cp "$BACKUP" "$VICTIM"

echo "=== 6. RESTORE — byte-identical, no plant survives, and the test OPENS again ==="
AFTER_SHA="$(shasum -a 256 "$VICTIM" | cut -d' ' -f1)"
if [ "$BEFORE_SHA" = "$AFTER_SHA" ]; then
  printf '  ✓ %s restored byte-identical (%s)\n' "$VICTIM" "$AFTER_SHA"; PASS=$((PASS+1))
else
  printf '  ✗ RESTORE FAILED: %s -> %s\n' "$BEFORE_SHA" "$AFTER_SHA"; FAIL=$((FAIL+1))
fi
for p in "$PLANT_TPL_DIR" "$PLANT_CFG" "$PLANT_GIT"; do
  [ -e "$p" ] && { printf '  ✗ plant survived: %s\n' "$p"; FAIL=$((FAIL+1)); }
done
run; check "post-restore: the test OPENS" 0 "Test Files  1 passed"

echo "----"
echo "live-fire: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
