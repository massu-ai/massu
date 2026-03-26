# QA Evaluator Specification

> Reference doc for `/massu-golden-path` Phase 2C. Return to `phase-2-implementation.md` for full Phase 2.

## Purpose

An adversarial functional QA agent that exercises the running application via Playwright MCP, tuned for skepticism. Catches "compiles but doesn't work" failures that self-evaluation and code review miss.

**Origin**: Adapted from Anthropic Labs' harness design. Key insight: separating generation from evaluation eliminates self-praise bias. Tuning a standalone evaluator to be skeptical is far more tractable than making a generator self-critical.

---

## Evaluation Dimensions

The QA evaluator grades each implemented plan item across 4 dimensions:

| # | Dimension | Weight | What It Checks |
|---|-----------|--------|----------------|
| 1 | **Functionality** | High | Can users complete the primary workflow? Navigate to feature, interact, verify result. |
| 2 | **Completeness** | High | Are ALL contract acceptance criteria met? No stubs, no mock data, no placeholder text. |
| 3 | **Data Integrity** | Medium | Do write→store→read→display roundtrips work? (Aligns with CR-47 VR-ROUNDTRIP) |
| 4 | **Design Compliance** | Medium | Does the UI follow the design system tokens and component specs? (Aligns with VR-TOKEN, VR-SPEC-MATCH) |

---

## Grading Rubric

Per plan item:

| Grade | Meaning | Gate Impact |
|-------|---------|-------------|
| **PASS** | All contract criteria met, feature works as intended | QA_GATE remains PASS |
| **PARTIAL** | Most criteria met but 1-2 minor gaps (e.g., missing empty state) | QA_GATE: FAIL — must fix |
| **FAIL** | Core functionality broken, mock data, unwired features | QA_GATE: FAIL — must fix |

**Failure threshold**: Any single FAIL or PARTIAL = QA_GATE: FAIL. The article emphasizes that a lenient evaluator defeats the purpose.

---

## Known Failure Patterns to Check

These patterns are derived from production incidents. The QA evaluator MUST actively check for each:

| Pattern | Source | How to Detect |
|---------|--------|---------------|
| **Mock/hardcoded data** | Common incident pattern | Data doesn't change when DB changes; look for hardcoded arrays in component files |
| **Write succeeds but read/display broken** | Data visibility incidents | Submit form successfully, navigate away and back, verify data persists and displays |
| **Feature stubs** | Multiple incidents | Component renders but onClick/onSubmit handlers are empty or log-only |
| **Invisible elements** | Visibility incidents | Elements exist in DOM but have `display:none`, `opacity:0`, or are behind other elements |
| **Missing query invalidation** | Common pattern | Create/update item, verify list updates without manual refresh |
| **Broken dark mode** | Design audit findings | Toggle theme, verify all text visible, no invisible-on-dark elements |

---

## Evaluation Protocol

For each plan item with a sprint contract:

```
1. NAVIGATE to the affected page using Playwright MCP
   - browser_navigate to the target URL
   - browser_snapshot to verify page loaded (not error/auth page)
   - browser_console_messages to check for React errors

2. EXERCISE the feature as a real user would
   - Follow the happy path described in contract criteria
   - browser_click, browser_fill_form, browser_select_option as needed
   - Wait 2-3 seconds after interactions for async operations

3. VERIFY against sprint contract acceptance criteria
   - Check each criterion explicitly
   - browser_snapshot after key interactions for evidence
   - browser_network_requests to verify API calls succeed

4. CHECK for known failure patterns
   - Look for hardcoded data (browser_evaluate to check DOM for static arrays)
   - Verify write→read roundtrip if applicable
   - Check empty/loading/error states by testing edge conditions

5. GRADE the item: PASS / PARTIAL / FAIL
   - Include specific evidence for any non-PASS grade
   - Reference the specific contract criterion that failed
```

---

## Conditional Activation

The QA evaluator only spawns when the plan touches UI files:
- `src/app/**/*.tsx`
- `src/components/**/*.tsx`

For backend-only plans (routers, crons, migrations with no UI), skip with log note:
```
QA Evaluator: SKIPPED (no UI files in plan)
```

---

## Relationship to Phase 2G

| Aspect | QA Evaluator (Phase 2C) | Browser Verification (Phase 2G) |
|--------|------------------------|--------------------------------|
| **When** | After implementation, during review | After all reviews pass |
| **Focus** | Contract compliance, feature functionality | Load audit, performance, interactive inventory |
| **Scope** | Only plan items with contracts | All pages affected by changes |
| **Adversarial?** | Yes — tuned for skepticism | No — comprehensive but not adversarial |
| **Fixes** | Reports findings; main agent fixes | Fixes issues directly |

They are **complementary, not redundant**. QA evaluator asks "does it do what we agreed?" while Phase 2G asks "does everything still work correctly?"

---

## Evaluator Prompt Tuning

The article explicitly notes that Claude is "a poor QA agent" out of the box — it identifies issues then talks itself into approving. Effective QA evaluation requires iterative prompt tuning.

### Tuning Protocol

After each golden-path run:

1. **Review QA evaluator findings log** — did it catch real bugs?
2. **Check Phase 2G results** — did browser verification catch anything QA evaluator missed?
3. **Check production** — did anything break after deploy that should have been caught?
4. **Update evaluator prompt** if judgment divergences found:
   - Add the missed pattern to the "Known Failure Patterns" list above
   - Strengthen the prompt language for that failure mode
   - Document the tuning decision in memory

### Anti-Leniency Rules

The evaluator prompt includes these rules to prevent the natural tendency toward generosity:

1. **Never say "this is acceptable because..."** — if criteria aren't met, it's FAIL
2. **Never give benefit of the doubt** — if you can't verify it works, it's FAIL
3. **Partial credit is still failure** — PARTIAL means "not done yet"
4. **Evidence required** — every PASS must cite specific evidence (screenshot, DOM state, network response)
