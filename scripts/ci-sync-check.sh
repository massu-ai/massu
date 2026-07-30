#!/usr/bin/env bash
# Extracted from .github/workflows/sync-check.yml `sync-verify` job (P1-002,
# plan-2026-05-18-pre-push-ci-parity). Called from BOTH:
#   - .github/workflows/sync-check.yml job `sync-verify`
#   - scripts/pre-push-light.sh step [13/15] Sync Check (when triggered)
#
# NOT CI-ONLY — this script must run locally so devs catch sync drift before push.
#
# Pipeline mirrors the prior inline workflow steps:
#   1. Create ephemeral mirror dir via mktemp
#   2. git init + commit --allow-empty (sync-public.sh requires .git)
#   3. bash scripts/sync-public.sh <mirror>
#   4. npm ci + npm run build:adapters + npm test in mirror
#   5. Assertions: public-command count (derived), no website/, no private docs, no secrets,
#                  no sync-public.sh leak, hooks present
#   6. Cleanup via trap (covers Ctrl+C / SIGTERM)
#
# Safety contract (P1-002 iter-6 GAP-IT6-004):
#   - set -euo pipefail (fail fast on any error or unset var)
#   - mktemp -d (unique per invocation; safe under concurrency)
#   - trap cleanup EXIT INT TERM (mirror removed even on abnormal exit)
#   - NEVER cd to ~/massu or ~/massu-public — verified by:
#       grep -nE "(cd|rsync|cp).*~/massu(\b|/)" scripts/ci-sync-check.sh  # MUST return 0 lines

set -euo pipefail
IFS=$'\n\t'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIRROR_DIR="$(mktemp -d -t massu-sync-check-XXXXXXXX)"

cleanup() {
  rm -rf -- "$MIRROR_DIR"
}
trap cleanup EXIT INT TERM

echo "[ci-sync-check] mirror dir: $MIRROR_DIR"

# Step 1: git-init the mirror (sync-public.sh requires .git/).
git init --quiet "$MIRROR_DIR"
git -C "$MIRROR_DIR" config user.email "ci@massu.ai"
git -C "$MIRROR_DIR" config user.name "CI Bot"
git -C "$MIRROR_DIR" commit --quiet --allow-empty -m "init"

# Step 1b: give the ephemeral mirror the SAME pre-commit gate the real mirror runs.
#
# WHY. `git init` here inherits the global `init.templateDir` hook, so payload-safety runs —
# but the PUBLIC LEAK GUARD is installed only in ~/massu itself, so it did NOT. This check
# therefore exercised ONE of the two gates that can refuse a publication commit and reported
# exit 0 while the real `sync-public.sh "$HOME/massu"` exited 1.
#
# Measured 2026-07-29: the leak guard held 6 findings and had made the mirror UNSYNCABLE for
# ~5 days; this script was green throughout, and so was pre-push [14/22]. A gate that
# exercises a subset of the real gates reports the same green as one that exercises all of
# them — the blind-gate law, aimed at the sync proxy.
#
# FAIL LOUD if the real hook is missing: "the mirror has no gate" must never be indistinguish-
# able from "the gate passed" (M2).
REAL_MIRROR_HOOK="$HOME/massu/.git/hooks/pre-commit"
if [ -x "$REAL_MIRROR_HOOK" ]; then
  cp "$REAL_MIRROR_HOOK" "$MIRROR_DIR/.git/hooks/pre-commit"
  chmod +x "$MIRROR_DIR/.git/hooks/pre-commit"
  echo "[ci-sync-check] mirrored the real pre-commit gate from $REAL_MIRROR_HOOK"
else
  echo "[ci-sync-check] FAIL: no executable pre-commit gate at $REAL_MIRROR_HOOK." >&2
  echo "  The real mirror's publication gate could not be exercised, so a green result here" >&2
  echo "  would prove nothing about whether a sync can complete. Re-arm it with" >&2
  echo "  the payload-safety hook installer in the automations repo (--apply)" >&2
  exit 1
fi

# Step 2: run the sync.
bash "$REPO_ROOT/scripts/sync-public.sh" "$MIRROR_DIR"

# Step 3: install + build + test inside the mirror.
#
# THE SAME PRECONDITION GAP W-1 CLOSED IN THE ANTI-VACUITY JOB, FOUND HERE 2026-07-27.
# This step built ONLY the adapters, then ran the whole suite. Tests that assert against
# `dist/` therefore ran against artifacts that were never produced. That stayed invisible
# for exactly one reason: those tests SILENTLY SKIPPED when their sentinel was absent —
# `if (!existsSync(SENTINEL)) return;` reports PASSED having asserted nothing. G-1
# (plan-2026-07-26, commit 0b9bcf65) made them fail-closed across 75 sites / 28 files, and
# this step went red the same day. The gap did not appear then; it became VISIBLE then.
#
# So build every artifact the suite asserts against, and ASSERT THE END STATE rather than
# inferring it from `npm run` exit 0 (CR-69) — `npm run` can exit 0 having emitted nothing.
cd "$MIRROR_DIR"
npm ci
npm run build:adapters
( cd packages/core && npm run build:bundle-adapters )
( cd packages/core && npm run build:hooks && npm run build:cli )
( cd packages/core && npm run build:assets )

_sync_require() {  # $1 = path, $2 = remedy
  if [ ! -e "$1" ]; then
    echo "FATAL: [ci-sync-check] mirror build produced no '$1'." >&2
    echo "       The build command exited 0 without emitting it." >&2
    echo "       REMEDY: $2" >&2
    exit 2
  fi
}
_sync_require "packages/adapter-rails/dist/index.js"  "npm run build:adapters"
_sync_require "packages/adapter-spring/dist/index.js" "npm run build:adapters"
_sync_require "packages/core/dist/detect/adapters/.bundle-shasums.json" \
              "(cd packages/core && npm run build:bundle-adapters)"
_sync_require "packages/core/dist/cli.js"             "(cd packages/core && npm run build:cli)"
_sync_require "packages/core/dist/hooks/session-start.js" \
              "(cd packages/core && npm run build:hooks)"
echo "── [ci-sync-check] mirror artifacts present — running the suite against a BUILT tree ──"

npm test

# Step 4: assertions.
# Expected public-command count is DERIVED from the internal repo (count of
# .claude/commands/massu-*.md minus massu-internal-*, mirroring exactly what
# sync-public.sh copies at lines 201-204). Deriving — not hardcoding a magic
# number — keeps this gate from breaking every time a public command is added or
# removed (CR-46 / derive-from-filesystem). Was hardcoded `-ne 59`; silently
# drifted to 60 when v0.2 added massu-rule.md and failed Sync Check undetected
# until 2026-05-27.
COUNT=$(find "$MIRROR_DIR/.claude/commands" -maxdepth 1 -name 'massu-*.md' 2>/dev/null | wc -l | tr -d ' ')
EXPECTED=$(find "$REPO_ROOT/.claude/commands" -maxdepth 1 -name 'massu-*.md' 2>/dev/null | grep -cv '/massu-internal-')
echo "Command count: $COUNT (expected $EXPECTED, derived from internal public commands)"
if [ "$COUNT" -ne "$EXPECTED" ]; then
  echo "FAIL: Expected $EXPECTED public commands in mirror, got $COUNT"
  exit 1
fi

if [ -d "$MIRROR_DIR/website/" ]; then
  echo "FAIL: website/ directory found in mirror"
  exit 1
fi
echo "PASS: No website/ directory"

for dir in strategy security plans; do
  if [ -d "$MIRROR_DIR/docs/$dir/" ]; then
    echo "FAIL: docs/$dir/ found in mirror"
    exit 1
  fi
done
echo "PASS: No private docs"

# Secrets scan — covers ALL file types (not just .ts + .md). Limiting by
# --include= leaves leak vectors in .json, .yml, .sh, .mjs, .tsx, package-lock.json
# (MEDIUM security finding M2 2026-05-18). --exclude-dir=node_modules covers the
# vendor-tree skip; --binary-files=without-match avoids matching inside binaries.
# Stripe regex extended to include rk_test_/rk_live_ (restricted keys) and
# whsec_ (webhook secrets) (MEDIUM security finding M3 2026-05-18).
# Exclude this scanner script from its own scan — the literal project-ref
# appears in this file as the grep target, NOT a leaked secret. Wrap the
# grep in `{ ... || true; }` so a zero-match return code under `set -o
# pipefail` doesn't crash the script (the previous script-self-match
# kept grep at exit 0; structurally that was fragile).
SUPA=$({ grep -rn --exclude-dir=node_modules --exclude=ci-sync-check.sh \
       --binary-files=without-match \
       "ileqitpsfwbvrxripdmp" "$MIRROR_DIR" 2>/dev/null || true; } | wc -l | tr -d ' ')
if [ "$SUPA" -ne 0 ]; then
  echo "FAIL: Supabase project ref found"
  exit 1
fi
STRIPE=$({ grep -rnE --exclude-dir=node_modules --binary-files=without-match \
         "(^|[^A-Za-z0-9_])(sk|pk|rk)_(test|live)_[A-Za-z0-9]{20,}|(^|[^A-Za-z0-9_])whsec_[A-Za-z0-9]{20,}|(^|[^A-Za-z0-9_])price_1[A-Za-z0-9]{8,}" \
         "$MIRROR_DIR" 2>/dev/null || true; } | wc -l | tr -d ' ')
if [ "$STRIPE" -ne 0 ]; then
  echo "FAIL: Stripe key found"
  exit 1
fi
# Exclude scanner-self-reference files — the trade-secret literal appears
# in these as the grep target / documentation, NOT as actual trade secret
# content. Same structural fix-class as the SUPA scan above.
TRADE=$({ grep -rn --exclude-dir=node_modules \
        --exclude=massu-public-leak-guard.sh \
        --exclude=ci-sync-check.sh \
        --exclude=leak-patterns.sh \
        --binary-files=without-match \
        "trade.secret\|TRADE-SECRET" "$MIRROR_DIR" 2>/dev/null || true; } | wc -l | tr -d ' ')
if [ "$TRADE" -ne 0 ]; then
  echo "FAIL: Trade secret reference found"
  exit 1
fi
echo "PASS: No secrets found"

if [ -f "$MIRROR_DIR/scripts/sync-public.sh" ]; then
  echo "FAIL: sync-public.sh leaked to mirror"
  exit 1
fi
echo "PASS: No sync script"

HOOK_COUNT=$(find "$MIRROR_DIR/.claude/hooks" -maxdepth 1 -name '*.js' 2>/dev/null | wc -l | tr -d ' ')
echo "Hook count: $HOOK_COUNT"
if [ "$HOOK_COUNT" -lt 10 ]; then
  echo "FAIL: Expected >= 10 hooks, got $HOOK_COUNT"
  exit 1
fi
echo "PASS: Hooks present"

echo "[ci-sync-check] OK"
