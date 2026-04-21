---
name: massu-learning-audit
description: "When user says 'learning audit', 'check auto-learning', 'memory coverage', or needs to validate that incidents are being learned from and patterns are being captured"
allowed-tools: Bash(*), Read(*), Grep(*), Glob(*), ToolSearch(mcp__massu-codegraph__*)
disable-model-invocation: true
---
name: massu-learning-audit

# Massu Learning Audit: Auto-Learning Effectiveness Validation

## Objective

Validate that the CR-34 auto-learning protocol is working effectively by checking:
1. Memory coverage for each canonical rule (CR)
2. Pattern scanner coverage for each documented incident
3. Failure recurrence rates
4. Session quality statistics

**CR-34**: ALL fixes MUST be auto-learned: ingest to memory, record pattern, update scanner.

**Philosophy**: Every incident that recurs is evidence that auto-learning failed. This audit proves the learning system is working.

---

## NON-NEGOTIABLE RULES

- **Proof > Claims** - Show MCP tool output, not summaries
- **Every CR must have memory** - CRs without entries = learning gaps
- **Every incident must have scanner rule** - Incidents without grep checks recur
- **Zero tolerance for recurrence** - Any recurrence_count > 1 is a learning failure
- **FIX ALL ISSUES ENCOUNTERED (CR-9)** - If any learning gap is discovered, fix it immediately by ingesting the missing memory and adding the missing scanner rule.

---

## Section 1: Memory Coverage Check

**For each canonical rule (CR-1 through CR-12), verify memory entries exist.**

### 1.1 Query Memory by CR

Use `mcp__massu-codegraph__massu_memory_search` for each major CR category:

```
massu_memory_search query="CR-9 fix all issues"
massu_memory_search query="CR-29 config map fallback"
massu_memory_search query="CR-30 feature parity rebuild"
massu_memory_search query="CR-33 RLS audit"
massu_memory_search query="CR-34 auto-learning"
massu_memory_search query="CR-12 compaction authorized command"
massu_memory_search query="include: ignored"
massu_memory_search query="ctx.prisma wrong"
massu_memory_search query="user_profiles not users"
```

### 1.2 Memory Coverage Report

| CR | Rule Summary | Memory Entries Found | Status |
|----|-------------|---------------------|--------|
| CR-1 | Verify don't claim | Query required | - |
| CR-2 | Never assume schema | Query required | - |
| CR-9 | Fix all issues | Query required | - |
| CR-29 | Config map fallback | Query required | - |
| CR-30 | Feature parity | Query required | - |
| CR-33 | RLS audit | Query required | - |
| CR-12 | No compaction escalation | Query required | - |

**Expected**: Every critical CR has >= 1 memory entry.

---

## Section 2: Pattern Scanner Coverage

**For each documented incident, verify the pattern scanner catches the bad pattern.**

### 2.1 Scan for Incident Patterns

```bash
# Verify pattern-scanner.sh exists and is executable
ls -la scripts/pattern-scanner.sh

# Run pattern scanner
scripts/pattern-scanner.sh
```

### 2.2 Verify Key Patterns Are Checked

```bash
# Incident #1: ctx.prisma usage
grep -c "ctx\.prisma" scripts/pattern-scanner.sh

# Incident #2: include: statements
grep -c "include:" scripts/pattern-scanner.sh

# Incident #5: wrong column names
grep -c "bad-columns\|check-bad-columns" scripts/pattern-scanner.sh

# Incident #10: import type from heavy deps
grep -c "import-chains\|check-import" scripts/pattern-scanner.sh
```

### 2.3 Scanner Coverage Report

| Incident | Pattern | Scanner Check Exists | Rule |
|----------|---------|---------------------|------|
| #1 Dec 18 | Unverified "complete" claims | N/A (behavioral) | - |
| #2 Dec 21 | ctx.prisma | grep check | - |
| #5 Jan 20 | Wrong column names | check-bad-columns.sh | - |
| #10 Jan 25 | import type from heavy deps | check-import-chains.sh | - |
| #20 Feb 8 | CONFIG_MAP no fallback | grep check | - |

**Expected**: All grep-able patterns have scanner checks.

---

## Section 3: Failure Recurrence Analysis

**Check if any known failures have recurred.**

### 3.1 Query Memory for Recurrences

Use `mcp__massu-codegraph__massu_memory_failures`:
```
massu_memory_failures
```

Look for entries with `recurrence_count > 1`.

### 3.2 Timeline Analysis

Use `mcp__massu-codegraph__massu_memory_timeline`:
```
massu_memory_timeline days=30
```

Check for patterns appearing more than once in the timeline.

### 3.3 Recurrence Report

| Pattern | First Occurrence | Recurrence Count | Status |
|---------|-----------------|------------------|--------|
| Query required | - | - | - |

**Expected**: recurrence_count == 1 for all patterns (no recurrences).

---

## Section 4: Session Quality Statistics

### 4.1 Query Session Stats

Use `mcp__massu-codegraph__massu_session_stats`:
```
massu_session_stats
```

### 4.2 Prompt Effectiveness

Use `mcp__massu-codegraph__massu_prompt_effectiveness`:
```
massu_prompt_effectiveness
```

### 4.3 Session Quality Report

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| Average gaps per session | Query required | < 5 | - |
| Recurrence rate | Query required | 0% | - |
| Auto-learning compliance | Query required | 100% | - |

---

## Section 5: Gap Report

**Identify and remediate learning gaps.**

### 5.1 CRs Without Memory Entries

List all CRs from Section 1 with 0 memory entries.

### 5.2 Incidents Without Scanner Rules

List all incidents from Section 2 with no scanner check.

### 5.3 Remediation Steps

For each gap found:

**Missing Memory Entry**: Use `mcp__massu-codegraph__massu_memory_ingest`:
```
massu_memory_ingest type="pattern" description="[CR summary]" importance=3
```

**Missing Scanner Rule**: Add to `scripts/pattern-scanner.sh`:
```bash
# Add grep check for the bad pattern
grep -rn "[bad_pattern]" src/ && echo "VIOLATION: [description]" && exit 1
```

---

## Completion Criteria

- [ ] All CRs have >= 1 memory entry
- [ ] All grep-able incident patterns have scanner checks
- [ ] recurrence_count == 1 for all patterns (no recurrences found)
- [ ] Session stats reviewed, quality >= target
- [ ] All gaps remediated
- [ ] pattern-scanner.sh exits 0

**Remember: Auto-learning is not optional. Every incident that recurs proves CR-34 failed.**
