---
name: massu-deploy
description: "Deploy a containerized Python service via docker compose — force-recreate the service container, health-check poll, diff before/after, rollback if unhealthy"
allowed-tools: Bash(*), Read(*), Grep(*), Glob(*)
---

# Massu Deploy: Python Service — Docker Compose

Force-recreates the Docker container for a Python service using `docker compose`. Use this variant when your service is containerized and `massu.config.yaml` declares `config.python.service_label` matching the compose service name.

## Workflow Position

```
/massu-push -> /massu-deploy (docker variant)
```

This command redeploys a running container. **If the service handles financial, transactional, or consequential state, real data is at risk** — pre-flight checks are mandatory.

---

## NON-NEGOTIABLE RULES

- **Never deploy with uncommitted changes** — push first via `/massu-push`
- **Never deploy with failing tests** — test suite must be green before this runs
- **Always restart-and-probe** — `docker compose up` ≠ the new image is healthy
- **Never stop containers without identifying them first** — confirm the compose service name before running any destructive command

---

## Pre-flight

```bash
# 1. Branch + working tree clean
test -z "$(git status --porcelain)" || { echo "DIRTY — commit/stash first"; exit 1; }

# 2. Tests green
pytest -x 2>&1 | tail -10

# 3. Confirm the service is running
docker compose ps {{config.python.service_label | default("<service-label>")}}

# 4. Capture current health for diff
curl -sS http://localhost:8000/health | python3 -m json.tool \
  > /tmp/{{config.python.service_label | default("service")}}-health-before.json
```

---

## Build (if image needs rebuilding)

```bash
# Rebuild the image for this service only (skip if using a pre-built registry image)
docker compose build {{config.python.service_label | default("<service-label>")}}
```

---

## Approval Gate

```
===============================================================================
APPROVAL REQUIRED — DOCKER COMPOSE REDEPLOY
===============================================================================

Compose service : {{config.python.service_label | default("<service-label>")}}
Supervisor      : docker compose
Pre-flight      : PASS

This will:
  1. docker compose up -d --force-recreate {{config.python.service_label | default("<service-label>")}}
  2. Poll /health every 2s against the container (max 60s) until 200
  3. Smoke /health + any critical endpoint
  4. Diff before/after health JSON
  5. On failure: print rollback command

Reply "approve" or "abort".
===============================================================================
```

---

## Redeploy

```bash
docker compose up -d --force-recreate {{config.python.service_label | default("<service-label>")}}
```

`--force-recreate` ensures the container is replaced even if the image tag didn't change. Omit if you only want `up` to no-op on unchanged images.

---

## Poll Container Health

```bash
for i in $(seq 1 30); do
  sleep 2
  status=$(curl -sS -o /dev/null -w "%{http_code}" http://localhost:8000/health || echo "000")
  [ "$status" = "200" ] && { echo "READY after ${i} polls"; break; }
  echo "poll ${i}: ${status}"
done
```

If the compose file declares a `HEALTHCHECK` directive, you can also poll the Docker health state:

```bash
for i in $(seq 1 30); do
  sleep 2
  state=$(docker inspect --format='\{{.State.Health.Status}}' \
    "$(docker compose ps -q {{config.python.service_label | default("<service-label>")}})") 2>/dev/null || state="unknown"
  [ "$state" = "healthy" ] && { echo "Container healthy after ${i} polls"; break; }
  echo "poll ${i}: $state"
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

## Tail Container Logs

```bash
# Last 100 lines, filtered for errors
docker compose logs {{config.python.service_label | default("<service-label>")}} \
  --tail=100 --no-log-prefix | grep -iE "error|warn" | head -20

# Follow live (Ctrl-C to stop)
docker compose logs -f {{config.python.service_label | default("<service-label>")}} --no-log-prefix
```

---

## Rollback

If `/health` does not return 200 within 60s, or any smoke check fails:

```bash
# Option A: revert code + redeploy
git revert HEAD --no-edit
docker compose build {{config.python.service_label | default("<service-label>")}}
docker compose up -d --force-recreate {{config.python.service_label | default("<service-label>")}}

# Option B: roll back to the previous image tag (if using a registry)
# docker compose pull {{config.python.service_label | default("<service-label>")}}:<prev-tag>
# docker compose up -d --force-recreate {{config.python.service_label | default("<service-label>")}}
```

Then page yourself or your on-call — an unhealthy production container is an incident.

---

## Audit Log

```bash
echo "$(date -u +%FT%TZ) deploy surface=docker sha=$(git rev-parse HEAD) service={{config.python.service_label | default("<service-label>")}} actor=$(whoami)" \
  >> data/audit/deploys.log
```

Done. Report: compose service name, image digest or sha, restart time, health status, any warnings.
