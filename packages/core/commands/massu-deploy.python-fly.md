---
name: massu-deploy
description: "Deploy a Python service to Fly.io — flyctl deploy, status check, log tail, rollback if unhealthy"
allowed-tools: Bash(*), Read(*), Grep(*), Glob(*)
---

# Massu Deploy: Python Service — Fly.io

Deploys a Python service to Fly.io using `flyctl deploy`. Use this variant when your project targets Fly.io and has a `fly.toml` in the repository root. The app name comes from `fly.toml` (or `config.python.service_label` as a fallback).

## Workflow Position

```
/massu-push -> /massu-deploy (fly variant)
```

This command deploys to a live Fly.io app. **If the app handles financial, transactional, or otherwise consequential state, real data is at risk** — pre-flight checks are mandatory.

---

## NON-NEGOTIABLE RULES

- **Never deploy with uncommitted changes** — push first via `/massu-push`
- **Never deploy with failing tests** — test suite must be green before this runs
- **Always check status after deploy** — `flyctl deploy` success ≠ the new release is healthy
- **Never force a deploy to fix a broken deploy** — diagnose first, then decide

---

## Pre-flight

```bash
# 1. Branch + working tree clean
test -z "$(git status --porcelain)" || { echo "DIRTY — commit/stash first"; exit 1; }

# 2. Tests green
pytest -x 2>&1 | tail -10

# 3. Confirm flyctl is authenticated and the app exists
flyctl status --app {{config.python.service_label | default("<app-name>")}} 2>&1 | head -20

# 4. Note the current release number for rollback reference
flyctl releases --app {{config.python.service_label | default("<app-name>")}} --limit 3
```

---

## `fly.toml` — Key Fields to Verify

Before deploying, confirm these sections exist in `fly.toml`:

```toml
app = "{{config.python.service_label | default("<app-name>")}}"
primary_region = "<region>"  # e.g. "ord", "lax", "iad"

[build]
  # Dockerfile or builder block

[http_service]
  internal_port = 8000
  force_https = true
  auto_stop_machines = true
  auto_start_machines = true

[[vm]]
  memory = "512mb"
  cpu_kind = "shared"
  cpus = 1

[checks]
  [checks.health]
    grace_period = "10s"
    interval = "30s"
    method = "GET"
    path = "/health"
    protocol = "https"
    timeout = "10s"
```

Missing a `[checks.health]` block means Fly.io won't automatically detect an unhealthy release.

---

## Approval Gate

```
===============================================================================
APPROVAL REQUIRED — FLY.IO DEPLOY
===============================================================================

App name   : {{config.python.service_label | default("<app-name>")}}
Platform   : Fly.io
Pre-flight : PASS

This will:
  1. flyctl deploy --app {{config.python.service_label | default("<app-name>")}}
  2. Wait for Fly.io health checks to pass (built-in to flyctl)
  3. flyctl status to confirm all instances are running
  4. Smoke /health endpoint
  5. On failure: print rollback command

Reply "approve" or "abort".
===============================================================================
```

---

## Deploy

```bash
flyctl deploy --app {{config.python.service_label | default("<app-name>")}}
```

`flyctl deploy` builds the image (or reuses a cached layer), pushes to the Fly.io registry, creates a new release, and waits for health checks. Pass `--strategy rolling` or `--strategy bluegreen` if your app supports it.

---

## Post-Deploy Status

```bash
# Confirm all machines are healthy
flyctl status --app {{config.python.service_label | default("<app-name>")}}

# Show the new release
flyctl releases --app {{config.python.service_label | default("<app-name>")}} --limit 1
```

---

## Smoke

```bash
# Hit the public health endpoint (replace with your actual hostname)
APP_HOST=$(flyctl info --app {{config.python.service_label | default("<app-name>")}} --hostname 2>/dev/null | head -1 || echo "{{config.python.service_label | default("<app-name>")}}.fly.dev")
curl -sS "https://${APP_HOST}/health" | python3 -m json.tool
```

---

## Tail Logs

```bash
# Live log stream (Ctrl-C to stop)
flyctl logs --app {{config.python.service_label | default("<app-name>")}}

# Filter for errors in recent output
flyctl logs --app {{config.python.service_label | default("<app-name>")}} 2>&1 | grep -iE "error|warn|exception" | head -30
```

---

## Rollback

If health checks fail or the smoke check returns non-200:

```bash
# Roll back to the previous release
flyctl releases --app {{config.python.service_label | default("<app-name>")}} --limit 5
flyctl deploy --image <previous-image-ref> --app {{config.python.service_label | default("<app-name>")}}
```

Or use the Fly dashboard's "Rollback" button if the release number is known.

Then page yourself or your on-call — an unhealthy Fly.io release is an incident.

---

## Secrets Management

Do NOT hard-code secrets in `fly.toml`. Use Fly secrets:

```bash
# Set a secret (prompts for value if omitted)
flyctl secrets set MY_SECRET_KEY=<value> --app {{config.python.service_label | default("<app-name>")}}

# List current secret names (values are redacted)
flyctl secrets list --app {{config.python.service_label | default("<app-name>")}}
```

---

## Audit Log

```bash
echo "$(date -u +%FT%TZ) deploy surface=fly sha=$(git rev-parse HEAD) app={{config.python.service_label | default("<app-name>")}} actor=$(whoami)" \
  >> data/audit/deploys.log
```

Done. Report: app name, release number, deploy time, health status, any warnings.
