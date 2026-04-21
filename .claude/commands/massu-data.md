---
name: massu-data
description: "When user asks about data trends, metrics, analytics, funnel analysis, cohort comparison, entity counts, storage usage, or 'what happened' questions about the database"
allowed-tools: Bash(*), Read(*), Grep(*), Glob(*), mcp__supabase__DEV__*, mcp__supabase__NEW_PROD__*, mcp__supabase__OLD_PROD__*
---

# Data Analysis

Structured data analysis and query library for Massu databases.

## Skill Contents

This skill is a folder. The following files are available for reference:

| File | Purpose | Read When |
|------|---------|-----------|
| `references/common-queries.md` | Pre-built Supabase queries | Looking for a query template |
| `references/table-guide.md` | Key tables and relationships | Understanding data model |
| `scripts/entity-counts.sql` | Quick entity count dashboard | Need a system overview |
| `scripts/funnel-query.sql` | Contact lifecycle funnel | Analyzing conversion |
| `scripts/cohort-compare.sql` | Compare two date ranges | Trend analysis |
| `scripts/storage-usage.sql` | Storage bucket analysis | Checking disk usage |

## Process

1. **Understand the question** — What data does the user need?
2. **Identify target database** — DEV (testing), NEW PROD (live data), OLD PROD (historical)
3. **Check for pre-built query** — Review `scripts/` for a matching SQL template
4. **Verify schema** — Run VR-SCHEMA-PRE before any custom query
5. **Execute query** — Use MCP `execute_sql` tool
6. **Present results** — Format as table with clear labels

## Database Selection

| User Says | Database |
|-----------|----------|
| "production", "live", "real data" | NEW PROD |
| "dev", "test", "local" | DEV |
| "old prod", "historical" | OLD PROD |
| No qualifier | NEW PROD (default) |

## Key Tables

| Domain | Primary Table | Related Tables |
|--------|---------------|----------------|
| Contacts | `unified_contacts` | `contact_activities`, `contact_tags` |
| Products | `unified_products` | `furniture_dimensions`, `product_images` |
| Orders | `orders` | `order_items`, `order_line_items` |
| Proposals | `proposals` | `proposal_sections`, `proposal_items` |
| Documents | `unified_documents` | `document_versions`, `document_comments` |
| Users | `user_profiles` | `portal_access`, `user_roles` |

## Gotchas

- **NEVER use `ctx.db.users`** — use `user_profiles` (auth.users not exposed)
- **NEVER guess column names** — always VR-SCHEMA-PRE first
- **BigInt columns** — convert with `::text` in SQL or `Number()` in JS
- **Decimal columns** — unified_products has 8 Decimal columns, use `::float` for display
- **RLS policies** — MCP queries run as service_role, bypassing RLS. Be aware of what data you're exposing.

## START NOW

Ask the user what data they need, then:
1. Check `scripts/` for a pre-built query
2. If custom query needed, verify schema first
3. Execute and present results
