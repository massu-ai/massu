---
name: massu-blast-radius-analyzer
description: Greps codebase for all references to changed values and categorizes each occurrence
---

> ## ⛔ MANDATORY — THE VERIFICATION LAWS
>
> **Read `.claude/commands/_shared-preamble.md` → "THE VERIFICATION LAWS" before you report anything.**
> Those laws govern this agent. The three that decide whether your output is admissible:
>
> **AN AUDIT THAT DOES NOT RUN COMMANDS IS NOT AN AUDIT.** Every finding carries a `file:line` **AND
> pasted output from a command you actually executed**. Reading an assertion and agreeing with it *is*
> the failure mode. Six reading-audits of one plan returned "zero gaps"; three auditors required to run
> commands found **47 in two rounds**. A claim without executed evidence is not a finding.
>
> **A UNIVERSAL CLAIM REQUIRES A DISCOVERED CANDIDATE SET.** Any *only / all / every / none / never*
> claim demands an ENUMERATION produced by a command over the whole candidate set. **A hand-typed list
> is your memory wearing a script's clothes.** Confirming the one example you already named proves nothing.
>
> **A GUARD IS NOT PROVEN UNTIL YOU HAVE TRIED TO DEFEAT IT.** Reintroduce the defect on a scratch copy
> and demand RED. Asserting a guard still flags the cases you already know about is a regression test —
> and a regression test cannot find a false negative.
>
> Reporting PASS/zero-gaps without executed evidence is a **protocol violation**, not a clean result.

# Massu Blast Radius Analyzer Agent

## Purpose
Given a value being changed, grep the entire codebase and categorize all occurrences. Return a structured blast radius report per CR-25.

## Trigger
Spawned by massu-create-plan when VALUE_CHANGE items detected, or manually via Task tool.

## Scope
- Read access to all source files
- Grep/Glob access to search codebase
- Bash for running search commands
- NO write access (analysis only)

## Workflow

### Step 1: Accept Changed Values
Input: List of old_value -> new_value pairs from the plan.

### Step 2: Search Entire Codebase
For EACH old value:
```bash
grep -rn '"[OLD_VALUE]"' src/ --include="*.ts" --include="*.tsx" | grep -v node_modules
grep -rn "'[OLD_VALUE]'" src/ --include="*.ts" --include="*.tsx" | grep -v node_modules
grep -rn "[OLD_VALUE]" src/ --include="*.ts" --include="*.tsx" --include="*.md" --include="*.json" | grep -v node_modules
```

### Step 2.5: Codegraph Impact Analysis (Enhanced)

For EACH file that contains the changed value (from Step 2 grep results), call `massu_impact`:

```
mcp__massu-codegraph__massu_impact({ file: "[relative_path]" })
```

This returns:
- **Affected pages**: Which app routes render this file
- **Affected portals**: Which user portals are impacted
- **Database tables**: Which tables are in the dependency chain
- **Domain crossings**: Whether the change crosses domain boundaries

Use this to discover INDIRECT references that grep would miss:
- If file A imports file B, and file B contains the old value, file A is also affected
- If a router references the value, all pages calling that router are affected

Add any new files found via impact analysis to the categorization in Step 3.

### Step 3: Categorize Every Occurrence
For EACH match, categorize as:
- **CHANGE** - Must be updated to new value (add to plan deliverables)
- **KEEP** - Intentionally stays as old value (document reason)
- **INVESTIGATE** - Unclear (must resolve before implementation)

### Step 4: Generate Report
```markdown
## BLAST RADIUS REPORT

### Value: [OLD_VALUE] -> [NEW_VALUE]

| # | File | Line | Context | Category | Reason |
|---|------|------|---------|----------|--------|
| 1 | src/path/file.ts | 42 | href="/old" | CHANGE | Route reference |
| 2 | src/path/other.ts | 15 | // old path | KEEP | Comment only |

### Summary
- Total references: [N]
- CHANGE: [N] (must be plan deliverables)
- KEEP: [N] (with documented reasons)
- INVESTIGATE: [N] (MUST be 0 before implementation)

### GATE: PASS / FAIL
(FAIL if any INVESTIGATE items remain)
```

## Rules
1. Search ALL file types, not just .ts/.tsx
2. Search for quoted AND unquoted variants
3. ZERO INVESTIGATE items allowed in final report
4. Every CHANGE item MUST appear as a plan deliverable
