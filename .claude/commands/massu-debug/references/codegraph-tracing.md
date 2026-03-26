# Codegraph-Enhanced Tracing

How to use codegraph MCP tools for dependency tracing and understanding the full context before debugging.

---

## Tools and When to Use Them

| Tool | Purpose | Use When |
|------|---------|----------|
| `mcp__codegraph__codegraph_callers` | Who calls the buggy function? | Find all entry points that could trigger the bug |
| `mcp__codegraph__codegraph_callees` | What does the buggy function call? | Find all dependencies that might be the real source |
| `mcp__codegraph__codegraph_context` | Full context (CRs, patterns, schema) for a file | Get CLAUDE.md-aware context for the file being debugged |
| `mcp__massu-codegraph__massu_context` | Massu-specific context for the affected file | Schema alerts, pattern warnings specific to this file |
| `mcp__codegraph__codegraph_impact` | What would be affected by changes to this file? | Before making a fix, understand blast radius |
| `mcp__codegraph__codegraph_search` | Search for symbols/patterns across the codebase | When you need to find all instances of a pattern |

---

## Recommended Workflow

### Step 1: Identify the Buggy File/Function

From the error trace or user report, identify the file and function where the error originates.

### Step 2: Get Full Context

```
mcp__codegraph__codegraph_context(file: "src/server/api/routers/[router].ts")
```

This returns:
- Applicable CRs (Canonical Rules) for this file
- Known patterns that apply
- Schema information if database-related
- Import dependencies

### Step 3: Trace Callers (Upstream)

```
mcp__codegraph__codegraph_callers(symbol: "procedureName", file: "src/server/api/routers/[router].ts")
```

This reveals:
- Which UI components call this procedure
- Which other routers depend on it
- Entry points from API routes or cron jobs

### Step 4: Trace Callees (Downstream)

```
mcp__codegraph__codegraph_callees(symbol: "procedureName", file: "src/server/api/routers/[router].ts")
```

This reveals:
- What database operations the function performs
- What utility functions it depends on
- External service calls

### Step 5: Check Impact Before Fixing

```
mcp__codegraph__codegraph_impact(file: "src/server/api/routers/[router].ts")
```

Before applying a fix, understand what else could break.

---

## Key Principle

**Use these tools BEFORE forming hypotheses.** Understanding the full call graph prevents fixing symptoms instead of root causes.

A bug in the UI might actually originate in:
- The tRPC router (wrong query)
- The database layer (missing RLS)
- A utility function (incorrect transformation)
- The middleware (wrong routing)

Tracing callers and callees reveals the true source.
