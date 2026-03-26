# Shared Reference: Auto-Learning Protocol

**This is a shared content block. Referenced by multiple commands. Do NOT invoke directly.**

---

## AUTO-LEARNING PROTOCOL (CR-34, CR-38 — MANDATORY)

**After EVERY fix, finding, or significant discovery, the system MUST automatically learn. This is NOT optional.**

### Step 1: Ingest into Memory

Use `mcp__massu-codegraph__massu_memory_ingest` with:
- `type`: "bugfix" | "pattern" | "failed_attempt"
- `description`: What was found/fixed
- `files`: Affected file paths
- `importance`: 5=security/data, 3=build/type, 2=cosmetic

### Step 2: Record Correct vs Incorrect Pattern

Update `memory/MEMORY.md` with the WRONG vs CORRECT pattern discovered:
```markdown
## [Feature/Area] — [Date]
- **WRONG**: [anti-pattern or incorrect approach]
- **RIGHT**: [correct pattern with example]
- **Root cause**: [why the bug happened]
```

### Step 3: Add to Pattern Scanner (if grep-able)

If the bad pattern is detectable by grep, add a check to `scripts/pattern-scanner.sh`:
```bash
# CR-XX: Description of what this catches
BAD_PATTERN_COUNT=$(grep -rn "[bad_pattern]" src/ --include="*.ts" --include="*.tsx" | grep -v "node_modules" | wc -l)
if [ "$BAD_PATTERN_COUNT" -gt 0 ]; then
  echo "FAIL: Found $BAD_PATTERN_COUNT instances of [bad_pattern]"
  FAILURES=$((FAILURES + 1))
fi
```

### Step 4: Search Codebase-Wide (CR-9)

Fix ALL instances of the same issue across the entire codebase:
```bash
grep -rn "[bad_pattern]" src/ --include="*.ts" --include="*.tsx"
```

---

## When to Execute Auto-Learning

| Trigger | Type | Action |
|---------|------|--------|
| Bug fixed | bugfix | Steps 1-4 |
| New component/utility/pattern created | pattern | Steps 1-2 |
| Successful approach discovered | pattern | Steps 1-2 |
| Failed approach abandoned | failed_attempt | Step 1-2 |
| Pre-existing issue found and fixed (CR-9) | bugfix | Steps 1-4 |

---

## Pre-Push Learning Check (CR-38)

Before code leaves the local machine:
1. **Review all fixes**: `git diff origin/main..HEAD` for any bug fixes
2. **For each fix**: Verify it was ingested into massu memory (if not, ingest now)
3. **For each fix**: Verify MEMORY.md was updated (if not, update now)
4. **For each new pattern**: Verify it was recorded (if not, record now)
5. **For each failed approach**: Verify it was recorded as failed_attempt (if not, record now)

**Code without captured learnings is an incomplete delivery.**
