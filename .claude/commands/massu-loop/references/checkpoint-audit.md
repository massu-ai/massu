# Checkpoint Audit Protocol

> Reference doc for `/massu-loop`. Return to main file for overview.

## CHECKPOINT AUDIT (Phase Boundaries)

```
CHECKPOINT AUDIT FLOW:
[1] READ plan section for this checkpoint
[2] QUERY database to verify tables/columns/policies/grants (all envs)
[3] GREP router files to verify procedures exist
[4] LS component files to verify they exist
[5] VR-RENDER: Verify UI components are RENDERED in pages (not just created)
[6] VR-COUPLING: Run ./scripts/check-coupling.sh (backend features exposed in UI)
[7] GREP for pattern violations (P-001 through P-008)
[8] RUN build verification (npm run build)
[9] RUN type verification (npx tsc --noEmit)
[10] RUN lint verification (npm run lint)
[11] RUN prisma validate (npx prisma validate)
[12] RUN tests (npm test) - MANDATORY, NOT optional
[13] RUN UI/UX verification (if UI changes)
[14] RUN API/router verification (if API changes)
[15] RUN security check (secrets staged)
[16] COUNT gaps found
[17] IF gaps > 0: FIX each gap, return to Step 1
[18] IF gaps = 0: UPDATE session state
[19] IF gaps = 0: Create checkpoint sign-off
```

---

## PROGRESS DOCUMENTATION

At the end of each phase, create archive: `session-state/archive/[plan-name]/phase-[X]-complete.md` with documentation, commit hash, files touched. Maintain `INDEX.md` for overall progress.

---

## PATTERN LIBRARY UPDATES

After implementation, document genuinely NEW patterns in `patterns/*.md`. Only add if the pattern is new (not reuse of existing). Include Problem, Solution, File reference, Code example, When to Use.
