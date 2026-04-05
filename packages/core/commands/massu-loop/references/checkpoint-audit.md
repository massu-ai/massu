# Checkpoint Audit Protocol

> Reference doc for `/massu-loop`. Return to main file for overview.

## CHECKPOINT AUDIT (Phase Boundaries)

```
CHECKPOINT AUDIT FLOW:
[1] READ plan section for this checkpoint
[2] GREP source files to verify modules/tools exist
[3] LS files to verify they exist
[4] VR-TOOL-REG: Verify tools are WIRED in tools.ts (not just created)
[5] GREP for pattern violations
[6] RUN build verification (npm run build)
[7] RUN type verification (cd packages/core && npx tsc --noEmit)
[8] RUN tests (npm test) - MANDATORY, NOT optional
[9] RUN hook build (cd packages/core && npm run build:hooks)
[10] RUN pattern scanner (bash scripts/massu-pattern-scanner.sh)
[11] RUN security check (secrets staged)
[12] COUNT gaps found
[13] IF gaps > 0: FIX each gap, return to Step 1
[14] IF gaps = 0: UPDATE session state
[15] IF gaps = 0: Create checkpoint sign-off
```

---

## PROGRESS DOCUMENTATION

At the end of each phase, create archive: `session-state/archive/[plan-name]/phase-[X]-complete.md` with documentation, commit hash, files touched. Maintain `INDEX.md` for overall progress.

---

## PATTERN LIBRARY UPDATES

After implementation, document genuinely NEW patterns in `patterns/*.md`. Only add if the pattern is new (not reuse of existing). Include Problem, Solution, File reference, Code example, When to Use.
