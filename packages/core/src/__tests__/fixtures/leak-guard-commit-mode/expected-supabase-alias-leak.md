# Fake fixture — Supabase MCP alias leak (drift-guard)

This fixture INTENTIONALLY contains a concrete Supabase MCP server alias so the
leak-guard's generic `mcp__supabase__<ALIAS>__` pattern is exercised. The id and
alias below are FAKE — never real operator values. The alias `FAKEENV` is
deliberately NOT one of the operator-named environment aliases, so this fixture
exercises the GENERIC pattern without itself matching the operator-alias catalog.

| Environment | Project ID | MCP Tool Prefix |
|-------------|------------|-----------------|
| FAKEENV | `zzzzzzzzzzzzzzzzzzzz` | `mcp__supabase__FAKEENV__` |

Query: `mcp__supabase__FAKEENV__execute_sql`
