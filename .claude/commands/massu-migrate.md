---
name: massu-migrate
description: Database migration creation, validation, RLS verification, ordering check, and rollback generation
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---
name: massu-migrate

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9, CR-35 enforced.

# CS Migrate: Database Migration Workflow

## Objective

Create and verify Supabase migrations with full safety checks. Supports three modes: creating new migrations, validating existing migrations, and quick health checks.

**Usage**:
- `/massu-migrate create [name]` — Create new migration from specification
- `/massu-migrate validate` — Validate all existing migrations
- `/massu-migrate check` — Quick health check (ordering, RLS coverage)

## STEP 0: MEMORY CHECK

Before creating migrations, check for:
- Past migration failures in session state
- Known schema issues in the project
- Existing migration files that might conflict

```bash
ls packages/core/src/migrations/ 2>/dev/null || echo "No migrations directory"
```

---

## NON-NEGOTIABLE RULES

- Every new table MUST have RLS enabled
- Every new table MUST have at least one SELECT policy
- Tables with write operations MUST have INSERT/UPDATE policies with ownership checks
- Foreign key columns MUST have indexes
- Tables with `updated_at` MUST have `update_updated_at()` trigger
- Migration numbering MUST be sequential (no gaps, no duplicates)
- Naming: table names snake_case, column names snake_case, index names `idx_[table]_[column]`

---

## STEP 1: MIGRATION INVENTORY

```bash
# List all migrations
ls -1 website/supabase/migrations/ 2>/dev/null | sort

# Extract sequence numbers, verify sequential
ls -1 website/supabase/migrations/ 2>/dev/null | grep -oP '^\d+' | sort -n

# Count total
ls -1 website/supabase/migrations/ 2>/dev/null | wc -l
```

```markdown
### Migration Inventory
- **Total migrations**: [N]
- **Latest sequence number**: [N]
- **Ordering issues**: [none / details]
```

---

## STEP 2: CREATE MODE (if `create`)

### 2.1 Determine Next Sequence Number

```bash
# Get the latest migration number and increment
LATEST=$(ls -1 website/supabase/migrations/ 2>/dev/null | grep -oP '^\d+' | sort -n | tail -1)
NEXT=$((LATEST + 1))
echo "Next migration number: $(printf '%03d' $NEXT)"
```

### 2.2 Read Recent Migrations for Pattern Reference

```bash
# Read the 2 most recent migrations
ls -1 website/supabase/migrations/ 2>/dev/null | sort | tail -2
```

Read both files to understand the project's SQL patterns.

### 2.3 Generate Migration SQL

Follow these patterns for every new migration:

#### Table Creation Pattern
```sql
-- [NNN]_[name].sql
-- Description: [what this migration does]

CREATE TABLE IF NOT EXISTS [table_name] (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Foreign keys
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Data columns
  [column_name] [TYPE] [NOT NULL] [DEFAULT],
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Constraints
ALTER TABLE [table_name] ADD CONSTRAINT [name] CHECK ([condition]);
ALTER TABLE [table_name] ADD CONSTRAINT [name] UNIQUE ([columns]);
```

#### RLS Pattern (MANDATORY for every new table)
```sql
-- Enable RLS
ALTER TABLE [table_name] ENABLE ROW LEVEL SECURITY;

-- SELECT policy for org members
CREATE POLICY "[table_name]_select" ON [table_name]
  FOR SELECT USING (org_id = get_user_org_id());

-- INSERT policy with ownership
CREATE POLICY "[table_name]_insert" ON [table_name]
  FOR INSERT WITH CHECK (org_id = get_user_org_id());

-- UPDATE policy with ownership
CREATE POLICY "[table_name]_update" ON [table_name]
  FOR UPDATE USING (org_id = get_user_org_id());

-- service_role full access (for edge functions)
CREATE POLICY "[table_name]_service" ON [table_name]
  FOR ALL USING (auth.role() = 'service_role');
```

#### Index Pattern
```sql
-- Index on foreign keys
CREATE INDEX idx_[table]_[fk_column] ON [table_name]([fk_column]);

-- Index on commonly filtered columns
CREATE INDEX idx_[table]_[column] ON [table_name]([column]);

-- Conditional index for nullable columns
CREATE INDEX idx_[table]_[column] ON [table_name]([column]) WHERE [column] IS NOT NULL;
```

#### Trigger Pattern
```sql
-- Auto-update updated_at timestamp
CREATE TRIGGER update_[table]_updated_at
  BEFORE UPDATE ON [table_name]
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
```

### 2.4 Write Migration File

Write to `website/supabase/migrations/[NNN]_[name].sql`

---

## STEP 3: VALIDATE MODE (if `validate`)

For ALL migration files, run these checks:

### 3.1 SQL Syntax Check

```bash
# Parse for common SQL syntax issues
for f in $(find website/supabase/migrations -name "*.sql" 2>/dev/null | sort); do
  echo "=== Checking: $f ==="
  # Unclosed parentheses
  OPEN=$(grep -o '(' "$f" | wc -l)
  CLOSE=$(grep -o ')' "$f" | wc -l)
  if [ "$OPEN" -ne "$CLOSE" ]; then
    echo "WARNING: Mismatched parentheses ($OPEN open, $CLOSE close)"
  fi
  # Missing semicolons on statements
  grep -n 'CREATE TABLE\|CREATE INDEX\|ALTER TABLE\|CREATE POLICY\|CREATE TRIGGER\|INSERT INTO\|UPDATE \|DELETE FROM' "$f" | while read line; do
    LINENUM=$(echo "$line" | cut -d: -f1)
    # Check if statement eventually ends with semicolon (simplified check)
    echo "  Statement at line $LINENUM"
  done
done
```

### 3.2 Reference Integrity

```bash
# For each REFERENCES clause, check that the target table exists
for f in $(find website/supabase/migrations -name "*.sql" 2>/dev/null | sort); do
  grep -oP 'REFERENCES\s+(\w+)' "$f" | while read ref; do
    TABLE=$(echo "$ref" | awk '{print $2}')
    # Check if table is created in this or earlier migration
    if ! grep -q "CREATE TABLE.*$TABLE" website/supabase/migrations/*.sql 2>/dev/null; then
      echo "MISSING TABLE: $TABLE referenced in $f"
    fi
  done
done
```

### 3.3 RLS Coverage

```bash
# For every CREATE TABLE, check for ENABLE ROW LEVEL SECURITY
for f in $(find website/supabase/migrations -name "*.sql" 2>/dev/null | sort); do
  grep -oP 'CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(\w+)' "$f" | while read match; do
    TABLE=$(echo "$match" | awk '{print $NF}')
    if ! grep -q "ALTER TABLE.*$TABLE.*ENABLE ROW LEVEL SECURITY" website/supabase/migrations/*.sql 2>/dev/null; then
      echo "MISSING RLS: $TABLE (in $f)"
    fi
  done
done
```

### 3.4 Index Coverage

```bash
# Every FK column should have an index
for f in $(find website/supabase/migrations -name "*.sql" 2>/dev/null | sort); do
  grep -oP 'REFERENCES\s+\w+' "$f" 2>/dev/null | while read ref; do
    # Extract the column name from the line context
    echo "  FK reference in $f: $ref — verify index exists"
  done
done
```

### 3.5 Trigger Coverage

```bash
# Every table with updated_at should have update_updated_at() trigger
for f in $(find website/supabase/migrations -name "*.sql" 2>/dev/null | sort); do
  grep -oP 'CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(\w+)' "$f" | while read match; do
    TABLE=$(echo "$match" | awk '{print $NF}')
    if grep -q "updated_at" "$f"; then
      if ! grep -q "update_${TABLE}_updated_at\|update.*${TABLE}.*updated" website/supabase/migrations/*.sql 2>/dev/null; then
        echo "MISSING TRIGGER: $TABLE has updated_at but no update trigger"
      fi
    fi
  done
done
```

### 3.6 Naming Conventions

```bash
# Table names should be snake_case
grep -oP 'CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(\w+)' website/supabase/migrations/*.sql 2>/dev/null | \
  grep '[A-Z]' && echo "NAMING: Found non-snake_case table names" || echo "NAMING: All table names are snake_case"

# Check for destructive operations
grep -n 'DROP TABLE\|DROP COLUMN\|TRUNCATE' website/supabase/migrations/*.sql 2>/dev/null && \
  echo "WARNING: Destructive operations found — verify intentional" || echo "No destructive operations found"
```

```markdown
### Validation Results

| Check | Files | Issues | Status |
|-------|-------|--------|--------|
| SQL Syntax | [N] | [N] | PASS/WARN/FAIL |
| Reference Integrity | [N] | [N] | PASS/FAIL |
| RLS Coverage | [N] tables | [N] missing | PASS/FAIL |
| Index Coverage | [N] FKs | [N] missing | PASS/WARN |
| Trigger Coverage | [N] tables | [N] missing | PASS/WARN |
| Naming Conventions | [N] | [N] violations | PASS/WARN |
| Destructive Operations | - | [N] found | INFO |
```

---

## STEP 4: TYPE SYNC CHECK

```bash
# For every table in migrations, verify corresponding type in types.ts
TYPES_FILE="website/src/lib/supabase/types.ts"
if [ -f "$TYPES_FILE" ]; then
  for TABLE in $(grep -oP 'CREATE TABLE(?:\s+IF NOT EXISTS)?\s+\K(\w+)' website/supabase/migrations/*.sql 2>/dev/null | sort -u); do
    if ! grep -qi "$TABLE" "$TYPES_FILE" 2>/dev/null; then
      echo "MISSING TYPE: $TABLE has no type alias in types.ts"
    fi
  done
else
  echo "types.ts not found at $TYPES_FILE"
fi
```

```markdown
### Type Sync Status

| Table | Type Exists | Status |
|-------|-------------|--------|
| [table] | YES/NO | PASS/FAIL |
```

---

## STEP 5: ROLLBACK GENERATION (for create mode)

Generate a rollback comment block at the bottom of the migration:

```sql
-- ============================================================
-- ROLLBACK (comment-only, not auto-executed)
-- Run these statements manually to reverse this migration
-- ============================================================
-- DROP TRIGGER IF EXISTS update_[table]_updated_at ON [table_name];
-- DROP POLICY IF EXISTS "[table_name]_service" ON [table_name];
-- DROP POLICY IF EXISTS "[table_name]_update" ON [table_name];
-- DROP POLICY IF EXISTS "[table_name]_insert" ON [table_name];
-- DROP POLICY IF EXISTS "[table_name]_select" ON [table_name];
-- DROP INDEX IF EXISTS idx_[table]_[column];
-- DROP TABLE IF EXISTS [table_name];
```

**Note**: DROP TABLE statements are in reverse dependency order. The rollback is comment-only and NOT auto-executed.

---

## COMPLETION REPORT

```markdown
## CS MIGRATE COMPLETE

### Mode: [create / validate / check]

### Migration Inventory
| Metric | Value |
|--------|-------|
| Total migrations | [N] |
| Latest sequence | [N] |
| Sequential ordering | YES/NO |

### Validation Results (if validate or check mode)
| Check | Status | Details |
|-------|--------|---------|
| Ordering | PASS/FAIL | [details] |
| RLS Coverage | PASS/FAIL | [N]/[N] tables covered |
| Reference Integrity | PASS/FAIL | [N] issues |
| Index Coverage | PASS/WARN | [N] FKs without index |
| Trigger Coverage | PASS/WARN | [N] tables without trigger |

### RLS Coverage Matrix (if validate or check mode)
| Table | RLS | SELECT | INSERT | UPDATE | service_role |
|-------|-----|--------|--------|--------|--------------|
| [table] | YES/NO | YES/NO | YES/NO | YES/NO | YES/NO |

### Type Sync Status
- **Tables in DB**: [N]
- **Types in code**: [N]
- **Missing types**: [list]

### Created Migration (if create mode)
- **File**: `website/supabase/migrations/[NNN]_[name].sql`
- **Tables created**: [list]
- **RLS policies**: [N]
- **Indexes**: [N]
- **Triggers**: [N]
- **Rollback SQL**: Included (commented)

### Next Steps
- Review generated SQL
- Run `/massu-migrate validate` to verify
- Apply with `supabase db push` (local) or `supabase db reset` (reset)
- Update types: `supabase gen types typescript --local > website/src/lib/supabase/types.ts`
```
