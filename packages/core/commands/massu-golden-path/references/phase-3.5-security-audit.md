# Phase 3.5: Deep Security Audit

> Reference doc for `/massu-golden-path`. Return to main file for overview.

```
[GOLDEN PATH -- PHASE 3.5: DEEP SECURITY AUDIT]
```

## Purpose

Run a full adversarial security audit loop against ALL files changed in this golden path run. This is a deep, iterative audit with parallel red-team agents that converges to zero findings. It runs AFTER simplification (Phase 3) so the audit targets the final, cleaned-up code -- and BEFORE pre-commit verification (Phase 4) so all security fixes are included in the verification gates.

**This phase is NEVER skipped.** Security is non-negotiable regardless of change size, type, or scope.

---

## 3.5.1 Determine Audit Scope

Collect ALL files changed during this golden path run:

```bash
git diff --name-only HEAD
```

If files were already committed in earlier phases, also include:
```bash
git diff --name-only main...HEAD
```

The audit scope is the union of all changed files. Do NOT narrow scope -- every changed file gets audited.

**Output:**
```
SECURITY AUDIT SCOPE:
  Files: [N]
  [list of files]
```

---

## 3.5.2 Execute Deep Security Audit

Run the full security audit protocol against the scoped files:

1. **Launch 2-4 parallel adversarial reviewer agents** adapted to the codebase area:
   - Backend/API code: 4 agents (Injection, Network/Leakage, DoS/Resources, Red Team Bypass)
   - Frontend code: 3 agents (XSS/Injection, Auth/Data Exposure, Input Validation/Logic)
   - Infrastructure/config: 2 agents (Secrets/Config, Dependencies/Supply Chain)

2. **Consolidate findings** -- deduplicate across agents, take higher severity on disagreements

3. **Fix ALL findings** -- CRITICAL first, then HIGH, MEDIUM, LOW. INFO documented only.

4. **Verify fixes** -- import checks, input validation tests, functionality preserved

5. **Loop until zero findings** -- max 5 iterations, escalate to user if still failing after 5

---

## 3.5.3 Attack Vector Coverage

Every audit iteration MUST verify the complete attack vector checklist:

### Universal
- Hardcoded secrets / API keys / credentials
- Error messages leaking internal details
- Dependency vulnerabilities
- Input validation on ALL external boundaries

### Backend / API
- SQL injection, command injection, path traversal
- SSRF, authentication bypass, authorization bypass
- DoS via unbounded inputs, memory leaks, race conditions
- Response validation, type confusion

### Frontend
- XSS, open redirects, sensitive data in client state
- CSRF, client-side auth bypass

### LLM / AI Specific
- Prompt injection, model output trust
- Tool argument injection, vision/multimodal injection

---

## 3.5.4 Completion Gate

The phase completes ONLY when the audit loop achieves a clean pass with zero findings.

```
SECURITY_AUDIT_GATE: PASS
  Iterations: [N]
  Total findings fixed: [N]
  Breakdown: [X] CRITICAL, [X] HIGH, [X] MEDIUM, [X] LOW fixed
  Clean pass: Iteration [N]
```

**Do NOT proceed to Phase 4 until SECURITY_AUDIT_GATE = PASS.**

---

## Rules

1. **NEVER skip this phase** -- not for small changes, not for docs, not for config
2. **NEVER proceed with findings unfixed** -- zero means zero
3. **ALL severity levels get fixed** -- CRITICAL through LOW
4. **No commit prompt** -- unlike standalone security audit commands, do NOT offer to commit here (Phase 4 handles commits)
5. **Findings feed Phase 4** -- security fixes are verified by Phase 4's type check, build, lint, and secrets gates automatically
