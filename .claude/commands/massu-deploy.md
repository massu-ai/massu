---
name: massu-deploy
description: Deploy the current project to Vercel
allowed-tools: Bash(*), Read(*), Grep(*), Glob(*)
---
name: massu-deploy

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding.

# Massu Deploy: Autonomous Deployment Pipeline

## Workflow Position

```
/massu-create-plan -> /massu-plan -> /massu-loop -> /massu-commit -> /massu-push -> /massu-deploy
(CREATE)           (AUDIT)        (IMPLEMENT)   (COMMIT)        (PUSH)         (DEPLOY)
```

**This command deploys the website to Vercel production with pre-flight checks.**

---

## CRITICAL: THIS COMMAND DEPLOYS TO PRODUCTION

**This command runs `scripts/massu-deploy.sh` which deploys to the Vercel project `massu`.**

### Pre-Flight Checks (automatic)
1. Branch check — must be on `main` with clean working tree
2. Project target verification — must match projectId `prj_Io7AaGCM27cwRQerAj3BdihUur1Y`
3. Local build verification — `npm run build` must succeed
4. Deploy to production — `vercel --prod --yes`
4.5. Alias propagation — poll `vercel ls --prod` until the new deploy's hostname prefix is the active production-alias target (warn-not-fail on timeout)
5. Smoke tests — GET `${PRODUCTION_HOST}/`, `/docs`, `/changelog`, `/overview` must return 200 (the latter two added by plan-1.6.3-website-feature-discoverability after the 33-day-stale-changelog incident; production-host target swap added by plan-1.9.2-deploy-smoke-test-production-host after smoke tests were found to silently 401 against the auth-gated per-deploy URL)
6. Rollback guidance — if smoke tests fail, prints rollback command

---

## Environment-Variable Overrides

The deploy script honors two env vars for testability:

| Var | Default | Effect |
|-----|---------|--------|
| `MASSU_PRODUCTION_HOST` | `https://massu.ai` | Sets `PRODUCTION_HOST` — the smoke-test target. Use a staging URL to dry-run the script against a non-production alias. |
| `MASSU_ALIAS_PROPAGATION_TIMEOUT_SECS` | `120` | Sets `ALIAS_PROPAGATION_TIMEOUT_SECS` — how long Step 4.5 polls Vercel before warn-not-fail. Typical Vercel propagation is 5-30s; the 120s default is conservative. |

Example: `MASSU_PRODUCTION_HOST=https://staging.massu.ai bash scripts/massu-deploy.sh`

---

## NON-NEGOTIABLE RULES

- Never create a new Vercel project — always deploy to the existing `massu` project
- Never deploy with uncommitted changes
- Always verify build locally before deploying
- Always run smoke tests after deployment
- Use `printf` (not `echo`) for any env var operations

---

## START NOW

### Step 1: Dry Run First

Run the deploy script in dry-run mode to verify pre-flight checks:

```bash
bash scripts/massu-deploy.sh --dry-run
```

If dry-run passes, ask user for approval:

```
===============================================================================
APPROVAL REQUIRED: DEPLOY TO PRODUCTION
===============================================================================

Pre-flight checks passed. Ready to deploy.

Target: Vercel project "massu" (prj_Io7AaGCM27cwRQerAj3BdihUur1Y)
Branch: [current branch]

OPTIONS:
  - Type "approve" or "deploy" to deploy to production
  - Type "abort" to cancel

===============================================================================
```

### Step 2: Deploy

After approval, run the full deploy:

```bash
bash scripts/massu-deploy.sh
```

### Step 3: Report Results

Report the deployment URL and smoke test results.

If smoke tests fail, provide the rollback command:
```bash
cd website && npx vercel rollback --yes
```
