#!/usr/bin/env bash
#
# Measure REAL /sync latency against the configured Massu endpoint, so the client's
# request-timeout and deadline constants are sized from measurement instead of from
# somebody's intuition.
#
# WHY THIS EXISTS: the client shipped a 2000ms request timeout with a comment
# asserting it "tolerat[ed] typical latency". Nobody had ever timed the endpoint. A
# 1-session/50-observation payload actually takes ~2000ms — so cloud sync timed out
# on every real session, retried, and then DISCARDED the data. The failure was
# invisible because a timeout and an idle seat look identical from the outside.
#
# Run this before changing DEFAULT_CLOUD_REQUEST_TIMEOUT_MS / SYNC_DEADLINE_MS in
# packages/core/src/cloud-sync.ts. Do NOT copy a number out of a comment — re-derive it.
#
# The API key is read from ~/.massu/credentials and is NEVER printed.
set -uo pipefail

ENDPOINT="${MASSU_CLOUD_ENDPOINT:-https://api.massu.ai/v1}"
ATTEMPTS="${ATTEMPTS:-5}"

KEY=$(python3 -c 'import json,os,sys
p=os.path.expanduser("~/.massu/credentials")
if not os.path.exists(p): sys.exit(1)
print(json.load(open(p)).get("apiKey",""))' 2>/dev/null)

if [ -z "${KEY}" ]; then
  echo "FAIL-CLOSED: no apiKey in ~/.massu/credentials — cannot measure." >&2
  exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "${tmp}"' EXIT

printf '%s\n' '{"sessions":[]}' > "${tmp}/empty.json"

python3 - "${tmp}/real.json" <<'PY'
import json, sys
obs = [{
    "local_observation_id": f"latency_probe_{i}",
    "session_id": "latency-probe",
    "type": "feature",
    "content": "Latency probe observation " + ("x" * 200),
    "importance": 3,
} for i in range(50)]
payload = {
    "sessions": [{
        "local_session_id": "latency-probe",
        "summary": "latency probe",
        "ended_at": "2026-01-01T00:00:00.000Z",
        "turns": 1, "tokens_used": 0, "estimated_cost": 0, "tools_used": [],
    }],
    "observations": obs,
}
with open(sys.argv[1], "w") as f:
    json.dump(payload, f)
PY

probe () {
  local label="$1" file="$2"
  local total=0 worst=0 n="${ATTEMPTS}"
  for _ in $(seq 1 "${n}"); do
    local t ms
    t=$(curl -s -o /dev/null -w '%{time_total}' --max-time 60 \
        -X POST "${ENDPOINT}/sync" \
        -H "Authorization: Bearer ${KEY}" \
        -H 'Content-Type: application/json' \
        --data-binary "@${file}")
    ms=$(python3 -c "print(int(float('${t}')*1000))")
    total=$(( total + ms ))
    [ "${ms}" -gt "${worst}" ] && worst="${ms}"
  done
  printf '  %-26s mean %5dms   worst %5dms\n' "${label}" $(( total / n )) "${worst}"
}

echo "endpoint: ${ENDPOINT}   attempts: ${ATTEMPTS}"
echo
probe "empty (auth/bcrypt only)" "${tmp}/empty.json"
probe "1 session + 50 obs"       "${tmp}/real.json"
echo
echo "Size DEFAULT_CLOUD_REQUEST_TIMEOUT_MS well above the WORST figure above,"
echo "and keep SYNC_DEADLINE_MS inside the Stop-hook timeout in .claude/settings.json."
