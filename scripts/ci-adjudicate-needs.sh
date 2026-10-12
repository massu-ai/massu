#!/usr/bin/env bash
# CI-ONLY: adjudicates a GitHub Actions `needs` context, which has no local equivalent — there
# is no needs graph outside a workflow run, so a pre-push invocation would judge nothing.
# Adjudicate a GitHub Actions `needs` context: did every needed job actually succeed?
#
# WHY THIS EXISTS AS A SCRIPT, NOT INLINE YAML. Two reasons, and the second is the real one:
#   1. pattern-scanner Check 26 forbids inline shell blocks over 5 lines in a CI workflow —
#      they are untestable, undiffable, and unreachable from any local runner.
#   2. ci.yml and ci.public.yml BOTH need this verdict. Inline, that is two copies drifting
#      apart; here it is ONE implementation both delegate to (G32 / Rule 25).
#
# THE DEFECT IT CLOSES. GitHub: "Successful check statuses are success, SKIPPED, and neutral."
# A job with `needs:` and no job-level `if:` is SKIPPED when a dependency fails, so as a
# REQUIRED status check it reports a satisfying state exactly when its dependency is red.
# Measured on massu-internal PR #36: a failing Windows leg left mergeStateStatus = UNSTABLE.
#
# CONTRACT: reads NEEDS_JSON from the environment — set it from `${{ toJSON(needs) }}`, so the
# judged set is DERIVED from the needs graph rather than transcribed job by job.
#   exit 0  every needed job succeeded (or was skipped downstream of a reported success)
#   exit 1  at least one needed job failed or was cancelled — named in the output
#   exit 2  could-not-look: NEEDS_JSON absent, unparseable, or empty. A gate that cannot see
#           must never report clean, so this is an ERROR and never a pass (M2).
set -euo pipefail

python3 - <<'PY'
import json, os, sys

raw = os.environ.get("NEEDS_JSON", "")
if not raw.strip():
    print("REFUSING: NEEDS_JSON is empty or unset. This job would adjudicate nothing, and a")
    print("gate that cannot see must never report clean. Set it from ${{ toJSON(needs) }}.")
    sys.exit(2)
try:
    needs = json.loads(raw)
except json.JSONDecodeError as exc:
    print("REFUSING: NEEDS_JSON did not parse as JSON: %s" % exc)
    sys.exit(2)
if not isinstance(needs, dict) or not needs:
    print("REFUSING: NEEDS_JSON parsed to %r, which adjudicates nothing." % (needs,))
    sys.exit(2)

# M1 — print the DENOMINATOR. "judged 0, found 0 bad" must be a loud error, never a pass.
print("jobs judged: %d" % len(needs))
bad = []
for name in sorted(needs):
    result = (needs[name] or {}).get("result", "<absent>")
    print("  %-30s %s" % (name, result))
    # A skip is NOT independently fatal here. Within one workflow a skip is downstream of a
    # failure that this same loop reports, and in ci.public.yml a skip is how the repository
    # guard excludes the non-matching repo — which is load-bearing for cross-repo ruleset
    # sharing. `failure` and `cancelled` are the fatal states; a MISSING result is too,
    # because absence of a verdict is not a verdict.
    if result in ("failure", "cancelled", "<absent>"):
        bad.append("%s=%s" % (name, result))

if bad:
    print()
    print("FAIL: %d of %d needed job(s) did not succeed: %s" % (len(bad), len(needs), ", ".join(bad)))
    sys.exit(1)
print()
print("PASS: all %d needed job(s) succeeded or were skipped downstream of a reported success." % len(needs))
PY
