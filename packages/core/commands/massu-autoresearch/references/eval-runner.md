# Eval Runner Protocol

## Purpose

Defines how to spawn a subagent to simulate command execution and score the output against the eval checklist.

## Why Subagent-Based Eval?

Claude Code cannot programmatically invoke `/massu-*` commands. The `claude` CLI accepts prompts but doesn't have a `--skill` flag for direct skill invocation. A subagent with the command text injected as instructions is the most practical simulation.

## Eval Execution Steps

### Step 1: Read inputs

Read three files:

1. **Target command file** (current version): `.claude/commands/[command].md` (or `[command]/[command].md` for folder-based)
2. **Eval checklist** (immutable): `.claude/evals/[command].md`
3. **Fixture input**: `.claude/evals/fixtures/[command]/input-01.md`

### Step 2: Spawn eval subagent

Use the Agent tool with `subagent_type="general-purpose"` and a prompt structured as:

```
You are simulating the execution of a Claude Code command. Your job is to produce the output EXACTLY as the command specifies, including all required sections and formatting.

## Command Instructions

[PASTE FULL COMMAND FILE TEXT HERE]

## Input

[PASTE FIXTURE INPUT TEXT HERE]

## Your Task

Execute the command against the input above. Produce the complete output as if you were running the command for real. Include every section the command specifies. Do not skip optional sections — treat everything as required for this simulation.

Do NOT include any meta-commentary about the simulation. Just produce the command output.
```

### Step 3: Score the output

After the subagent returns its output, score each check from the eval checklist:

For each check in `.claude/evals/[command].md`:

1. Read the check's `pass_condition`
2. Evaluate the subagent output against that condition
3. Record `true` (pass) or `false` (fail)

Scoring rules:
- Checks are binary — no partial credit
- Section presence checks: the section header must exist AND contain substantive content (not just the header)
- Count checks (e.g., "at least 3 action items"): count actual items, not placeholders
- Conditional checks (e.g., "if score >= 40"): evaluate the condition first, then check

### Step 4: Calculate score

```
score = (passing_checks / total_checks) * 100
```

### Step 5: Return results

Return to the main loop:

1. `score`: percentage (e.g., 75.0)
2. `checks`: object mapping check_id to boolean (e.g., `{"has_executive_summary": true, "has_score_table": false, ...}`)
3. `failing_checks`: list of check_ids that failed
4. `status`: "success" or "crash" (if subagent errored or output was unparseable)

## Output Containment

The full subagent output is NOT retained in the main agent context. After scoring:

- Discard the full output text
- Keep only: score, per-check results, failing check names
- This prevents context window exhaustion during long runs (Karpathy insight #4)

## Crash Handling

If the subagent errors, times out, or produces output that cannot be scored, return `status: "crash"` to the main loop. See `safety-rails.md` for crash retry protocol.
