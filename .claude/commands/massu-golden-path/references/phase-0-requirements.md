# Phase 0: Requirements & Context Loading

> Reference doc for `/massu-golden-path`. Return to main file for overview.

## 0.1 Session Context Loading

```
[GOLDEN PATH -- PHASE 0: REQUIREMENTS & CONTEXT]
```

- Call `massu_memory_sessions` for recent session context
- Call `massu_memory_search` + `massu_memory_failures` with feature keywords
- Read `session-state/CURRENT.md` for any prior state

## 0.2 Requirements Coverage Map

Initialize ALL dimensions as `pending`:

| # | Dimension | Status | Resolved By |
|---|-----------|--------|-------------|
| D1 | Problem & Scope | pending | User request + interview |
| D2 | Users & Personas | pending | Interview |
| D3 | Data Model | pending | Phase 1A (DB Reality Check) |
| D4 | Backend / API | pending | Phase 1A (Codebase Reality Check) |
| D5 | Frontend / UX | pending | Interview + Phase 1A |
| D6 | Auth & Permissions | pending | Phase 1A (Security Pre-Screen) |
| D7 | Error Handling | pending | Phase 1A (Pattern Compliance) |
| D8 | Security | pending | Phase 1A (Security Pre-Screen) |
| D9 | Edge Cases | pending | Phase 1A (Question Filtering) |
| D10 | Performance | pending | Phase 1A (Pattern Compliance) |

## 0.3 Ambiguity Detection (7 Signals)

| Signal | Description |
|--------|-------------|
| A1 | Vague scope -- no clear boundary |
| A2 | No success criteria -- no measurable outcome |
| A3 | Implicit requirements -- unstated but necessary |
| A4 | Multi-domain -- spans 3+ domains |
| A5 | Contradictions -- conflicting constraints |
| A6 | No persona -- unclear who benefits |
| A7 | New integration -- external service not yet in codebase |

**Score >= 2**: Enter interview loop (0.4). **Score 0-1**: Fast-track to Phase 1A.

## 0.4 Interview Loop (When Triggered)

Ask via AskUserQuestion, one question at a time:
1. Show compact coverage status: `Coverage: D1:done D2:pending ...`
2. Provide 2-4 curated options (never open-ended)
3. Push back on contradictions and over-engineering
4. Self-terminate when D1, D2, D5 covered
5. Escape hatch: user says "skip" / "enough" / "just do it" -> mark remaining as `n/a`
