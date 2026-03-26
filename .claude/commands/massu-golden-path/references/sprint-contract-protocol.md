# Sprint Contract Protocol

> Reference doc for `/massu-golden-path` Phase 2A.5. Return to `phase-2-implementation.md` for full Phase 2.

## What Is a Sprint Contract?

A sprint contract is a **negotiated definition-of-done** established for each plan item **before implementation begins**. It bridges the gap between high-level plan items and testable implementation by defining specific, measurable acceptance criteria that both the implementing agent and the evaluator agree on.

**Origin**: Adapted from Anthropic Labs' harness design pattern where generator and evaluator agents negotiate per-sprint contracts before coding starts. This prevents the "I implemented something adjacent to the plan item" failure mode.

---

## Contract Template

For each plan item in the Phase 2A tracking table, add these columns:

| Column | Content |
|--------|---------|
| **Scope Boundary** | What is IN scope and what is explicitly OUT of scope for this item |
| **Implementation Approach** | High-level approach (which files, which patterns) |
| **Acceptance Criteria** | 3-5 testable statements per item (see quality bar below) |
| **VR-* Mapping** | Which verification types apply and their expected output |

### Example Contract

```
Plan Item: P3-001 — Add contact activity timeline to CRM detail page
Scope Boundary:
  IN: Activity timeline component on contact detail, showing calls/emails/meetings
  OUT: Creating new activities (that's P3-002), activity filtering, pagination
Implementation Approach:
  - New ActivityTimeline component in src/components/crm/
  - tRPC query in contacts router using 3-step pattern
  - Render in contact detail page right column
Acceptance Criteria:
  1. Timeline renders with most recent activity first
  2. Each activity shows type icon, timestamp (relative), and summary text
  3. Empty state shows "No activities recorded" when contact has zero activities
  4. Loading state shows 3 skeleton rows while fetching
  5. Clicking an activity row navigates to the activity detail (or opens Sheet)
VR-* Mapping:
  - VR-GREP: ActivityTimeline component exists
  - VR-RENDER: Component rendered in contact detail page
  - VR-VISUAL: Route passes weighted scoring >= 3.0
  - VR-ROUNDTRIP: Activity data flows from DB to display
```

---

## Contract Quality Bar

Acceptance criteria MUST be specific enough that **two independent evaluators would agree on PASS/FAIL**.

| Quality | Example | Verdict |
|---------|---------|---------|
| **BAD** | "UI looks good" | Subjective, unmeasurable |
| **BAD** | "Feature works correctly" | Too vague, no specific behavior |
| **OKAY** | "Table renders contact data" | Testable but not specific enough |
| **GOOD** | "DataTable renders with sortable columns for name, email, company. Clicking column header toggles sort direction. Empty state shows 'No contacts found' message." | Specific, testable, includes edge case |
| **GOOD** | "Form submits and shows toast.success('Contact created'). New contact appears in list without page refresh." | Verifiable behavior with specific UI feedback |

### Criteria Categories

Each contract should include criteria from at least 3 of these categories:

1. **Happy path**: Primary workflow completes successfully
2. **Data display**: Correct data appears in the right places
3. **Empty/loading/error states**: All states handled
4. **User feedback**: Success/error messages shown
5. **Edge cases**: Null values, long text, missing data

---

## Negotiation Rules

1. **Max 3 negotiation rounds per item.** If generator and auditor can't agree after 3 rounds, escalate to user via AskUserQuestion.
2. **Auditor challenges vague criteria.** If a criterion uses words like "good", "correct", "proper" without specifics, the auditor MUST push back.
3. **Generator can propose simpler criteria** if the auditor's demands exceed the plan item's scope.
4. **No gold-plating.** Criteria must match the plan item scope, not expand it. If the auditor wants more, that's a new plan item.

---

## Contract Storage

Contracts are stored as **additional columns in the Phase 2A tracking table**, not as separate files. This avoids file proliferation and keeps contracts co-located with the items they describe.

```
| Item # | Type | Description | Location | Verification | Contract | Acceptance Criteria | Status |
|--------|------|-------------|----------|--------------|----------|---------------------|--------|
| P3-001 | COMPONENT | Activity timeline | src/components/crm/ | VR-RENDER | See above | 5 criteria | PENDING |
```

---

## When to Skip

Sprint contracts can be marked **N/A** for:
- Pure refactors with no user-facing behavior change (verified by VR-BUILD + VR-TYPE + VR-TEST)
- Documentation-only items
- Migration items where the SQL IS the contract (the migration either applies or it doesn't)

Mark as: `Contract: N/A — [reason]`

---

## Relationship to Existing Verification

Sprint contracts **ADD** acceptance criteria on top of existing VR-* checks. They do NOT replace them.

```
VR-* checks = "Does the code meet technical standards?"
Sprint contracts = "Does the code do what we agreed it would do?"
```

Both must pass. A plan item is NOT complete unless:
1. All VR-* checks pass
2. All contract acceptance criteria are met
