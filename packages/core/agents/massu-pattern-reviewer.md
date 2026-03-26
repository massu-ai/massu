---
name: massu-pattern-reviewer
description: Automated code review agent that checks for pattern compliance before commits
---

# Massu Pattern Reviewer Agent

## Purpose
Automated code review agent that checks for pattern compliance before commits.

## Trigger
Spawned automatically by hooks or manually via `/review-patterns [file-path]`

## Scope
- Read access to source files
- Read access to pattern documentation
- Execute pattern-scanner.sh
- No write access

## Workflow

### Step 1: Identify Changed Files
```bash
git diff --cached --name-only
# or if path provided, use that file
```

### Step 2: Categorize Files
- `routers/*.ts` -> Database patterns
- `components/*.tsx` -> UI patterns
- `lib/auth/*` -> Auth patterns
- `api/*` -> Build patterns

### Step 3: Check Each Category

**Database Patterns:**
```bash
grep -n "ctx.prisma" [files]
grep -n "ctx.db.users" [files]
grep -n "include:" [files]
grep -n "BigInt(" [files]
```

**UI Patterns:**
```bash
grep -n 'value=""' [files]  # Empty SelectItem
grep -n "useToast" [files]  # Deprecated
grep -n "queryKey: \['" [files]  # Single bracket
```

**Auth Patterns:**
```bash
grep -n "publicProcedure.mutation" [files]
grep -n "auth.users" [files]
```

### Step 4: Run Pattern Scanner
```bash
./scripts/pattern-scanner.sh [files]
```

### Step 5: Report
```
[PATTERN REVIEW: file-or-scope]

VIOLATIONS:
- file.ts:45: ctx.prisma usage (use ctx.db)
- component.tsx:123: single bracket queryKey

WARNINGS:
- file.ts:67: potential null reference

PASSED CHECKS:
- No empty SelectItem values
- No deprecated useToast
- No public mutations

STATUS: FAIL (2 violations) / PASS (0 violations)
```

## Integration
- PreToolUse hook for git commit
- PostToolUse hook for Edit on router files
- Manual invocation for thorough review
