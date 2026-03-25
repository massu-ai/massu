---
name: massu-batch
description: "When user wants to apply the same code-only change across multiple files in parallel — 'batch update', 'apply to all', 'migrate these files'"
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---
name: massu-batch

# Massu Batch: Parallel Code Migration via Worktree Agents

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding.

---

## Workflow Position

```
/massu-batch [migration] → /massu-simplify → /massu-commit → /massu-push
```

**This command is for CODE-ONLY migrations. It REFUSES database work.**

---

## What This Command Does

Takes a migration description, identifies all affected files, splits them into batches, and spawns parallel agents in isolated git worktrees. Each agent transforms its files independently, runs checks, and the results merge back into your branch.

**Best for**: Import renames, component swaps, API call updates, class name migrations, pattern replacements across 5+ files.

**NOT for**: New features, database migrations, changes requiring cross-file coordination.

---

## EXECUTION PROTOCOL

### Step 1: Parse Migration Description

Read `$ARGUMENTS` for the migration description.

If no arguments provided, ask:
- **Search pattern**: What to find (glob pattern or grep pattern)
- **Transformation**: What to change it to
- **Scope**: Directory to limit search (default: `src/`)

### Step 2: DB Guard (Safety Gate — MANDATORY)

**This step CANNOT be skipped. No exceptions.**

Check the migration description for these keywords:
```
migration, schema, ALTER, CREATE TABLE, DROP, column, RLS, GRANT,
database, prisma, supabase, ctx.db, ctx.prisma, $queryRaw, execute_sql
```

And check target file paths for:
```
src/server/api/routers/
src/lib/db
prisma/
supabase/migrations/
```

**If ANY check triggers**: HALT immediately with:

```
## DB GUARD: Migration Blocked

This migration touches database-related code. Database migrations require
sequential coordination across environments.

/massu-batch is designed for code-only migrations:
  - Import path changes
  - Component library swaps
  - API call updates
  - Renaming patterns
  - Style/class name migrations
  - Utility function swaps

To proceed with database work: /massu-create-plan → /massu-loop
```

**STOP HERE. Do not proceed. Do not offer workarounds.**

### Step 3: Identify Affected Files

```bash
# Use Grep to find all files matching the migration pattern
grep -rn "[search_pattern]" src/ --include="*.ts" --include="*.tsx" -l
```

If 0 files found: "No files match the migration pattern. Check your search pattern." STOP.
If < 5 files found: "Only N files affected. Consider making these changes manually instead of using /massu-batch." Offer to proceed anyway or cancel.

### Step 4: Planning Phase (Interactive — Requires User Approval)

Split files into batches:
- **Batch size**: 5-8 files per agent
- **Minimum agents**: 2 (otherwise manual is faster)
- **Maximum agents**: 15 (beyond this, consolidation risk increases)
- **Grouping strategy**: Group files from the same directory together when possible

Present the plan:

```markdown
## Batch Migration Plan

**Migration**: [description]
**Search pattern**: [pattern]
**Total files**: N
**Batches**: M agents x ~K files each

| Batch | Files | Directory |
|-------|-------|-----------|
| 1 | file1.tsx, file2.tsx, file3.tsx, file4.tsx, file5.tsx | src/components/ |
| 2 | file6.tsx, file7.tsx, file8.tsx, file9.tsx | src/app/ |
| 3 | file10.tsx, file11.tsx, file12.tsx | src/lib/ |

Each agent will:
1. Apply the transformation to its assigned files
2. Run pattern-scanner.sh --single-file on each changed file
3. Run tsc type check
4. Report results
```

**Wait for explicit user approval. Do NOT proceed without it.**

### Step 5: Execution Phase (Parallel Worktree Agents)

Spawn all agents simultaneously using the Agent tool with `isolation: "worktree"`:

```
FOR each batch (IN PARALLEL):
  result_{batch_id} = Agent(
    subagent_type="general-purpose",
    isolation="worktree",
    model="sonnet",
    description="Batch {batch_id}: migrate {N} files",
    prompt="
      You are a CODE MIGRATION AGENT. Apply this transformation to the assigned files.

      ## Migration
      {migration_description}

      ## Transformation Rule
      FIND: {search_pattern}
      REPLACE WITH: {replacement_pattern}

      ## Assigned Files
      {file_list_for_this_batch}

      ## Instructions
      For EACH file in your assignment:
      1. Read the file completely
      2. Apply the transformation — change ONLY what matches the pattern
      3. Do NOT modify unrelated code
      4. Do NOT add comments about the migration
      5. Do NOT change formatting or whitespace beyond the transformation
      6. Save the file

      After ALL files are modified:
      7. Run: ./scripts/pattern-scanner.sh --single-file [file] for each changed file
      8. If pattern-scanner finds violations, fix them
      9. Run: NODE_OPTIONS='--max-old-space-size=8192' npx tsc --noEmit
      10. If tsc finds errors in your changed files, fix them

      ## Output Format (MANDATORY)
      Return this EXACT structure:

      BATCH_ID: {batch_id}
      FILES_MODIFIED: [count]
      PATTERN_SCANNER: PASS | FAIL
      TSC_CHECK: PASS | FAIL
      CHANGES:
      - [file]: [brief description of change]
      - [file]: [brief description of change]
      ERRORS: [any errors encountered, or NONE]
    "
  )
END FOR
```

**All agents run simultaneously.** This is the core parallelization benefit.

### Step 6: Consolidation Phase

After ALL agents complete:

1. **Collect results** from each agent
2. **Check for failures**:
   - If any agent's worktree has changes, the branch name is returned
   - Failed agents: log the failure, mark batch as needs-retry
3. **Merge worktree branches**:
   ```bash
   # For each successful agent's worktree branch:
   git merge [worktree-branch] --no-edit
   # If merge conflict: flag for manual resolution
   ```
4. **Handle conflicts**:
   - Conflicts should be RARE since files don't overlap between batches
   - If conflicts occur: report to user with conflicting files and stop
   - User can resolve manually and re-run verification

### Step 7: Verification Phase

Run on the consolidated result:

```bash
# Full pattern scanner
./scripts/pattern-scanner.sh

# Full type check
NODE_OPTIONS="--max-old-space-size=8192" npx tsc --noEmit

# Build check
npm run build
```

### Step 8: Output Structured Result

```markdown
## /massu-batch Results

**Migration**: [description]
**Total files**: N across M batches
**Duration**: Xs

| Batch | Files | Agent Status | Pattern Scanner | TSC |
|-------|-------|-------------|-----------------|-----|
| 1 | 5 | PASS | PASS | PASS |
| 2 | 5 | PASS | PASS | PASS |
| 3 | 3 | PASS | PASS | PASS |

### Consolidated Verification

| Check | Status |
|-------|--------|
| Pattern Scanner (full) | PASS / FAIL |
| TypeScript (full) | PASS / FAIL |
| Build | PASS / FAIL |

BATCH_GATE: PASS

### Changes Summary
- [file]: [change]
- [file]: [change]
...

### Next Steps
1. Run /massu-simplify for efficiency review (recommended)
2. Run /massu-commit to commit
3. Run /massu-push to push
```

If verification fails:

```
BATCH_GATE: FAIL

### Failures
- [check]: [error details]

### Recovery Options
1. Fix the failing files manually, then re-run verification
2. Run /massu-batch again with adjusted scope
3. Abort and use /massu-loop for sequential implementation
```

### Step 9: Cleanup

Worktrees are auto-cleaned by the Agent tool. If any remain:

```bash
# List lingering worktrees
git worktree list

# Remove if needed (user confirmation required)
git worktree remove [path]
```

---

## SAFETY RULES

| Rule | Enforcement |
|------|-------------|
| **No database changes** | DB guard inline keyword check + path check |
| **User approval required** | Interactive approval before execution phase |
| **No file overlap between batches** | Planning phase ensures each file appears in exactly one batch |
| **Per-agent verification** | Each agent runs pattern-scanner + tsc before completing |
| **Consolidated verification** | Full checks run after merge |
| **Merge conflicts halt execution** | No automatic conflict resolution |

---

## EXAMPLES

```bash
# Rename an import path
/massu-batch "change all imports from @/components/ui/old-button to @/components/ui/button"

# Replace a deprecated hook
/massu-batch "replace all useToast() calls with the new toast() pattern from @/components/ui/sonner"

# Migrate CSS classes
/massu-batch "replace className='container mx-auto' with className='page-container' in all page files"

# Update API calls
/massu-batch "update all fetch('/api/v1/...') calls to fetch('/api/v2/...') in src/lib/integrations/"
```

---

## WHEN NOT TO USE THIS COMMAND

| Scenario | Use Instead |
|----------|-------------|
| Database/schema changes | `/massu-loop` |
| < 5 files affected | Manual changes + `/massu-simplify` |
| New feature development | `/massu-create-plan` → `/massu-loop` |
| Cross-file dependencies | `/massu-loop` (sequential is safer) |
| Changes needing plan coverage | `/massu-loop` (has plan audit loop) |

## Gotchas

- **NEVER for database work** — batch migrations are CODE-ONLY. Database migrations must be applied to all environments in sequence, which requires coordination that parallel agents cannot provide
- **Worktree isolation** — each agent runs in a git worktree. Changes must be mergeable. Agents editing the same file will cause merge conflicts
- **One task per agent** — each worktree agent gets exactly one plan item. Never combine unrelated items in a single agent
