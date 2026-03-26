# Safety Rails

## Protected Line Patterns

Lines containing ANY of these patterns are READ-ONLY. The agent may add content adjacent to them but MUST NOT modify or delete these lines:

- `CR-` (Canonical Rule references)
- `VR-` (Verification Requirement references)
- `NON-NEGOTIABLE`
- `NEVER` — protected when: (a) at start of line, (b) after bullet/dash (`- NEVER`, `* NEVER`), or (c) in ALL-CAPS imperative context (`NEVER use`, `NEVER edit`, `NEVER import`). NOT protected in lowercase prose (`should never`, `would never`, `can never`).
- `MANDATORY`
- `FORBIDDEN`
- `MUST NOT`

These patterns encode incident-learned safety rules. Modifying them to pass an eval check would optimize the metric while degrading real safety — a Goodhart's Law violation.

### Verification

Before applying any edit, grep the target file for protected patterns in the edit region. If the edit would modify a protected line, reject the edit and try a different approach.

---

## Backup Protocol

Before the first iteration of any autoresearch run:

1. Create the backups directory if needed: `.claude/metrics/backups/`
2. Copy the target file to: `.claude/metrics/backups/[command]-autoresearch-[YYYY-MM-DD-HHmmss].md.bak`
3. Verify the backup exists and is non-empty

The backup is the ultimate rollback if the entire autoresearch branch needs to be abandoned.

---

## Git Branch Protocol

All autoresearch commits go to a dedicated branch:

1. **Resolve target path**: Determine the actual target file path — `.claude/commands/[command].md` for flat commands, `.claude/commands/[command]/[command].md` for folder-based commands. Store as `TARGET_PATH` and use for ALL subsequent git add/checkout operations.
2. **Create branch**: `git checkout -b autoresearch/[command]-[YYYY-MM-DD]`. If branch already exists (same command, same day), append a numeric suffix: `autoresearch/[command]-[YYYY-MM-DD]-2`, `-3`, etc.
3. **Commit on KEEP**: `git add [TARGET_PATH] && git commit -m "autoresearch([command]): [1-line summary]"`
4. **Revert on DISCARD**: `git checkout -- [TARGET_PATH]`
5. **After run**: User reviews the branch and decides to merge, cherry-pick, or discard

The branch naming convention allows multiple autoresearch runs on different commands without conflict.

---

## Cost Tracking

Track estimated token usage per iteration:

- **Eval subagent prompt**: ~target file tokens + eval file tokens + fixture tokens
- **Eval subagent response**: ~2x fixture tokens (simulated output)
- **Main agent overhead**: ~500 tokens per iteration (scoring, logging, state)

Rough estimate: each iteration costs ~3x the target file size in tokens.

**Cost cap**: If cumulative estimated token usage exceeds 500K tokens, **stop the loop** and produce the final report. This is a hard backstop regardless of `--no-limit` mode — it is NOT a pause, it is a termination.

---

## Tristate Crash Handling

When an eval produces a CRASH result:

1. **Log the crash**: Record in `autoresearch-runs.jsonl` with `"action":"crashed"`
2. **Do NOT increment** the consecutive reverts counter
3. **Retry once**: On the retry, use a SIMPLIFIED edit (smaller change, fewer lines modified)
4. **If retry also crashes**: Log as DISCARD, increment consecutive reverts counter
5. **Continue the loop** — a single crash does not warrant stopping

Crash accumulation: if `cumulative_crashed >= 5` in a single run, warn that there may be a systemic issue with the eval or fixture.

---

## "Think Harder" Graduated Escalation

When consecutive reverts trigger escalation, the edit strategy changes:

### Level 0 (default)
Normal operation. Target the weakest failing check. Try standard edit types.

### Level 1 (3 consecutive reverts)
**Switch edit type.** If previous attempts used "add rule", try in this order:
1. Add a worked example (before/after demonstration)
2. Restructure the section (reorder for emphasis)
3. Add a banned anti-pattern
4. Promote existing requirement higher in the file

### Level 2 (5 consecutive reverts)
**Full context reload.** Before the next edit:
1. Re-read the eval checklist from disk (not from memory)
2. Re-read the target file from disk
3. Review the changelog of ALL kept changes so far (from `autoresearch-runs.jsonl`)
4. Identify which failing check has been attempted most without success
5. Look for TWO previous near-miss approaches and try COMBINING them

### Level 3 (8 consecutive reverts)
**Radical restructuring.** Try structural changes, not content changes:
1. Reorder major sections of the target file
2. Merge two related sections into one focused section
3. Split an overloaded section into two specific sections
4. Convert abstract rules into concrete worked examples
5. Add a decision tree or flowchart for complex logic

### BAIL (10 consecutive reverts)
**Stagnation exit.** Log: "STAGNATION: 10 consecutive reverts after Level 3 escalation."
- Revert any pending changes
- Produce the final report
- Exit the loop
- This is the only way CR-37 triggers — after Level 3 has been attempted

---

## Output Containment

Eval subagent output is captured and scored, NOT inlined into the main agent context.

The main agent context receives ONLY:
- Score percentage (e.g., 75.0%)
- Per-check pass/fail results (e.g., `has_executive_summary: true, has_score_table: false`)
- Names of failing checks

This is the Karpathy `> run.log 2>&1` pattern adapted for LLM context management.
