# Approval Points

> Reference doc for `/massu-golden-path`. Return to main file for overview.

There are exactly 4 approval points (5 when using `--competitive` mode) where the golden path pauses for user input. Everything else runs automatically.

## Approval Point Format

```
===============================================================================
APPROVAL REQUIRED: [TYPE]
===============================================================================

[Details]

OPTIONS:
  "approve" / "yes" to continue
  "modify" to request changes
  "abort" to stop the golden path

===============================================================================
```

After receiving approval, immediately continue. Do NOT ask "shall I continue?" -- just proceed.

---

## Approval Point #1: PLAN

Triggered at: End of Phase 1 (after plan creation + audit loop).

```
===============================================================================
APPROVAL REQUIRED: PLAN
===============================================================================

Plan created and audited ({iteration} audit passes, 0 gaps).

PLAN SUMMARY:
--------------------------------------------------------------------------
Feature: [name]
File: [plan path]
Total Items: [N]
Phases: [list]

Requirements Coverage: [X]/10 dimensions resolved
Feasibility: VERIFIED (DB, files, patterns, security)
Audit Passes: {iteration} (final pass: 0 gaps)
--------------------------------------------------------------------------

OPTIONS:
  "approve" to begin implementation
  "modify: [changes]" to adjust plan
  "abort" to stop

===============================================================================
```

---

## Approval Point #2: NEW PATTERN

Triggered at: Any phase, when a new pattern is needed that does not exist in CLAUDE.md or patterns/*.md.

```
===============================================================================
APPROVAL REQUIRED: NEW PATTERN
===============================================================================

A new pattern is needed for: [functionality]

Existing patterns checked:
- [pattern 1]: Not suitable because [reason]

PROPOSED NEW PATTERN:
--------------------------------------------------------------------------
Name: [Pattern Name]
Domain: [UI/Database/Auth/etc.]

WRONG: [code]
CORRECT: [code]
Error if violated: [What breaks]
--------------------------------------------------------------------------

OPTIONS:
  "approve" to save and continue
  "modify: [changes]" to adjust
  "abort" to stop

===============================================================================
```

---

## Approval Point #3: COMMIT

Triggered at: End of Phase 4 (after all verification gates pass).

```
===============================================================================
APPROVAL REQUIRED: COMMIT
===============================================================================

All verification checks passed. Ready to commit.

VERIFICATION RESULTS:
--------------------------------------------------------------------------
  Pattern scanner: Exit 0
  Type check: 0 errors
  Build: Exit 0
  Lint: Exit 0
  Prisma: Valid
  Security: No secrets staged, no credentials in code
  VR-RENDER: All UI components rendered
  VR-COUPLING: All backend features exposed in UI
  VR-COLOR: No hardcoded Tailwind colors
  Plan Coverage: [X]/[X] = 100%
  Database: All environments verified
  Help site: UP TO DATE / N/A
  Quality Score: [X.X]/5.0
--------------------------------------------------------------------------

FILES TO BE COMMITTED:
[list]

PROPOSED COMMIT MESSAGE:
--------------------------------------------------------------------------
[type]: [description]

[body]

Co-Authored-By: Claude <noreply@anthropic.com>
--------------------------------------------------------------------------

OPTIONS:
  "approve" to commit and continue to push
  "message: [new message]" to change commit message
  "abort" to stop (changes remain staged)

===============================================================================
```

---

## Approval Point #4: PUSH

Triggered at: End of Phase 5 (after all push verification tiers pass).

```
===============================================================================
APPROVAL REQUIRED: PUSH TO REMOTE
===============================================================================

All verification tiers passed. Ready to push.

PUSH GATE SUMMARY:
--------------------------------------------------------------------------
Commit: [hash]
Message: [message]
Files changed: [N] | +[N] / -[N]
Branch: [branch] -> origin

Tier 1 (Quick): PASS
Tier 2 (Tests): PASS -- Unit: X/X, E2E: X/X, Regression: 0
Tier 3 (Security): PASS -- Audit: 0 high/crit, RLS: verified, Secrets: clean
--------------------------------------------------------------------------

OPTIONS:
  "approve" / "push" to push to remote
  "abort" to stop (commit remains local)

===============================================================================
```

---

## Approval Point #5: WINNER SELECTION (--competitive only)

Triggered at: End of Phase 2-COMP-D (after competitive scoring completes). Only present when `--competitive` flag is used.

```
===============================================================================
APPROVAL REQUIRED: WINNER SELECTION
===============================================================================

Competitive implementation complete. {N} agents scored.

COMPETITIVE SCORECARD:
--------------------------------------------------------------------------
| Dimension          | Agent A ({bias_a}) | Agent B ({bias_b}) | Agent C ({bias_c}) |
|--------------------|--------------------|--------------------|---------------------|
| Code Clarity       | X/5                | X/5                | X/5                 |
| Pattern Compliance | X/5                | X/5                | X/5                 |
| Error Handling     | X/5                | X/5                | X/5                 |
| UX Quality         | X/5                | X/5                | X/5                 |
| Test Coverage      | X/5                | X/5                | X/5                 |
| **Raw Total**      | **XX/25**          | **XX/25**          | **XX/25**           |
| **Weighted Total** | **XX.X**           | **XX.X**           | **XX.X**            |

NOTABLE DIFFERENCES:
  [Aspect]: Agent A did [X], Agent B did [Y]

RECOMMENDATION: Agent {X} ({bias}) — [reason]
--------------------------------------------------------------------------

PER-AGENT NOTES:
  Agent A ({bias_a}): [approach summary, strengths, weaknesses]
  Agent B ({bias_b}): [approach summary, strengths, weaknesses]

OPTIONS:
  "approve" to accept recommended winner (Agent {X})
  "override [agent_id]" to select a different winner
  "abort" to stop (worktrees remain for manual inspection)

===============================================================================
```
