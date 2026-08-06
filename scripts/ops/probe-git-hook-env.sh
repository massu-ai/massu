#!/usr/bin/env bash
# probe-git-hook-env.sh — WHICH GIT_* VARIABLES DOES GIT ACTUALLY HAND TO A HOOK?
#
# WHY THIS EXISTS. On 2026-08-04/05 this repo shipped, in ~20 files and to the public
# mirror, the sentence:
#
#     "GIT_DIR outranks cwd, and git EXPORTS GIT_DIR to every hook it runs."
#
# The first clause is true. The second is FALSE, and nobody had run a command to check it.
# It was an assertion about the behaviour of an external tool — CR-68: a constant about the
# outside world is a CLAIM, and the answer is to ship the measuring script, not the number.
# This is that script. Run it instead of trusting the sentence, on any git version.
#
# MEASURED 2026-08-05, git 2.50.1 (Apple Git-155), macOS:
#   pre-commit, commit-msg -> GIT_AUTHOR_DATE GIT_AUTHOR_EMAIL GIT_AUTHOR_NAME
#                             GIT_EDITOR GIT_EXEC_PATH GIT_INDEX_FILE GIT_PREFIX
#                             GIT_TEMPLATE_DIR
#   pre-push               -> GIT_EDITOR GIT_EXEC_PATH GIT_PREFIX GIT_TEMPLATE_DIR
#   GIT_DIR                -> ABSENT FROM ALL THREE
#
# WHY THAT MATTERS RATHER THAN BEING TRIVIA. GIT_INDEX_FILE *is* inherited by pre-commit,
# and it redirects THE INDEX on its own. A sandbox `git add` from a script running under a
# pre-commit hook therefore writes to the REAL index with no GIT_DIR involved. The hazard
# is real; the shipped comments named the wrong carrier for it. The corollary is a hard
# constraint: NEVER strip GIT_INDEX_FILE from a script that IS a commit hook — that
# disarms it, because such a script legitimately needs the inherited index to see the
# staged tree.
#
# BLIND-GATE POSTURE. v1 of this probe exported GIT_TEMPLATE_DIR="" at the top, so
# `git init` created NO .git/hooks directory, the hook files were never written, and it
# reported "no GIT_* variables" because NOTHING RAN — agreeing with the hypothesis for
# entirely the wrong reason. So this version creates the directory explicitly and ASSERTS
# each hook fired (M1) before any result is interpreted; zero hooks fired is exit 2.
#
# Usage: bash scripts/ops/probe-git-hook-env.sh
#   exit 0 = probed successfully (read the table)   exit 2 = could not measure
set -uo pipefail

# G29/CR-92 — neutralise the caller's git environment so the sandbox is really a sandbox.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
      GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX
export GIT_TEMPLATE_DIR=""

echo "git version: $(git --version)"
echo

T="$(mktemp -d)" || { echo "FATAL: mktemp failed" >&2; exit 2; }
trap 'rm -rf "$T"' EXIT INT TERM
R="$T/repo"

git init -q "$R" || { echo "FATAL: git init failed" >&2; exit 2; }
git -C "$R" config user.email probe@example.test
git -C "$R" config user.name probe
mkdir -p "$R/.git/hooks"          # REQUIRED: with an empty template, git creates none

OUT="$T/out.txt"; : > "$OUT"
FIRED="$T/fired.txt"; : > "$FIRED"

for h in pre-commit commit-msg pre-push; do
  {
    echo '#!/usr/bin/env bash'
    echo "echo \"$h\" >> \"$FIRED\""
    echo "env | grep -E '^GIT_' | LC_ALL=C sort | sed 's/^/  $h  /' >> \"$OUT\""
    echo 'exit 0'
  } > "$R/.git/hooks/$h"
  chmod +x "$R/.git/hooks/$h"
done

echo probe > "$R/f.txt"
git -C "$R" add -A
git -C "$R" commit -qm probe >/dev/null 2>&1

BARE="$T/bare.git"; git init -q --bare "$BARE"
git -C "$R" remote add origin "$BARE"
git -C "$R" push -q origin HEAD:refs/heads/main >/dev/null 2>&1

echo "=== M1 — DID THE HOOKS FIRE? (0 fired => this probe proves NOTHING) ==="
if [ ! -s "$FIRED" ]; then
  echo "  NONE FIRED. Refusing to report a result: 'no GIT_* variables' would be" >&2
  echo "  indistinguishable from 'the hooks were never installed'." >&2
  exit 2
fi
LC_ALL=C sort "$FIRED" | uniq -c | sed 's/^/  /'

echo
echo "=== GIT_* VARIABLES EACH HOOK RECEIVED ==="
if [ -s "$OUT" ]; then sed 's/=.*/=<value>/' "$OUT"; else
  echo "  (hooks fired and received ZERO GIT_* variables)"
fi

echo
echo "=== POSITIVE CONTROL — the capture CAN see GIT_* when one is present ==="
GIT_DIR=/nonexistent bash -c "env | grep -E '^GIT_' | sed 's/=.*/=<value>/' | sed 's/^/  /'"

echo
echo "=== VERDICT ==="
if grep -q '  GIT_DIR=' "$OUT" 2>/dev/null; then
  echo "  GIT_DIR IS present in hook environments on this git version."
else
  echo "  GIT_DIR is ABSENT from every hook environment on this git version."
  echo "  Any comment claiming git 'exports GIT_DIR to every hook' is WRONG here."
fi
