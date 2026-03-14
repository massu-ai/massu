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
5. Smoke tests — GET `/` and `/docs` must return 200
6. Rollback guidance — if smoke tests fail, prints rollback command

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
