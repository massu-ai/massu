---
name: massu-rebuild
description: Safe rebuild/replacement protocol enforcing feature parity before deletion
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---
name: massu-rebuild

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9, CR-35 enforced.

# Massu Rebuild: Safe Rebuild/Replacement Protocol

## Objective

Execute a SAFE rebuild/replacement of an existing module, tool, hook, or system that enforces:
1. **Catalog ALL old features BEFORE deleting anything**
2. **CR-9**: Fix ALL issues encountered, whether from current changes or pre-existing
3. **VR-PARITY**: 100% feature parity required before deletion is permitted

**Philosophy**: "Rebuild" means "replicate everything old PLUS build new". It does NOT mean "build new from scratch and hope you remembered everything."

---

## NON-NEGOTIABLE RULES

- **Catalog before delete** - NEVER delete old code until 100% parity checklist is verified
- **CR-9: Fix ALL issues** - If ANY issue is discovered during rebuilding - whether from current changes OR pre-existing - fix it immediately. "Not in scope" and "pre-existing" are NEVER valid reasons to skip a fix.
- **FIX ALL ISSUES ENCOUNTERED (CR-9)** - When fixing a bug, search entire codebase for same pattern and fix ALL instances.
- **Proof required** - Show grep/command output as evidence for each parity item
- **No assumptions** - Read old code before building new
- **Zero shortcuts** - Quality is imperative

---

## ZERO-GAP AUDIT LOOP

**Rebuild does NOT complete until a SINGLE COMPLETE PARITY AUDIT finds ZERO gaps.**

```
Loop:
  1. Run full parity check (compare Old vs New feature list)
  2. Count GAPS_DISCOVERED
  3. If GAPS_DISCOVERED > 0:
     - Fix ALL gaps found in this pass
     - Spawn FRESH parity audit (do NOT continue current audit)
  4. If GAPS_DISCOVERED == 0:
     - Deletion is permitted
     - Report REBUILD COMPLETE
```

**GAPS_DISCOVERED semantics**: Count ALL gaps FOUND in a pass, even if fixed in the same pass. Finding 5 gaps and fixing all 5 = GAPS_DISCOVERED: 5, NOT 0. Only a FRESH pass finding nothing wrong proves correctness.

---

## Phase 0: CATALOG Old Implementation (MANDATORY FIRST STEP)

**Before writing a single line of new code, you MUST catalog EVERYTHING in the old implementation.**

### 0.1 Read Old Implementation Completely

```bash
# Read the old file(s) completely
# Do NOT start Phase 1 until this step is DONE
```

### 0.2 Create Feature Catalog

For each old file being replaced, create an exhaustive list:

| Category | Old Feature | Line(s) | Notes |
|----------|-------------|---------|-------|
| Exports | `export function X(...)` | L42 | - |
| Types/Interfaces | `interface Props { ... }` | L10-25 | - |
| Tool definitions | `getXToolDefinitions()` | L80 | - |
| Tool handlers | `handleXToolCall()` | L120 | - |
| Config access | `getConfig().toolPrefix` | L155 | - |
| DB operations | `memDb.prepare(...)` | L200 | - |
| Error handling | `try/catch`, error responses | L300 | - |
| Helper functions | Internal utility functions | L350 | - |
| Constants | Exported or internal constants | L400 | - |

### 0.3 Document What MUST Be Preserved

Explicitly list items that MUST exist in the new implementation:
- [ ] Feature A
- [ ] Feature B
- [ ] Feature C (etc.)

---

## Phase 1: PARITY CHECKLIST (Old vs New Comparison)

**This is a living document. Update as you build.**

### Parity Template

| Feature | Old Location | New Location | Status |
|---------|--------------|--------------|--------|
| Feature A | `OldFile.ts:42` | `NewFile.ts:???` | PENDING |
| Feature B | `OldFile.ts:80` | `NewFile.ts:???` | PENDING |

Status values: `PENDING` | `IN PROGRESS` | `DONE` | `INTENTIONAL_REMOVAL` (requires justification)

### Intentional Removals

If any old feature is intentionally NOT carried forward, document WHY:

| Feature | Reason for Removal | Approved By |
|---------|--------------------|-------------|
| Feature X | Deprecated, replaced by Feature Y | Session notes |

---

## Phase 2: IMPLEMENT New Version

### 2.1 Implementation Rules

- Reference the parity checklist at each step
- Mark each feature as DONE when implemented and verified
- Do NOT mark the implementation complete until ALL items are DONE or INTENTIONAL_REMOVAL

### 2.2 Per-Feature Verification

For EACH item in the parity checklist, verify with grep:

```bash
grep -n "feature_name_pattern" path/to/new-file.ts
# Expected: Match found
```

---

## Phase 3: VERIFY PARITY (VR-PARITY Gate)

**This gate BLOCKS deletion of old code. Do NOT proceed to Phase 4 until this passes.**

### VR-PARITY Checklist

Run this checklist before deleting old code:

- [ ] ALL parity items are DONE or INTENTIONAL_REMOVAL
- [ ] Zero PENDING items remain
- [ ] Each DONE item has grep proof
- [ ] Each INTENTIONAL_REMOVAL has documented justification
- [ ] New implementation builds without errors (`npm run build`)
- [ ] TypeScript passes (`cd packages/core && npx tsc --noEmit`)
- [ ] Tests pass (`npm test`)

### VR-PARITY Gate Command

```bash
# Count pending parity items
grep -c "PENDING" /path/to/parity-checklist.md
# Expected: 0

# Build verification
npm run build
# Expected: Exit 0
```

**If ANY item is PENDING: DO NOT DELETE. Continue implementing.**

---

## Phase 4: DELETE OLD (Only After 100% Parity)

**Deletion is permitted ONLY when VR-PARITY gate passes (0 PENDING items).**

### 4.1 Final Verification Before Delete

```bash
# One last count of pending items
grep -c "PENDING" /path/to/parity-checklist.md
# Expected: 0

# Confirm new file exists
ls -la path/to/new-file.ts
# Expected: File exists
```

### 4.2 Delete Old Code

After VR-PARITY passes:
- Remove old file(s)
- Remove old imports
- Update all references to point to new implementation

### 4.3 Post-Delete Verification

```bash
# Verify old file is gone
ls path/to/old-file.ts 2>/dev/null && echo "STILL EXISTS - MANUAL DELETE NEEDED" || echo "DELETED OK"

# Verify no dangling imports
grep -rn "old-file" packages/core/src/ | wc -l
# Expected: 0

# Final build
npm run build
# Expected: Exit 0
```

---

## AUTO-LEARNING PROTOCOL (MANDATORY after every rebuild)

**After EVERY rebuild, the system MUST automatically learn. This is NOT optional.**

### Step 1: Record Correct vs Incorrect Pattern

Update session state with:
- WRONG: [what the old code did that violated patterns]
- CORRECT: [what the new code does]

### Step 2: Add to Pattern Scanner (if grep-able)

If the bad pattern is detectable by grep, add check to `scripts/massu-pattern-scanner.sh`.

### Step 3: Search Codebase-Wide (CR-9)

```bash
grep -rn "[bad_pattern]" packages/core/src/
# Expected: 0 matches (after fixing all instances)
```

---

## VR-PARITY Template

Copy this template to track parity for each rebuild:

```markdown
## VR-PARITY: [Module Name] Rebuild

**Old file**: `path/to/old-file.ts`
**New file**: `path/to/new-file.ts`
**Date**: YYYY-MM-DD

| Feature | Old Location | New Location | Status | Proof |
|---------|--------------|--------------|--------|-------|
| | | | PENDING | |

**Gate status**: [ ] PENDING [ ] PASS
**Items remaining**: N
**Intentional removals**: N
```

---

## START NOW

**Step 0: Write AUTHORIZED_COMMAND to session state (CR-35)**

Before any other work, update `session-state/CURRENT.md` to include:
```
AUTHORIZED_COMMAND: massu-rebuild
```
This ensures that if the session compacts, the recovery protocol knows `/massu-rebuild` was authorized.

**Step 1: Read old implementation (Phase 0)**
**Step 2: Build parity checklist (Phase 1)**
**Step 3: Implement new version (Phase 2)**
**Step 4: Verify parity (Phase 3) - gate before deletion**
**Step 5: Delete old code (Phase 4) - ONLY after gate passes**
**Step 6: Auto-learning**

**Remember: Rebuild without a parity checklist is an incident.**
