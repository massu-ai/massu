---
name: massu-push
description: "When user says 'push', 'push to remote', 'deploy', or wants to push committed changes to the remote repository"
allowed-tools: Bash(*), Read(*), Edit(*), Write(*), Grep(*), Glob(*)
---
name: massu-push

# Massu Push: Verify, Push, Monitor CI

## Objective

Run deterministic pre-push checks, push, then monitor CI. If CI fails, auto-fix.

---

## EXECUTION

### Phase 1: Pre-Flight

```bash
# Verify commits to push
git log origin/$(git branch --show-current)..HEAD --oneline
git remote -v
```

If no commits to push, abort.

### Phase 2: Pre-Push Verification

```bash
./scripts/push-verify.sh
```

**This script runs pre-push checks: pattern scanner, coupling, UX quality, schema validation, ESLint, TypeScript.**

If it exits non-zero, fix the failures before proceeding. Do NOT push with failing checks.

### Phase 3: Push

```bash
git push origin $(git branch --show-current)
```

### Phase 4: Monitor CI

```bash
./scripts/ci-status.sh --wait --max-wait 300
```

Three outcomes:
- **CI passes**: Done. Report success.
- **CI fails**: Auto-run `/massu-ci-fix` protocol (diagnose, fix, commit, re-push, re-monitor).
- **CI timeout**: Report timeout, suggest manual check.

### Phase 5: CI Auto-Fix (if CI failed)

If CI failed, execute the `/massu-ci-fix` protocol inline:

1. Pull failure logs: `gh run view [RUN_ID] --log-failed`
2. Diagnose root cause
3. Fix locally
4. Verify fix: run the same check that failed
5. Commit: `fix(ci): [description]`
6. Re-push
7. Re-monitor CI
8. Max 3 fix attempts

---

## OUTPUT FORMAT

```
== MASSU PUSH ==

Commits: 3 ahead of origin/main
Remote: [your-remote-url]

Pre-Push Verification:
  [1/N] Pattern Scanner...  PASS
  [2/N] VR-COUPLING...      PASS
  ...
  ALL CHECKS PASSED

Pushing to origin/main...
  0382f95a..29b569dc main -> main

CI Status:
  Schema Validation: success
  (300s timeout)

PUSH COMPLETE
```

---

## GOTCHAS

- Verify remote URL before push (`git remote -v`)
- Verify branch before push (`git branch --show-current`)
- Never force-push to main without explicit user confirmation
- If push-verify.sh fails, fix issues first -- do NOT bypass

---

## QUALITY SCORING (silent)

After push completes, append one JSONL line to `.claude/metrics/command-scores.jsonl`:

| Check | Pass condition |
|-------|---------------|
| `pre_push_verify_passed` | push-verify.sh exited 0 |
| `ci_monitored` | CI status was checked after push |
| `ci_passed_or_fixed` | CI passed (first try or after auto-fix) |
| `no_force_push` | No --force flag used |

```json
{"command":"massu-push","timestamp":"ISO8601","scores":{"pre_push_verify_passed":true,"ci_monitored":true,"ci_passed_or_fixed":true,"no_force_push":true},"pass_rate":"4/4","input_summary":"[branch]:[commit-range]"}
```
