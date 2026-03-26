# Canonical Rules (CR) — Full Reference

All CR rules with verification types and reference links.

| ID | Rule | Verification Type | Reference |
|----|------|-------------------|-----------|
| CR-1 | Never claim state without proof | VR-* | [protocols/verification.md](../protocols/verification.md) |
| CR-2 | Never assume database schema | VR-SCHEMA | [protocols/verification.md](../protocols/verification.md) |
| CR-3 | Never commit secrets | git status check | Incident records |
| CR-4 | Verify removals with negative grep | VR-NEGATIVE | [protocols/plan-implementation.md](../protocols/plan-implementation.md) |
| CR-5 | ALL secrets MUST use secure credential management | VR-SECRETS | [patterns/security-patterns.md](../patterns/security-patterns.md) |
| CR-6 | Read plan file, not memory | Plan file open | [protocols/plan-implementation.md](../protocols/plan-implementation.md) |
| CR-7 | Check ALL items in plan, not "most" | VR-COUNT | [protocols/plan-implementation.md](../protocols/plan-implementation.md) |
| CR-8 | Created components MUST be rendered | VR-RENDER | Incident records |
| CR-9 | Fix ALL issues encountered, whether from current changes or pre-existing | VR-FIX-ALL | Incident records |
| CR-10 | Plan document MUST have completion status | VR-PLAN-STATUS | [protocols/plan-implementation.md](../protocols/plan-implementation.md) |
| CR-11 | NEVER stop loop until 100% plan coverage | VR-PLAN-COVERAGE | Implementation loop protocol |
| CR-12 | After compaction, NEVER escalate beyond AUTHORIZED_COMMAND | VR-PROTOCOL | [protocols/recovery.md](../protocols/recovery.md) |
| CR-13 | Plan UI specs MUST match implementation | VR-PLAN-SPEC | [protocols/plan-implementation.md](../protocols/plan-implementation.md) |
| CR-14 | ALL solutions MUST be enterprise-grade | Design review | [protocols/verification.md](../protocols/verification.md) |
| CR-15 | Edge Runtime files MUST NOT import Node.js deps | VR-EDGE | [patterns/build-patterns.md](../patterns/build-patterns.md) |
| CR-16 | Native/heavy packages MUST be externalized | VR-EXTERN | [patterns/build-patterns.md](../patterns/build-patterns.md) |
| CR-17 | ALWAYS fix ALL issues encountered | VR-FIX | [protocols/verification.md](../protocols/verification.md) |
| CR-18 | Import chains MUST NOT pull heavy deps | VR-IMPORT | [patterns/build-patterns.md](../patterns/build-patterns.md) |
| CR-19 | Builds MUST have ZERO warnings | VR-LINT | [patterns/build-patterns.md](../patterns/build-patterns.md) |
| CR-20 | ALL tests MUST pass before claiming complete | VR-TEST | [protocols/verification.md](../protocols/verification.md) |
| CR-21 | Database configs MUST match code expectations | VR-DATA | [protocols/verification.md](../protocols/verification.md) |
| CR-22 | Backend procedures MUST be called from UI | VR-COUPLING | [protocols/verification.md](../protocols/verification.md) |
| CR-23 | ALL protocol commands MUST be followed exactly | VR-PROTOCOL | Incident records |
| CR-24 | Changing values requires codebase-wide blast radius analysis | VR-BLAST-RADIUS | Plan creation protocol |
| CR-25 | Before editing UI, verify file serves target URL | VR-ROUTE | Incident records |
| CR-26 | After table migrations, audit ALL stored procedures | VR-STORED-PROC | Incident records |
| CR-27 | Config map lookups MUST have fallback defaults for dynamic keys | VR-CONFIG-GUARD | Incident records |
| CR-28 | Rebuilds MUST audit old implementation for feature parity BEFORE deleting | VR-PARITY | Incident records |
| CR-29 | ALWAYS propose the most robust, enterprise-grade solution | VR-QUALITY | [protocols/verification.md](../protocols/verification.md) |
| CR-30 | ALL public tables MUST have RLS enabled | VR-RLS-AUDIT | Incident records |
| CR-31 | ALL fixes MUST be auto-learned: ingest to memory, record pattern, update scanner | VR-LEARNING | All command protocols |
| CR-32 | ALL database migrations MUST be applied to ALL environments | VR-SCHEMA-SYNC | Incident records |
| CR-33 | Stagnating loops MUST bail and replan, not grind | VR-PROTOCOL | Implementation loop protocol |
| CR-34 | ALL significant work MUST be persisted to memory BEFORE session ends | VR-MEMORY | [protocols/verification.md](../protocols/verification.md) |
| CR-35 | Propose approach before multi-file changes | VR-APPROACH | [protocols/verification.md](../protocols/verification.md) |
| CR-36 | ALL overlays MUST use Sheet, NEVER Dialog (except AlertDialog) | VR-UI | Incident records |
| CR-37 | ALL UI fixes MUST be browser-verified via Playwright before claiming done | VR-BROWSER | Incident records |
| CR-38 | Plan UI specs (CSS classes, structure, layout) MUST match implementation exactly | VR-SPEC-MATCH | [protocols/verification.md](../protocols/verification.md) |
| CR-39 | Data pipeline features MUST be triggered end-to-end with non-empty output verified | VR-PIPELINE | [protocols/verification.md](../protocols/verification.md) |
| CR-40 | After every debug fix, scanner MUST be updated with detection rule for the root cause pattern | VR-LEARNING | Incident records |
| CR-41 | After context compaction during implementation, re-read plan file from disk and rebuild item tracking before proceeding | VR-PLAN-COVERAGE | Incident records |
| CR-42 | ALL exported service functions MUST be wired to a consumer (tRPC router, API route, or cron). No half-built features. | VR-UNWIRED | Scanner enforcement |
| CR-43 | ALL data-writing features MUST be verified write->store->read->display end-to-end before claiming complete | VR-ROUNDTRIP | [reference/vr-verification-reference.md](vr-verification-reference.md) |

---

## Full Core Principles (22)

1. **NO SHORTCUTS** - Quality over speed, always
2. **COMPLETE VERIFICATION** - Proof, not claims
3. **ZERO ASSUMPTIONS** - Query, don't guess
4. **ALL ITEMS** - "Most of them" is not "all of them"
5. **NEGATIVE VERIFICATION** - Removals need grep returning 0
6. **SESSION STATE** - Record decisions and failures
7. **PATTERN COMPLIANCE** - Read patterns, show proof
8. **ENHANCEMENT PRINCIPLE** - If it would improve the system, add it NOW (no skipping, no workarounds)
9. **ENTERPRISE-GRADE ONLY** - Every solution must be permanent, production-ready, error-free
10. **NEVER SKIP** - Solve ALL problems as encountered, never postpone or use stopgaps
11. **NEVER STOP EARLY** - Loop continues until 100% plan coverage, no exceptions, no early termination
12. **SECRETS SECURED** - All secrets use secure credential management, never plain env vars
13. **PROTOCOLS ARE MANDATORY** - Slash commands are execution instructions; reading is not following
14. **BLAST RADIUS FIRST** - When changing any value, grep entire codebase before planning; documented sync patterns are necessary but not sufficient
15. **CONTEXT HYGIENE** - Use subagents for exploration, /clear between unrelated tasks, update session state before compaction
16. **FIX EVERYTHING ENCOUNTERED** - Every issue found during work MUST be fixed immediately, whether from current changes or pre-existing; "not in scope" is never valid
17. **MIGRATIONS HIT ALL ENVIRONMENTS** - Every schema change MUST be applied to all environments in the same session; a migration applied to 1 database is incomplete
18. **SIMPLEST CORRECT SOLUTION** - When fixing or building, choose the simplest approach that is correct and complete. CR-9 mandates fixing all issues; this principle mandates fixing them simply. If scope expands beyond the original task, flag it before expanding.
19. **ELEGANCE CHECK** - For non-trivial changes, pause and ask: "Is there a more elegant way?" If a fix feels hacky, implement the elegant solution. Skip for simple, obvious fixes. Would a staff engineer approve this approach?
20. **ONE TASK PER SUBAGENT** - Each spawned agent gets a single focused task. Parallel spawning is encouraged but each agent receives one isolated concern. Never combine unrelated tasks in one spawn.
21. **MEMORY IS MANDATORY** - ALL significant decisions, fixes, patterns, errors, config changes, new tools, and architectural learnings MUST be persisted to memory files BEFORE the session ends or /clear. Knowledge lost to session end is unrecoverable.
22. **PROPOSE FIRST** - For non-trivial tasks (>2 files, unfamiliar API, multiple valid approaches), propose approach in 2-3 bullets before implementing. Include which existing codebase patterns/utilities to use. Skip for simple fixes with obvious implementations.
