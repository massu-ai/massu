# Code Quality & Communication Standards

**Part of Prime Directive** | [Back to Main](../CLAUDE.md)

---

## Code Quality Standards

### TypeScript

- **0 errors** required for production
- Warnings are acceptable if documented
- No `any` types without justification
- No `@ts-ignore` without explanation
- Type safety is non-negotiable

### Testing

- Fix failing tests, don't skip them
- >90% pass rate minimum
- Flaky tests must be investigated
- E2E tests must pass for critical flows

### Code Structure

- No commented-out code blocks >10 lines
- No console.log in production (except error handling)
- No TODO in critical paths without tracking
- No hardcoded credentials ever

### Database Schema Awareness

**CRITICAL**: Always verify field names exist in schema before using them.

```typescript
// [X] WRONG: Assuming fields exist
const name = `${contact.first_name} ${contact.last_name}`;

// [x] CORRECT: Check schema first
// Schema has: { id, name, email, phone, company_id, position }
const name = contact.name || contact.email;
```

**Prevention**:
1. Check Prisma schema file before accessing fields
2. Use TypeScript types from Prisma
3. Test with actual data from database

---

## Communication Standards

### Be Honest

- Admit mistakes immediately
- Don't hide problems
- Don't sugarcoat issues
- Don't make excuses

### Be Precise

- Show exact commands run
- Show exact output received
- Show exact errors encountered
- Provide concrete evidence

### Be Conservative

- Under-promise, over-deliver
- Flag potential issues early
- Assume worst case scenarios
- Verify optimistic assumptions

---

## When Making Claims

### [X] NEVER SAY:
- "This should work"
- "Probably production ready"
- "Looks good to me"
- "I think it's fixed"
- "The tests pass so it's ready"

### [x] ALWAYS SAY:
- "I verified X by running Y, here are the results"
- "The build succeeded in X minutes: [output]"
- "I found N errors, here's the plan to fix them"
- "Not production ready: [specific issues]"
- "Production ready: [proof of verification]"

---

## Verification Checklist

Before claiming **ANY** task is complete:

- [ ] Does it work? (tested manually or automatically)
- [ ] Does it build? (no errors)
- [ ] Does it type-check? (no errors)
- [ ] Is it secure? (no secrets, no vulnerabilities)
- [ ] Is it documented? (updated relevant docs)
- [ ] Can it be verified? (repeatable test)

**All checkboxes must be [x] before claiming complete.**

---

## When in Doubt

### Ask Questions

- "Should I verify this works before claiming it's fixed?"
  **Answer: YES, ALWAYS**

- "Is it okay to skip this check to save time?"
  **Answer: NO, NEVER**

- "Can I claim production ready without running the build?"
  **Answer: NO, ABSOLUTELY NOT**

- "Should I investigate this timeout?"
  **Answer: YES, IMMEDIATELY**

### Default to Quality

- **When choosing between fast and correct**: Choose correct
- **When choosing between easy and proper**: Choose proper
- **When choosing between done and verified**: Choose verified
- **When choosing between working and production-ready**: Choose production-ready

---

**Status**: MANDATORY
**Reference**: [Main CLAUDE.md](../CLAUDE.md)
