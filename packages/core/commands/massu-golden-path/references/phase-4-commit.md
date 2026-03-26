# Phase 4: Pre-Commit Verification

> Reference doc for `/massu-golden-path`. Return to main file for overview.

```
[GOLDEN PATH -- PHASE 4: PRE-COMMIT VERIFICATION]
```

## 4.1 Auto-Verification Gates (ALL must pass in SINGLE run)

| Gate | Command | Expected |
|------|---------|----------|
| 1. Pattern Scanner | `./scripts/pattern-scanner.sh` | Exit 0 |
| 2. Type Safety (VR-TYPE) | `NODE_OPTIONS="--max-old-space-size=8192" npx tsc --noEmit` | 0 errors |
| 3. Build (VR-BUILD) | `npm run build` | Exit 0 |
| 4. Lint | `npm run lint` | Exit 0 |
| 5. Prisma Validate | `npx prisma validate` | Exit 0 |
| 6. Secrets Staged | `git diff --cached --name-only \| grep -E '\.(env\|pem\|key\|secret)'` | 0 files |
| 7. Credentials in Code | `grep -rn "sk-\|password.*=.*['\"]" --include="*.ts" --include="*.tsx" src/ \| grep -v "process.env" \| wc -l` | 0 |
| 8. Schema Mismatch | Extract tables from staged routers -> query columns via MCP | All exist |
| 9. VR-RENDER | For EACH staged component: `grep "<ComponentName" src/app/**/page.tsx` | Match found |
| 9.5. VR-COLOR | `git diff --cached \| grep "text-red-\|bg-green-\|..."` | 0 matches |
| 9.6. VR-COUPLING | `massu_coupling_check` or `./scripts/check-coupling.sh` | Exit 0 |
| 10. Plan Coverage | Verify ALL plan items with VR-* proof | 100% |
| 11. VR-PLAN-STATUS | `grep "IMPLEMENTATION STATUS" [plan]` | Match |
| 12. Dependency Security | `npm audit --audit-level=high` | 0 high/crit |
| 13. Test Coverage | Check test files exist for new code | WARN level |
| 14. VR-VISUAL | `bash scripts/ui-review.sh [route]` (if UI files changed) | VR_VISUAL_STATUS: PASS |

For each modified file: `massu_validate_file`, `massu_security_score`, `massu_security_heatmap`. If any file scores > 7/10 risk, flag for review.

Spawn `massu-pattern-reviewer` agent for deep CR rule checks, import chain validation, semantic pattern matching.

## 4.2 Database Verification (All Environments)

For EACH affected table, query all configured environments via MCP:

| Env | MCP Prefix | Verify |
|-----|-----------|--------|
| DEV | `mcp__supabase__DEV__execute_sql` | Table, columns, RLS, grants |
| PROD | `mcp__supabase__PROD__execute_sql` | Table, columns, RLS, grants |

VR-DATA: If config-driven features, query actual config values and compare to code expectations.

## 4.3 Help Site Auto-Sync

1. Get staged files -> pass to `massu_docs_audit`
2. For STALE/NEW pages: update MDX, set `lastVerified`, add changelog
3. Commit to help site repo (separate git)
4. Return to main app repo

## 4.4 Quality Scoring Gate

Spawn `massu-output-scorer` (sonnet): Code Clarity, Pattern Compliance, Error Handling, UX Quality, Test Coverage (1-5 each). All >= 3: PASS. Any < 3: FAIL.

## 4.5 If ANY Gate Fails

**DO NOT PAUSE** -- Fix automatically, re-run ALL gates, repeat until all pass.

## 4.6 Auto-Learning Protocol

- For each bug fixed: `massu_memory_ingest` type="bugfix", update MEMORY.md
- For new patterns: `massu_memory_ingest` type="pattern"
- Add detection to `scripts/pattern-scanner.sh` if grep-able
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
- DB: All environments verified
- Help site: UP TO DATE

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```
