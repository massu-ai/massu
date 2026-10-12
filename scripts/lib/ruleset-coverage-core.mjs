/**
 * scripts/lib/ruleset-coverage-core.mjs
 *
 * THE single implementation of the plan-rulesets-as-code Layer 2 coverage JUDGEMENT.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────
 * Two runtimes need one judgement and cannot share a dependency:
 *
 *   node, in CI, on BOTH repos   scripts/ruleset-context-coverage.mjs
 *                                job `Ruleset Drift Guard` = a REQUIRED status check
 *   vitest, private tree only    website/src/__tests__/ruleset-context-coverage.test.ts
 *                                via website/src/lib/ruleset-parser.ts
 *
 * The public mirror has no `yaml` package and no `website/` workspace at all, so the TS
 * library is not present there. The historical answer was to DUPLICATE the judgement into
 * the .mjs and bolt a drift test on to police the copy — and that drift test then made a
 * THIRD copy of the extractor in order to compare, so the parser that actually gated CI on
 * both repos was policed by nothing. One line planted in it took reverse coverage from
 * `all 21 push-triggered job contexts` to `all 0` and every guard stayed green.
 * Recorded 2026-09-23 in the retro for this repair.
 *
 * This module ends that by being importable from BOTH runtimes:
 *   - zero dependencies, so `node` needs no install step in either repo;
 *   - under scripts/lib/, which IS synced to the public mirror and already ships .mjs;
 *   - plain ESM, which website/tsconfig.json consumes via `allowJs: true`.
 *
 * ── WHAT IS SHARED AND WHAT IS DELIBERATELY NOT ─────────────────────────────────────────
 * SHARED (one definition, here): the ORACLE, the templated-context rule, the `needs:`-graph
 * derivation, and the reverse-coverage classification. These are JUDGEMENTS. Two copies of a
 * judgement is drift by construction.
 *
 * NOT SHARED, ON PURPOSE: the EXTRACTOR. This file owns the regex tier; the TS library keeps
 * its `yaml`-package tier. Two INDEPENDENT implementations compared on the same input is
 * differential testing and is a real oracle — that is what parser parity is for, and it is
 * only true once the parity test imports THIS file instead of a copy of it.
 *
 * Reference: docs/plans/2026-05-15-rulesets-as-code.md §3 Layer 2 + P-C-007;
 *            docs/plans/2026-09-22-a-required-check-can-pass-by-not-running.md D-4.
 */

/**
 * Jobs whose contexts are intentionally NOT required as gating status checks.
 * Each entry MUST cite the reason. Renames or removals here are intentional
 * changes that should go through code review.
 *
 * KEEP IN SYNC with WORKFLOW_NOT_REQUIRED_AS_CONTEXT in
 * website/src/__tests__/ruleset-context-coverage.test.ts.
 */
export const WORKFLOW_NOT_REQUIRED_AS_CONTEXT = new Set([
  // G-1 REALITY GATE (reality.yml). Probes the OUTSIDE WORLD — live endpoints at
  // api.massu.ai, massu.ai. It MUST NOT gate a merge: a vendor outage, a DNS blip, or a
  // Supabase incident would then block every push, and a gate that blocks on someone
  // else's downtime gets switched off — which is how gates rot.
  'reality',

  // The rule-apply workflow must not gate the rule it creates (chicken-and-egg).
  'Apply Ruleset',

  // The anti-vacuity sweep proves other gates can FAIL. It is a ~1h job and its verdict is
  // about the gate corpus, not about this commit, so it reports rather than holds the door.
  'Anti-Vacuity',

  // MATRIX TEMPLATE NAMES — PERMANENT, and restored 2026-09-23 after D-4 wrongly retired
  // them. `jobs.<id>.name` here carries a `${{ }}` expression, so the context GitHub
  // actually reports is the EXPANDED name (`Windows Bootstrap (Node 22)`) and this string
  // can never literally equal a required context. In both cases the required context is the
  // AGGREGATOR job, so these are permanently not-required rather than pending anything.
  // That makes them an ORACLE entry by design (G32 clause 0): deriving "is this templated?"
  // inside the coverage rule would put the same judgement in two implementations, which is
  // exactly the drift the parity test exists to catch — and did catch, here.
  // aggregator that IS required: 'Windows Bootstrap Gate'
  'Windows Bootstrap (Node ${{ matrix.node }})',
  // fresh-install-matrix.yml, measured ~52s; aggregated by its own workflow
  'init --ci on ${{ matrix.fixture }}',
  // aggregator that IS required: 'Native Module Gate'
  'Native Module (Node ${{ matrix.node }})',

  // The PUBLIC mirror's fan-in gate. PERMANENT for this ruleset, not transitional: this file
  // governs massu-internal, whose 13 other required contexts are all internal jobs, and the
  // public gate belongs to the public repo's own ruleset. In THIS repo its job is
  // repository-guarded and skips by design, which is how one committed ruleset serves both.
  'CI Required (public mirror)',
])

/* === THE REGEX EXTRACTOR TIER ==========================================================
 * Moved here VERBATIM from scripts/ruleset-context-coverage.mjs so that file has no private
 * parser left to drift, and so the parity test can import the production code instead of
 * vendoring a copy of it.
 * ====================================================================================== */

/**
 * Regex-based extractor for jobs.<id>.name.
 * Constraints (enforced by website P-B-005 test):
 *   - 2-space indent
 *   - single-line job name
 *   - job name does not contain a literal ":"
 *
 * Algorithm:
 *   1. Find the `^jobs:$` line.
 *   2. From there, scan for `^  ([a-zA-Z0-9_-]+):` (job ID at 2-space indent).
 *   3. Within each job body, find `^    name:\s*(.+?)\s*$` (4-space indent).
 *   4. Skip commented-out lines (`^\s*#`).
 *   5. If no `name:` found before the next job ID, fall back to the job ID.
 */
export function jobContextNames(yamlContent) {
  const lines = yamlContent.split('\n')
  const jobs = []
  let inJobsBlock = false
  let currentJobId = null
  let currentJobIndent = null
  let currentJobName = null

  const finalizeCurrentJob = () => {
    if (currentJobId !== null) {
      jobs.push(currentJobName ?? currentJobId)
    }
    currentJobId = null
    currentJobIndent = null
    currentJobName = null
  }

  for (const rawLine of lines) {
    if (/^\s*#/.test(rawLine)) continue // skip comments
    if (rawLine.trim() === '') continue // skip blank lines

    if (!inJobsBlock) {
      if (/^jobs:\s*$/.test(rawLine)) inJobsBlock = true
      continue
    }

    // Top-level key (column 0, e.g., `permissions:`) ends the jobs block
    if (/^[a-zA-Z_-]/.test(rawLine)) {
      finalizeCurrentJob()
      inJobsBlock = false
      continue
    }

    const jobIdMatch = rawLine.match(/^  ([a-zA-Z0-9_-]+):\s*$/)
    if (jobIdMatch) {
      finalizeCurrentJob()
      currentJobId = jobIdMatch[1]
      currentJobIndent = 2
      currentJobName = null
      continue
    }

    if (currentJobId !== null && currentJobName === null) {
      const nameMatch = rawLine.match(/^    name:\s*(.+?)\s*$/)
      if (nameMatch) {
        let v = nameMatch[1].trim()
        // Strip single OR double quotes when fully wrapped
        if (
          (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
          (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
        ) {
          v = v.slice(1, -1)
        }
        currentJobName = v
      }
    }
  }
  finalizeCurrentJob()

  return jobs
}

export function isPushTriggered(yamlContent) {
  // Matches `on: push` (single-line) or `on:` block containing `push:` (or `push: ...`)
  // The first variant: `^on:\s*push\s*$`
  // The second: an `^on:` line followed within ~30 lines by `^  push:`
  const lines = yamlContent.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (/^on:\s*push\s*$/.test(lines[i])) return true
    if (/^on:\s*$/.test(lines[i])) {
      // scan block for `^  push:` or `^  push:\s*$`
      for (let j = i + 1; j < lines.length; j++) {
        if (/^[a-zA-Z_-]/.test(lines[j])) break // new top-level key
        if (/^  push:/.test(lines[j])) return true
      }
    }
    // inline mapping: `on: [push, pull_request]`
    if (/^on:\s*\[.*\bpush\b.*\]/.test(lines[i])) return true
  }
  return false
}

/* === THE REGEX FACT TIER ================================================================
 * `needs:` and job-level `if:` for every job, from the same 2-space/4-space workflow style
 * P-B-005 enforces. The TS library derives the identical facts with the `yaml` package; both
 * feed the SHARED judgement below, so the two extractors stay a differential pair rather
 * than two copies of one decision.
 * ====================================================================================== */

/** `jobs.<id>.needs` as a job-id list per job, normalising scalar, inline-seq and block-seq. */
export function needsByJobId(yamlContent) {
  const lines = yamlContent.split('\n')
  const out = new Map()
  let inJobs = false
  let jobId = null
  let collecting = null // job id whose block-sequence `needs:` we are reading
  for (const raw of lines) {
    if (/^\s*#/.test(raw) || raw.trim() === '') continue
    if (!inJobs) {
      if (/^jobs:\s*$/.test(raw)) inJobs = true
      continue
    }
    if (/^[a-zA-Z_-]/.test(raw)) break // next top-level key ends the jobs block
    const id = raw.match(/^  ([a-zA-Z0-9_-]+):\s*$/)
    if (id) {
      jobId = id[1]
      collecting = null
      continue
    }
    if (jobId === null) continue
    if (collecting !== null) {
      const item = raw.match(/^ {6}- *(.+?)\s*$/)
      if (item) {
        out.get(collecting).push(unquote(item[1]))
        continue
      }
      collecting = null // the block sequence ended
    }
    const needs = raw.match(/^ {4}needs:\s*(.*)$/)
    if (needs) {
      const value = needs[1].trim()
      if (value === '') {
        out.set(jobId, [])
        collecting = jobId
      } else if (value.startsWith('[')) {
        const inner = value.replace(/^\[/, '').replace(/\]$/, '')
        out.set(
          jobId,
          inner
            .split(',')
            .map((s) => unquote(s.trim()))
            .filter((s) => s !== ''),
        )
      } else {
        out.set(jobId, [unquote(value)])
      }
    }
  }
  // A `needs:` that opened a block sequence and collected nothing is NOT a dependency-free
  // job — it is a malformed workflow, and returning [] would make it read as one (M2).
  for (const [id, deps] of out) {
    if (deps.length === 0) {
      throw new Error(
        `ruleset-coverage-core: jobs.${id}.needs is declared but empty — ` +
          `refusing to report it as dependency-free`,
      )
    }
  }
  return out
}

function unquote(v) {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1)
  }
  return v
}

/**
 * Gate facts per job: the effective context name, whether a dependency can skip it, and
 * whether a job-level `if:` exists to run it anyway.
 *
 * Mirrors the shape of the TS library's `JobGateFacts` exactly, because the shared judgement
 * consumes both.
 */
export function jobGateFacts(yamlContent) {
  const contexts = jobContextNames(yamlContent)
  const ids = jobIds(yamlContent)
  if (contexts.length !== ids.length) {
    // The two walks disagree on how many jobs exist, so pairing them by index would silently
    // attribute one job's context to another. Fail closed rather than mis-pair (M2).
    throw new Error(
      `ruleset-coverage-core: job walk disagreement — ${ids.length} ids vs ` +
        `${contexts.length} contexts; refusing to pair them`,
    )
  }
  const needs = needsByJobId(yamlContent)
  const ifs = topLevelIfByJobId(yamlContent)
  return ids.map((jobId, i) => ({
    jobId,
    context: contexts[i],
    hasNeeds: needs.has(jobId),
    hasTopLevelIf: ifs.has(jobId),
    ifExpression: ifs.get(jobId),
  }))
}

/** Job IDs in document order — the pairing key for {@link jobGateFacts}. */
export function jobIds(yamlContent) {
  const out = []
  let inJobs = false
  for (const raw of yamlContent.split('\n')) {
    if (/^\s*#/.test(raw) || raw.trim() === '') continue
    if (!inJobs) {
      if (/^jobs:\s*$/.test(raw)) inJobs = true
      continue
    }
    if (/^[a-zA-Z_-]/.test(raw)) break
    const id = raw.match(/^  ([a-zA-Z0-9_-]+):\s*$/)
    if (id) out.push(id[1])
  }
  return out
}

/** Job-level `if:` expressions by job id. A block scalar records its first line. */
export function topLevelIfByJobId(yamlContent) {
  const out = new Map()
  let inJobs = false
  let jobId = null
  for (const raw of yamlContent.split('\n')) {
    if (/^\s*#/.test(raw) || raw.trim() === '') continue
    if (!inJobs) {
      if (/^jobs:\s*$/.test(raw)) inJobs = true
      continue
    }
    if (/^[a-zA-Z_-]/.test(raw)) break
    const id = raw.match(/^  ([a-zA-Z0-9_-]+):\s*$/)
    if (id) {
      jobId = id[1]
      continue
    }
    if (jobId === null) continue
    const m = raw.match(/^ {4}if:\s*(.*)$/)
    if (m && !out.has(jobId)) out.set(jobId, m[1].trim())
  }
  return out
}

/* === THE SHARED JUDGEMENT ===============================================================
 * One definition, consumed by node-in-CI and by vitest. Everything below is PURE over facts
 * — no file reads, no parser — so both extractor tiers feed the identical decision.
 * ====================================================================================== */

/**
 * A job name containing a GitHub expression can NEVER be a literal required context.
 *
 * `jobs.<id>.name` may be a template — `Native Module (Node ${{ matrix.node }})`. No static
 * reader expands it; the per-leg check-run names exist only at GitHub runtime. So such a name
 * is structurally incapable of matching a required-context string, and reverse coverage
 * DERIVES that instead of taking an exemption list's word for it.
 */
export function isTemplatedContext(context) {
  return context.includes('${{')
}

/**
 * Contexts reachable from the `needs:` graph of a job that IS a required context.
 *
 * A matrix leg under a required fan-in gate is already gated — transitively, by the gate that
 * depends on it. That is a fact about the graph, so it is derived rather than transcribed.
 * Resolution is job id -> effective context name, because `needs:` names job IDS while the
 * ruleset names CONTEXTS.
 *
 * Takes FACTS, not file content, so the caller's own extractor tier supplies them.
 * `perWorkflow` is `[{ facts: JobGateFacts[], needs: Map<jobId, jobId[]> }]`.
 */
export function contextsCoveredByRequiredGateFromFacts(perWorkflow, requiredContexts) {
  const required = new Set(requiredContexts)
  const covered = new Set()
  for (const { facts, needs } of perWorkflow) {
    const contextOf = new Map(facts.map((f) => [f.jobId, f.context]))
    for (const f of facts) {
      if (!required.has(f.context)) continue
      for (const dep of needs.get(f.jobId) ?? []) {
        covered.add(contextOf.get(dep) ?? dep)
      }
    }
  }
  return covered
}

/** Convenience over the regex tier, for callers that hold raw workflow contents. */
export function contextsCoveredByRequiredGate(sources, requiredContexts) {
  return contextsCoveredByRequiredGateFromFacts(
    sources.map(({ content }) => ({ facts: jobGateFacts(content), needs: needsByJobId(content) })),
    requiredContexts,
  )
}

/**
 * The CLOSED verdict vocabulary for reverse coverage. An unrecognised verdict is an ERROR
 * rather than a silently skipped row (G3), so this Set is the authority and callers compare
 * against it instead of writing their own strings.
 */
export const REVERSE_COVERAGE_VERDICTS = new Set([
  'required', // named in the ruleset's required_status_checks
  'derivably-gated', // a dependency of a job that IS required — gated transitively
  'templated', // the name carries a ${{ }} expression, so it can never be a literal context
  'oracle', // an entry of WORKFLOW_NOT_REQUIRED_AS_CONTEXT, with its cited reason
  'UNGATED', // none of the above — the finding
])

/**
 * Classify every push-triggered context, and REFUSE to answer vacuously.
 *
 * ⛔ THE M1 ASSERTION IS THE POINT OF THIS FUNCTION, not decoration on it. Reverse coverage
 * is a universally quantified claim — "every push-triggered context is gated" — over a set
 * the CALLER's extractor computes. Shrinking that set makes the claim EASIER, so a parser
 * that goes blind produces the healthiest-looking possible output. Measured 2026-09-23: one
 * planted line took the denominator from 21 to 0 and the gate printed
 * `REVERSE COVERAGE PASS: all 0 push-triggered job contexts` and exited 0.
 *
 * So an empty subject set, or an empty required set, THROWS. "I could not look" and "I looked
 * and found nothing" must not be the same value.
 */
export function classifyReverseCoverage({
  pushTriggeredContexts,
  requiredContexts,
  coveredByRequiredGate,
  oracle = WORKFLOW_NOT_REQUIRED_AS_CONTEXT,
}) {
  const subjects = [...pushTriggeredContexts]
  if (subjects.length === 0) {
    throw new Error(
      'ruleset-coverage-core: 0 push-triggered contexts were extracted. Reverse coverage over ' +
        'an empty set is vacuously true, so this is an EXTRACTOR failure, not a pass. ' +
        'Check that the workflow corpus is readable and that on:/jobs: detection still matches.',
    )
  }
  if ([...requiredContexts].length === 0) {
    throw new Error(
      'ruleset-coverage-core: 0 required contexts were read from the ruleset. Every context ' +
        'would classify as UNGATED for the wrong reason; refusing to judge.',
    )
  }
  const required = new Set(requiredContexts)
  const covered = new Set(coveredByRequiredGate ?? [])
  const verdicts = new Map()
  for (const context of subjects) {
    let verdict
    if (required.has(context)) verdict = 'required'
    else if (covered.has(context)) verdict = 'derivably-gated'
    else if (isTemplatedContext(context)) verdict = 'templated'
    else if (oracle.has(context)) verdict = 'oracle'
    else verdict = 'UNGATED'
    if (!REVERSE_COVERAGE_VERDICTS.has(verdict)) {
      throw new Error(`ruleset-coverage-core: verdict '${verdict}' is outside the closed vocabulary`)
    }
    verdicts.set(context, verdict)
  }
  const counts = {}
  for (const v of REVERSE_COVERAGE_VERDICTS) counts[v] = 0
  for (const v of verdicts.values()) counts[v] += 1
  const ungated = subjects.filter((c) => verdicts.get(c) === 'UNGATED')
  const tallied = Object.values(counts).reduce((a, b) => a + b, 0)
  if (tallied !== subjects.length) {
    // A counted-but-unclassified subject is a dead branch; totals and details must agree.
    throw new Error(
      `ruleset-coverage-core: classified ${tallied} of ${subjects.length} subjects — ` +
        'totals and details disagree',
    )
  }
  return { denominator: subjects.length, verdicts, counts, ungated }
}
