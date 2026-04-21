---
name: massu-ui-audit
description: "When user says 'UI audit', 'UX review', 'accessibility check', 'check responsiveness', or needs a deep review of UI consistency, accessibility, and user flows"
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*), Task(*)
disable-model-invocation: true
---
name: massu-ui-audit

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-14, CR-5, CR-12 enforced.

# Massu UI Audit: Comprehensive UI/UX Review

## MANDATORY LOOP CONTROLLER (EXECUTE THIS - DO NOT SKIP)

**This section is the EXECUTION ENTRY POINT. You MUST follow these steps exactly.**

### How This Command Works

This command is a **loop controller** for UI/UX verification. Your job is to:
1. Spawn a `massu-plan-auditor` subagent for ONE complete UI audit pass
2. Parse the structured result (`GAPS_FOUND: N`)
3. If gaps > 0: fix UI issues, then spawn ANOTHER audit pass
4. If gaps == 0: UI audit passes

**The UI audit runs inside Task subagents. This prevents early termination.**

### Execution Protocol

```
iteration = 0

WHILE true:
  iteration += 1

  # Spawn auditor subagent for ONE complete UI audit pass
  result = Task(subagent_type="massu-plan-auditor", model="opus", prompt="
    UI Audit iteration {iteration}.
    Execute ONE complete UI/UX audit covering all 10 sections.
    Check: pages, navigation, buttons, forms, states, responsiveness,
    accessibility, component consistency, user flows, UX quality.
    Fix any issues you can. Return the structured result block.
  ")

  # Parse structured result
  gaps = parse GAPS_FOUND from result

  # Report iteration to user
  Output: "UI Audit iteration {iteration}: {gaps} issues found"

  IF gaps == 0:
    Output: "UI AUDIT PASSED - Zero issues in iteration {iteration}"
    BREAK
  ELSE:
    # Fix UI issues, then continue loop
    CONTINUE
END WHILE
```

### Rules for the Loop Controller

| Rule | Meaning |
|------|---------|
| **NEVER pass audit while issues > 0** | Only zero-issue iteration passes |
| **NEVER ask user "should I continue?"** | The loop is mandatory |
| **ALWAYS use Task tool for audit passes** | Subagents keep context clean |
| **Maximum 10 iterations** | If still failing after 10, report to user |

---

## Objective

Execute a thorough UI/UX audit covering accessibility, responsiveness, component consistency, state management, and user flow completeness.

---

## NON-NEGOTIABLE RULES

- **Every button has a handler** - No dead buttons
- **Every form has validation** - Zod schemas required
- **Every async operation has loading state** - User must see feedback
- **Every list has empty state** - No blank screens
- **Every action has error handling** - Graceful failures
- **Mobile-first responsive** - Proper responsive layout classes
- **Accessibility basics** - Alt text, aria labels, keyboard nav
- **FIX ALL ISSUES ENCOUNTERED (CR-9)** - If ANY issue is discovered during UI audit - whether from current changes OR pre-existing - fix it immediately. "Not in scope" and "pre-existing" are NEVER valid reasons to skip a fix. When fixing a bug, search entire codebase for same pattern and fix ALL instances.

---

## ZERO-GAP AUDIT LOOP - ENFORCED BY LOOP CONTROLLER

**This loop is now STRUCTURALLY ENFORCED by the Loop Controller at the top of this file.**

The Loop Controller spawns `massu-plan-auditor` subagents per iteration and continues until `GAPS_FOUND: 0`. Each iteration is a fresh subagent doing a FULL UI audit across all 10 sections.

### Loop Mechanics (Reference)

```
ITERATION 1: Spawn auditor -> Find N issues -> Fix -> Spawn again
ITERATION 2: Spawn auditor -> Find M issues -> Fix -> Spawn again
ITERATION 3: Spawn auditor -> Find 0 issues -> UI AUDIT PASSED
```

**Partial re-checks are NOT valid. The ENTIRE UI audit must pass in a SINGLE run.**

---

## DOMAIN-SPECIFIC PATTERN LOADING

| Domain | Pattern File | Load When |
|--------|--------------|-----------|
| UI components | `.claude/patterns/ui-patterns.md` | Always for UI audit |
| Auth UI | `.claude/patterns/auth-patterns.md` | Auditing auth screens |
| Build issues | `.claude/patterns/build-patterns.md` | Component build errors |

---

## MANDATORY PATTERN ALIGNMENT CHECK

**EVERY UI audit MUST verify compliance with ALL patterns from ui-patterns.md.**

### Step 1: Read ui-patterns.md First

BEFORE running any audit checks, read and extract ALL patterns from:
- `.claude/patterns/ui-patterns.md`
- `.claude/reference/patterns-quickref.md` (UI section)

### Step 2: Mandatory UI Pattern Verification Matrix

```markdown
### MANDATORY UI PATTERN VERIFICATION

| Pattern ID | Pattern | Check Command | Expected | Actual | Status |
|------------|---------|---------------|----------|--------|--------|
| UI-001 | DataTable for lists | `grep -rn "<Table" src/ \| grep -v DataTable` | 0 violations | | |
| UI-002 | sonner toast() | `grep -rn "useToast" src/ \| wc -l` | 0 matches | | |
| UI-003 | Dark mode contrast | `grep -rn "text-white\|text-black" src/ \| grep "bg-"` | Review | | |
| UI-004 | Select __none__ | `grep -rn 'value=""' src/ \| grep -i select` | 0 matches | | |
| UI-005 | Responsive layout | `grep -rn "page-container" src/` | Proper usage | | |
| UI-006 | Loading states | `grep -rn "isPending\|isLoading" src/components/` | Present | | |
| UI-007 | Empty states | `grep -rn "length === 0" src/components/` | Present | | |
| UI-008 | Error states | `grep -rn "isError\|toast.error" src/components/` | Present | | |
| UI-009 | Form validation | `grep -rn "zodResolver" src/components/` | Present | | |
```

### Pattern Alignment Gate

```markdown
### UI PATTERN ALIGNMENT GATE

| Pattern | Verified | Status |
|---------|----------|--------|
| DataTable for all lists | YES/NO | PASS/FAIL |
| sonner toast (no useToast) | YES/NO | PASS/FAIL |
| Dark mode contrast (WCAG AA) | YES/NO | PASS/FAIL |
| Select __none__ (no value="") | YES/NO | PASS/FAIL |
| Responsive layout | YES/NO | PASS/FAIL |
| Loading states present | YES/NO | PASS/FAIL |
| Empty states present | YES/NO | PASS/FAIL |
| Error states present | YES/NO | PASS/FAIL |
| Form validation with Zod | YES/NO | PASS/FAIL |

**UI PATTERN ALIGNMENT GATE: PASS / FAIL**

If ANY pattern fails, audit cannot pass until fixed.
```

---

## COMPONENT REUSE REQUIREMENTS

**Audit MUST check for component duplication and missed reuse opportunities.**

### Reuse Audit Checks
```bash
# Find duplicate component patterns
find src/components -name "*.tsx" | xargs basename -a | sort | uniq -d

# Find similar component names
find src/components -name "*Button*" -o -name "*Card*" -o -name "*List*" | sort

# Check if custom components duplicate UI primitives
grep -rln "className.*rounded.*border.*p-" src/components/ | head -20

# Find components not using design system
grep -rL "@/components/ui" src/components/*.tsx 2>/dev/null | head -10
```

### Required UI Primitives (should be used, not recreated)
- Button, Input, Select, Checkbox, Switch
- Dialog, Sheet, Popover, Dropdown
- Card, Table, Skeleton, Badge
- Form components (with react-hook-form)

---

## AUDIT SECTION 1: PAGE INVENTORY

### 1.1 List All Pages
```bash
# Find all pages
find src/app -name "page.tsx" -o -name "page.ts" 2>/dev/null | sort

# Find all layouts
find src/app -name "layout.tsx" -o -name "layout.ts" 2>/dev/null | sort

# Find error boundaries
find src/app -name "error.tsx" -o -name "error.ts" 2>/dev/null | sort

# Find loading states
find src/app -name "loading.tsx" -o -name "loading.ts" 2>/dev/null | sort
```

### 1.2 Page Audit Matrix
```markdown
### Page Inventory

| Page | Path | Auth Required | Has Layout | Has Error | Has Loading |
|------|------|---------------|------------|-----------|-------------|
| Dashboard | /dashboard | YES | YES | YES/NO | YES/NO |
```

### 1.3 VR-RENDER: Component Render Verification (CRITICAL)

**Every component created MUST be rendered in at least one page.**

```bash
# Find orphaned components (created but never used)
for comp in $(find src/components -name "*.tsx" -type f | grep -v index | xargs basename -a | sed 's/.tsx//'); do
  count=$(grep -rn "<$comp" src/ | grep -v "node_modules" | wc -l)
  if [ "$count" -eq 0 ]; then
    echo "ORPHANED COMPONENT: $comp (never rendered)"
  fi
done
```

---

## AUDIT SECTION 2: NAVIGATION

### 2.1 Navigation Analysis
```bash
# Find navigation components
find src/components -name "*Nav*" -o -name "*Sidebar*" -o -name "*Menu*" -o -name "*Header*" 2>/dev/null

# Extract all href values
grep -rn "href=" src/components/ | grep -v node_modules | sort -u

# Find all Link components
grep -rn "<Link" src/ | grep -v node_modules | wc -l

# Find router.push/replace calls
grep -rn "router\.push\|router\.replace" src/ | grep -v node_modules | head -20
```

---

## AUDIT SECTION 3: BUTTONS & ACTIONS

### 3.1 Button Inventory
```bash
# Count all buttons
grep -rn "<button\|<Button" src/components/ src/app/ | grep -v node_modules | wc -l

# Find buttons WITHOUT onClick (potential issues)
grep -rn "<button\|<Button" src/ | grep -v node_modules | grep -v "onClick\|type=\"submit\"\|disabled\|asChild"

# Find buttons without type (should have type="button" or type="submit")
grep -rn "<button" src/ | grep -v node_modules | grep -v "type="
```

---

## AUDIT SECTION 4: FORMS

### 4.1 Form Inventory
```bash
# Find all forms
grep -rn "<form\|<Form" src/ | grep -v node_modules | wc -l

# Find forms WITHOUT onSubmit (issues)
grep -rn "<form\|<Form" src/ | grep -v node_modules | grep -v "onSubmit"

# Find react-hook-form usage
grep -rn "useForm\|Controller\|register" src/ | grep -v node_modules | wc -l

# Find Zod validation
grep -rn "zodResolver\|z\.object" src/ | grep -v node_modules | wc -l
```

---

## AUDIT SECTION 5: STATE MANAGEMENT

### 5.1 Loading States
```bash
# Find loading indicators
grep -rn "isLoading\|isPending\|isFetching" src/ | grep -v node_modules | wc -l

# Find Skeleton components
grep -rn "Skeleton\|skeleton" src/components/ | grep -v node_modules

# Find suspense usage
grep -rn "<Suspense\|React.Suspense" src/ | grep -v node_modules
```

### 5.2 Empty States
```bash
grep -rn "length === 0\|\.length === 0\|isEmpty\|!data\|no.*found" src/components/ | grep -v node_modules | head -30
```

### 5.3 Error States
```bash
grep -rn "isError\|\.error\|onError" src/ | grep -v node_modules | head -30
grep -rn "toast\.error\|toast\.warning" src/ | grep -v node_modules
```

---

## AUDIT SECTION 6: RESPONSIVENESS

### 6.1 Mobile Checks
```bash
# Find responsive classes
grep -rn "sm:\|md:\|lg:\|xl:" src/components/ | grep -v node_modules | wc -l

# Find mobile-specific code
grep -rn "mobile\|Mobile\|useMediaQuery\|useBreakpoint" src/ | grep -v node_modules
```

---

## AUDIT SECTION 7: ACCESSIBILITY

### 7.1 Image Alt Text
```bash
# Images without alt
grep -rn "<img\|<Image" src/ | grep -v node_modules | grep -v "alt=" | head -20
# Expected: 0 matches
```

### 7.2 ARIA Labels
```bash
grep -rn "aria-label\|aria-labelledby\|aria-describedby" src/ | grep -v node_modules | wc -l
```

### 7.3 Keyboard Navigation
```bash
grep -rn "onKeyDown\|onKeyPress\|onKeyUp" src/ | grep -v node_modules | wc -l
grep -rn "tabIndex" src/ | grep -v node_modules
```

---

## AUDIT SECTION 8: COMPONENT CONSISTENCY

### 8.1 Design System Check
```bash
# Find button variants
grep -rn "variant=" src/components/ | grep -v node_modules | sort | uniq -c

# Find custom colors (should use design tokens)
grep -rn "bg-\[#\|text-\[#\|border-\[#" src/ | grep -v node_modules | wc -l
# Expected: 0 (use Tailwind colors)
```

---

## AUDIT SECTION 9: USER FLOWS

### 9.1 Identify Critical Flows
```markdown
### Critical User Flows

| Flow | Entry Point | Steps | Priority |
|------|-------------|-------|----------|
| Login | /login | 3 | P0 |
| Create Item | /items/new | 5 | P0 |
```

### 9.2 Flow Verification Template
```markdown
### User Flow: [FLOW_NAME]

| Step | Action | Element | Expected | Actual | Status |
|------|--------|---------|----------|--------|--------|
| 1 | Navigate | Link | Page loads | | |
| 2 | Fill form | Inputs | Values captured | | |
| 3 | Submit | Button | Loading shown | | |
| 4 | Complete | Redirect | Success page | | |

**Flow Status: PASS/FAIL**
```

---

## AUDIT SECTION 10: UX QUALITY

### 10.1 Focus Ring Visibility (VR-FOCUS)

```bash
# Check for focus indicators
grep -rn "focus:ring\|focus-visible:" src/ | wc -l

# Find focus:outline-none without replacement (a11y issue)
grep -rn "focus:outline-none" src/components/ | grep -v "focus:ring"
# Expected: 0
```

### 10.2 Touch Target Sizes (VR-TOUCH)

```bash
# Find potentially undersized buttons
grep -rn 'size="sm"\|size="xs"' src/components/ | grep -i button
# Review: Verify these have >= 44x44px touch area
```

### 10.3 Motion Preferences (VR-MOTION)

```bash
# Check for prefers-reduced-motion support
grep -rn "prefers-reduced-motion\|motion-reduce\|motion-safe" src/ | wc -l

# Count animations
grep -rn "animate-\|transition-\|@keyframes" src/ | wc -l
```

### 10.4 Error Recovery Flows (VR-RECOVERY)

```bash
# Check for error boundaries
find src/app -name "error.tsx" | wc -l

# Check for retry mechanisms
grep -rn "retry\|refetch\|try again" src/components/ | wc -l
```

### 10.5 UX Quality Audit Matrix

```markdown
### UX Quality Verification

| Check | Command | Expected | Actual | Status |
|-------|---------|----------|--------|--------|
| Focus indicators | grep focus:ring | > 0 | | PASS/FAIL |
| Touch targets | No undersized | 0 violations | | PASS/FAIL |
| Motion preferences | If animations, has support | Present | | PASS/FAIL |
| Error recovery | error.tsx + retry buttons | Present | | PASS/FAIL |
| Keyboard nav | Handlers + Escape | Present | | PASS/FAIL |
| Contrast | WCAG AA | Compliant | | PASS/FAIL |

**UX QUALITY GATE: PASS / FAIL**
```

---

## UI AUDIT REPORT FORMAT

```markdown
## MASSU UI AUDIT REPORT

### Audit Summary
- **Date**: [timestamp]
- **Scope**: Full UI/UX audit
- **Pages Audited**: [N]
- **Components Audited**: [N]

---

### Section 1: Page Infrastructure
| Check | Count | Issues | Status |
|-------|-------|--------|--------|
| Total pages | N | - | - |
| With error.tsx | N | [missing] | PASS/FAIL |
| With loading.tsx | N | [missing] | PASS/FAIL |

### Section 2: Navigation
| Check | Result | Status |
|-------|--------|--------|
| Dead links | 0 | PASS |

### Section 3: Buttons
| Check | Result | Status |
|-------|--------|--------|
| Buttons with handlers | N/N | PASS |

### Section 4: Forms
| Check | Result | Status |
|-------|--------|--------|
| Forms with validation | N/N | PASS |

### Section 5: State Management
| State Type | Coverage | Status |
|------------|----------|--------|
| Loading states | N components | PASS |
| Empty states | N components | PASS |
| Error states | N components | PASS |

### Section 6: Responsiveness
| Check | Result | Status |
|-------|--------|--------|
| Mobile layouts | Present | PASS |

### Section 7: Accessibility
| Check | Result | Status |
|-------|--------|--------|
| Images without alt | 0 | PASS |
| aria-labels | Present | PASS |

### Section 8: Consistency
| Check | Result | Status |
|-------|--------|--------|
| Custom colors | 0 | PASS |
| Design tokens | Used | PASS |

### Section 9: User Flows
| Flow | Steps Verified | Status |
|------|----------------|--------|
| [Flow 1] | N/N | PASS |

### Section 10: UX Quality
| Check | Result | Status |
|-------|--------|--------|
| Focus rings | Present | PASS |
| Touch targets | Adequate | PASS |

---

### Issues Found

#### HIGH Priority
[List or "None"]

#### MEDIUM Priority
[List or "None"]

#### LOW Priority
[List or "None"]

---

**UI AUDIT: PASSED / FAILED**
```

---

## SESSION STATE UPDATE

After audit, update `session-state/CURRENT.md`:

```markdown
## UI AUDIT SESSION

### Audit
- **Date**: [timestamp]
- **Scope**: Full UI/UX audit
- **Result**: PASSED / FAILED

### Findings Summary
- Pages: [N] audited, [N] issues
- Forms: [N] audited, [N] issues
- Accessibility: [N] issues
- Responsiveness: [N] issues

### Fixes Required
[List or "None"]
```

---

## AUTO-LEARNING PROTOCOL (MANDATORY after every fix/finding)

Read '.claude/commands/_shared-references/auto-learning-protocol.md' for the full auto-learning protocol. Execute after EVERY fix or finding during the audit.

---

## START NOW

**Execute the LOOP CONTROLLER at the top of this file.**

1. Spawn `massu-plan-auditor` subagent (via Task tool) for UI audit iteration 1
   - The auditor runs all 10 sections
2. Parse `GAPS_FOUND` from the subagent result
3. If gaps > 0: fix UI issues, spawn another iteration
4. If gaps == 0: UI audit passes - output final report
5. Update session state

**Remember: Every interaction must have feedback. No dead ends. World-class UX is the standard.**
