---
name: massu-review
description: Automated code review across 7 dimensions (patterns, security, architecture, website, AI-specific, performance, accessibility)
allowed-tools: Bash(*), Read(*), Grep(*), Glob(*)
---
name: massu-review

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9, CR-35 enforced.

# CS Review: Automated Code Review

## Objective

Perform a comprehensive code review across 7 dimensions: pattern compliance, security, architecture, website-specific checks, AI-specific, performance, and accessibility. Accepts a PR number, branch name, or reviews uncommitted changes by default. This is READ-ONLY - no files are modified.

**Usage**: `/massu-review` (uncommitted changes) or `/massu-review [PR#|branch]`

---

## NON-NEGOTIABLE RULES

- Do NOT modify any files
- Do NOT fix any issues found (report only)
- Review ALL changed files, not just a sample
- Security findings are ALWAYS reported, even if minor
- Output structured findings that can be acted on

---

## STEP 1: DETERMINE REVIEW SCOPE

```bash
# If argument is a PR number
gh pr diff $ARGUMENTS 2>/dev/null

# If argument is a branch name
git diff main...$ARGUMENTS 2>/dev/null

# If no argument, review uncommitted changes
git diff HEAD
git diff --cached
```

```markdown
### Review Scope
- **Target**: [PR #N / branch / uncommitted changes]
- **Files changed**: [N]
- **Lines added**: [N]
- **Lines removed**: [N]
```

---

## DIMENSION 1: CLAUDE.md PATTERN COMPLIANCE

For each changed file in `packages/core/src/`:

| Check | What | How |
|-------|------|-----|
| ESM imports | No require() | grep for require( |
| Config access | getConfig() not yaml.parse | grep for yaml.parse |
| No process.exit | Library code only | grep for process.exit |
| Tool prefix | Uses p() helper | grep for hardcoded 'massu_' |
| memDb lifecycle | try/finally pattern | Check memDb usage |
| ESM exports | No module.exports | grep for module.exports |

```markdown
### Pattern Compliance Findings

| File | Check | Status | Details |
|------|-------|--------|---------|
| [file] | [check] | PASS/FAIL | [details] |
```

---

## DIMENSION 2: SECURITY REVIEW

For ALL changed files:

| Check | Pattern | Severity |
|-------|---------|----------|
| XSS | innerHTML, dangerouslySetInnerHTML, javascript: URLs | HIGH |
| Injection | Template literals in SQL, shell commands with user input | CRITICAL |
| SSRF | Unvalidated URL construction, fetch with user input | HIGH |
| Secrets | Hardcoded API keys, passwords, tokens | CRITICAL |
| Auth bypass | Missing auth checks, exposed endpoints | HIGH |
| Path traversal | User input in file paths without validation | HIGH |
| Open redirect | Unvalidated redirect URLs | MEDIUM |
| CSRF | Missing CSRF tokens on state-changing operations | MEDIUM |

```markdown
### Security Findings

| File:Line | Severity | Type | Description | Recommendation |
|-----------|----------|------|-------------|----------------|
| [loc] | [sev] | [type] | [desc] | [fix] |
```

---

## DIMENSION 3: ARCHITECTURE REVIEW

| Check | What | Impact |
|-------|------|--------|
| Tool registration | New tools wired into tools.ts | Tools invisible if missing |
| Hook compilation | New hooks compile with esbuild | Hooks fail silently |
| Config schema | New config matches interface | Runtime errors |
| DB access | Correct DB used (CodeGraph/Data/Memory) | Data corruption |
| Import cycles | No circular dependencies | Build failures |
| Type safety | No unsafe `as any` casts | Runtime errors |

```markdown
### Architecture Findings

| File | Check | Status | Details |
|------|-------|--------|---------|
| [file] | [check] | PASS/WARN/FAIL | [details] |
```

---

## DIMENSION 4: WEBSITE-SPECIFIC CHECKS (if website/ files changed)

| Check | What | Impact |
|-------|------|--------|
| Client/Server boundary | 'use client' / 'use server' directives | Build failures |
| Env var exposure | NEXT_PUBLIC_ prefix for client-safe vars only | Secret leakage |
| Supabase RLS | Data access goes through RLS policies | Data leakage |
| Input validation | User input validated server-side | Injection attacks |
| Auth middleware | Protected routes use middleware | Auth bypass |

```markdown
### Website-Specific Findings

| File | Check | Status | Details |
|------|-------|--------|---------|
| [file] | [check] | PASS/WARN/FAIL | [details] |
```

---

## DIMENSION 5: AI-SPECIFIC REVIEW (for changes involving AI/LLM patterns)

| Check | What | Impact |
|-------|------|--------|
| Prompt injection | User input flowing into system prompts without sanitization | Data exfiltration |
| Over-privileged tools | Tools with broader permissions than needed | Unauthorized actions |
| Context window management | Unnecessarily large context stuffing | Cost waste, degraded responses |
| Cost awareness | Changes that increase API token consumption without justification | Budget overrun |
| Model selection | Using expensive models (Opus) where cheaper ones (Haiku) suffice | Unnecessary cost |
| Hallucination guards | Verifying AI outputs before acting on them | Incorrect actions |

```markdown
### AI-Specific Findings

| File | Check | Status | Details |
|------|-------|--------|---------|
| [file] | [check] | PASS/WARN/FAIL | [details] |
```

---

## DIMENSION 6: PERFORMANCE REVIEW (for all changed files)

| Check | What | Impact |
|-------|------|--------|
| N+1 queries | Loop containing database query | Slow responses |
| Unbounded fetches | `.select('*')` without `.limit()` on list endpoints | Memory/performance |
| Missing pagination | List endpoints without page/per_page parameters | Unbounded data |
| Bundle impact | New imports of heavy libraries without dynamic import | Slow page load |
| Missing Suspense/loading | New pages without loading.tsx | Poor UX |
| Synchronous operations | Blocking calls in request handlers | Request timeouts |

```markdown
### Performance Findings

| File | Check | Status | Details |
|------|-------|--------|---------|
| [file] | [check] | PASS/WARN/FAIL | [details] |
```

---

## DIMENSION 7: ACCESSIBILITY REVIEW (for website component changes)

| Check | What | Impact |
|-------|------|--------|
| ARIA labels | Interactive elements without aria-label or aria-labelledby | Screen readers can't identify element |
| Keyboard navigation | Clickable elements without keyboard handler (onKeyDown) | Keyboard-only users blocked |
| Color contrast | Text on backgrounds with insufficient contrast (light gray on white) | Low-vision users can't read |
| Focus management | Modals/dialogs without focus trap | Focus escapes modal |
| Screen reader | Images without alt text, icons without sr-only labels | Content invisible to screen readers |
| Semantic HTML | Divs used instead of button/nav/main/section/article | Structure lost for assistive tech |

```markdown
### Accessibility Findings

| File | Check | Status | Details |
|------|-------|--------|---------|
| [file] | [check] | PASS/WARN/FAIL | [details] |
```

---

## COMPLETION REPORT

```markdown
## CS REVIEW COMPLETE

### Review Summary
- **Scope**: [PR #N / branch / uncommitted]
- **Files reviewed**: [N]

### Findings by Dimension

| Dimension | Critical | High | Medium | Low | Total |
|-----------|----------|------|--------|-----|-------|
| Pattern Compliance | [N] | [N] | [N] | [N] | [N] |
| Security | [N] | [N] | [N] | [N] | [N] |
| Architecture | [N] | [N] | [N] | [N] | [N] |
| Website | [N] | [N] | [N] | [N] | [N] |
| AI-Specific | [N] | [N] | [N] | [N] | [N] |
| Performance | [N] | [N] | [N] | [N] | [N] |
| Accessibility | [N] | [N] | [N] | [N] | [N] |
| **Total** | **[N]** | **[N]** | **[N]** | **[N]** | **[N]** |

### Verdict: APPROVE / REQUEST CHANGES / BLOCK

- **APPROVE**: 0 critical, 0 high findings
- **REQUEST CHANGES**: 0 critical, 1+ high findings
- **BLOCK**: 1+ critical findings

### Top Priority Fixes
1. [Most critical finding]
2. [Second most critical]
3. [Third most critical]
```
