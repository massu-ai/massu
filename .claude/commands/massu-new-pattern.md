---
name: massu-new-pattern
description: Create and save new patterns with approval workflow and CLAUDE.md integration
allowed-tools: Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---
name: massu-new-pattern

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9, CR-35 enforced.

# Massu New Pattern: Pattern Creation Protocol

## Objective

Create new patterns when existing patterns don't cover a required functionality, with proper approval workflow and documentation to ensure patterns are:
1. Well thought out with clear rationale
2. Explicitly approved by the user
3. Saved to CLAUDE.md/pattern files BEFORE implementation
4. Include WRONG vs CORRECT examples

---

## NON-NEGOTIABLE RULES

- **Never implement without pattern** - Custom approaches must be documented first
- **User approval required** - No pattern is saved without explicit user approval
- **WRONG/CORRECT required** - Every pattern must show what NOT to do and what TO do
- **Error consequence required** - Every pattern must explain what breaks if violated
- **Save BEFORE implement** - Pattern must be in CLAUDE.md before any code uses it

---

## ZERO-GAP AUDIT LOOP

**Pattern creation does NOT complete until a SINGLE COMPLETE VALIDATION finds ZERO gaps.**

```
Loop:
  1. Draft pattern with WRONG/CORRECT examples
  2. Present to user for review
  3. If user has feedback: incorporate ALL feedback
  4. Present updated pattern again
  5. Only when user explicitly approves: save to CLAUDE.md/patterns
  6. Verify pattern is saved (grep proof)
  7. If ANY step is incomplete: do NOT mark complete
```

**A pattern not saved to CLAUDE.md does not exist. File existence is the only proof.**

---

## WHEN TO USE THIS COMMAND

Use `/massu-new-pattern` when:
1. You need functionality with NO existing pattern in CLAUDE.md
2. Existing patterns don't fit the specific use case
3. You've verified no suitable pattern exists

---

## PHASE 1: VERIFY NO EXISTING PATTERN

### 1.1 Search All Pattern Sources

```bash
# Search CLAUDE.md
grep -n "[functionality]" .claude/CLAUDE.md

# Search pattern files
grep -rn "[functionality]" .claude/patterns/

# Search existing commands
grep -rn "[functionality]" .claude/commands/
```

### 1.2 Document Search Results

```markdown
### PATTERN SEARCH: [Functionality Name]

**Searched:**
- [ ] CLAUDE.md
- [ ] .claude/patterns/ (all files)
- [ ] .claude/commands/ (all files)

**Results:**
| Source | Related Pattern | Why Not Suitable |
|--------|-----------------|------------------|
| [file] | [pattern] | [reason] |
| None found | - | New pattern required |

**Conclusion:** New pattern required because [reason]
```

---

## PHASE 2: DEFINE THE NEW PATTERN

### 2.1 Pattern Definition Template

```markdown
## NEW PATTERN PROPOSAL

### Basic Information

| Field | Value |
|-------|-------|
| **Pattern Name** | [Short, descriptive name] |
| **Pattern ID** | [DOMAIN]-[NUMBER] (e.g., TOOL-015, CONFIG-008) |
| **Domain** | [Tool/Config/Hook/Build/Test] |
| **Purpose** | [What problem it solves] |
| **When to Use** | [Specific scenarios] |
| **Error if Violated** | [What breaks] |

### The Pattern

**WRONG (Never Do This):**
```[language]
// This is wrong because [reason]
[incorrect code example]
```

**CORRECT (Always Do This):**
```[language]
// This is correct because [reason]
[correct code example]
```

### Rationale

**Why this approach:**
1. [Reason 1]
2. [Reason 2]
3. [Reason 3]

**What it prevents:**
1. [Problem 1]
2. [Problem 2]

### Verification

How to check compliance:
```bash
# Command to find violations
grep -rn "[violation pattern]" packages/core/src/

# Command to verify correct usage
grep -rn "[correct pattern]" packages/core/src/
```
```

### 2.2 Examples for Different Domains

#### Tool Pattern Example:
```markdown
### Pattern Name: Config-Driven Tool Prefix
### Pattern ID: TOOL-012
### Domain: Tool
### Purpose: Ensure all tool names use configurable prefix
### When to Use: When defining any new MCP tool
### Error if Violated: Tools won't match when config uses different prefix

**WRONG:**
```typescript
// Hardcoded prefix - breaks for other projects
name: 'massu_my_tool',
```

**CORRECT:**
```typescript
// Config-driven prefix - works for any project
const p = (name: string) => `${getConfig().toolPrefix}_${name}`;
name: p('my_tool'),
```
```

#### Hook Pattern Example:
```markdown
### Pattern Name: Hook JSON Protocol
### Pattern ID: HOOK-005
### Domain: Hook
### Purpose: Ensure hooks communicate via JSON stdin/stdout
### When to Use: When creating any new hook
### Error if Violated: Hook fails silently, no output captured

**WRONG:**
```typescript
// Console.log output - not parseable
console.log('Hook result: success');
```

**CORRECT:**
```typescript
// JSON stdout - properly parsed by runner
process.stdout.write(JSON.stringify({ result: 'success' }));
```
```

---

## PHASE 3: USER APPROVAL

### 3.1 Present Pattern for Review

Display the full pattern definition to the user and explicitly ask:

```markdown
## NEW PATTERN APPROVAL REQUEST

I've defined a new pattern that doesn't exist in our documentation:

[Full pattern definition from Phase 2]

**Questions:**
1. Does this pattern make sense for our codebase?
2. Are the WRONG/CORRECT examples clear?
3. Should this be a CRITICAL rule (blocks deployment) or RECOMMENDED?
4. Any modifications needed?

**Please approve or request changes before I save this pattern.**
```

### 3.2 Handle Feedback

- If approved: Proceed to Phase 4
- If modifications requested: Update pattern definition, re-present
- If rejected: Document rejection reason, find alternative approach

---

## PHASE 4: SAVE PATTERN

### 4.1 Determine Save Location

| Pattern Type | Primary Location | Also Add To |
|--------------|------------------|-------------|
| Tool | `.claude/patterns/tool-patterns.md` | `CLAUDE.md` if CRITICAL |
| Config | `.claude/patterns/config-patterns.md` | `CLAUDE.md` if CRITICAL |
| Hook | `.claude/patterns/hook-patterns.md` | `CLAUDE.md` if CRITICAL |
| Build | `.claude/patterns/build-patterns.md` | `CLAUDE.md` if CRITICAL |
| Test | `.claude/patterns/test-patterns.md` | `CLAUDE.md` if CRITICAL |

### 4.2 Save to Pattern File

Add to the appropriate section in the pattern file:

```markdown
## [Pattern Name]

| Rule | Pattern | Error if Violated |
|------|---------|-------------------|
| [Short rule] | `[correct code]` | [What breaks] |

**WRONG:**
```[language]
[incorrect code]
```

**CORRECT:**
```[language]
[correct code]
```
```

### 4.3 Add to CLAUDE.md if CRITICAL

If pattern is CRITICAL (violation blocks deployment), add to CLAUDE.md:

```markdown
### [Domain] Rules

| Rule | Pattern | Error if Violated |
|------|---------|-------------------|
| [Pattern Name] | `[correct code]` | [What breaks] |
```

---

## PHASE 5: VERIFICATION

### 5.1 Verify Pattern Saved

```bash
# Verify in pattern file
grep -n "[Pattern Name]" .claude/patterns/[domain]-patterns.md

# Verify in CLAUDE.md (if CRITICAL)
grep -n "[Pattern Name]" .claude/CLAUDE.md
```

### 5.2 Document Pattern Addition

```markdown
### NEW PATTERN SAVED

| Field | Value |
|-------|-------|
| Pattern Name | [name] |
| Pattern ID | [ID] |
| Approved By | User (this session) |
| Saved To | [list of files] |
| Date | [timestamp] |

**Pattern is now available for use in implementations.**
```

---

## PHASE 6: UPDATE SESSION STATE

After saving pattern, update `session-state/CURRENT.md`:

```markdown
## NEW PATTERN CREATED

### Pattern
- **Name**: [pattern name]
- **ID**: [pattern ID]
- **Domain**: [domain]

### Saved To
- [x] patterns/[domain]-patterns.md
- [ ] CLAUDE.md (if CRITICAL)

### Reason
[Why this pattern was needed]

### User Approval
- Approved: [timestamp]
- Modifications: [any changes requested]
```

---

## NEW PATTERN REPORT FORMAT

```markdown
## MASSU NEW PATTERN REPORT

### Summary
- **Date**: [timestamp]
- **Pattern Name**: [name]
- **Pattern ID**: [ID]
- **Domain**: [domain]

### Justification
- **Need**: [why pattern was needed]
- **Existing Patterns Checked**: [list]
- **Why Not Suitable**: [reasons]

### Pattern Definition
[Full pattern definition]

### Approval
- **User Approved**: YES
- **Modifications**: [any]
- **Approval Time**: [timestamp]

### Saved Locations
- [x] [location 1]
- [x] [location 2]

### Verification
```bash
# Pattern exists in documentation
[verification commands and output]
```

**NEW PATTERN COMPLETE - READY FOR USE**
```

---

## START NOW

1. Verify no existing pattern covers the need
2. Document why existing patterns don't work
3. Define the new pattern with WRONG/CORRECT examples
4. Present to user for explicit approval
5. Save to appropriate pattern files
6. Add to CLAUDE.md if CRITICAL
7. Verify pattern is saved
8. Update session state
9. Produce new pattern report

**Remember: Document first, implement second. No undocumented patterns.**
