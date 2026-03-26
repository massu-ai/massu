# Iteration Structure

> Reference doc for `/massu-loop`. Return to main file for overview.

## ITERATION STRUCTURE

```
ITERATION N:
  1. [EXECUTE] Perform task segment
  2. [GUARDRAIL] Run pattern-scanner.sh (ABORT if fails)
  3. [GUARDRAIL] Check for security violations
  4. [VERIFY] Run applicable VR-* checks
  5. [AUDIT] Count gaps
  6. [DECIDE] If gaps > 0: fix and re-verify
  7. [PERSIST] Update session-state/CURRENT.md
  8. [CHECKPOINT] At phase boundary: run full audit
```

---

## GUARDRAIL CHECKS (Every Iteration)

### MEMORY CHECK (Start of Each Iteration)

Query `massu_memory_failures` and `massu_memory_search` for failures related to this plan's domain and files being modified. Surface relevant past failures as additional audit checkpoints.

### Enhanced Context Loading

For each file being modified:
- `massu_context` - Load CR rules, schema alerts, patterns relevant to the file
- `massu_coupling_check` - Verify frontend-backend coupling (CR-12/CR-23)
- `massu_knowledge_rule` - Load applicable CR rules for the file's domain
- `massu_knowledge_verification` - Load required VR-* checks for the file type

For VR-COUPLING checks, also call `massu_trpc_map` to get automated procedure-to-UI mapping and compare against check-coupling.sh results for comprehensive coverage.

When verifying CR-32 feature registration, use `massu_sentinel_detail` to get full feature details and verify all linked components/procedures/pages exist.

When CR-30 applies (rebuilds), call `massu_sentinel_parity` to compare old vs new implementation for feature parity.

### Mandatory Checks

```bash
# Pattern scanner (covers P-001 through P-008)
./scripts/pattern-scanner.sh
# Exit 0 = PASS, non-zero = ABORT iteration

# Security check
git diff --cached --name-only | grep -E '\.(env|pem|key|secret)' && echo "SECURITY VIOLATION" && exit 1
```

---

## UI/UX VERIFICATION (When UI Work Done)

Trace ALL: buttons (onClick -> handler -> API), navigation (href/router.push), props chains (source -> consumer), callbacks (defined -> called), state (init -> update -> render), end-to-end flows. Verify loading/error/empty/success states exist. Run `./scripts/check-ux-quality.sh`.

---

## API/ROUTER VERIFICATION (When API Work Done)

Verify procedures exist with `protectedProcedure` for mutations, input schemas defined, client calls match server definitions, and procedures exported in root router.

---

## ENVIRONMENT & CONFIG VERIFICATION

Verify env vars documented, no hardcoded secrets (`grep -rn "sk-\|password.*=" src/` = 0), config files exist.

---

## CONSOLE & ERROR PREVENTION

Check for `console.log` (remove for production), error boundaries exist, null safety with optional chaining.

---

## ITERATION OUTPUT FORMAT

```markdown
## [MASSU LOOP - Iteration N]

### Task
Phase: X | Task: [description]

### Guardrails
- Pattern scanner: PASS/FAIL
- Security check: PASS/FAIL

### Verifications
| Check | Type | Result | Proof |
|-------|------|--------|-------|
| [item] | VR-FILE | PASS | `ls -la output` |

### Gap Count
Gaps found: N

### Status
CONTINUE | FIX_REQUIRED | CHECKPOINT | COMPLETE

### Next Action
[Specific next step]
```

---

## SESSION STATE UPDATE (After Every Iteration)

Update `session-state/CURRENT.md` with: loop status (task, iteration, phase, checkpoint), iteration log table, verified work with proof, failed attempts (do not retry), next iteration plan.

---

## CONTEXT MANAGEMENT

Use Task tool with subagents for exploration to keep main context clean. Update session state before compaction. After compaction, read recovery.md and resume from correct step. Never mix unrelated tasks during a protocol.
