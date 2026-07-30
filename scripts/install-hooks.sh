#!/usr/bin/env bash
# install-hooks — wire git hooks for this clone.
#
# Called automatically by `npm install` via package.json's `postinstall`
# script. Idempotent: re-running is safe and overwrites the hook with
# the latest source-of-truth version.
#
# Why a post-install script: .git/hooks/ is NOT tracked in git (and
# CANNOT be without git's own opt-in via core.hooksPath). Without this
# auto-install, fresh clones have ZERO leak protection until someone
# manually runs install-hooks.sh — which is exactly the failure mode
# that allowed the 2026-04-28→05-06 docs/internal/ leak to ship.
#
# To bypass during local dev (you should not): touch
# .massu-skip-hook-install in the repo root before running npm install.
#
# History: created 2026-05-06 as part of the post-leak enterprise
# defense layering. See the project memory rule
# feedback_public_repo_leak_guard.md for the incident.

set -euo pipefail

# Resolve repo root (handles being called from any working directory,
# including npm's child cwd which is the package being installed).
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOKS_DIR="$REPO_ROOT/.git/hooks"
GUARD_SCRIPT="$REPO_ROOT/scripts/massu-public-leak-guard.sh"

# Skip if .git/ doesn't exist (e.g., this is an extracted tarball,
# not a git clone). The hook only runs in git contexts.
if [ ! -d "$REPO_ROOT/.git" ]; then
  echo "[install-hooks] no .git/ — not a git clone, skipping hook install" >&2
  # fail-open-approved: scope absence, not check failure. An extracted tarball has
  # no .git/, therefore no hooks to install and nothing that could be bypassed.
  # There is no gate here to fail closed ON.
  exit 0
fi

# Skip if user explicitly asked to skip.
if [ -e "$REPO_ROOT/.massu-skip-hook-install" ]; then
  echo "[install-hooks] .massu-skip-hook-install present, skipping" >&2
  exit 0
fi

# ---------------------------------------------------------------------------
# REPO CONTEXT — the public mirror, or the internal source repo?
#
# This installer lives in scripts/, which SYNCS to the public mirror. The same
# file therefore runs in BOTH repos and must not assume which one it is in. It
# did assume, until 2026-07-24: it wired massu-public-leak-guard.sh — whose own
# header reads "this is the PUBLIC repo" — into massu-internal, where the
# guard's DENIED_PATTERNS (^website/, ^docs/plans/, ^docs/incidents/, …) reject
# paths that are perfectly legal internally. Every commit touching them was
# blocked, including the plan and incident documents describing the breakage.
#
# FAIL-CLOSED DIRECTION, deliberately asymmetric:
#   misread public as internal → the PUBLIC repo runs with NO leak guard, which
#     is the precondition of the 2026-04-28 docs/internal/ leak;
#   misread internal as public → commits are blocked, loudly and reversibly.
# So PUBLIC is the default and INTERNAL requires positive proof.
#
# The internal markers are DERIVED, not remembered. Each is a file whose only
# purpose is to GENERATE the public repo, and each is named in the leak guard's
# own DENIED_PATTERNS — the guard itself asserts these cannot exist in public.
# ---------------------------------------------------------------------------
INTERNAL_MARKERS=(
  "package.public.json"
  "README.public.md"
  ".gitignore.public"
  ".claude/CLAUDE.public.md"
  "scripts/PUBLIC_MANIFEST.md"
)

# Validate the override before anything reads it, so a typo fails LOUD here
# rather than silently selecting the default and installing the wrong gate.
case "${MASSU_REPO_CONTEXT:-}" in
  ""|internal|public) : ;;
  *)
    echo "[install-hooks] FATAL: MASSU_REPO_CONTEXT='${MASSU_REPO_CONTEXT}' is neither 'internal' nor 'public'." >&2
    exit 1
    ;;
esac

detect_repo_context() {
  if [ -n "${MASSU_REPO_CONTEXT:-}" ]; then
    echo "[install-hooks] context OVERRIDDEN → $MASSU_REPO_CONTEXT (MASSU_REPO_CONTEXT set)" >&2
    printf '%s' "$MASSU_REPO_CONTEXT"
    return 0
  fi

  # 1. A remote naming the public mirror is DEFINITIVE. It outranks the marker
  #    scan so that a stray generator file in a public checkout cannot disarm
  #    the guard there — the dangerous direction.
  #
  #    Captured to a variable, NOT piped into `grep -q`: under `set -o pipefail`
  #    a `grep -q` that exits on first match SIGPIPEs the producer, so the
  #    pipeline can report failure on a successful match (incident 2026-07-16).
  #    Here that race would flip a repo from `public` to the marker scan — i.e.
  #    it could silently decide the PUBLIC mirror is not public.
  local remotes
  remotes="$(git -C "$REPO_ROOT" remote -v 2>/dev/null || true)"
  if grep -qE 'github\.com[:/]massu-ai/massu(\.git)?[[:space:]]' <<<"$remotes"; then
    printf 'public'
    return 0
  fi

  # 2. Positive proof of internal: a public-source generator file in the tree.
  local m
  for m in "${INTERNAL_MARKERS[@]}"; do
    if [ -e "$REPO_ROOT/$m" ]; then
      printf 'internal'
      return 0
    fi
  done

  # 3. Unknown — an external fork, a scratch clone, a tarball-turned-repo.
  #    Fail closed: treat as public and install the guard.
  printf 'public'
  return 0
}

REPO_CONTEXT="$(detect_repo_context)"
echo "[install-hooks] repo context: $REPO_CONTEXT ($REPO_ROOT)" >&2

# The leak guard is a PUBLIC-repo concern only. Its absence matters solely in
# the context that needs it — and it must never suppress the internal repo's
# release battery, which is a different gate guarding a different thing.
if [ "$REPO_CONTEXT" = "public" ] && [ ! -x "$GUARD_SCRIPT" ]; then
  echo "" >&2
  echo "[install-hooks] ⚠️  LEAK GUARD MISSING: $GUARD_SCRIPT" >&2
  echo "[install-hooks]     This checkout looks like the PUBLIC repo but carries no leak" >&2
  echo "[install-hooks]     guard, so NO pre-commit or pre-push protection is installed." >&2
  echo "" >&2
  # fail-open-approved: exiting non-zero here fails `npm install` itself, which
  # would refuse the install to every external contributor whose fork predates
  # the guard — training them to bypass, the precise trap P5-2 documents. So it
  # is LOUD rather than fatal. The boundary that matters is the sync gate, which
  # fails closed independently of whether any hook was ever installed.
  exit 0
fi

mkdir -p "$HOOKS_DIR"

AUTO_MARKER="Auto-installed by scripts/install-hooks.sh"

# Remove a hook THIS installer previously wrote that no longer applies in this
# context — otherwise re-running the installer cannot repair a mis-installed
# gate, and the stale hook keeps firing. Never touches an unmarked hook: the
# preserve_or_write rationale below applies with equal force to deletion.
remove_stale_auto_hook() {
  local name="$1"
  local why="$2"
  local target="$HOOKS_DIR/$name"
  # fail-open-approved: "no hook present" is the SUCCESS case for a remover —
  # there is nothing to remove and nothing to check.
  [ -e "$target" ] || return 0
  if grep -q "$AUTO_MARKER" "$target" 2>/dev/null; then
    rm -f "$target"
    echo "[install-hooks] REMOVED auto-installed $name — $why" >&2
  else
    echo "[install-hooks] ⚠️  KEPT hand-authored $name — $why, but this hook is not ours to remove." >&2
  fi
}

# ⛔ NEVER CLOBBER A HOOK THIS INSTALLER DID NOT AUTHOR.
#
# This function is load-bearing. A checkout may carry a hand-built hook that is
# STRONGER than what this installer writes — e.g. one that runs an authoritative
# fail-closed scanner in addition to the diff-scoped guard below. Overwriting it
# would silently DOWNGRADE the gate to the weaker one, and the downgrade would be
# invisible: the hook file still exists, still runs, still exits 0.
#
# A hook without our marker was written by a human for a reason we cannot see from
# here. Preserve it and say so LOUDLY. Fail loud, never fail silent — and never
# fail closed: a preserved stronger hook is not an error condition.
preserve_or_write() {
  # NOTE: two statements, deliberately. `local a="$1" b="$HOOKS_DIR/$a"` expands $a
  # BEFORE `local` binds it (bash expands all builtin args first), which under
  # `set -u` aborts the script — silently turning this guard into a no-op.
  local name="$1"
  local target="$HOOKS_DIR/$name"
  if [ -e "$target" ] && ! grep -q "$AUTO_MARKER" "$target" 2>/dev/null; then
    echo "" >&2
    echo "[install-hooks] ⚠️  PRESERVED existing $name — not written by this installer." >&2
    echo "[install-hooks]     $target" >&2
    echo "[install-hooks]     Refusing to overwrite a hook authored by hand: it may be a" >&2
    echo "[install-hooks]     STRONGER gate than the one this script installs. Review both" >&2
    echo "[install-hooks]     and compose them deliberately if you want this installer's" >&2
    echo "[install-hooks]     version too." >&2
    echo "" >&2
    return 1
  fi
  return 0
}

# pre-commit carries exactly one concern — the public path allowlist — so it is
# installed in the public context and REMOVED in the internal one. There is no
# internal pre-commit gate to compose with it: the internal repo's gating runs
# at pre-push via the 22-gate battery.
if [ "$REPO_CONTEXT" = "public" ]; then
if preserve_or_write pre-commit; then
cat > "$HOOKS_DIR/pre-commit" <<EOF
#!/usr/bin/env bash
# Auto-installed by scripts/install-hooks.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ).
# Context: public
# DO NOT EDIT this file directly — re-run scripts/install-hooks.sh after
# changes to scripts/massu-public-leak-guard.sh.
exec "\$(git rev-parse --show-toplevel)/scripts/massu-public-leak-guard.sh" "\$@"
EOF
chmod +x "$HOOKS_DIR/pre-commit"
fi
else
  remove_stale_auto_hook pre-commit \
    "massu-public-leak-guard.sh enforces the PUBLIC repo's path allowlist and rejects internal-only paths (website/, docs/plans/, docs/incidents/)"
fi

# Also install pre-push as a second-chance gate. pre-commit catches
# the moment of authoring; pre-push catches amend / rebase / cherry-pick
# scenarios that introduced new content without a fresh commit.
if preserve_or_write pre-push; then
cat > "$HOOKS_DIR/pre-push" <<EOF
#!/usr/bin/env bash
# Auto-installed by scripts/install-hooks.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ).
# Context: $REPO_CONTEXT
# Pre-push gate. Concerns are COMPOSED into one hook rather than left to
# overwrite one another; WHICH concerns apply depends on the context above.
set -euo pipefail
REPO_ROOT="\$(git rev-parse --show-toplevel)"
EOF

# --- First concern: the public leak guard — PUBLIC context ONLY ---
if [ "$REPO_CONTEXT" = "public" ]; then
cat >> "$HOOKS_DIR/pre-push" <<EOF
# Re-runs the leak guard against the diff between local HEAD and the remote,
# catching anything that slipped past pre-commit (amends, rebases,
# cherry-picks, --no-verify'd commits).
GUARD="\$REPO_ROOT/scripts/massu-public-leak-guard.sh"
if [ ! -x "\$GUARD" ]; then
  echo "" >&2
  echo "[pre-push] ⚠️  LEAK GUARD MISSING: \$GUARD" >&2
  echo "[pre-push]     This push was NOT scanned for private content." >&2
  echo "" >&2
  # fail-open-approved: refusing here would block every push from an external
  # fork whose checkout lacks the guard, and the documented workaround for that
  # is --no-verify — which trains contributors to bypass the gate permanently.
  # P5-2 makes this context-aware (fail CLOSED for maintainers, no-op notice for
  # contributors); until it lands the hook is LOUD rather than silent, which is
  # the part that was actually missing.
  exit 0
fi

# Inputs from git: each line is "<local_ref> <local_sha> <remote_ref> <remote_sha>"
while read local_ref local_sha remote_ref remote_sha; do
  [ "\$local_sha" = "0000000000000000000000000000000000000000" ] && continue  # branch delete
  if [ "\$remote_sha" = "0000000000000000000000000000000000000000" ]; then
    # New branch — diff against the merge-base with origin/main.
    base=\$(git merge-base "\$local_sha" origin/main 2>/dev/null || echo "")
    range="\${base}..\${local_sha}"
  else
    range="\${remote_sha}..\${local_sha}"
  fi

  # For each commit in the push, stage its diff into a temp index and
  # invoke the guard. We use --diff-filter=ACMR to match what the
  # pre-commit guard already filters.
  for sha in \$(git rev-list --reverse "\$range"); do
    files=\$(git diff-tree --no-commit-id --name-only --diff-filter=ACMR -r "\$sha")
    [ -z "\$files" ] && continue
    # Set up a temp index pointing at this commit so the guard's
    # "git diff --cached" sees the right thing.
    export GIT_INDEX_FILE="\$(mktemp)"
    git read-tree "\$sha"
    if ! "\$GUARD"; then
      rm -f "\$GIT_INDEX_FILE"
      unset GIT_INDEX_FILE
      echo "" >&2
      echo "  pre-push leak guard rejected commit \$sha" >&2
      echo "  Push aborted. Investigate the violations above." >&2
      exit 1
    fi
    rm -f "\$GIT_INDEX_FILE"
    unset GIT_INDEX_FILE
  done
done
EOF
else
cat >> "$HOOKS_DIR/pre-push" <<EOF
# --- Leak guard: DELIBERATELY NOT INSTALLED (context: internal) ---
# massu-public-leak-guard.sh enforces the PUBLIC repo's path allowlist. Its own
# header states "this is the PUBLIC repo", and its DENIED_PATTERNS reject
# ^website/, ^docs/plans/, ^docs/incidents/ and the *.public generator files —
# every one of which is legitimate, and internal-only, in this repo. Running it
# here blocks correct work and teaches --no-verify, which is how a real gate
# gets bypassed. The boundary this repo publishes ACROSS is enforced at the
# sync/publish step, not at every internal commit.
EOF
fi

cat >> "$HOOKS_DIR/pre-push" <<EOF

# --- Second concern: the release gate battery (CR-62) ---
# COMPOSED, not competing. Two gates that guard different things but share the hook
# name \`pre-push\` will silently overwrite each other — whichever installer runs last
# wins, and nothing reports that the other one is gone. So both concerns run from ONE
# installed hook, in this order deliberately: the leak guard is cheap and
# security-critical, the battery is slow and quality-critical, so a secret aborts the
# push before we spend minutes on gates.
BATTERY="\$REPO_ROOT/scripts/hooks/pre-push-release-battery.sh"
if [ -f "\$BATTERY" ]; then
  bash "\$BATTERY" || exit 1
else
  # Fail LOUD, not closed: a missing battery must not brick pushing, but silence here
  # is how the 2026-07-23 incident stayed invisible.
  echo "[pre-push] WARNING: \$BATTERY missing — pushed WITHOUT release gates." >&2
fi

exit 0
EOF
chmod +x "$HOOKS_DIR/pre-push"
fi

echo "[install-hooks] hook install complete at $HOOKS_DIR/ (preserved hooks, if any, reported above)" >&2
