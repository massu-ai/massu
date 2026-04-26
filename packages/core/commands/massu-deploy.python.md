---
name: massu-deploy
description: "Deploy a Python service (FastAPI / asgi) to production. Default target is a long-running process supervised by launchd, systemd, pm2, or docker — NOT Vercel. Asks which surface before acting."
allowed-tools: Bash(*), Read(*), Grep(*), Glob(*)
---

> **Shared rules apply.** Read `${paths.commands}/_shared-preamble.md` before proceeding.

# Massu Deploy: Python Service Production Deploy

## Workflow Position

```
/massu-create-plan -> /massu-plan -> /massu-loop -> /massu-commit -> /massu-push -> /massu-deploy
(CREATE)           (AUDIT)        (IMPLEMENT)   (COMMIT)        (PUSH)         (DEPLOY)
```

This command deploys to production. **If the service is doing anything financial, transactional, or otherwise consequential, real money / data integrity is at risk** — pre-flight checks are mandatory.

---

## CRITICAL — Deployment Surfaces

A non-Vercel Python project usually has multiple deploy surfaces. Ask the user which one(s) before proceeding:

| Surface | What "deploy" means | Authority |
|---------|---------------------|-----------|
| **Service** (default) | Restart the supervised process — `launchctl kickstart`, `systemctl restart`, `pm2 restart`, or `docker compose up -d` | The actual production brain |
| **Static / docs** | rsync / S3 sync (if applicable) | Static site only |
| **Worker(s)** | Restart any background workers (celery, rq, custom asyncio task runners) | Background processing |

**There is NO assumption of Vercel.** Do NOT run `vercel --prod` from this template. If the user wants a Vercel deploy of a separate sub-project, route them to a different surface or scaffold a dedicated script.

---

## NON-NEGOTIABLE RULES

- **Never deploy with uncommitted changes** — push first via `/massu-push`
- **Never deploy with failing tests** — `pytest` (or your project's test runner) must be green
- **Always restart-and-probe** — file-saved ≠ process-running-the-fix. After restart, hit a health endpoint and diff before/after
- **Never kill processes without identifying them first** — get the PID, log line, or supervisor label before sending any signal
- **Live-trading or live-billing flag flips are a separate concern** — this command does not flip `auto_*_mode`, `*_live`, `production_*` flags. Use the dedicated approval flow

---

## START NOW

### Step 0: Ask the user

```
===============================================================================
PYTHON DEPLOY — Which surface?
===============================================================================

  service   Restart the supervised Python service (default)
  workers   Restart background workers (celery / rq / custom)
  all       service + workers
  static    rsync / S3 sync (only if applicable)

Which? [service / workers / all / static]
===============================================================================
```

---

## Path A: Service (default)

Substitute `${supervisor}` with whatever your project actually uses (`launchd`, `systemd`, `pm2`, `docker`). Substitute `${service_label}` with the actual label / unit name from `massu.config.yaml` (`deploy.python.service_label`) or from your project's process manager.

### Pre-flight

```bash
# 1. Branch + working tree clean
test -z "$(git status --porcelain)" || { echo "DIRTY — commit/stash first"; exit 1; }

# 2. Tests green (impacted area only — full suite is for /massu-push)
${paths.python_test_command:-pytest} -x 2>&1 | tail -10

# 3. Identify the running process (NEVER blind-kill)
# launchd: launchctl list | grep ${service_label}
# systemd: systemctl status ${service_label}
# pm2:     pm2 jlist | jq '.[] | select(.name=="${service_label}")'
# docker:  docker compose ps ${service_label}

# 4. Capture current health for diff
curl -sS ${health_url:-http://localhost:8000/health} | python3 -m json.tool > /tmp/${service_label}-health-before.json
```

### Approval gate

```
===============================================================================
APPROVAL REQUIRED — RESTART ${service_label}
===============================================================================

Pre-flight: PASS
Branch: <current>
HEAD: <sha>
Last service uptime: <etime>

This will:
  1. Restart ${service_label} via ${supervisor}
  2. Wait 5s, poll /health until 200 (max 60s)
  3. Smoke: /health, /api/feature-flags (if applicable), one critical endpoint
  4. Diff before/after health responses
  5. If any check fails: print rollback (`git revert HEAD` + restart)

Reply "approve" or "abort".
===============================================================================
```

### Restart + verify

Pick the line that matches your supervisor:

```bash
# launchd
launchctl kickstart -k gui/$(id -u)/${service_label}

# systemd (user)
systemctl --user restart ${service_label}

# pm2
pm2 restart ${service_label}

# docker compose
docker compose up -d --force-recreate ${service_label}
```

Then probe:

```bash
# Poll until ready (60s budget)
for i in $(seq 1 30); do
  sleep 2
  status=$(curl -sS -o /dev/null -w "%{http_code}" ${health_url:-http://localhost:8000/health} || echo "000")
  [ "$status" = "200" ] && { echo "READY after ${i} polls"; break; }
done

# Smoke + diff
curl -sS ${health_url:-http://localhost:8000/health} | python3 -m json.tool > /tmp/${service_label}-health-after.json
diff /tmp/${service_label}-health-before.json /tmp/${service_label}-health-after.json | head -50

# Tail the supervisor log for startup errors
# launchd:
log show --predicate 'subsystem == "${service_label}"' --last 2m --info 2>/dev/null | grep -iE "error|warn" | head -20
# systemd:
# journalctl --user -u ${service_label} --since "2 minutes ago" | grep -iE "error|warn" | head -20
# pm2:
# pm2 logs ${service_label} --lines 100 --nostream | grep -iE "error|warn" | head -20
```

### Rollback

If `/health` does not return 200 within 60s, or smoke fails:

```bash
git revert HEAD --no-edit && <restart-command-from-above>
```

Then page yourself or your on-call: an unhealthy production service is an incident.

---

## Path B: Workers

```bash
# Restart background workers (celery / rq / custom asyncio runners)
# Substitute the supervisor label list for your project's worker names.
for label in ${worker_labels}; do
  echo "restarting $label..."
  # launchd: launchctl kickstart -k gui/$(id -u)/$label
  # systemd: systemctl --user restart $label
  # pm2:     pm2 restart $label
done

# Verify each worker is processing again — push a no-op job if you have one,
# or read the queue depth before/after.
```

---

## Path C: Static (only if applicable)

```bash
# Build static site, rsync, or aws s3 sync — fill in your project's pipeline.
# This is intentionally NOT a default; only run if your project has a static deploy target.
```

---

## After ANY surface deploys

Save the deployment sha and timestamp to your project's audit log so the boundary is visible:

```bash
echo "$(date -u +%FT%TZ) deploy surface=<surface> sha=$(git rev-parse HEAD) actor=$(whoami)" >> ${paths.audit_log:-data/audit/deploys.log}
```

Done. Report: surface, sha, time, smoke results, any warnings.
