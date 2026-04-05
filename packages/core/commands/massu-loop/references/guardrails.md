# The 10 Accountability Safeguards

> Reference doc for `/massu-loop`. Return to main file for overview.

## THE 10 ACCOUNTABILITY SAFEGUARDS

1. **Audit Proof Requirement** - Every claim MUST include proof output. Claims without proof are INVALID.
2. **Explicit Gap Count Per Loop** - State gaps found, gap details, status (PASS/FAIL). "Looks good" is BANNED.
3. **Checkpoint Sign-Off Format** - Use exact format from COMPLETION OUTPUT section (see [vr-plan-spec.md](vr-plan-spec.md)).
4. **Session State Mandatory Updates** - Update `session-state/CURRENT.md` after EVERY change with proof.
5. **User Verification Rights** - User can request proof re-runs at any time. Comply with actual output.
6. **Post-Compaction Recovery** - Read session state FIRST, re-read plan, resume from exact point.
7. **No Claims Without Evidence** - "I verified...", "Build passed..." require accompanying proof output.
8. **Failure Acknowledgment** - Acknowledge failures, re-execute audit from Step 1, log in session state.
9. **User Flow Audit Required** - ALL tools, hooks, handlers, flows verified AFTER technical audits pass.
10. **Component Reuse Verification** - Check existing modules before creating new ones.
11. **No Workarounds Allowed** - TODOs, ts-ignore are BLOCKING violations. Pattern scanner is a HARD GATE.
