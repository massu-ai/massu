#!/usr/bin/env bash
#
# MUTATION TEST — the npm publish IDENTITY gate (scripts/npm-publish-guard.sh, gate 0).
#
# The gate's guarantee: @massu/* is published from the SANCTIONED PUBLIC ACCOUNT, never from
# one of the operator's private identities — and if it cannot establish that, it REFUSES.
#
# On 2026-07-14 the gate was extended to work under an npm AUTOMATION TOKEN, because a token
# cannot read `npm profile get email` (by design) and the gate therefore had no path to
# publish from CI at all. Extending a security gate is exactly when you must try hardest to
# DEFEAT it — so this plants each failure the gate exists to catch and demands it goes RED.
#
# CR-72: a gate you have not attacked is decoration.
#
# Run: bash scripts/tests/test_publish_identity_gate.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GUARD="$REPO_ROOT/scripts/npm-publish-guard.sh"
PASS=0; FAIL=0; CHECKS=0

if [ ! -f "$GUARD" ]; then
  echo "FAIL-CLOSED: the guard does not exist at $GUARD — nothing to test."
  exit 1
fi

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

# A fake `npm` on PATH lets us drive the gate's two identity probes deterministically,
# exactly as production invokes them (M3 — test the gate the way production runs it).
make_fake_npm () {  # $1 = profile-email output, $2 = whoami output
  mkdir -p "$SCRATCH/bin"
  cat > "$SCRATCH/bin/npm" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "profile" ] && [ "\$2" = "get" ] && [ "\$3" = "email" ]; then
  [ -n "$1" ] && printf '%s\n' "$1"
  exit 0
fi
if [ "\$1" = "whoami" ]; then
  [ -n "$2" ] && printf '%s\n' "$2"
  exit 0
fi
exit 0
EOF
  chmod +x "$SCRATCH/bin/npm"
}

# Run ONLY gate 0 by sourcing the guard with a stub that stops after the identity block.
# Simpler and more faithful: run the real guard and look at gate-0's verdict lines/exit.
run_gate0 () {
  PATH="$SCRATCH/bin:$PATH" bash "$GUARD" 2>&1
}

check () {  # check <label> <expect_pattern> <output>
  CHECKS=$((CHECKS + 1))
  if printf '%s' "$3" | grep -qE "$2"; then
    printf '  PASS  %s\n' "$1"; PASS=$((PASS + 1))
  else
    printf '  FAIL  %s\n' "$1"
    printf '        expected to match: %s\n' "$2"
    printf '        got: %s\n' "$(printf '%s' "$3" | head -3 | tr '\n' ' ')"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== MUTATION: plant each identity failure, demand the gate REFUSE ==="

# 1. NOT AUTHENTICATED AT ALL — both probes empty. Must refuse (the blind-gate case).
make_fake_npm "" ""
OUT="$(run_gate0)"
check "no auth at all (both probes empty) is REFUSED" \
      "could not read the npm identity|not authenticated" "$OUT"

# 2. TOKEN AUTH AS THE WRONG ACCOUNT. Must refuse — this is the whole point of the gate.
make_fake_npm "" "some-other-user"
OUT="$(run_gate0)"
check "token auth as a NON-sanctioned account is REFUSED" \
      "NOT the sanctioned public|non-public identity" "$OUT"

# 3. INTERACTIVE AUTH WITH AN UNVERIFIED EMAIL. Must refuse.
make_fake_npm "hello@massu.ai" ""
OUT="$(run_gate0)"
check "an UNVERIFIED profile email is REFUSED" \
      "NOT VERIFIED" "$OUT"

echo
echo "=== the gate must also OPEN for the legitimate identities (a brick gets disabled) ==="

# 4. TOKEN AUTH AS THE SANCTIONED ACCOUNT. Must pass gate 0.
make_fake_npm "" "massu"
OUT="$(run_gate0)"
check "token auth as 'massu' PASSES gate 0" \
      "token auth; publishing as npm account 'massu'" "$OUT"

# 5. INTERACTIVE AUTH, VERIFIED SANCTIONED EMAIL. Must pass gate 0.
make_fake_npm "hello@massu.ai (verified)" "massu"
OUT="$(run_gate0)"
check "verified hello@massu.ai PASSES gate 0" \
      "sanctioned public identity|OK — publishing as" "$OUT"

echo
# M1 — PROVE IT LOOKED. A run that asserted nothing is a LOUD failure, never a pass.
echo "checks run (denominator): $CHECKS   passed: $PASS   failed: $FAIL"
if [ "$CHECKS" -lt 5 ]; then
  echo "FAIL-CLOSED: only $CHECKS checks ran — the harness itself is broken."
  exit 1
fi
if [ "$FAIL" -gt 0 ]; then
  echo "RESULT: FAIL — the publish identity gate does not refuse what it must refuse."
  exit 1
fi
echo "RESULT: PASS — the gate refuses no-auth and wrong-account, and opens only for the public role account."
