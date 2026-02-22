---
name: massu-session-optimization
description: Audit and optimize session context overhead (CLAUDE.md, commands, MCP, hooks, memory)
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9 enforced.

# Session Context Optimization Audit

Run a 6-section audit of context overhead, generate a report, and optionally apply fixes.

---

## Section 1: Context Budget Measurement

Measure these components and flag any over threshold:

| Component | Command | Threshold |
|-----------|---------|-----------|
| CLAUDE.md | `wc -c .claude/CLAUDE.md` | < 20,000 chars |
| MEMORY.md | `wc -c` on project memory file | < 4,000 chars |
| rules/*.md | `ls ~/.claude/rules/*.md 2>&1` | 0 files |
| MCP tools | Count deferred tools from ToolSearch or session context | < 150 |
| Top command | `wc -c .claude/commands/massu-loop.md` | < 40,000 chars |
| Autocompact | `grep CLAUDE_AUTOCOMPACT .claude/settings.json` | >= 90% |
| Shared preamble | `wc -c .claude/commands/_shared-preamble.md` | exists |

Calculate estimated total overhead in tokens (chars / 4).

## Section 2: Duplication Detection

- Cross-reference project memory content against CLAUDE.md (key phrase matching)
- Flag CR-* rules documented in both files
- Flag build/security/architecture patterns duplicated across files
- Check if `~/.claude/rules/*.md` files have crept back
- Report duplication score: % of memory that overlaps CLAUDE.md

## Section 3: Command Bloat Analysis

```bash
# Measure all command files
wc -c .claude/commands/massu-*.md | sort -rn | head -10
# Check shared preamble usage
grep -l "_shared-preamble" .claude/commands/massu-*.md | wc -l
# Detect inline boilerplate that should be in shared preamble
grep -l "QUALITY STANDARDS\|POST-COMPACTION SAFETY CHECK" .claude/commands/massu-*.md | wc -l
```

Flag any command over 40K chars. Flag any inline boilerplate (should be 0).

## Section 4: MCP Server Audit

- List all active MCP servers and tool counts
- Search recent session transcripts for `mcp__` usage patterns
- Flag servers with 0 usage as "candidates for disable"
- Report total deferred tool count

## Section 5: Hook Overhead Analysis

```bash
# Count hooks per event type
jq '.hooks | to_entries[] | .key + ": " + (.value | length | tostring)' ~/.claude/settings.json
# Check for wildcard PostToolUse matchers
jq '.hooks.PostToolUse[]? | select(.matcher == "*")' ~/.claude/settings.json
# Check if pattern scanner is scoped to code files
grep 'pattern-scanner.*single-file' ~/.claude/settings.json
```

Flag `*` wildcard PostToolUse matchers. Flag pattern scanner firing on non-code files.

## Section 6: Autocompact & Session Health

- Read current `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` value
- Flag if below 90%
- Check session-state/CURRENT.md for staleness (last updated > 7 days ago)

---

## Report Format

Generate report to stdout:

```
# Session Optimization Report - [DATE]

## Context Budget
| Component | Current | Target | Status |
|-----------|---------|--------|--------|
| CLAUDE.md | X chars | <20K | OK/OVER |
| Memory | X chars | <4K | OK/OVER |
| rules/*.md | X files | 0 | OK/OVER |
| MCP tools | X deferred | <150 | OK/OVER |
| Top command | X chars | <40K | OK/OVER |
| Autocompact | X% | >=90% | OK/LOW |

## Estimated Session Overhead: ~X tokens

## Findings
1. [Finding: severity INFO/WARN/ACTION]

## Recommended Actions
- [ ] Action (saves ~X chars)

## Comparison to Last Audit
| Metric | Last | Now | Delta |
|--------|------|-----|-------|
```

After reporting, update `.claude/session-state/optimization-baseline.json` with current measurements.

---

## Safe Auto-Apply

After showing the report:
1. Ask user which actions to apply (or "all")
2. For each action, show exact change before applying
3. After applying, re-measure and show before/after comparison
4. Update baseline file with new measurements

**Safety rules**:
- NEVER delete content that doesn't exist elsewhere (move to external file first)
- NEVER modify slash command protocol logic (only trim verbose explanations/duplicates)
- NEVER disable MCP servers without asking (only recommend)
- Always create backup before modifying CLAUDE.md or memory files
