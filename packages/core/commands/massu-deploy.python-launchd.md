---
name: massu-deploy
description: "Deploy a Python service supervised by launchd (macOS) — restart the launchd agent, poll health, diff before/after, rollback if unhealthy"
allowed-tools: Bash(*), Read(*), Grep(*), Glob(*)
---

# Massu Deploy: Python Service — launchd (macOS)

Restarts a Python service running under `launchd` on macOS. Use this variant when your `massu.config.yaml` declares `config.python.service_label` and your host is macOS.

## Workflow Position

```
/massu-push -> /massu-deploy (launchd variant)
```

This command restarts a production service. **If the service handles financial, transactional, or otherwise consequential state, real data is at risk** — pre-flight checks are mandatory.

---

## NON-NEGOTIABLE RULES

- **Never deploy with uncommitted changes** — push first via `/massu-push`
- **Never deploy with failing tests** — test suite must be green before this runs
- **Always restart-and-probe** — file-saved ≠ process-running-the-fix
- **Never kill processes without identifying them first** — confirm the label before sending any signal

---

## Pre-flight

```bash
# 1. Branch + working tree clean
test -z "$(git status --porcelain)" || { echo "DIRTY — commit/stash first"; exit 1; }

# 2. Tests green
pytest -x 2>&1 | tail -10

# 3. Confirm the launchd agent is registered
launchctl list | grep {{config.python.service_label | default("<service-label>")}}

# 4. Capture current health for diff
curl -sS http://localhost:8000/health | python3 -m json.tool \
  > /tmp/{{config.python.service_label | default("service")}}-health-before.json
```

---

## Approval Gate

```
===============================================================================
APPROVAL REQUIRED — LAUNCHD RESTART
===============================================================================

Service label : {{config.python.service_label | default("<service-label>")}}
Supervisor    : launchd (macOS)
Pre-flight    : PASS

This will:
  1. launchctl kickstart -k gui/$(id -u)/{{config.python.service_label | default("<service-label>")}}
  2. Poll /health every 2s (max 60s) until 200
  3. Smoke /health + any critical endpoint
  4. Diff before/after health JSON
  5. On failure: print rollback command

Reply "approve" or "abort".
===============================================================================
```

---

## Restart

```bash
launchctl kickstart -k gui/$(id -u)/{{config.python.service_label | default("<service-label>")}}
```

The `-k` flag kills the existing process before relaunching — equivalent to a clean restart. If you need to stop without restart, use `launchctl kill SIGTERM gui/$(id -u)/{{config.python.service_label | default("<service-label>")}}` instead.

---

## Poll Health

```bash
for i in $(seq 1 30); do
  sleep 2
  status=$(curl -sS -o /dev/null -w "%{http_code}" http://localhost:8000/health || echo "000")
  [ "$status" = "200" ] && { echo "READY after ${i} polls"; break; }
  echo "poll ${i}: ${status}"
done
```

---

## Smoke + Diff

```bash
curl -sS http://localhost:8000/health | python3 -m json.tool \
  > /tmp/{{config.python.service_label | default("service")}}-health-after.json

diff \
  /tmp/{{config.python.service_label | default("service")}}-health-before.json \
  /tmp/{{config.python.service_label | default("service")}}-health-after.json \
  | head -50
```

---

## Tail Startup Logs

```bash
# Unified log (most reliable for launchd-managed services)
log show \
  --predicate 'subsystem == "{{config.python.service_label | default("<service-label>")}}"' \
  --last 2m --info 2>/dev/null | grep -iE "error|warn" | head -20

# Alternative: stderr from the plist's StandardErrorPath
# cat ~/Library/Logs/{{config.python.service_label | default("<service-label>")}}/stderr.log | tail -40
```

---

## Rollback

If `/health` does not return 200 within 60s, or any smoke check fails:

```bash
git revert HEAD --no-edit
launchctl kickstart -k gui/$(id -u)/{{config.python.service_label | default("<service-label>")}}
```

Then page yourself or your on-call — an unhealthy production service is an incident.

---

## Audit Log

```bash
echo "$(date -u +%FT%TZ) deploy surface=launchd sha=$(git rev-parse HEAD) label={{config.python.service_label | default("<service-label>")}} actor=$(whoami)" \
  >> data/audit/deploys.log
```

Done. Report: label, sha, restart time, health status, any warnings.
