# Phase 4: Pre-Commit Verification

> Reference doc for `/massu-golden-path`. Return to main file for overview.

```
[GOLDEN PATH -- PHASE 4: PRE-COMMIT VERIFICATION]
```

## 4.1 Auto-Verification Gates (ALL must pass in SINGLE run)

| Gate | Command | Expected |
|------|---------|----------|
| 1. Pattern Scanner | `bash scripts/massu-pattern-scanner.sh` | Exit 0 |
| 2. Type Safety (VR-TYPE) | `cd packages/core && npx tsc --noEmit` | 0 errors |
| 3. Build (VR-BUILD) | `npm run build` | Exit 0 |
| 4. Tests (VR-TEST) | `npm test` | ALL pass |
| 5. Hook Compilation (VR-HOOK-BUILD) | `cd packages/core && npm run build:hooks` | Exit 0 |
| 6. Generalization (VR-GENERIC) | `bash scripts/massu-generalization-scanner.sh` | Exit 0 |
| 7. Security Scanner | `bash scripts/massu-security-scanner.sh` | Exit 0 |
| 8. Secrets Staged | `git diff --cached --name-only \| grep -E '\.(env\|pem\|key\|secret)'` | 0 files |
| 9. Credentials in Code | `grep -rn "sk-\|password.*=.*['\"]" --include="*.ts" packages/ \| grep -v "process.env" \| wc -l` | 0 |
| 10. VR-TOOL-REG | For EACH new tool: verify definitions + handler wired in tools.ts | All wired |
| 11. Plan Coverage | Verify ALL plan items with VR-* proof | 100% |
| 12. VR-PLAN-STATUS | `grep "IMPLEMENTATION STATUS" [plan]` | Match |
| 13. Dependency Security | `npm audit --audit-level=high` | 0 high/crit |

## 4.2 Quality Scoring Gate

Spawn `massu-output-scorer` (sonnet): Code Clarity, Pattern Compliance, Error Handling, Test Coverage, Config-Driven Design (1-5 each). All >= 3: PASS. Any < 3: FAIL.

## 4.3 If ANY Gate Fails

**DO NOT PAUSE** -- Fix automatically, re-run ALL gates, repeat until all pass.

## 4.4 Auto-Learning Protocol

- For each bug fixed: update memory files
- For new patterns: record in memory
- Add detection to `scripts/massu-pattern-scanner.sh` if grep-able
- Codebase-wide search: no other instances of same bad pattern (CR-9)
- Record user corrections to `memory/corrections.md`

---

## Phase 4 Complete -> APPROVAL POINT #3: COMMIT

See `approval-points.md` for the exact format.

### Commit Format

```bash
git commit -m "$(cat <<'EOF'
[type]: [description]

[Body]

Changes:
- [Change 1]
- [Change 2]

Verified:
- Pattern scanner: PASS | Type check: 0 errors | Build: PASS
- Tests: ALL pass | Hooks: compiled | Generalization: PASS

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```
