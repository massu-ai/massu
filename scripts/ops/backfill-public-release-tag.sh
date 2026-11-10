#!/usr/bin/env bash
# Copyright (c) 2026 Massu. All rights reserved.
# Licensed under BSL 1.1 - see LICENSE file for details.
#
# Give a past release a TRUTHFUL tag in the public mirror when no mirror commit holds its tree.
#
# publish-public-mirror.sh tags a mirror commit vX.Y.Z only when that commit was synced from
# exactly the release commit. v2.4.0, v2.5.0, v2.5.1 and v2.5.2 were never synced at their
# release commit (the mirror received later trees), so no public commit contains exactly what
# those versions shipped. This script builds that commit:
#
#   1. refuses unless the private tag's commit IS what npm published (`npm view … gitHead`);
#   2. checks the release commit out into a temporary worktree, and places in it the hooks from
#      the tarball npm actually serves for that version (a rebuild from today's node_modules
#      would publish hooks the release never shipped);
#   3. syncs that tree into a temporary clone of the mirror with TODAY's sync-public.sh, via
#      MASSU_SYNC_SOURCE_TREE. The release-era copy of the script lacks later fixes that keep
#      internal paths out of the mirror, so it must never be the one that runs;
#   4. runs the mirror's own commit and push hooks (copied into the clone);
#   5. tags that commit vX.Y.Z and pushes ONLY the tag. The commit is reachable from the tag and
#      from nothing else: main is never touched, and branch pushes are disabled in the clone.
#
# An existing public tag is never moved (idempotent: reported, exit 0).
#
# Usage:
#   scripts/ops/backfill-public-release-tag.sh --list
#   scripts/ops/backfill-public-release-tag.sh --tag v2.5.2 --dry-run
#   scripts/ops/backfill-public-release-tag.sh --tag v2.5.2
#   [--public-dir <mirror checkout>]   default: ../massu next to this repository
set -euo pipefail

TOOLS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source-path=SCRIPTDIR/../lib source=git-env-scrub.sh
. "$TOOLS_ROOT/scripts/lib/git-env-scrub.sh" || { echo "FATAL: cannot source git-env-scrub.sh" >&2; exit 2; }
git_sandbox_isolate

PUBLIC_DIR="$(cd "$TOOLS_ROOT/.." && pwd)/massu"
TAG=""
DRY_RUN=false
LIST=false
while [ $# -gt 0 ]; do
  case "$1" in
    --tag)        TAG="${2:?--tag needs a value}"; shift 2 ;;
    --public-dir) PUBLIC_DIR="${2:?--public-dir needs a value}"; shift 2 ;;
    --dry-run)    DRY_RUN=true; shift ;;
    --list)       LIST=true; shift ;;
    -h|--help)    sed -n '5,30p' "$0"; exit 0 ;;
    *) echo "FATAL: unrecognised argument '$1'" >&2; exit 2 ;;
  esac
done

[ -d "$PUBLIC_DIR/.git" ] || { echo "FATAL: --public-dir '$PUBLIC_DIR' is not a git checkout" >&2; exit 2; }
REMOTE_URL="$(git -C "$PUBLIC_DIR" remote get-url origin)"
[ -n "$REMOTE_URL" ] || { echo "FATAL: $PUBLIC_DIR has no origin URL" >&2; exit 2; }
REMOTE_TAGS="$(git -C "$PUBLIC_DIR" ls-remote --tags "$REMOTE_URL")"
[ -n "$REMOTE_TAGS" ] || { echo "FATAL: read 0 tags from $REMOTE_URL — cannot judge (blind, not clean)" >&2; exit 2; }

public_tag_target() {  # peeled commit of a public tag, or empty
  local t="$1" v
  v="$(printf '%s\n' "$REMOTE_TAGS" | awk -v r="refs/tags/${t}^{}" '$2==r {print $1}')"
  [ -n "$v" ] || v="$(printf '%s\n' "$REMOTE_TAGS" | awk -v r="refs/tags/${t}" '$2==r {print $1}')"
  printf '%s' "$v"
}

if $LIST; then
  total=0; missing=0
  while IFS= read -r t; do
    total=$((total + 1))
    have="$(public_tag_target "$t")"
    if [ -n "$have" ]; then echo "  public   $t -> ${have:0:12}"; else echo "  MISSING  $t"; missing=$((missing + 1)); fi
  done < <(git -C "$TOOLS_ROOT" tag -l 'v[0-9]*.[0-9]*.[0-9]*' | LC_ALL=C sort -V)
  echo "  $total private release tag(s); $missing without a public tag"
  exit 0
fi

[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "FATAL: --tag must look like vX.Y.Z (got '$TAG')" >&2; exit 2; }
VERSION="${TAG#v}"
COMMIT="$(git -C "$TOOLS_ROOT" rev-parse --verify --quiet "${TAG}^{commit}")" \
  || { echo "FATAL: no private tag $TAG" >&2; exit 2; }

HAVE="$(public_tag_target "$TAG")"
if [ -n "$HAVE" ]; then
  echo "$TAG is already public at ${HAVE:0:12}. Never moved by this script; nothing to do."
  exit 0
fi

GITHEAD="$(npm view "@massu/core@${VERSION}" gitHead 2>/dev/null || true)"
if [ "$GITHEAD" != "$COMMIT" ]; then
  echo "FATAL: npm published $VERSION from '${GITHEAD:-unknown}', but private $TAG is $COMMIT." >&2
  echo "       Refusing to publish a tree npm did not ship." >&2
  exit 1
fi
echo "=== $TAG: private $COMMIT == npm gitHead ==="

WORK="$(mktemp -d "${TMPDIR:-/tmp}/massu-backfill-XXXXXX")"
case "$WORK" in */massu-backfill-??????) ;; *) echo "FATAL: unexpected scratch path '$WORK'" >&2; exit 2 ;; esac
cleanup() {
  git -C "$TOOLS_ROOT" worktree remove --force "${WORK:?}/src" >/dev/null 2>&1 || true
  rm -rf "${WORK:?}"
}
trap cleanup EXIT

# 2. the release tree, with the hooks npm actually serves for it
git -C "$TOOLS_ROOT" worktree add --quiet --detach "$WORK/src" "$COMMIT"
mkdir -p "$WORK/pkg"
( cd "$WORK/pkg" && npm pack "@massu/core@${VERSION}" >/dev/null 2>&1 && tar -xzf ./*.tgz )
HOOKS_N="$(find "$WORK/pkg/package/dist/hooks" -maxdepth 1 -name '*.js' 2>/dev/null | wc -l | tr -d ' ')"
[ "$HOOKS_N" -gt 0 ] || { echo "FATAL: the published $VERSION tarball has no dist/hooks" >&2; exit 1; }
mkdir -p "$WORK/src/packages/core/dist/hooks"
cp "$WORK/pkg/package/dist/hooks/"*.js "$WORK/src/packages/core/dist/hooks/"
echo "  release tree checked out; $HOOKS_N hook(s) taken from the published tarball"

# 3. the mirror commit to build on: the newest main commit synced from an ancestor of the release
PARENT=""
while IFS=' ' read -r sha subject; do
  src="$(printf '%s' "$subject" | sed -nE 's/^sync: Update from massu-internal \(([0-9a-f]{7,40})\)$/\1/p')"
  [ -n "$src" ] || continue
  full="$(git -C "$TOOLS_ROOT" rev-parse --verify --quiet "${src}^{commit}")" || continue
  if git -C "$TOOLS_ROOT" merge-base --is-ancestor "$full" "$COMMIT"; then PARENT="$sha"; break; fi
done < <(git -C "$PUBLIC_DIR" log --format='%H %s' origin/main)
[ -n "$PARENT" ] || { echo "FATAL: no mirror commit was synced from an ancestor of $TAG" >&2; exit 1; }
echo "  parent: mirror ${PARENT:0:12}"

# --template= : the clone must carry exactly the MIRROR's hooks (copied below), not whatever the
# machine's init.templateDir would install; the gate assertions after the sync then prove the
# mirror's own chain ran.
git clone --quiet --no-hardlinks --template= "$PUBLIC_DIR" "$WORK/pub"
git -C "$WORK/pub" checkout --quiet --detach "$PARENT"
git -C "$WORK/pub" checkout --quiet -b "release-tree/$TAG"
git -C "$WORK/pub" remote set-url origin "$REMOTE_URL"
git -C "$WORK/pub" remote set-url --push origin "branch-pushes-disabled-by-backfill-public-release-tag"
for k in user.name user.email; do
  v="$(git -C "$PUBLIC_DIR" config --get "$k" || true)"
  [ -n "$v" ] || { echo "FATAL: $PUBLIC_DIR has no $k; the mirror's identity gate needs it" >&2; exit 2; }
  git -C "$WORK/pub" config "$k" "$v"
done
mkdir -p "$WORK/pub/.git/hooks"
HOOKS_COPIED=0
for h in "$PUBLIC_DIR/.git/hooks/"*; do
  case "$h" in *.sample) continue ;; esac
  [ -f "$h" ] || continue
  cp -p "$h" "$WORK/pub/.git/hooks/"; HOOKS_COPIED=$((HOOKS_COPIED + 1))
done
[ "$HOOKS_COPIED" -gt 0 ] || { echo "FATAL: $PUBLIC_DIR carries no git hooks; refusing to commit without the mirror's leak guard" >&2; exit 2; }
echo "  mirror clone ready; $HOOKS_COPIED hook file(s) installed from $PUBLIC_DIR"

# 3-4. today's sync over the release tree, gated by the mirror's own hooks
MASSU_SYNC_SOURCE_TREE="$WORK/src" bash "$TOOLS_ROOT/scripts/sync-public.sh" "$WORK/pub" > "$WORK/sync.log" 2>&1 \
  || { echo "FATAL: sync-public refused the $TAG tree:" >&2; tail -30 "$WORK/sync.log" >&2; exit 1; }
SUBJECT="$(git -C "$WORK/pub" log -1 --format=%s)"
SYNCED="$(printf '%s' "$SUBJECT" | sed -nE 's/^sync: Update from massu-internal \(([0-9a-f]{7,40})\)$/\1/p')"
case "$COMMIT" in "${SYNCED:-none}"*) ;; *)
  echo "FATAL: synced commit is '$SUBJECT', which does not name the release commit $COMMIT" >&2; exit 1 ;;
esac
RELEASE_SHA="$(git -C "$WORK/pub" rev-parse HEAD)"
# M1: show which publication gates ran on this tree. A sync that printed none of them did not
# run them, and a commit made that way is not a release tree this script may tag.
GATES="$(grep -E 'private-content-scan: CLEAN|Home-path guard: no real home paths|Publication gate: CLEAN|managed-pre-commit: OK|payload-safety-check --staged' "$WORK/sync.log" || true)"
for want in 'private-content-scan: CLEAN' 'Home-path guard' 'managed-pre-commit: OK'; do
  printf '%s\n' "$GATES" | grep -q "$want" \
    || { echo "FATAL: the sync log shows no '$want' line; the gate did not run on this tree" >&2; exit 1; }
done
printf '%s\n' "$GATES" | sed 's/^/  gate: /' | cut -c1-140
echo "  release-tree commit ${RELEASE_SHA:0:12} ($(git -C "$WORK/pub" diff --shortstat "$PARENT" HEAD))"

MSG="$(git -C "$TOOLS_ROOT" tag -l --format='%(contents)' "$TAG")"
[ -n "$MSG" ] || MSG="$TAG"
NOTE="Release tree: massu-internal ${COMMIT} (the commit npm published ${VERSION} from), published through the current sync gates on $(TZ=America/Los_Angeles date '+%Y-%m-%d %Z'). This commit is not on main: ${VERSION} was never mirrored at its exact release commit."

if $DRY_RUN; then
  echo "(--dry-run: would tag ${RELEASE_SHA:0:12} as $TAG and push the tag. Nothing was pushed.)"
  exit 0
fi

# 5. the tag, and only the tag
git -C "$WORK/pub" tag -a "$TAG" -m "$MSG" -m "$NOTE" "$RELEASE_SHA"
git -C "$WORK/pub" push "$REMOTE_URL" "refs/tags/$TAG"
GOT="$(git -C "$WORK/pub" ls-remote "$REMOTE_URL" "refs/tags/${TAG}^{}" | awk '{print $1}')"
[ "$GOT" = "$RELEASE_SHA" ] || { echo "FATAL: pushed $TAG but the remote serves '${GOT:-nothing}', expected $RELEASE_SHA" >&2; exit 1; }
echo "  tagged   : $TAG -> ${RELEASE_SHA:0:12} (verified on the remote)"
