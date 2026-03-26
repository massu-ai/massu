# Auto-Learning Protocol

> Reference doc for `/massu-loop`. Return to main file for overview.

## POST-BUILD REFLECTION + MANDATORY MEMORY PERSIST (CR-38)

After verification passes with zero gaps, capture accumulated implementation knowledge before it's lost to context compression. Answer these questions:

1. **"Now that I've built this, what would I have done differently?"**
   - Architectural choices that caused friction
   - Patterns that were harder to work with than expected
   - Code that works but feels fragile or overly complex

2. **"What should be refactored before moving on?"**
   - Concrete suggestions with file paths and line numbers
   - Technical debt introduced during this implementation
   - Opportunities to simplify or consolidate

3. **"Did we over-build? Is there a simpler way?"**
   - Identify any added complexity that wasn't strictly needed
   - Flag scope expansion beyond the original plan
   - Check if any "fix everything encountered" items could have been simpler

4. **"Would a staff engineer approve this?" (Principle #19)**

**MANDATORY Actions** (reflection + memory write = ONE atomic action):
1. Apply any low-risk refactors immediately (re-run build/type check after)
2. **IMMEDIATELY write ALL learnings to memory/ files** -- failed approaches, new patterns, tool gotchas, architectural insights. DO NOT just output reflections as text. Every insight MUST be persisted to `memory/MEMORY.md` or a topic file using the Write/Edit tool.
3. Log remaining suggestions in the plan document under `## Post-Build Reflection`

**WARNING**: Outputting reflections without writing them to memory files is a CR-38 violation. The reflection and the memory write are inseparable.

---

## AUTO-LEARNING PROTOCOL (MANDATORY after every loop completion)

After Loop Completes (Zero Gaps):

- **Persist Phase 2.1 reflections**: EVERY insight from Post-Build Reflection MUST be written to `memory/MEMORY.md` or a topic file -- failed approaches, tool gotchas, unexpected behavior, "what I'd do differently". This is NOT optional. If Phase 2.1 produced reflections that aren't in memory files, this protocol is INCOMPLETE.
- **Ingest fixes into massu memory**: `massu_memory_ingest` with type "bugfix"/"pattern", description "[Wrong] -> [Fixed]", files, importance (5=security, 3=build, 2=cosmetic)
- **Record failed approaches**: `massu_memory_ingest` with type "failed_attempt", importance 5
- **Update MEMORY.md**: Add wrong vs correct patterns, tool behaviors, config gotchas
- **Update pattern scanner**: Add new grep-able bad patterns to `scripts/pattern-scanner.sh`
- **Codebase-wide search**: Verify no other instances of same bad pattern (CR-9)
- **Consider new CR rule**: If a class of bug was found (not one-off), propose for CLAUDE.md
- **Record user corrections**: If the user corrected any behavior during this loop, add structured entry to `memory/corrections.md` with date, wrong behavior, correction, and prevention rule

**A loop that fixes 5 bugs but records 0 learnings is 80% wasted. The fixes are temporary; the learnings are permanent.**
**A reflection that isn't persisted to memory is a learning that will be lost. Text output is not persistence.**
