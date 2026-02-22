---
name: massu-accessibility
description: WCAG 2.1 AA accessibility audit — ARIA, keyboard, contrast, semantics, screen reader
allowed-tools: Bash(*), Read(*), Grep(*), Glob(*)
---

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9 enforced.

# CS Accessibility: WCAG 2.1 AA Audit

## Objective

Comprehensive READ-ONLY accessibility audit of the website UI components against WCAG 2.1 Level AA. Covers ARIA labeling, keyboard navigation, color contrast, semantic HTML, focus management, and screen reader support. No files are modified.

**Usage**: `/massu-accessibility` (full audit) or `/massu-accessibility [area]` (focused: aria, keyboard, contrast, semantic, focus, screen-reader)

---

## NON-NEGOTIABLE RULES

- Do NOT modify any files
- Do NOT fix any issues found (report only)
- Report ALL findings including LOW severity
- Run ALL checks even if early ones find many issues
- FIX ALL ISSUES ENCOUNTERED (CR-9) — flag all issues for follow-up, even pre-existing ones
- If no website/ directory exists, clearly state that and exit

---

## STEP 0: SCOPE CHECK

```bash
# Verify website exists
if [ ! -d "website/src" ]; then
  echo "No website/src directory found — accessibility audit requires a website."
  echo "If this is a CLI/MCP-only project, accessibility audit does not apply."
  exit 0
fi

# Count component files
find website/src -name "*.tsx" | wc -l
find website/src/app -name "page.tsx" 2>/dev/null | wc -l
find website/src/components -name "*.tsx" 2>/dev/null | wc -l
```

If `$ARGUMENTS` specifies a focused area, only run that dimension and skip others.

---

## DIMENSION 1: ARIA LABELING

Interactive elements MUST have accessible names.

### 1a. Buttons Without Labels

```bash
# Buttons with no text content or aria-label
grep -rn "<button" website/src/ --include="*.tsx" | grep -v "aria-label\|aria-labelledby" | grep -v ">.*[a-zA-Z].*</"
```

### 1b. Icon-Only Buttons

```bash
# Buttons likely to be icon-only (common patterns)
grep -rn "<button" website/src/ --include="*.tsx" | grep -i "icon\|svg\|lucide\|chevron\|close\|menu\|trash\|edit"
# Each must have aria-label or visually hidden text
grep -rn 'aria-label\|sr-only' website/src/ --include="*.tsx" | head -20
```

### 1c. Links Without Descriptive Text

```bash
# Anchor tags with generic text patterns
grep -rn "<a " website/src/ --include="*.tsx" | grep -i '"here"\|"click here"\|"read more"\|"link"'

# Links that are image/icon only
grep -rn "<Link\|<a " website/src/ --include="*.tsx" | grep -v "aria-label\|children\|>.*[a-zA-Z]"
```

### 1d. Form Inputs Without Labels

```bash
# Input elements that might lack associated label
grep -rn "<input\|<textarea\|<select" website/src/ --include="*.tsx" | grep -v "aria-label\|aria-labelledby\|id=" | head -20

# Check for label-input association via htmlFor
grep -rn "htmlFor\|aria-label" website/src/ --include="*.tsx" | wc -l
```

### 1e. Images Without Alt Text

```bash
# <img> tags without alt attribute
grep -rn "<img " website/src/ --include="*.tsx" | grep -v "alt="

# next/image without alt
grep -rn "<Image " website/src/ --include="*.tsx" | grep -v "alt="
```

```markdown
### ARIA Findings

| File:Line | Element | Issue | Severity | WCAG Criterion |
|-----------|---------|-------|----------|----------------|
| [loc] | [element] | [issue] | HIGH/MEDIUM/LOW | [criterion] |
```

---

## DIMENSION 2: KEYBOARD NAVIGATION

All interactive elements MUST be keyboard-accessible.

### 2a. Click Handlers Without Keyboard Equivalents

```bash
# onClick on non-interactive elements (div, span, li) without keyboard handler
grep -rn "onClick" website/src/ --include="*.tsx" | grep -v "onKeyDown\|onKeyUp\|onKeyPress\|<button\|<a \|<input\|<select\|<textarea" | grep "div\|span\|li\|p\b\|td\b\|tr\b" | head -20
```

### 2b. Missing tabIndex for Custom Interactive Elements

```bash
# Custom interactive elements that need tabIndex
grep -rn "onClick.*div\|div.*onClick" website/src/ --include="*.tsx" | grep -v "tabIndex\|role=" | head -20
```

### 2c. tabIndex > 0 (Breaks Natural Tab Order)

```bash
grep -rn "tabIndex=['\"][1-9]\|tabIndex={[1-9]" website/src/ --include="*.tsx"
```

### 2d. Keyboard Trap Detection

```bash
# Modal/dialog components — should trap focus while open
grep -rn "modal\|Modal\|dialog\|Dialog" website/src/ --include="*.tsx" | grep -v "aria-modal\|FocusTrap\|useFocusTrap\|focus-trap" | head -20
```

```markdown
### Keyboard Navigation Findings

| File:Line | Element | Issue | Severity | WCAG Criterion |
|-----------|---------|-------|----------|----------------|
| [loc] | [element] | [issue] | HIGH/MEDIUM/LOW | [criterion] |
```

---

## DIMENSION 3: COLOR CONTRAST

Text MUST have sufficient contrast against background.

### 3a. Potential Low-Contrast Patterns

```bash
# Common low-contrast text patterns in Tailwind
grep -rn "text-gray-300\|text-gray-400\|text-gray-200\|text-slate-300\|text-slate-400" \
  website/src/ --include="*.tsx" | grep -v "dark:" | head -20

# Light text on white/light background
grep -rn "text-gray-[123]\|text-slate-[123]\|text-zinc-[123]" website/src/ --include="*.tsx" | head -20
```

### 3b. Placeholder Text Contrast

```bash
# Placeholder text often fails contrast requirements
grep -rn "placeholder=" website/src/ --include="*.tsx" | head -20
grep -rn "placeholder:text-gray-[234]\|placeholder:text-slate-[234]" website/src/ --include="*.tsx" | head -20
```

### 3c. Disabled State Contrast

```bash
# Disabled elements need 3:1 contrast minimum (WCAG 1.4.3 exception applies but should be documented)
grep -rn "disabled\|opacity-50\|opacity-30\|opacity-25" website/src/ --include="*.tsx" | head -10
```

```markdown
### Color Contrast Findings

| File:Line | Element | Issue | Severity | WCAG Criterion |
|-----------|---------|-------|----------|----------------|
| [loc] | [element] | [pattern detected] | HIGH/MEDIUM/LOW | 1.4.3 |
```

---

## DIMENSION 4: SEMANTIC HTML

Correct semantic elements MUST be used for meaningful content.

### 4a. Heading Hierarchy

```bash
# All heading usages — check for skipped levels
grep -rn "<h[1-6]\|text-[0-9]*xl.*font-bold\|text-[0-9]*xl.*font-semibold" \
  website/src/app/ --include="*.tsx" | head -30
```

### 4b. List Semantics

```bash
# Bullet lists built with divs instead of ul/li
grep -rn "• \|\\- [A-Z]\|flex.*gap.*map" website/src/ --include="*.tsx" | grep -v "<ul\|<ol\|<li" | head -10
```

### 4c. Table Usage

```bash
# Data tables should use <table>, not CSS grid pretending to be a table
grep -rn "grid.*cols.*[4-9]\|data.*row\|table.*data" website/src/ --include="*.tsx" | grep -v "<table\|<thead\|<th\b" | head -10
```

### 4d. Landmark Regions

```bash
# Check for main, nav, header, footer landmarks
grep -rn "<main\|<nav\|<header\|<footer\|role=\"main\"\|role=\"navigation\"" \
  website/src/app/ --include="*.tsx" | head -20
```

### 4e. Button vs. Div for Actions

```bash
# Interactive elements that should be <button>
grep -rn "cursor-pointer\|onClick" website/src/ --include="*.tsx" | grep "div\|span" | grep -v "<button" | head -20
```

```markdown
### Semantic HTML Findings

| File:Line | Element | Issue | Severity | WCAG Criterion |
|-----------|---------|-------|----------|----------------|
| [loc] | [element] | [issue] | HIGH/MEDIUM/LOW | [criterion] |
```

---

## DIMENSION 5: FOCUS MANAGEMENT

Focus MUST be managed correctly for dynamic content.

### 5a. Modal Focus Management

```bash
# Modals should set focus on open and restore on close
grep -rn "modal\|Modal\|Dialog\|dialog\|sheet\|Sheet" website/src/components/ --include="*.tsx" 2>/dev/null | \
  grep -v "useRef\|focus()\|autoFocus\|initialFocus" | head -20
```

### 5b. Route Change Focus

```bash
# Next.js route changes — check for focus reset patterns
grep -rn "useRouter\|usePathname" website/src/ --include="*.tsx" | head -10
grep -rn "focus.*route\|scroll.*top\|announcer" website/src/ --include="*.tsx" 2>/dev/null | head -10
```

### 5c. Focus Visible Styles

```bash
# Check for focus:ring or focus-visible styles
grep -rn "focus:ring\|focus-visible\|outline-none" website/src/ --include="*.tsx" | head -20

# Danger: outline removal without replacement
grep -rn "outline-none\|outline: none\|outline:none" website/src/ --include="*.tsx" | \
  grep -v "focus:ring\|focus-visible:ring\|focus:outline" | head -10
```

```markdown
### Focus Management Findings

| File:Line | Component | Issue | Severity | WCAG Criterion |
|-----------|-----------|-------|----------|----------------|
| [loc] | [component] | [issue] | HIGH/MEDIUM/LOW | [criterion] |
```

---

## COMPLETION REPORT

```markdown
## CS ACCESSIBILITY COMPLETE

### Scan Summary
- **Scope**: [full scan / focused: area]
- **Dimensions scanned**: [N]/5
- **Files analyzed**: [N]

### Findings by Severity

| Severity | Count | Top Issues |
|----------|-------|-----------|
| HIGH | [N] | [brief descriptions] |
| MEDIUM | [N] | [brief descriptions] |
| LOW | [N] | [brief descriptions] |
| **Total** | **[N]** | |

### Findings by Dimension

| Dimension | HIGH | MEDIUM | LOW | Total |
|-----------|------|--------|-----|-------|
| ARIA Labeling | [N] | [N] | [N] | [N] |
| Keyboard Navigation | [N] | [N] | [N] | [N] |
| Color Contrast | [N] | [N] | [N] | [N] |
| Semantic HTML | [N] | [N] | [N] | [N] |
| Focus Management | [N] | [N] | [N] | [N] |

### Verdict: COMPLIANT / NEEDS WORK / NON-COMPLIANT

- **COMPLIANT**: 0 HIGH findings
- **NEEDS WORK**: 1+ MEDIUM findings, 0 HIGH
- **NON-COMPLIANT**: 1+ HIGH findings

### Top Priority Fixes (by WCAG Impact)

| # | File:Line | Criterion | Issue | Recommendation |
|---|-----------|-----------|-------|----------------|
| 1 | [loc] | [WCAG ref] | [issue] | [fix] |
| 2 | [loc] | [WCAG ref] | [issue] | [fix] |
| 3 | [loc] | [WCAG ref] | [issue] | [fix] |

### Recommended Next Steps
- Use `/massu-create-plan` to address HIGH findings systematically
- Use `/massu-hotfix` for isolated, low-risk fixes
```
