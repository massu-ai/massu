# Shared Reference: Verification Table

**This is a shared content block. Referenced by multiple commands. Do NOT invoke directly.**

---

## Standard VR-* Verification Gates

| Type | Command | Expected | Use When |
|------|---------|----------|----------|
| VR-BUILD | `npm run build` | Exit 0 | Claiming production ready |
| VR-TYPE | `npx tsc --noEmit` | 0 errors | Claiming type safety |
| VR-TEST | `npm test` | ALL pass (MANDATORY) | ALWAYS before claiming complete |
| VR-SCHEMA-PRE | `SELECT column_name FROM information_schema.columns WHERE table_name = 'X'` | All columns exist | BEFORE writing ANY query |
| VR-NEGATIVE | `grep -rn "[old]" src/` | 0 matches | Claiming removal |
| VR-GREP | `grep "[pattern]" [file]` | Match found | Claiming code added |
| VR-RENDER | `grep "<ComponentName" src/app/**/page.tsx` | Match in page file | UI component integrated |
| VR-COUPLING | `./scripts/check-coupling.sh` | Exit 0 | Backend features have UI exposure |
| VR-BLAST-RADIUS | Grep codebase for ALL refs to changed value | 0 uncategorized refs | Changing any constant/path/enum |
| VR-PLAN-COVERAGE | Item-by-item verification with proof | 100% items verified | Before claiming plan complete |
| VR-SCHEMA-SYNC | Query same table across all environments via MCP | Column counts + names match | After ANY database migration |
| VR-TOKEN | `scripts/audit-design-tokens.sh` | Exit 0 | CSS changes |
| VR-BROWSER | Playwright: navigate, snapshot, console_messages, interact | 0 errors, UI works | ANY UI fix/change (CR-41) |
| VR-SPEC-MATCH | Grep for EXACT CSS classes/structure from plan | All plan-specified strings found | UI plan items (CR-42) |
| VR-PIPELINE | Trigger pipeline procedure, verify non-empty output | Output contains data | Data pipeline features (CR-43) |

**Full VR-* reference (50+ types)**: [reference/vr-verification-reference.md](../../reference/vr-verification-reference.md)

---

## Auto-Verification Command Gate (Pre-Commit/Push)

| Gate | Command | Must |
|------|---------|------|
| 1. Pattern Scanner | `./scripts/pattern-scanner.sh` | Exit 0 |
| 2. Type Safety | `npx tsc --noEmit` | 0 errors |
| 3. Build | `npm run build` | Exit 0 |
| 4. Lint | `npm run lint` | Exit 0 |
| 5. Schema | `npx prisma validate` | Exit 0 |
| 6. Secrets Staged | `git diff --cached --name-only \| grep -E '\.(env\|pem\|key\|secret)'` | 0 files |
| 7. Credentials | `grep -rn "sk-\|password.*=.*['\"]" --include="*.ts" --include="*.tsx" src/ \| grep -v "process.env"` | 0 matches |

---

## Database Environments

| Environment | Description | MCP Tool Prefix |
|-------------|-------------|-----------------|
| DEV | Local development, testing | `mcp__supabase__DEV__` |
| PROD | Production database | `mcp__supabase__PROD__` |

> **Note**: Project-specific Supabase project IDs should be configured in the project's CLAUDE.md or `.env` file, not in shared references.
