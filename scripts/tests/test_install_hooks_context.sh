#!/usr/bin/env bash
# test_install_hooks_context — install-hooks.sh must know WHICH repo it is in.
#
# The defect this locks down (2026-07-24): scripts/install-hooks.sh ships in
# scripts/, which syncs to the public mirror, so the same file runs in both
# repos. It had no context detection and unconditionally wired
# massu-public-leak-guard.sh — a guard whose own header reads "this is the
# PUBLIC repo" — into massu-internal, where its DENIED_PATTERNS reject
# the website tree, the plan corpus and the incident corpus. Every internal commit touching
# those paths was blocked, including the plan and incident documents about the
# breakage itself.
#
# ANTI-VACUITY (P-C, proof by reintroduction). Case 5 does not simulate the
# defect or describe it — it checks out the REAL pre-fix installer from the
# pinned commit f9395b0b and runs it. If that installer stops exhibiting the
# defect, or cannot be retrieved, this test FAILS rather than skips: a
# reintroduction check that silently stops reintroducing proves nothing.
#
# Fail-closed direction under test (case 4): an unrecognised repo must be
# treated as PUBLIC. Misreading public as internal leaves the public repo with
# no leak guard, which is the precondition of the 2026-04-28 leak; misreading
# internal as public only blocks commits, loudly and reversibly.

set -uo pipefail

# --- G29/CR-92: NEUTRALISE THE CALLER'S GIT ENVIRONMENT — DO NOT REMOVE -------
# `cd` DOES NOT SCOPE GIT. GIT_DIR outranks cwd, and git EXPORTS GIT_DIR to every
# hook it runs — so a git write aimed at a temp sandbox silently addresses the REAL
# repository instead. 2026-08-04, a sibling repo on this machine: one such harness
# committed 5,543 files touched, 1,388,627 lines deleted, `core.bare` flipped true.
# Incident #166. Unset, never override: a sandbox belongs to no repository.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
      GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX
# -----------------------------------------------------------------------------


REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PREFIX_SHA="f9395b0b"   # last commit BEFORE context-awareness landed
GUARD_REF="massu-public-leak-guard.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0

ok()   { printf '  ok   %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  FAIL %s\n' "$1"; FAIL=$((FAIL + 1)); }
check() {  # check <description> <condition-as-exit-status>
  if [ "$2" -eq 0 ]; then ok "$1"; else bad "$1"; fi
}

# Build a scratch clone. $1=dir  $2=internal|public|unknown  $3=installer path
make_repo() {
  local dir="$1" kind="$2" installer="$3"
  mkdir -p "$dir/scripts"
  git -C "$dir" init -q 2>/dev/null || { mkdir -p "$dir"; git -C "$dir" init -q; }
  cp "$installer" "$dir/scripts/install-hooks.sh"
  chmod +x "$dir/scripts/install-hooks.sh"
  # The guard must be present and executable, or the public path short-circuits
  # before installing anything and every assertion below would pass vacuously.
  cp "$REPO_ROOT/scripts/$GUARD_REF" "$dir/scripts/$GUARD_REF"
  chmod +x "$dir/scripts/$GUARD_REF"

  case "$kind" in
    internal)
      # The markers are the *.public generator files — present only in the
      # repo that GENERATES the mirror, and named in the guard's own denylist.
      printf '{}\n'      > "$dir/package.public.json"
      printf '# public\n'> "$dir/README.public.md"
      # A SYNTHETIC remote, deliberately not the real internal URL. Detection
      # only requires "not the public mirror", so naming the real private repo
      # here would buy nothing and publish it: this file syncs to the public
      # mirror, and the publication gate rejected exactly that on 2026-07-24.
      git -C "$dir" remote add origin \
        "https://github.com/example-org/example-internal.git"
      ;;
    public)
      git -C "$dir" remote add origin "https://github.com/massu-ai/massu.git"
      ;;
    unknown)
      # An external fork or a scratch clone: no markers, no upstream remote.
      git -C "$dir" remote add origin "https://github.com/someone/massu.git"
      ;;
  esac
}

# Simulate the CURRENT broken machine state: a previously auto-installed
# leak-guard pre-commit already sitting in .git/hooks/.
plant_auto_hook() {
  local dir="$1"
  mkdir -p "$dir/.git/hooks"
  cat > "$dir/.git/hooks/pre-commit" <<'STALE'
#!/usr/bin/env bash
# Auto-installed by scripts/install-hooks.sh on 2026-07-24T18:54:17Z.
exec "$(git rev-parse --show-toplevel)/scripts/massu-public-leak-guard.sh" "$@"
STALE
  chmod +x "$dir/.git/hooks/pre-commit"
}

echo "=============================================================="
echo "  install-hooks.sh repo-context detection"
echo "=============================================================="

# ---------------------------------------------------------------------------
echo
echo "[1] INTERNAL context — public leak guard must NOT be wired"
D="$WORK/internal"
make_repo "$D" internal "$REPO_ROOT/scripts/install-hooks.sh"
plant_auto_hook "$D"
OUT="$(bash "$D/scripts/install-hooks.sh" 2>&1)"; RC=$?

check "installer exits 0 (rc=$RC)" "$([ "$RC" -eq 0 ]; echo $?)"
# LIVENESS: a named line on stderr. Without this, every assertion below is
# also satisfied by an installer that died before doing anything.
grep -q 'repo context: internal' <<<"$OUT"
check "emits liveness line 'repo context: internal'" $?
grep -q 'REMOVED auto-installed pre-commit' <<<"$OUT"
check "reports removing the stale auto-installed pre-commit" $?
[ ! -e "$D/.git/hooks/pre-commit" ]
check "stale pre-commit is actually gone from disk" $?
[ -e "$D/.git/hooks/pre-push" ]
check "pre-push IS installed (internal still gets its battery)" $?
# Comment-stripped: the internal hook DOCUMENTS why the guard is absent, and
# naming it in prose is not invoking it. Assert on executable lines only, so
# this checks what it claims to check rather than merely what it mentions.
# Captured to a here-string rather than piped: `grep -q` exits on first match
# and SIGPIPEs the upstream grep, which can yield a false verdict
# (incident 2026-07-16, gate-script-grep-q-pipeline-drift-guard).
EXEC_LINES="$(grep -v '^[[:space:]]*#' "$D/.git/hooks/pre-push")"
! grep -q "$GUARD_REF" <<<"$EXEC_LINES"
check "pre-push does NOT invoke the public leak guard (executable lines)" $?
grep -q "$GUARD_REF" "$D/.git/hooks/pre-push" 2>/dev/null
check "pre-push DOES document why the guard is absent" $?
# INVOKED, not merely mentioned. Grepping the filename alone also matches the
# BATTERY= assignment, so a hook that defines the battery and never runs it
# would pass — a silently disarmed gate reported as green.
grep -qE '^[[:space:]]*bash "\$BATTERY"' "$D/.git/hooks/pre-push" 2>/dev/null
check "pre-push actually INVOKES the release battery (not just assigns it)" $?
grep -qE '^exit 0' "$D/.git/hooks/pre-push" 2>/dev/null
check "pre-push body is complete (terminating 'exit 0' present)" $?
# A generated security hook must be generated CLEANLY. The backtick bug at
# install-hooks.sh:270 command-substituted `pre-push` out of a comment and
# emitted 'command not found' — noise that hid nothing this time, but the
# same expansion in a heredoc is how arbitrary output reaches a hook body.
! grep -qiE 'command not found|unbound variable|syntax error' <<<"$OUT"
check "installer emits no shell errors while generating the hook" $?

# ---------------------------------------------------------------------------
echo
echo "[2] PUBLIC context — leak guard must still be wired (no regression)"
D="$WORK/public"
make_repo "$D" public "$REPO_ROOT/scripts/install-hooks.sh"
OUT="$(bash "$D/scripts/install-hooks.sh" 2>&1)"; RC=$?

check "installer exits 0 (rc=$RC)" "$([ "$RC" -eq 0 ]; echo $?)"
grep -q 'repo context: public' <<<"$OUT"
check "emits liveness line 'repo context: public'" $?
grep -q "$GUARD_REF" "$D/.git/hooks/pre-commit" 2>/dev/null
check "pre-commit invokes the leak guard" $?
grep -q "$GUARD_REF" "$D/.git/hooks/pre-push" 2>/dev/null
check "pre-push invokes the leak guard" $?
grep -qE '^[[:space:]]*bash "\$BATTERY"' "$D/.git/hooks/pre-push" 2>/dev/null
check "pre-push also INVOKES the release battery (composed, not competing)" $?
grep -qE '^exit 0' "$D/.git/hooks/pre-push" 2>/dev/null
check "pre-push body is complete (terminating 'exit 0' present)" $?
! grep -qiE 'command not found|unbound variable|syntax error' <<<"$OUT"
check "installer emits no shell errors while generating the hook" $?

# ---------------------------------------------------------------------------
echo
echo "[3] PUBLIC remote OUTRANKS a stray marker file"
# A generator file loose in a public checkout must not disarm the guard there
# — that is the dangerous direction.
D="$WORK/public-with-marker"
make_repo "$D" public "$REPO_ROOT/scripts/install-hooks.sh"
printf '{}\n' > "$D/package.public.json"
OUT="$(bash "$D/scripts/install-hooks.sh" 2>&1)"
grep -q 'repo context: public' <<<"$OUT"
check "still detected as public despite package.public.json present" $?
grep -q "$GUARD_REF" "$D/.git/hooks/pre-commit" 2>/dev/null
check "guard still installed" $?

# ---------------------------------------------------------------------------
echo
echo "[4] UNKNOWN repo — must fail CLOSED to public"
D="$WORK/unknown"
make_repo "$D" unknown "$REPO_ROOT/scripts/install-hooks.sh"
OUT="$(bash "$D/scripts/install-hooks.sh" 2>&1)"
grep -q 'repo context: public' <<<"$OUT"
check "unrecognised repo treated as public" $?
grep -q "$GUARD_REF" "$D/.git/hooks/pre-commit" 2>/dev/null
check "guard installed in the unknown repo" $?

# ---------------------------------------------------------------------------
echo
echo "[5] ANTI-VACUITY — the real pre-fix installer must still show the defect"
OLD="$WORK/old-install-hooks.sh"
if ! git -C "$REPO_ROOT" show "$PREFIX_SHA:scripts/install-hooks.sh" > "$OLD" 2>/dev/null; then
  bad "could not retrieve $PREFIX_SHA:scripts/install-hooks.sh — cannot prove this test has teeth"
elif [ ! -s "$OLD" ]; then
  bad "$PREFIX_SHA:scripts/install-hooks.sh retrieved but EMPTY"
else
  D="$WORK/internal-old"
  make_repo "$D" internal "$OLD"
  bash "$D/scripts/install-hooks.sh" >/dev/null 2>&1
  # The pre-fix installer wired the PUBLIC guard into an INTERNAL repo. If this
  # assertion ever stops holding, case 1 above is no longer proving anything.
  grep -q "$GUARD_REF" "$D/.git/hooks/pre-commit" 2>/dev/null
  check "pre-fix installer DOES wire the guard into an internal repo (defect reproduced)" $?

  # And prove the consequence, not just the wiring: that guard rejects a path
  # this repo is entitled to commit.
  mkdir -p "$D/website"
  printf 'placeholder fixture content\n' > "$D/website/CHANGELOG.md"
  git -C "$D" add -A >/dev/null 2>&1
  if (cd "$D" && bash "./scripts/$GUARD_REF" >/dev/null 2>&1); then
    bad "guard ACCEPTED website/ — the reproduction is no longer meaningful"
  else
    ok "that guard rejects website/CHANGELOG.md — the blocked-commit consequence"
  fi
fi

# ---------------------------------------------------------------------------
echo
echo "[6] SELF-PROVING MUTATION — break the CURRENT installer, demand RED"
# Case 5 proves the historical defect still reproduces. This proves THIS test
# can fail against THIS implementation: without it, the suite could go green
# on an installer whose context branch had been silently removed, and the
# G-6 registry entry claiming `recipe: self-proving` would be a lie.
MUT="$WORK/mutated-install-hooks.sh"
sed 's/\[ "\$REPO_CONTEXT" = "public" \]; then/true; then/g' \
  "$REPO_ROOT/scripts/install-hooks.sh" > "$MUT"

if cmp -s "$MUT" "$REPO_ROOT/scripts/install-hooks.sh"; then
  # PLANT step failed: the mutation changed nothing, so a RED result below
  # would prove nothing. Conflating "bogus fixture" with "blind check" is the
  # entire bug class the registry's ORACLE step exists to separate.
  bad "mutation changed nothing — the context branch pattern no longer matches"
else
  ok "mutation applied (context branch forced to always-public)"
  D="$WORK/internal-mutated"
  make_repo "$D" internal "$MUT"
  plant_auto_hook "$D"
  bash "$D/scripts/install-hooks.sh" >/dev/null 2>&1

  # ORACLE: independent of this test's assertions — is the public guard wired
  # into a repo that is unambiguously internal?
  if grep -q "$GUARD_REF" "$D/.git/hooks/pre-commit" 2>/dev/null; then
    ok "ORACLE: mutated installer wires the public guard into an internal repo"
  else
    bad "ORACLE: mutation did not reproduce the defect — case 1 proves nothing"
  fi

  # DEFEAT: case 1's own criteria must now FAIL. Asserted explicitly rather
  # than assumed, so a criterion that silently stopped discriminating shows up
  # here as a failure instead of as silence.
  if [ -e "$D/.git/hooks/pre-commit" ]; then
    ok "DEFEAT: case 1's 'stale pre-commit is gone' assertion goes RED under mutation"
  else
    bad "DEFEAT: pre-commit still absent — case 1's assertion cannot discriminate"
  fi
fi

# ---------------------------------------------------------------------------
echo
echo "=============================================================="
printf '  passed: %d   failed: %d\n' "$PASS" "$FAIL"
echo "=============================================================="
[ "$FAIL" -eq 0 ]
