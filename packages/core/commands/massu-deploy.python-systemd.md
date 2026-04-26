---
name: massu-deploy
description: "Deploy a Python service supervised by systemd (Linux) — restart the user unit, poll health, tail journalctl, diff before/after, rollback if unhealthy"
allowed-tools: Bash(*), Read(*), Grep(*), Glob(*)
---

# Massu Deploy: Python Service — systemd (Linux)

Restarts a Python service running under a `systemd --user` unit on Linux. Use this variant when your `massu.config.yaml` declares `config.python.service_label` and your host is Linux.

## Workflow Position

```
/massu-push -> /massu-deploy (systemd variant)
```

This command restarts a production service. **If the service handles financial, transactional, or otherwise consequential state, real data is at risk** — pre-flight checks are mandatory.

---

## NON-NEGOTIABLE RULES

- **Never deploy with uncommitted changes** — push first via `/massu-push`
- **Never deploy with failing tests** — test suite must be green before this runs
- **Always restart-and-probe** — file-saved ≠ process-running-the-fix
- **Never kill processes without identifying them first** — confirm the unit name before sending any signal

---

## Pre-flight

```bash
# 1. Branch + working tree clean
test -z "$(git status --porcelain)" || { echo "DIRTY — commit/stash first"; exit 1; }

# 2. Tests green
pytest -x 2>&1 | tail -10

# 3. Confirm the unit is active
systemctl --user status {{config.python.service_label | default("<service-label>")}} --no-pager | head -20

# 4. Capture current health for diff
curl -sS http://localhost:8000/health | python3 -m json.tool \
  > /tmp/{{config.python.service_label | default("service")}}-health-before.json
```

---

## Approval Gate

```
===============================================================================
APPROVAL REQUIRED — SYSTEMD RESTART
===============================================================================

Service unit  : {{config.python.service_label | default("<service-label>")}}
Supervisor    : systemd --user (Linux)
Pre-flight    : PASS

This will:
  1. systemctl --user restart {{config.python.service_label | default("<service-label>")}}
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
systemctl --user restart {{config.python.service_label | default("<service-label>")}}
```

If the unit is system-level (not user-level), drop `--user` and run with `sudo`.

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
# Recent errors from the unit (2-minute window)
journalctl --user -u {{config.python.service_label | default("<service-label>")}} \
  --since "2 minutes ago" --no-pager | grep -iE "error|warn" | head -20

# Follow live (Ctrl-C to stop)
journalctl --user -u {{config.python.service_label | default("<service-label>")}} -f --no-pager

# Full boot for this unit
journalctl --user -u {{config.python.service_label | default("<service-label>")}} \
  -b --no-pager | tail -100
```

---

## Rollback

If `/health` does not return 200 within 60s, or any smoke check fails:

```bash
git revert HEAD --no-edit
systemctl --user restart {{config.python.service_label | default("<service-label>")}}
```

Then page yourself or your on-call — an unhealthy production service is an incident.

---

## Useful systemd Diagnostics

```bash
# Check if the unit file needs a daemon-reload after editing the .service file
systemctl --user daemon-reload

# Show the resolved unit definition (useful to verify ExecStart path)
systemctl --user cat {{config.python.service_label | default("<service-label>")}}

# List recent restarts / crash history
systemctl --user show {{config.python.service_label | default("<service-label>")}} \
  --property=NRestarts,ActiveState,SubState
```

---

## Audit Log

```bash
echo "$(date -u +%FT%TZ) deploy surface=systemd sha=$(git rev-parse HEAD) unit={{config.python.service_label | default("<service-label>")}} actor=$(whoami)" \
  >> data/audit/deploys.log
```

Done. Report: unit name, sha, restart time, health status, any warnings.
