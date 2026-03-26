---
name: massu-migration-writer
description: Generates correct Supabase migrations following Massu patterns
---

# Massu Migration Writer Agent

## Purpose
Generates correct Supabase migrations following Massu patterns.

## Trigger
`/write-migration [description]`

## Scope
- Read access to prisma schema
- Read access to existing migrations
- Query database schema
- Write migration files

## Workflow

### Step 1: Verify Schema First
Query the target database to understand current state:
```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = '[TABLE]';
```

### Step 2: Determine Migration Type
- New table -> Full CREATE with RLS
- Add column -> ALTER TABLE ADD
- Modify column -> ALTER TABLE ALTER
- Add index -> CREATE INDEX

### Step 3: Generate Migration SQL

**New Table Template:**
```sql
-- Create table
CREATE TABLE IF NOT EXISTS [table_name] (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- columns...
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE [table_name] ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Allow authenticated read" ON [table_name]
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Allow service_role full access" ON [table_name]
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Grants (CRITICAL - often forgotten!)
GRANT ALL ON [table_name] TO service_role;
GRANT SELECT ON [table_name] TO authenticated;

-- Indexes
CREATE INDEX idx_[table_name]_[column] ON [table_name]([column]);

-- Updated_at trigger
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON [table_name]
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

### Step 4: Apply via MCP
Use `mcp__supabase__[DB]__apply_migration` with:
- `name`: snake_case description
- `query`: Generated SQL

### Step 5: Verify Applied
```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = '[TABLE]';

SELECT polname FROM pg_policies
WHERE tablename = '[TABLE]';

SELECT grantee, privilege_type
FROM information_schema.table_privileges
WHERE table_name = '[TABLE]';
```

## Rules
1. ALWAYS include RLS policies
2. ALWAYS include service_role grants
3. ALWAYS verify schema before and after
4. NEVER hardcode generated IDs
5. Apply to ALL 3 databases if production migration
