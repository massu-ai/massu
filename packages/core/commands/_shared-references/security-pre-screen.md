# Shared Reference: Security Pre-Screen

**This is a shared content block. Referenced by multiple commands. Do NOT invoke directly.**

---

## SECURITY PRE-SCREEN (Shift-Left Gate)

**Purpose**: Catch security gaps BEFORE implementation/plan generation, not after. Complements (does not replace) the security-reviewer subagent that audits implemented code.

### 6 Security Dimensions

| # | Dimension | Trigger | Action if Triggered |
|---|-----------|---------|---------------------|
| S1 | PII / Sensitive Data | Feature handles names, emails, financial data, addresses | Add RLS policies + column-level access to plan |
| S2 | Authentication | Feature needs to know WHO the user is | Verify protectedProcedure usage, add auth items |
| S3 | Authorization | Feature restricts WHAT users can do (roles, ownership) | Add RBAC checks, RLS policies to plan |
| S4 | Injection Surfaces | User input flows to SQL, HTML, shell, or file paths | Add Zod validation, parameterized queries to plan |
| S5 | Secrets Management | New API keys, tokens, or credentials (CR-5) | Add AWS Secrets Manager items (P0-XXX) to plan |
| S6 | Rate Limiting | Public endpoints or high-cost operations (AI, email, PDF) | Add rate limiting middleware to plan |

### Scoring

For each dimension, assign:
- **PASS**: Not applicable or already handled
- **N/A**: Feature does not touch this dimension
- **BLOCK**: Unresolved concern that must be addressed before proceeding

### Block Resolution

| Block Type | Resolution |
|------------|------------|
| Self-resolvable | Add missing security deliverable (RLS policy, Zod schema, protectedProcedure, etc.) and change to PASS |
| Requires user decision | Ask via AskUserQuestion (e.g., "Should factory portal users see all orders or only their own?") |
| Architectural concern | Document in Risk Assessment section |

### Gate

```
BLOCKS_REMAINING = count of BLOCK items
IF BLOCKS_REMAINING > 0: DO NOT proceed. Resolve all blocks first.
IF BLOCKS_REMAINING = 0: PASS.
```

### Skip Condition

Pure read-only UI cosmetic changes (styling, copy, layout) with NO data access changes may skip this phase. Document: `Security Pre-Screen SKIPPED: [reason -- cosmetic-only, no data flow changes]`.

### Pre-Screen Report Format

```markdown
## Security Pre-Screen

| # | Dimension | Status | Notes |
|---|-----------|--------|-------|
| S1 | PII / Sensitive Data | PASS/N/A/BLOCK | [details] |
| S2 | Authentication | PASS/N/A/BLOCK | [details] |
| S3 | Authorization | PASS/N/A/BLOCK | [details] |
| S4 | Injection Surfaces | PASS/N/A/BLOCK | [details] |
| S5 | Secrets Management | PASS/N/A/BLOCK | [details] |
| S6 | Rate Limiting | PASS/N/A/BLOCK | [details] |

**SECURITY PRE-SCREEN: PASS / BLOCKED ([N] blocks remaining)**
```
