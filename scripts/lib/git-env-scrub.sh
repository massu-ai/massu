#!/usr/bin/env bash
#
# git-env-scrub.sh — THE runtime chokepoint for git-environment scoping.
# G29/CR-92, P-1 of plans/2026-08-05-git-env-scoping-chokepoint-in-every-repo.md.
#
# ONE canonical content. A byte-identical copy lives at <repo>/scripts/lib/git-env-scrub.sh
# in every discovered repo, because this code must work where ~/.claude does not exist:
# CI on ubuntu-latest, a fresh clone, another machine, another person. A machine-level
# helper would be a MISSING DEPENDENCY in CI — and a missing dependency that substitutes
# to nothing is precisely the blind-gate failure this file exists to end.
#
# ---------------------------------------------------------------------------
# WHY THIS FILE EXISTS
# ---------------------------------------------------------------------------
# `cd` does not scope git. A caller's GIT_DIR outranks the working directory, `git -C`,
# AND Python's `cwd=`, so a script that believes it addresses a throwaway sandbox can
# address the REAL repository instead:
#
#   LOUD    init / add / commit        -> mass deletion staged, core.bare flipped
#   QUIET   log / ls-files / rev-parse -> confident answers about the WRONG repo
#   SILENT  config                     -> the repo's committer identity is rewritten
#
# 2026-08-04, a commit titled "base" authored by `t <t@t>` in a private repository on
# this machine (attribution kept out of this file DELIBERATELY — it is byte-identical
# across every repo including ones that publish to a public mirror, and a private repo
# name in a source comment is publishable content; the full account lives in the
# incident report, which does not publish):
#
#     5,543 files touched · 3 lines added · 1,388,627 lines DELETED
#
# `.husky/pre-push` invoked the harness, so an ordinary `git push` was sufficient to fire
# it. Nothing was lost, and that was luck rather than a control.
#
# THE READ HALF IS THE ONE YOU MISS. A sweep for init/add/commit finds writers only. A
# reader leak returns the WRONG ANSWER SILENTLY. Note which defence failed in the known
# cases: a guard HAD a "returned nothing -> Unreadable" check and it did not fire.
# A LEAK DOES NOT RETURN NOTHING, IT RETURNS PLENTY — FROM THE WRONG REPO. No non-empty
# check can detect the wrong corpus.
#
# ---------------------------------------------------------------------------
# ⛔ WHY THERE ARE TWO OPPOSITE PRIMITIVES AND NOT ONE SCRUB — MEASURED
# ---------------------------------------------------------------------------
# The obvious fix — scrub all seven variables everywhere — DISARMS pre-commit gates.
# Measured on git 2.50.1 (Apple Git-155), 2026-08-15, three invocation shapes:
#
#   1. Git does NOT export GIT_DIR to hooks. A plain `git commit` / `git push` exports
#      GIT_INDEX_FILE and GIT_PREFIX only. GIT_DIR reaches a hook ONLY when the CALLER
#      already had it set, or passed --git-dir/--work-tree (git turns those flags into
#      env for its subprocesses). So on the production hook path there is nothing to
#      scrub, and any GIT_DIR present came from a caller — which is precisely the leak.
#
#   2. GIT_INDEX_FILE *IS* exported and it is LOAD-BEARING. Git points it at a TEMPORARY
#      index for `git commit -a` and `git commit -- <path>`. The scrub does not narrow
#      the staged-file scan set, IT SWAPS IT FOR A DISJOINT ONE:
#
#        CASE: git commit -- tracked_a.txt
#          GIT_INDEX_FILE_env = .git/next-index-15375.lock
#          AS GIT GAVE IT     = [tracked_a.txt ]   <- the file being committed
#          AFTER 7-VAR SCRUB  = [tracked_b.txt ]   <- DISJOINT. Committed file NEVER scanned.
#
#        CASE: git commit -a
#          AS GIT GAVE IT     = [tracked_a.txt tracked_b.txt ]
#          AFTER 7-VAR SCRUB  = [tracked_b.txt ]   <- committed file dropped
#
#      A gate migrated with the scrub would scan a file the commit does not contain,
#      miss the one it does, and print its normal clean line. A disarmed gate and a
#      passing gate are observationally identical (G7 / the blind-gate law).
#
# THE PRESCRIBED REMEDIATION WAS THE DISARM. That is why the tier is a first-class
# decision and not a detail.
#
# ---------------------------------------------------------------------------
# WHICH PRIMITIVE DO I WANT?
# ---------------------------------------------------------------------------
#   Is this script reachable from .git/hooks (pre-commit, pre-push, husky, a
#   PreToolUse entry, or anything they call)?
#
#     YES -> git_bind_or_die        ASSERT the repo; scrub NOTHING.
#            Git's index binding is the hook contract. Removing it is the disarm
#            above. A leaked binding instead dies LOUDLY.
#
#     NO  -> git_sandbox_isolate    Full neutralisation, all seven.
#            A throwaway sandbox belongs to no repository and no index; absence
#            is the only safe value.
#
#   Operating on a REAL repository you NAME by path — not the one you are in,
#   and not a throwaway?
#     -> git_target_repo <path>     Neutralise, then ASSERT the named path is a
#        repository. Added 2026-08-15 because the vocabulary could not express
#        this, which left two files UNTIERABLE: neutralisation is REQUIRED (a
#        leaked GIT_DIR outranks their own `git -C <path>` and silently
#        redirects it), yet the do-not-scrub rule forbade exactly that for
#        anything reading a staged index. A closed vocabulary that cannot state
#        a true thing is a gate people eventually route around, so the term was
#        added rather than the two files exempted.
#
#   Creating a throwaway repo?
#     -> mk_git_sandbox             isolate + mktemp + init. Callers never write
#        `git init` themselves, so the unsafe form becomes UNEXPRESSIBLE rather
#        than merely detected (the G17 safe_project_paths.sh move).
#
#   A SOURCED library that must not mutate its caller's environment?
#     -> git_isolated <git-args...> (env -u form)
#
# The tier is NOT a judgement call and NOT an allowlist: a tracked script that invokes
# git without declaring one fails the build. An allowlist of hook-reachable scripts was
# offered to the operator and REJECTED — it is the hand-maintained N+1 list this whole
# exercise exists to remove (Rule 25 / G18).
#
# ---------------------------------------------------------------------------
# HOW TO USE IT (consumers MUST fail closed — blind-gate law M2)
# ---------------------------------------------------------------------------
#   ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
#   . "${ROOT}/lib/git-env-scrub.sh" || { echo "FATAL: git-env-scrub.sh" >&2; exit 2; }
#   git_bind_or_die            # or git_sandbox_isolate
#
# Source it with an explicit `|| exit`, NOT under bare `set -e`: a `.` of a missing file
# kills the shell before the `||` runs, so the guard never fires and the failure is
# misread as the gate's own output.

# shellcheck shell=bash

# ---------------------------------------------------------------------------
# THE LEAK SURFACE — ONE definition, split into TWO groups
# ---------------------------------------------------------------------------
# THE SPLIT IS THE CONTRACT. A flat seven-name list cannot express "scrub these but
# never that one", which is exactly the distinction between a working hook gate and a
# disarmed one. Nine files repeating seven names is nine chances to drift; a flat list
# is a tenth kind of drift that no equality check would catch.

# Bindings through which a caller's REPOSITORY captures a child git process.
# None of these is ever supplied by git itself on the hook path, so on that path there
# is nothing legitimate to preserve and anything present is the leak.
GIT_ENV_REPO_BINDINGS="GIT_DIR GIT_WORK_TREE GIT_OBJECT_DIRECTORY \
GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX"

# Deliberately SEPARATE. Git supplies this one on the pre-commit path and it is
# load-bearing; see the measurement above. Scrubbed by git_sandbox_isolate (a sandbox
# has no legitimate index binding) and NEVER by git_bind_or_die.
GIT_ENV_INDEX_BINDING="GIT_INDEX_FILE"

# Every variable, for the sandbox case.
GIT_ENV_ALL_BINDINGS="${GIT_ENV_REPO_BINDINGS} ${GIT_ENV_INDEX_BINDING}"

# ---------------------------------------------------------------------------
# TWO VARIABLES DELIBERATELY *NOT* IN EITHER LIST
# ---------------------------------------------------------------------------
# GIT_AUTHOR_DATE / GIT_COMMITTER_DATE set commit METADATA, not the target repository.
# Tests legitimately pin them to get deterministic commits. Stripping them would break
# working tests to fix a hazard they are not part of. Named here so nobody "completes"
# the list by adding them.

# ---------------------------------------------------------------------------
# THE THIRD VECTOR: A NEW SANDBOX IS NOT A PRISTINE SANDBOX
# ---------------------------------------------------------------------------
# `init.templateDir` pre-populates .git/hooks on EVERY `git init`, so a freshly created
# throwaway repo arrives carrying hooks even under a fully scrubbed environment.
# Elsewhere this produced a `22 passed / 4 failed` that read as a code bug for days.
#
# GIT_TEMPLATE_DIR (env) outranks the config, and THE NEUTRALISING VALUE IS THE EMPTY
# STRING, NOT UNSET — unsetting merely falls back to init.templateDir. That is the exact
# opposite of the rule for the bindings above (removed, never blanked), which is why it
# is a separate constant rather than another entry in a list.
#
# IT IS NOT PART OF THE GENERAL SCRUB, deliberately: at least one script depends on
# inheriting the template so its payload-safety gate runs in an ephemeral mirror, and a
# class-wide strip would DISARM a working control. Template neutralisation belongs at
# sandbox CREATION — mk_git_sandbox, where a pristine repo is the point — never in
# git_isolated, which is about addressing.
GIT_ENV_TEMPLATE_NEUTRALISE='GIT_TEMPLATE_DIR='

# ---------------------------------------------------------------------------
# _git_env_enclosing_gitdir <dir> — the INDEPENDENT authority
# ---------------------------------------------------------------------------
# Walks UP the filesystem for a `.git` entry and resolves it to the GIT DIRECTORY it
# denotes. It deliberately does NOT ask git, because git is the thing being validated:
# an expected value produced by the same mechanism you are checking cannot tell
# "correct" from "captured".
#
# Handles both shapes:
#   .git is a DIRECTORY -> an ordinary clone;   gitdir = <root>/.git
#   .git is a FILE      -> a linked worktree;   gitdir = the `gitdir:` target
# The worktree case matters: agents run with isolation:"worktree", and a guard that
# cannot tell a legitimate worktree from a leak is a brick — and a brick gets disabled.
_git_env_enclosing_gitdir() {
  local d target
  d="$(cd "${1}" 2>/dev/null && pwd -P)" || return 1
  while [ -n "${d}" ] && [ "${d}" != "/" ]; do
    if [ -d "${d}/.git" ]; then
      printf '%s\n' "${d}/.git"; return 0
    elif [ -f "${d}/.git" ]; then
      target="$(sed -n 's/^gitdir: *//p' "${d}/.git" | head -1)"
      [ -n "${target}" ] || return 1
      case "${target}" in
        /*) : ;;
        *)  target="${d}/${target}" ;;
      esac
      (cd "${target}" 2>/dev/null && pwd -P) && return 0
      return 1
    fi
    d="$(dirname "${d}")"
  done
  return 1
}

# ---------------------------------------------------------------------------
# git_bind_or_die [expected_root] — FOR HOOK-REACHABLE SCRIPTS
# ---------------------------------------------------------------------------
# Asserts that the repository git will actually operate on is the repository this script
# lives in. Scrubs NOTHING, so git's index binding — the hook contract — survives intact.
#
# Detection, not prevention, is the RIGHT shape here, and that is a deliberate choice
# rather than a weaker one: the only alternative that "prevents" is the scrub, and the
# scrub is the disarm. What this makes impossible is the thing that actually hurt — a
# gate silently reporting clean about the wrong repository.
#
# With no argument the expected root is derived from the CALLER's own file, so there is
# no hand-maintained expectation to drift, and a sandbox-copied script validates against
# the sandbox automatically.
git_bind_or_die() {
  local expected_root="${1-}" expected_gitdir actual_gitdir actual_top caller

  if [ -n "${expected_root}" ]; then
    if ! expected_gitdir="$(_git_env_enclosing_gitdir "${expected_root}")"; then
      echo "git-env: FATAL — ${expected_root} is not inside any git repository." >&2
      return 2
    fi
  else
    # BASH_SOURCE[1] is the file that called us — the script being protected.
    caller="${BASH_SOURCE[1]-}"
    if [ -z "${caller}" ]; then
      echo "git-env: FATAL — git_bind_or_die could not identify its caller;" >&2
      echo "git-env: pass the expected root explicitly." >&2
      return 2
    fi
    if ! expected_gitdir="$(_git_env_enclosing_gitdir "$(dirname "${caller}")")"; then
      echo "git-env: FATAL — ${caller} is not inside any git repository." >&2
      return 2
    fi
  fi

  # ⛔ COMPARE THE GIT DIRECTORY, NEVER THE TOPLEVEL. `git rev-parse --show-toplevel`
  # is BLIND to a leaked GIT_DIR — with GIT_DIR set and no GIT_WORK_TREE, git defaults
  # the work tree to the CWD, so --show-toplevel returns the directory you are standing
  # in and looks correct:
  #
  #   $ cd <repo> && GIT_DIR=/tmp/other/.git git rev-parse --show-toplevel
  #   <repo>                             <- reassuring, and WRONG
  #   $ cd <repo> && GIT_DIR=/tmp/other/.git git rev-parse --absolute-git-dir
  #   /tmp/other/.git                    <- the truth
  #
  # GIT_DIR ALONE is the DESTRUCTIVE shape: work tree and index disagree, so `git add -A`
  # stages a DELETION for every victim file — and it is precisely the value
  # --show-toplevel cannot see. Any "am I in a work tree?" check that merely tests
  # --show-toplevel for non-emptiness is blind to this.
  if ! actual_gitdir="$(git rev-parse --absolute-git-dir 2>/dev/null)" || [ -z "${actual_gitdir}" ]; then
    echo "git-env: FATAL — not inside a git work tree (git rev-parse failed)." >&2
    return 2
  fi

  expected_gitdir="$(cd "${expected_gitdir}" 2>/dev/null && pwd -P)" || return 2
  actual_gitdir="$(cd "${actual_gitdir}" 2>/dev/null && pwd -P)" || return 2

  # The work tree is reported too: GIT_WORK_TREE can redirect it independently.
  actual_top="$(git rev-parse --show-toplevel 2>/dev/null)"

  if [ "${expected_gitdir}" != "${actual_gitdir}" ]; then
    echo "git-env: FATAL — GIT ENVIRONMENT LEAK (G29/CR-92)." >&2
    echo "git-env:   this script belongs to git dir : ${expected_gitdir}" >&2
    echo "git-env:   git would operate on git dir   : ${actual_gitdir}" >&2
    echo "git-env:   (work tree resolves to ${actual_top:-<none>})" >&2
    echo "git-env:   GIT_DIR=${GIT_DIR-<unset>} GIT_WORK_TREE=${GIT_WORK_TREE-<unset>}" >&2
    echo "git-env: refusing to run. A gate that answers about the wrong repository" >&2
    echo "git-env: reports the same CLEAN as a healthy one — that is the whole bug." >&2
    return 2
  fi
  return 0
}

# ---------------------------------------------------------------------------
# git_sandbox_isolate — FOR EVERYTHING NOT REACHABLE FROM .git/hooks
# ---------------------------------------------------------------------------
# Removes every binding from the CURRENT shell, so this process and all its children
# belong to no repository. Unset, never override: pointing GIT_DIR at the sandbox would
# still leave a wrong answer reachable if a path were computed badly. Absence is the
# only safe value.
#
# Mutates the calling shell BY DESIGN — call it from a top-level script that owns its
# own process. A SOURCED library must use git_isolated instead, or it silently rewrites
# its caller's environment for everything after the source line.
git_sandbox_isolate() {
  # shellcheck disable=SC2086  # word-splitting the name list is intended
  unset ${GIT_ENV_ALL_BINDINGS}

  # M2 — fail closed. A scrub that did not scrub must never reach git. Without this, a
  # future edit that reorders or renames a variable degrades SILENTLY back to the
  # mass-deletion path, and a partial scrub reports safe while leaking.
  local leaked="" name
  for name in ${GIT_ENV_ALL_BINDINGS}; do
    if [ -n "${!name-}" ]; then leaked="${leaked} ${name}"; fi
  done
  if [ -n "${leaked}" ]; then
    echo "git-env: FATAL — scrub failed to remove:${leaked}" >&2
    echo "git-env: refusing to run git with a live repository binding attached." >&2
    return 2
  fi
  return 0
}

# ---------------------------------------------------------------------------
# git_isolated <git-args...> — non-mutating single call
# ---------------------------------------------------------------------------
# For SOURCED libraries. A bare `unset` in a sourced file mutates the caller's
# environment, which is a different bug in the same family: the library decides
# something about a process it does not own.
git_isolated() {
  local args=() name
  for name in ${GIT_ENV_ALL_BINDINGS}; do args+=(-u "${name}"); done
  command env "${args[@]}" git "$@"
}

# ---------------------------------------------------------------------------
# git_target_repo <path> — I operate on a repository I NAME, not the one I am in
# ---------------------------------------------------------------------------
# THE THIRD TIER, added 2026-08-15 because the vocabulary had two words for three
# situations and the missing one was UNSAYABLE.
#
# A script that manages some OTHER repository by path — `git -C "$CLAUDE_DIR" …`, a
# clone repairer, a proof harness that builds a victim repo — sits in a gap:
#
#   it MUST neutralise, because GIT_DIR outranks `-C`. A leaked binding silently
#   redirects every one of those calls to the leaking repository, with PLENTY of
#   output rather than none, so no non-empty check can see it; and
#
#   the do-not-scrub rule forbids neutralising for anything that reads a staged
#   index — correctly, because on the hook path GIT_INDEX_FILE is the contract.
#
# Both rules are right, and together they left two real files with NO LEGAL EDIT:
# declaring the honest primitive flipped them straight into the disarm list. An
# exemption per site would have "fixed" it while teaching the vocabulary nothing,
# so the term was added instead. The distinction it draws is the one that actually
# matters: WHOSE index is being read — the caller's (bind) or a repository the
# script names (neutralise, then assert).
#
# It ASSERTS rather than trusts, for the same reason git_bind_or_die does: a path
# that is not a repository must fail LOUDLY here, not produce a confusing git error
# five lines later, and never be silently created.
#
# --create-ok: the caller CREATES the target (an initialiser). Neutralisation still
# happens unconditionally — that is the part that must never be conditional — but a
# path that does not exist yet is accepted instead of refused. A path that EXISTS and
# is not a repository still fails: "I will create it" is not "anything goes". The flag
# exists so an initialiser never has to call `git_sandbox_isolate` directly, which
# would put a bare scrub back into a file that reads a staged index and re-open the
# very contradiction this tier was added to close.
git_target_repo() {
  local target="" gitdir create_ok=0

  while [ $# -gt 0 ]; do
    case "${1}" in
      --create-ok) create_ok=1; shift ;;
      -*) echo "git-env: FATAL — git_target_repo: unknown flag '${1}'" >&2; return 2 ;;
      *)  target="${1}"; shift ;;
    esac
  done

  # M2 — an empty argument is the G17 shape: `git -C "" …` silently means the CWD,
  # which is the caller's own repo, which is precisely what this primitive exists to
  # avoid addressing by accident.
  if [ -z "${target}" ]; then
    echo "git-env: FATAL — git_target_repo requires a path; got none." >&2
    echo "git-env: an empty target resolves to the CURRENT directory, which is the" >&2
    echo "git-env: repository this primitive exists to NOT touch." >&2
    return 2
  fi

  git_sandbox_isolate || return 2      # neutralise FIRST, so the assert below is honest

  if [ ! -d "${target}" ]; then
    # UNCONDITIONALLY neutralised above; only the ASSERTION is relaxed here.
    [ "${create_ok}" -eq 1 ] && return 0
    echo "git-env: FATAL — git_target_repo target is not a directory: ${target}" >&2
    echo "git-env: pass --create-ok if this script is the one that creates it." >&2
    return 2
  fi
  if ! gitdir="$(_git_env_enclosing_gitdir "${target}")"; then
    echo "git-env: FATAL — git_target_repo target is not inside a git repository:" >&2
    echo "git-env:   ${target}" >&2
    echo "git-env: refusing — a caller that names a repository must name one that exists." >&2
    return 2
  fi
  printf '%s\n' "${gitdir}"
}

# ---------------------------------------------------------------------------
# mk_git_sandbox [--keep-template] [name_hint] — the unsafe form, made unexpressible
# ---------------------------------------------------------------------------
# isolate -> mktemp -d -> git init -> print the path. Callers never write `git init`
# themselves, so the guard's predicate shrinks to something narrow and STABLE —
# "nothing outside the helper calls git init directly" — instead of an ever-growing
# list of dangerous spellings. That is the difference between a predicate that must
# keep chasing syntax and one that has a fixed job.
#
# ⛔ IT NEVER PRINTS AN EMPTY PATH. G17/CR-77: an empty path component widens a delete
# to its parent, and callers routinely `rm -rf "$(mk_git_sandbox)"`. Every failure path
# below returns non-zero WITHOUT printing, and the final value is re-validated before
# it is emitted. `set -u` does NOT protect against empty — the variable is SET, to "".
#
# --keep-template preserves init.templateDir inheritance for the one documented case
# where a caller genuinely depends on it (an ephemeral mirror that must run the real
# payload-safety hooks). Stating the exception here keeps it auditable instead of
# turning the default into "sometimes pristine".
mk_git_sandbox() {
  local keep_template=0 hint="git-sandbox" d
  while [ $# -gt 0 ]; do
    case "$1" in
      --keep-template) keep_template=1; shift ;;
      -*) echo "git-env: FATAL — mk_git_sandbox: unrecognised option: $1" >&2; return 2 ;;
      *)  hint="$1"; shift ;;
    esac
  done

  d="$(mktemp -d "${TMPDIR:-/tmp}/${hint}.XXXXXX" 2>/dev/null)" || d=""
  if [ -z "${d}" ] || [ ! -d "${d}" ]; then
    echo "git-env: FATAL — mk_git_sandbox could not create a temporary directory." >&2
    return 2
  fi

  if [ "${keep_template}" -eq 1 ]; then
    git_isolated -C "${d}" init -q . >/dev/null 2>&1 || {
      echo "git-env: FATAL — mk_git_sandbox: git init failed in ${d}" >&2; return 2; }
  else
    local args=() name
    for name in ${GIT_ENV_ALL_BINDINGS}; do args+=(-u "${name}"); done
    command env "${args[@]}" "${GIT_ENV_TEMPLATE_NEUTRALISE}" \
      git -C "${d}" init -q . >/dev/null 2>&1 || {
      echo "git-env: FATAL — mk_git_sandbox: git init failed in ${d}" >&2; return 2; }
  fi

  # Assert the END STATE rather than inferring it from exit 0 (CR-69).
  if [ ! -d "${d}/.git" ]; then
    echo "git-env: FATAL — mk_git_sandbox: ${d} is not a repository after init." >&2
    return 2
  fi
  # Re-validate before emitting: this is the value a caller will interpolate into rm -rf.
  [ -n "${d}" ] || { echo "git-env: FATAL — mk_git_sandbox: empty path." >&2; return 2; }
  printf '%s\n' "${d}"
  return 0
}

# ---------------------------------------------------------------------------
# SELF-TEST — runs only when EXECUTED, never when sourced.
# ---------------------------------------------------------------------------
# A self-test is not a caller (CR-71); the callers are each repo's own test suite and
# the machine-wide census live-fire.
#
# ⛔ G25/CR-88: no payload below combines a shell metacharacter with a destructive
# token. The observable payload is a marker FILE, and non-execution is proven by
# asserting the marker is ABSENT — never by a comment claiming something cannot run.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  fail=0
  say () { printf '%s %s\n' "$1" "$2"; }

  probe="$(mktemp -d "${TMPDIR:-/tmp}/ges-selftest.XXXXXX")" || exit 2
  # RESOLVE THE PROBE ROOT. On macOS /var is a symlink to /private/var and $TMPDIR ends
  # in a slash, so mktemp yields `/var/folders/...//x` while git reports the realpath
  # `/private/var/folders/.../x`. Comparing the two unresolved forms makes the positive
  # control fail on PATH SPELLING while the hazard reproduces perfectly — a dead control
  # that looks like a dead hazard, which would void a suite that is in fact healthy.
  probe="$(cd "${probe}" && pwd -P)" || exit 2
  victim="${probe}/victim"; work="${probe}/work"
  mkdir -p "${victim}" "${work}"
  ( cd "${victim}" && git_isolated init -q . ) || { say FATAL "could not build probe repo"; exit 2; }

  # 1. POSITIVE CONTROL FIRST, AND FATAL. If an unscrubbed git does NOT obey a poisoned
  #    GIT_DIR on this machine, the hazard is absent and every assertion below is
  #    vacuous. Never report a zero without a control that must return non-zero (G16).
  poisoned="$(cd "${work}" && GIT_DIR="${victim}/.git" git rev-parse --absolute-git-dir 2>/dev/null || true)"
  if [ "${poisoned}" = "${victim}/.git" ]; then
    say PASS "positive control: an unscrubbed git obeys the poisoned GIT_DIR"
  else
    say FATAL "positive control DEAD — unscrubbed git answered '${poisoned}', expected '${victim}/.git'."
    say FATAL "The hazard is not reproducing, so nothing below can be trusted. Results VOID."
    rm -rf "${probe}"; exit 2
  fi

  # 2. git_isolated ignores the poison, and does not mutate its caller.
  answer="$(cd "${work}" && GIT_DIR="${victim}/.git" git_isolated rev-parse --absolute-git-dir 2>&1 || true)"
  case "${answer}" in
    *"not a git repository"*) say PASS "git_isolated ignores a poisoned GIT_DIR" ;;
    *) say FAIL "git_isolated answered '${answer}' under a poisoned GIT_DIR"; fail=1 ;;
  esac
  GIT_DIR="${victim}/.git"
  git_isolated rev-parse --absolute-git-dir >/dev/null 2>&1 || true
  if [ "${GIT_DIR:-}" = "${victim}/.git" ]; then
    say PASS "git_isolated left the caller's GIT_DIR intact (env -u, not unset)"
  else
    say FAIL "git_isolated MUTATED the caller's environment"; fail=1
  fi
  unset GIT_DIR

  # 3. THE CONTRACT SPLIT. GIT_INDEX_FILE must be in ALL but NOT in REPO — if it drifts
  #    into the repo group, git_bind_or_die would start scrubbing it and every
  #    hook-reachable gate silently loses the file it is meant to scan.
  case " ${GIT_ENV_REPO_BINDINGS} " in
    *" GIT_INDEX_FILE "*) say FAIL "GIT_INDEX_FILE leaked into GIT_ENV_REPO_BINDINGS — bind_or_die would disarm hooks"; fail=1 ;;
    *) say PASS "GIT_INDEX_FILE is NOT in the repo-binding group" ;;
  esac
  case " ${GIT_ENV_ALL_BINDINGS} " in
    *" GIT_INDEX_FILE "*) say PASS "GIT_INDEX_FILE IS in the all-bindings group (sandboxes scrub it)" ;;
    *) say FAIL "GIT_INDEX_FILE missing from GIT_ENV_ALL_BINDINGS"; fail=1 ;;
  esac
  for forbidden in GIT_AUTHOR_DATE GIT_COMMITTER_DATE; do
    case " ${GIT_ENV_ALL_BINDINGS} " in
      *" ${forbidden} "*) say FAIL "${forbidden} must NOT be scrubbed — it is commit metadata"; fail=1 ;;
      *) say PASS "${forbidden} correctly absent from the scrub list" ;;
    esac
  done

  # 4. git_sandbox_isolate removes every binding from this shell.
  ( export GIT_DIR="${victim}/.git" GIT_WORK_TREE="${victim}" GIT_INDEX_FILE="${victim}/.git/index"
    export GIT_OBJECT_DIRECTORY="${victim}/.git/objects" GIT_COMMON_DIR="${victim}/.git"
    export GIT_ALTERNATE_OBJECT_DIRECTORIES="${victim}/.git/objects" GIT_PREFIX="x/"
    git_sandbox_isolate || exit 1
    for n in ${GIT_ENV_ALL_BINDINGS}; do [ -z "${!n-}" ] || exit 1; done ) \
    && say PASS "git_sandbox_isolate removed all $(set -- ${GIT_ENV_ALL_BINDINGS}; echo $#) bindings" \
    || { say FAIL "git_sandbox_isolate left a binding behind"; fail=1; }

  # 5. git_bind_or_die: accepts its own repo, REFUSES a leaked one, and — the property
  #    this whole file turns on — does NOT scrub GIT_INDEX_FILE while doing so.
  #
  #    ⛔ THE REFUSAL CASE MUST RUN FROM INSIDE A GENUINE REPOSITORY. The first draft
  #    ran it from `${work}`, which is not inside any repo, so git_bind_or_die refused
  #    at expected-root RESOLUTION and never reached the gitdir comparison at all. The
  #    assertion passed, and it was satisfied by a different line than the one it names
  #    — a plant that swapped the comparison left it GREEN. An `own` repo is required so
  #    the comparison is actually exercised.
  own="${probe}/own"
  mkdir -p "${own}"
  ( cd "${own}" && git_isolated init -q . ) || { say FATAL "could not build own repo"; exit 2; }

  if ( cd "${own}" && git_bind_or_die "${own}" ) >/dev/null 2>&1; then
    say PASS "git_bind_or_die accepts a genuine binding (it OPENS — a brick gets disabled)"
  else
    say FAIL "git_bind_or_die refused its own repository"; fail=1
  fi

  # NEGATIVE CONTROL for the refusal case specifically. Without it, "the guard refused"
  # and "the poison never applied" are indistinguishable, which is G7 aimed at my own
  # test. This must show git genuinely answering with the VICTIM from inside `own`.
  leak_answer="$(cd "${own}" && GIT_DIR="${victim}/.git" git rev-parse --absolute-git-dir 2>/dev/null || true)"
  if [ "${leak_answer}" = "${victim}/.git" ]; then
    say PASS "negative control: from inside own/, a leaked GIT_DIR really answers victim/"
  else
    say FATAL "negative control DEAD — leaked git answered '${leak_answer}'; refusal test would be vacuous"
    rm -rf "${probe}"; exit 2
  fi

  if ( cd "${own}" && GIT_DIR="${victim}/.git" git_bind_or_die "${own}" ) >/dev/null 2>&1; then
    say FAIL "git_bind_or_die PASSED under a leaked GIT_DIR — it is decoration"; fail=1
  else
    say PASS "git_bind_or_die refuses a leaked GIT_DIR"
  fi
  idx_after="$( cd "${victim}" && GIT_INDEX_FILE="/tmp/ges-sentinel-index" \
                bash -c '. "'"${BASH_SOURCE[0]}"'"; git_bind_or_die "'"${victim}"'" >/dev/null 2>&1; printf "%s" "${GIT_INDEX_FILE-<unset>}"' )"
  if [ "${idx_after}" = "/tmp/ges-sentinel-index" ]; then
    say PASS "git_bind_or_die preserved GIT_INDEX_FILE (the hook contract survives)"
  else
    say FAIL "git_bind_or_die altered GIT_INDEX_FILE to '${idx_after}' — THIS IS THE DISARM"; fail=1
  fi

  # 6. mk_git_sandbox: a real repo, a pristine one, and never an empty path.
  sb="$(mk_git_sandbox ges-probe)" || sb=""
  if [ -n "${sb}" ] && [ -d "${sb}/.git" ]; then
    say PASS "mk_git_sandbox produced a repository at a non-empty path"
    n_hooks=$(ls "${sb}/.git/hooks" 2>/dev/null | grep -vc '\.sample$' || true)
    if [ "${n_hooks:-0}" -eq 0 ]; then
      say PASS "mk_git_sandbox sandbox is PRISTINE (0 non-sample hooks)"
    else
      say FAIL "mk_git_sandbox sandbox inherited ${n_hooks} hook(s) from init.templateDir"; fail=1
    fi
    # Non-execution proven by an ABSENT marker, not by a comment (G25).
    marker="${sb}/ges-marker-must-not-exist"
    ( cd "${sb}" && git_isolated status --porcelain >/dev/null 2>&1 )
    if [ -e "${marker}" ]; then say FAIL "sandbox probe produced a side effect"; fail=1
    else say PASS "sandbox probe left no side effect (marker absent)"; fi
    rm -rf "${sb}"
  else
    say FAIL "mk_git_sandbox did not produce a usable sandbox"; fail=1
  fi
  if mk_git_sandbox --no-such-flag >/dev/null 2>&1; then
    say FAIL "mk_git_sandbox resolved an unrecognised flag instead of refusing (R-011)"; fail=1
  else
    say PASS "mk_git_sandbox refuses an unrecognised flag"
  fi

  # ── git_target_repo — the third tier ────────────────────────────────────────────────
  # Its whole purpose is that a NAMED repository survives a poisoned environment, so the
  # assertion is exactly that: point GIT_DIR at a decoy, ask about ${victim}, and require
  # the answer to be ${victim} rather than the decoy. Without the neutralisation this is
  # the one that would come back wrong, and it would come back wrong QUIETLY.
  decoy="${probe}/decoy"; mkdir -p "${decoy}"
  ( cd "${decoy}" && git_isolated init -q . ) >/dev/null 2>&1
  # ABSOLUTE path, resolved BEFORE the subshell cds away. `bash git-env-scrub.sh
  # --self-test` leaves BASH_SOURCE[0] relative, so passing it into a subshell that
  # `cd`s first made the source fail — and the check reported an empty answer, which
  # reads exactly like the primitive returning the wrong repo. A control that cannot
  # run must not be mistaken for a control that failed.
  self_abs="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/$(basename "${BASH_SOURCE[0]}")"
  answer="$( cd "${work}" && GIT_DIR="${decoy}/.git" bash -c '
      . "$1" || exit 3
      git_target_repo "$2" >/dev/null || exit 4
      git -C "$2" rev-parse --absolute-git-dir
    ' _ "${self_abs}" "${victim}" 2>/dev/null || true )"
  if [ "${answer}" = "${victim}/.git" ]; then
    say PASS "git_target_repo addresses the NAMED repo under a poisoned GIT_DIR"
  else
    say FAIL "git_target_repo answered '${answer}', expected '${victim}/.git'"; fail=1
  fi

  # An empty target is the G17 shape — `git -C "" …` silently means the CWD.
  if git_target_repo "" >/dev/null 2>&1; then
    say FAIL "git_target_repo accepted an EMPTY path (it would address the CWD)"; fail=1
  else
    say PASS "git_target_repo refuses an empty path"
  fi

  # A path that is not a repository must fail LOUDLY, never be created.
  notrepo="${probe}/not-a-repo"; mkdir -p "${notrepo}"
  if git_target_repo "${notrepo}" >/dev/null 2>&1; then
    say FAIL "git_target_repo accepted a non-repository path"; fail=1
  else
    say PASS "git_target_repo refuses a path that is not a repository"
  fi
  if [ -e "${notrepo}/.git" ]; then
    say FAIL "git_target_repo CREATED a repository at a path it was asked to verify"; fail=1
  else
    say PASS "git_target_repo created nothing at the rejected path"
  fi

  # --create-ok relaxes the EXISTENCE assertion only. Neutralisation is unconditional,
  # and a path that exists but is not a repository must STILL be refused — otherwise the
  # flag would mean "anything goes" rather than "I am the one who creates it".
  if git_target_repo --create-ok "${probe}/not-yet-created" >/dev/null 2>&1; then
    say PASS "git_target_repo --create-ok accepts a path that does not exist yet"
  else
    say FAIL "git_target_repo --create-ok rejected a not-yet-created path"; fail=1
  fi
  if git_target_repo --create-ok "${notrepo}" >/dev/null 2>&1; then
    say FAIL "--create-ok accepted an EXISTING non-repository (it means create, not anything)"; fail=1
  else
    say PASS "git_target_repo --create-ok still refuses an existing non-repository"
  fi
  if git_target_repo --no-such-flag "${victim}" >/dev/null 2>&1; then
    say FAIL "git_target_repo resolved an unrecognised flag instead of refusing (R-011)"; fail=1
  else
    say PASS "git_target_repo refuses an unrecognised flag"
  fi

  rm -rf "${probe}"
  if [ ${fail} -eq 0 ]; then echo "SELF-TEST: PASS"; exit 0; else echo "SELF-TEST: FAIL"; exit 1; fi
fi
