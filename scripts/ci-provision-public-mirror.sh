#!/usr/bin/env bash
# CI-ONLY: clones the PUBLIC massu-ai/massu mirror into $HOME and writes a pre-push hook there.
# Both are destructive to a developer's real $HOME/massu working clone, so this must never run
# from pre-push-light.sh. The pre-push mirror of these guards is that they run against the
# operator's OWN $HOME/massu, which already exists and is already scanner-wired.
#
# W-2 of plan-2026-07-26-anti-vacuity-9-unproven-gates.
#
# WHY THIS FILE EXISTS AT ALL: the three Layer-3 boundary guards
#   scripts/tests/test_boundary_guard_goes_red.sh
#   scripts/tests/test_publication_gates_anti_vacuity.sh
#   scripts/tests/test_private_boundary_files_never_shipped.sh
# verify the OUTCOME that private files are ABSENT from the PUBLIC repo, and that its push path
# is scanner-gated. That needs a real checkout of massu-ai/massu plus the pre-push hook the
# operator keeps in their local clone. A fresh runner has neither, so the guards fail CLOSED
# ("public repo not found — cannot verify the OUTCOME"). The `type-check` job provisioned this
# inline; the `anti-vacuity` job — the one job that runs ALL 405 proofs — provisioned nothing,
# so those same three guards were reported there as "not proven can-fail", which is the same
# words the sweep uses for decoration. This script is the ONE authoring site for the
# provisioning, referenced by both jobs through .github/actions/provision-public-mirror.
set -euo pipefail

PUBLIC_REPO="${PUBLIC_REPO:-$HOME/massu}"
WORKSPACE="${GITHUB_WORKSPACE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# Defined UP HERE, not beside the assertions below, because provisioning steps above the
# assertion block need it too. A helper defined after its first caller is a runtime error that
# only fires on the failure path — i.e. exactly when it is needed.
_fail() { echo "FATAL: [provision-public-mirror] $1" >&2; echo "       REMEDY: $2" >&2; exit 2; }

# ── CI-ONLY, ENFORCED — not merely documented (G11: a mitigation with no OFF switch is a wish) ──
# This script REWRITES BOTH HOOKS in $HOME/massu, which on a developer machine is the operator's
# real working clone of the public mirror. The header has said "must never run locally" since it
# was written, and a comment is not a control. It rewrites more now than it used to (pre-commit as
# well as pre-push), so the warning is made mechanical. The override is NAMED and traced to the
# single condition it suppresses; PUBLIC_REPO is also honoured, so pointing this at a scratch
# directory needs no override at all.
if [ -z "${CI:-}${GITHUB_ACTIONS:-}" ] && [ "${MASSU_ALLOW_LOCAL_MIRROR_PROVISION:-0}" != "1" ]; then
  _fail \
    "refusing to run outside CI: this REWRITES .git/hooks/{pre-commit,pre-push} in '$PUBLIC_REPO', which on this machine is your real public-mirror clone" \
    "run it in CI, or point it elsewhere with PUBLIC_REPO=/tmp/scratch-mirror, or override deliberately with MASSU_ALLOW_LOCAL_MIRROR_PROVISION=1"
fi

echo "── [provision-public-mirror] cloning massu-ai/massu -> $PUBLIC_REPO ──"
if [ -d "$PUBLIC_REPO/.git" ]; then
  echo "── [provision-public-mirror] $PUBLIC_REPO already present — reusing (idempotent no-op) ──"
else
  git clone --depth 1 https://github.com/massu-ai/massu.git "$PUBLIC_REPO"
fi

# ── The PRE-COMMIT leak guard, installed by the mirror's OWN tracked installer ────────────────
#
# WHY THIS IS HERE (CI run 30506056540, 2026-07-29). `scripts/ci-sync-check.sh` copies the real
# mirror's pre-commit gate into its ephemeral mirror so it exercises BOTH gates that can refuse a
# publication commit — the payload-safety hook AND the public leak guard. It reads that gate from
# `$HOME/massu/.git/hooks/pre-commit`, and it FAILS LOUD when absent, correctly: "the mirror has
# no gate" must never look like "the gate passed".
#
# That precondition holds on the operator's machine and holds in the two jobs that call this
# script. It did NOT hold in the `Sync Check` job, which provisioned nothing — so the moment the
# gate stopped failing open it went red on a precondition rather than on a leak. THE GATE WAS
# RIGHT; the environment it runs in was never made to match (a gate's predicate must hold in the
# state it actually runs in).
#
# Run the PUBLIC clone's own `scripts/install-hooks.sh` rather than re-writing the shim here:
# that file is the single authoring site for the hook body, it is tracked in both repos, and it
# detects PUBLIC context from the `massu-ai/massu` remote this clone has. Re-typing the five-line
# shim would be a second authoring site for one fact — the drift class this script exists to
# close. NOTE it is deliberately FAIL-OPEN (it exits 0 loudly when the guard script is missing,
# so a stale external fork cannot have its `npm install` refused), which is exactly why the end
# state is ASSERTED below instead of inferred from its exit code.
( cd "$PUBLIC_REPO" && bash scripts/install-hooks.sh ) || _fail \
  "the public mirror's own scripts/install-hooks.sh exited non-zero" \
  "cd \"$PUBLIC_REPO\" && bash scripts/install-hooks.sh   # then re-run this script"

# pre-push is written AFTER install-hooks.sh, which also installs one: the CI guards need the
# SCANNER-wired variant pointing at this workspace, not the mirror's own. Order is load-bearing.
printf '#!/usr/bin/env bash\nexec python3 "%s/scripts/lib/private_content_scan.py" "$@"\n' \
  "$WORKSPACE" > "$PUBLIC_REPO/.git/hooks/pre-push"
chmod +x "$PUBLIC_REPO/.git/hooks/pre-push"

# ── ASSERT THE END STATE (CR-69 / G12) ───────────────────────────────────────────────────────
# `git clone`, `printf >` and `chmod` can each exit 0 having achieved nothing useful (a partial
# clone, a read-only $HOME, a hook written to a path that is not the one the guards read). If
# any of these is false the three guards fail CLOSED and the sweep renders that failure as
# "not proven can-fail" — indistinguishable from decoration, which is the entire defect this
# plan exists to close. Infer nothing from exit 0. (_fail is defined at the top of the file.)

[ -d "$PUBLIC_REPO" ] || _fail \
  "public mirror directory absent at '$PUBLIC_REPO' after clone" \
  "git clone --depth 1 https://github.com/massu-ai/massu.git \"$PUBLIC_REPO\""
[ -d "$PUBLIC_REPO/.git" ] || _fail \
  "'$PUBLIC_REPO' exists but is not a git repository" \
  "rm -rf \"$PUBLIC_REPO\" and re-run this script"
[ -x "$PUBLIC_REPO/.git/hooks/pre-push" ] || _fail \
  "pre-push hook missing or not executable at '$PUBLIC_REPO/.git/hooks/pre-push'" \
  "chmod +x \"$PUBLIC_REPO/.git/hooks/pre-push\""
grep -q 'private_content_scan.py' "$PUBLIC_REPO/.git/hooks/pre-push" || _fail \
  "pre-push hook exists but is NOT wired to the scanner (no private_content_scan.py reference)" \
  "re-run this script so the hook body is regenerated"

# pre-commit: install-hooks.sh is FAIL-OPEN by design, so its exit 0 proves nothing about
# whether the hook was written. This is the assertion that makes it real — and it is the exact
# precondition ci-sync-check.sh reads, so a green here means that gate can actually be exercised.
[ -x "$PUBLIC_REPO/.git/hooks/pre-commit" ] || _fail \
  "pre-commit leak guard missing or not executable at '$PUBLIC_REPO/.git/hooks/pre-commit' — install-hooks.sh is fail-open and exits 0 when it installs nothing" \
  "cd \"$PUBLIC_REPO\" && bash scripts/install-hooks.sh   # needs an executable scripts/massu-public-leak-guard.sh in that clone"
grep -q 'massu-public-leak-guard.sh' "$PUBLIC_REPO/.git/hooks/pre-commit" || _fail \
  "pre-commit hook exists but is NOT the leak guard (no massu-public-leak-guard.sh reference) — ci-sync-check.sh would copy a gate that guards nothing" \
  "cd \"$PUBLIC_REPO\" && rm -f .git/hooks/pre-commit && bash scripts/install-hooks.sh"

echo "── [provision-public-mirror] end state ASSERTED: mirror present, pre-commit leak guard AND scanner-wired pre-push both executable ──"
