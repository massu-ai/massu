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
#   5. Assertions: 59 commands, no website/, no private docs, no secrets,
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

# Step 2: run the sync.
bash "$REPO_ROOT/scripts/sync-public.sh" "$MIRROR_DIR"

# Step 3: install + build + test inside the mirror.
cd "$MIRROR_DIR"
npm ci
npm run build:adapters
npm test

# Step 4: assertions.
COUNT=$(ls "$MIRROR_DIR/.claude/commands/massu-"*.md 2>/dev/null | wc -l | tr -d ' ')
echo "Command count: $COUNT"
if [ "$COUNT" -ne 59 ]; then
  echo "FAIL: Expected 59 commands, got $COUNT"
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
SUPA=$(grep -rn --exclude-dir=node_modules --binary-files=without-match \
       "ileqitpsfwbvrxripdmp" "$MIRROR_DIR" 2>/dev/null | wc -l | tr -d ' ')
if [ "$SUPA" -ne 0 ]; then
  echo "FAIL: Supabase project ref found"
  exit 1
fi
STRIPE=$(grep -rnE --exclude-dir=node_modules --binary-files=without-match \
         "sk_(test|live)_[A-Za-z0-9]{20,}|pk_(test|live)_[A-Za-z0-9]{20,}|rk_(test|live)_[A-Za-z0-9]{20,}|whsec_[A-Za-z0-9]{20,}|price_1[A-Za-z0-9]{8,}" \
         "$MIRROR_DIR" 2>/dev/null | wc -l | tr -d ' ')
if [ "$STRIPE" -ne 0 ]; then
  echo "FAIL: Stripe key found"
  exit 1
fi
TRADE=$(grep -rn --exclude-dir=node_modules --binary-files=without-match \
        "trade.secret\|TRADE-SECRET" "$MIRROR_DIR" 2>/dev/null | wc -l | tr -d ' ')
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

HOOK_COUNT=$(ls "$MIRROR_DIR/.claude/hooks/"*.js 2>/dev/null | wc -l | tr -d ' ')
echo "Hook count: $HOOK_COUNT"
if [ "$HOOK_COUNT" -lt 10 ]; then
  echo "FAIL: Expected >= 10 hooks, got $HOOK_COUNT"
  exit 1
fi
echo "PASS: Hooks present"

echo "[ci-sync-check] OK"
