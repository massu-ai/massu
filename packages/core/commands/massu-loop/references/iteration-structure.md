# Iteration Structure

> Reference doc for `/massu-loop`. Return to main file for overview.

## ITERATION STRUCTURE

```
ITERATION N:
  1. [EXECUTE] Perform task segment
  2. [GUARDRAIL] Run massu-pattern-scanner.sh (ABORT if fails)
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

Search memory files and session state for failures related to this plan's domain and files being modified. Surface relevant past failures as additional audit checkpoints.

### Enhanced Context Loading

For each file being modified:
- `massu_context` - Load CR rules, schema alerts, patterns relevant to the file
- `massu_coupling_check` - Verify tool registration coupling (CR-11)
- `massu_knowledge_rule` - Load applicable CR rules for the file's domain
- `massu_knowledge_verification` - Load required VR-* checks for the file type

For VR-TOOL-REG checks, also call `massu_trpc_map` to get automated tool-to-handler mapping for comprehensive coverage.

When verifying CR-11 tool registration, use `massu_sentinel_detail` to get full feature details and verify all linked components/tools/handlers exist.

When CR-30 applies (rebuilds), call `massu_sentinel_parity` to compare old vs new implementation for feature parity.

### Mandatory Checks

```bash
# Pattern scanner (covers all pattern checks)
bash scripts/massu-pattern-scanner.sh
# Exit 0 = PASS, non-zero = ABORT iteration

# Security check
git diff --cached --name-only | grep -E '\.(env|pem|key|secret)' && echo "SECURITY VIOLATION" && exit 1
```

---

## IMPLEMENTATION PROTOCOL

### For EACH Plan Item

1. **Read the plan item** from the extracted list
2. **Read any referenced files** before modifying
3. **Implement** following CLAUDE.md patterns
4. **Verify** with the item's verification command
5. **Update coverage** count
6. **Continue** to next item

### Pattern Compliance During Implementation

For every file you create or modify, verify against:

```bash
# Run pattern scanner
bash scripts/massu-pattern-scanner.sh

# Type check
cd packages/core && npx tsc --noEmit

# Tests still pass
npm test
```

### Massu-Specific Implementation Checks

| If Implementing | Must Also |
|-----------------|-----------|
| New MCP tool | Wire 3 functions into tools.ts (CR-11) |
| New hook | Verify esbuild compilation (CR-12) |
| Config changes | Update interface in config.ts AND example in YAML |
| New test | Place in `__tests__/` directory |
| New module | Use ESM imports, getConfig() for config |

---

## API/TOOL VERIFICATION (When Tool Work Done)

Verify tools exist with 3-function pattern (getDefs, isTool, handleCall) in tools.ts, input schemas defined, and tool registration is complete.

---

## ENVIRONMENT & CONFIG VERIFICATION

Verify env vars documented, no hardcoded secrets (`grep -rn "sk-\|password.*=" packages/core/src/` = 0), config files exist.

---

## CONSOLE & ERROR PREVENTION

Check for `console.log` (remove for production), error boundaries exist, null safety with optional chaining.

---

## ITERATION OUTPUT FORMAT

```markdown
## [CS LOOP - Iteration N]

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

Use Task tool with subagents for exploration to keep main context clean. Update session state before compaction. After compaction, read session state and resume from correct step. Never mix unrelated tasks during a protocol.
