# Auto-Learning Protocol

**MANDATORY after every bug fix.** The system MUST automatically learn from every fix. This is NOT optional.

---

## Step 1: Ingest Failure + Fix into Memory

```
Use mcp__massu-codegraph__massu_memory_ingest with:
- type: "bugfix"
- description: "[What was wrong] -> [What fixed it]"
- files: [list of files changed]
- importance: 5 (if caused data exposure or production error), 3 (if caused build/type error), 2 (if cosmetic)
```

---

## Step 2: Record Correct vs Incorrect Pattern

Update `memory/MEMORY.md` with:

```markdown
## [Category] Pattern (discovered [date])
- WRONG: [the incorrect pattern that caused the bug]
- CORRECT: [the pattern that fixed it]
- File(s): [where it was found]
```

---

## Step 3: Add to Pattern Scanner (if grep-able)

If the incorrect pattern can be detected by grep, add it to `scripts/pattern-scanner.sh`:

```bash
# Check for [description of bad pattern]
BAD_PATTERN=$(grep -rn "[bad_pattern]" src/ --include="*.ts" --include="*.tsx" | grep -v node_modules | wc -l)
if [ "$BAD_PATTERN" -gt 0 ]; then
  echo "[FAIL] [description]"
  CRITICAL=$((CRITICAL + 1))
fi
```

---

## Step 4: Search for Same Pattern Codebase-Wide (CR-9)

```bash
grep -rn "[bad_pattern]" src/ --include="*.ts" --include="*.tsx"
```

Fix ALL instances found, not just the one that was reported.

---

## When to Skip

- **NEVER** skip Steps 1-2 (memory recording)
- Skip Step 3 only if the pattern cannot be expressed as a grep pattern
- **NEVER** skip Step 4 (codebase-wide search)
