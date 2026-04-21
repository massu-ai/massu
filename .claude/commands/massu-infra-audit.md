---
name: massu-infra-audit
description: "When user asks about .claude/ infrastructure health, says 'audit infra', 'check claude setup', or needs to verify references, staleness, and format compliance"
allowed-tools: Bash(*), Read(*), Grep(*), Glob(*)
---
name: massu-infra-audit

# Massu Infrastructure Audit: .claude/ Directory Health Check

## Objective

Verify the health of the `.claude/` directory infrastructure: dead references, staleness, conflicts, format consistency, and memory health. Designed for periodic execution to catch drift before it causes problems.

---

## AUDIT PHASES (8 Checks)

| Phase | Check | Pass Criteria |
|-------|-------|---------------|
| 1 | **Dead References in CLAUDE.md** | All file paths referenced in CLAUDE.md exist |
| 2 | **Script References** | All scripts referenced by commands/patterns exist |
| 3 | **Command Format Consistency** | All commands have valid YAML frontmatter (name, description, allowed-tools) |
| 4 | **Cross-Reference Integrity** | Commands reference patterns that exist; patterns reference files that exist |
| 5 | **Line Count Accuracy** | Line counts in CLAUDE.md Load Instructions match actual file line counts |
| 6 | **Memory Health** | MEMORY.md under 200-line limit; topic files organized |
| 7 | **Archive Bloat** | Session state archive size and count assessment |
| 8 | **Orphan Detection** | Files in .claude/ not referenced from CLAUDE.md or any command |

---

## EXECUTION PROTOCOL

### Phase 1: Dead References in CLAUDE.md

```bash
# Extract all relative file paths from CLAUDE.md and verify each exists
grep -oE '\[.*?\]\((protocols|patterns|commands|incidents|reference|session-state)/[^)]+\)' .claude/CLAUDE.md \
  | grep -oE '(protocols|patterns|commands|incidents|reference|session-state)/[^)]+' \
  | sort -u \
  | while read path; do
      [ -f ".claude/$path" ] && echo "OK: $path" || echo "MISSING: $path"
    done
```

**FAIL** if any path is MISSING.

### Phase 2: Script References

```bash
# Find all script references across .claude/ files
grep -roh 'scripts/[a-zA-Z0-9_-]*\.\(sh\|ts\)' .claude/ | sort -u | while read script; do
  [ -f "$script" ] && echo "OK: $script" || echo "MISSING: $script"
done
```

**FAIL** if any script is MISSING.

### Phase 3: Command Format Consistency

```bash
# For each command file, verify YAML frontmatter has required fields
for f in .claude/commands/massu-*.md; do
  name=$(basename "$f" .md)
  has_name=$(head -10 "$f" | grep -c "^name:")
  has_desc=$(head -10 "$f" | grep -c "^description:")
  has_tools=$(head -10 "$f" | grep -c "^allowed-tools:")
  if [ "$has_name" -eq 0 ] || [ "$has_desc" -eq 0 ] || [ "$has_tools" -eq 0 ]; then
    echo "INVALID: $name (name:$has_name desc:$has_desc tools:$has_tools)"
  else
    echo "OK: $name"
  fi
done
```

**FAIL** if any command has missing required fields.

### Phase 4: Cross-Reference Integrity

```bash
# Find pattern/protocol references in commands and verify they exist
grep -roh 'patterns/[a-zA-Z0-9_-]*\.md\|protocols/[a-zA-Z0-9_-]*\.md' .claude/commands/ \
  | sort -u \
  | while read ref; do
      [ -f ".claude/$ref" ] && echo "OK: $ref" || echo "BROKEN: $ref"
    done
```

**FAIL** if any cross-reference is BROKEN.

### Phase 5: Line Count Accuracy

Read CLAUDE.md Load Instructions table. For each entry with a line count:

```bash
# Compare claimed vs actual line counts
# Flag if delta > 20 lines (significant drift)
wc -l .claude/patterns/*.md .claude/protocols/*.md .claude/reference/*.md 2>/dev/null
```

Compare to claimed counts in CLAUDE.md. **WARN** if any delta > 20 lines.

### Phase 6: Memory Health

```bash
# Check memory directory
MEMORY_DIR="$HOME/.claude/projects/$(pwd | tr '/' '-')/memory"
echo "=== Memory Files ==="
ls -la "$MEMORY_DIR/"
echo "=== MEMORY.md line count ==="
wc -l "$MEMORY_DIR/MEMORY.md"
echo "=== Total memory size ==="
du -sh "$MEMORY_DIR/"
```

**WARN** if MEMORY.md exceeds 180 lines (approaching 200 limit).

### Phase 7: Archive Bloat Assessment

```bash
echo "=== Archive Stats ==="
echo "File count: $(ls .claude/session-state/archive/ | wc -l)"
echo "Total size: $(du -sh .claude/session-state/archive/)"
echo "=== Age distribution ==="
echo "Last 7 days: $(find .claude/session-state/archive/ -mtime -7 | wc -l)"
echo "7-30 days: $(find .claude/session-state/archive/ -mtime +7 -mtime -30 | wc -l)"
echo "30+ days: $(find .claude/session-state/archive/ -mtime +30 | wc -l)"
```

**INFO** only — no pass/fail, but flag if > 500 files or > 5MB.

### Phase 8: Orphan Detection

```bash
# List all non-archive .claude/ files
# For each, check if referenced from CLAUDE.md or any command
find .claude/ -name "*.md" -not -path "*/archive/*" -not -path "*/session-state/*" | while read f; do
  basename=$(basename "$f")
  refs=$(grep -rl "$basename" .claude/CLAUDE.md .claude/commands/ .claude/patterns/ .claude/protocols/ 2>/dev/null | wc -l)
  if [ "$refs" -eq 0 ]; then
    echo "ORPHAN?: $f (0 incoming references)"
  fi
done
```

**INFO** only — orphans may be intentional (specialized tools).

---

## OUTPUT FORMAT

```markdown
## Massu Infrastructure Audit Report
Date: YYYY-MM-DD

### Results Summary
| Phase | Check | Status | Details |
|-------|-------|--------|---------|
| 1 | Dead References | PASS/FAIL | [count] issues |
| 2 | Script References | PASS/FAIL | [count] issues |
| 3 | Command Format | PASS/FAIL | [count] issues |
| 4 | Cross-References | PASS/FAIL | [count] issues |
| 5 | Line Counts | PASS/WARN | [count] stale |
| 6 | Memory Health | PASS/WARN | [lines] / 200 limit |
| 7 | Archive Bloat | INFO | [count] files, [size] |
| 8 | Orphan Detection | INFO | [count] potential orphans |

### Overall: PASS / WARN / FAIL
[Summary of action items if any]
```

---

## PASS CRITERIA

- **PASS**: Phases 1-4 all pass, Phase 6 under limits
- **WARN**: Phases 5, 7, 8 have non-critical findings
- **FAIL**: Any of Phases 1-4 have failures (broken references, missing files, invalid format)

---

## WHEN TO RUN

- After editing CLAUDE.md or any command file
- After adding/removing pattern or protocol files
- After memory cleanup or reorganization
- Weekly as part of `/massu-codebase-audit`
- After any `.claude/` directory restructuring
