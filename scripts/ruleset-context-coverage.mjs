#!/usr/bin/env node
/**
 * scripts/ruleset-context-coverage.mjs
 *
 * Public-repo drift-guard for plan-rulesets-as-code Layer 2.
 *
 * The internal-repo drift-guard lives in vitest
 * (website/src/__tests__/ruleset-context-coverage.test.ts) which uses the
 * `yaml` npm package for proper YAML parsing. The public repo does NOT have
 * vitest or `yaml` available at root — adding either as a public-repo dep
 * would create a new cross-repo drift surface.
 *
 * This script implements the same forward + reverse coverage checks using a
 * regex-based extractor, constrained to the workflow YAML style enforced by
 * website/src/__tests__/workflow-style-constraints.test.ts (P-B-005):
 *   - 2-space indent throughout
 *   - job names are single-line
 *   - job names do not contain a literal ":"
 *
 * Invoked by:
 *   - .github/workflows/ci.yml      job "Ruleset Drift Guard" (internal repo)
 *   - .github/workflows/ci.public.yml job "Ruleset Drift Guard" (renamed to
 *     ci.yml on sync; lives in the public repo)
 *   - Operator (local, ad hoc)
 *
 * Reference: docs/plans/2026-05-15-rulesets-as-code.md §3 Layer 2 + P-C-007
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// THE shared judgement. This file owns NO parser and NO oracle of its own: both live in the
// core, which vitest imports too, so the thing CI runs is the thing the guards read.
// Recorded 2026-09-23 in the retro for this repair.
import {
  WORKFLOW_NOT_REQUIRED_AS_CONTEXT,
  jobContextNames,
  isPushTriggered,
  contextsCoveredByRequiredGate,
  classifyReverseCoverage,
} from './lib/ruleset-coverage-core.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..')
const RULESET_PATH = path.join(REPO_ROOT, '.github', 'rulesets', 'main-branch.json')
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows')




function loadRuleset(rulesetPath) {
  const raw = readFileSync(rulesetPath, 'utf-8')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    console.error(`::error::${rulesetPath} is not valid JSON: ${err.message}`)
    process.exit(1)
  }
  return parsed
}

function loadRulesetRequiredContexts(ruleset) {
  const rules = Array.isArray(ruleset.rules) ? ruleset.rules : []
  const rsc = rules.find((r) => r && r.type === 'required_status_checks')
  const checks = rsc?.parameters?.required_status_checks ?? []
  return checks.map((c) => c.context)
}

/**
 * Pinned bypass actor set (security-review CRIT-1 + HIGH-3 defense).
 *
 * KEEP IN SYNC with EXPECTED_BYPASS_ACTORS in
 * website/src/__tests__/ruleset-bypass-actors-pin.test.ts.
 *
 * Updating this list MUST be paired with an ADR amendment to
 * docs/adr/0002-rulesets-as-code-and-bypass-actors.md §3 and reviewed
 * via CODEOWNERS-gated PR on both repos. The drift-guard test
 * `ruleset-allowlist-mirror.test.ts` does NOT currently mirror this
 * constant — bypass-actor mirroring is the operator's responsibility
 * via the cross-repo invariant test (which runs in the internal repo's
 * vitest) plus this .mjs check (which runs in BOTH repos' CI).
 */
const EXPECTED_BYPASS_ACTORS = [
  { actor_id: 261639734, actor_type: 'User', bypass_mode: 'always' },
]

function checkBypassActorsPin(ruleset) {
  const actual = Array.isArray(ruleset.bypass_actors) ? ruleset.bypass_actors : []
  const stringify = (a) =>
    JSON.stringify(
      a.map((x) => ({
        actor_id: x.actor_id,
        actor_type: x.actor_type,
        bypass_mode: x.bypass_mode,
      })),
    )
  const actualStr = stringify(actual)
  const expectedStr = stringify(EXPECTED_BYPASS_ACTORS)
  if (actualStr !== expectedStr) {
    console.error(
      `::error::BYPASS ACTORS PIN VIOLATION — .github/rulesets/main-branch.json bypass_actors ` +
        `has been mutated.\n::error::Actual:   ${actualStr}\n::error::Expected: ${expectedStr}\n` +
        `::error::Updating this list REQUIRES an ADR amendment to docs/adr/0002-rulesets-as-code-and-bypass-actors.md ` +
        `+ updating EXPECTED_BYPASS_ACTORS in BOTH this script AND ` +
        `website/src/__tests__/ruleset-bypass-actors-pin.test.ts.`,
    )
    return false
  }
  return true
}

function main() {
  if (!existsSync(RULESET_PATH)) {
    console.error(`::error::Ruleset file not found at ${RULESET_PATH}`)
    process.exit(1)
  }
  if (!existsSync(WORKFLOWS_DIR)) {
    console.error(`::error::Workflows dir not found at ${WORKFLOWS_DIR}`)
    process.exit(1)
  }

  const ruleset = loadRuleset(RULESET_PATH)
  const requiredContexts = loadRulesetRequiredContexts(ruleset)
  if (requiredContexts.length === 0) {
    console.error(
      `::error::${RULESET_PATH} contains no required_status_checks rule with contexts. ` +
        `If this is intentional, remove this drift-guard invocation; otherwise add at least one context.`,
    )
    process.exit(1)
  }

  const workflowFiles = readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f))
  const allJobContexts = new Set()
  const pushTriggeredContexts = new Set()

  for (const f of workflowFiles) {
    const content = readFileSync(path.join(WORKFLOWS_DIR, f), 'utf-8')
    const contexts = jobContextNames(content)
    contexts.forEach((c) => allJobContexts.add(c))
    if (isPushTriggered(content)) contexts.forEach((c) => pushTriggeredContexts.add(c))
  }

  let failed = false

  // Security: bypass_actors constant-pin (CRIT-1 + HIGH-3 defense). Catches
  // attempts to add a second bypass actor or swap actor_id silently. Runs
  // BEFORE coverage checks so the failure message surfaces first.
  if (!checkBypassActorsPin(ruleset)) {
    failed = true
  } else {
    console.log(
      `BYPASS ACTORS PIN PASS: bypass_actors matches EXPECTED (${EXPECTED_BYPASS_ACTORS.length} actor(s))`,
    )
  }

  // Forward coverage: every required context maps to an existing job
  const missing = requiredContexts.filter((c) => !allJobContexts.has(c))
  if (missing.length > 0) {
    console.error(`::error::FORWARD COVERAGE FAILED — required contexts not emitted by any job:`)
    for (const c of missing) console.error(`::error::  - ${c}`)
    console.error(
      `::error::Either add a matching job (jobs.<id>.name or fallback <id>) in .github/workflows/*.yml, ` +
        `or remove the context from .github/rulesets/main-branch.json.`,
    )
    failed = true
  } else {
    console.log(`FORWARD COVERAGE PASS: ${requiredContexts.length} required contexts all emitted by some job`)
  }

  // Reverse coverage: every push-triggered context is required, DERIVABLY GATED by the
  // `needs:` graph of a job that IS required, structurally templated, or an oracle entry.
  // The classification and its M1 refusal live in the core, so this file cannot pass
  // vacuously by extracting nothing — which is exactly how it used to pass (21 -> 0).
  const pushTriggeredSources = workflowFiles
    .map((f) => ({ file: f, content: readFileSync(path.join(WORKFLOWS_DIR, f), 'utf-8') }))
    .filter(({ content }) => isPushTriggered(content))
  let reverse
  try {
    reverse = classifyReverseCoverage({
      pushTriggeredContexts,
      requiredContexts,
      coveredByRequiredGate: contextsCoveredByRequiredGate(pushTriggeredSources, requiredContexts),
    })
  } catch (err) {
    // M2: could not judge is not a pass. Exit 1 loudly rather than print a clean line.
    console.error(`::error::REVERSE COVERAGE UNMEASURED — ${err.message}`)
    process.exit(1)
  }
  const ungated = reverse.ungated
  if (ungated.length > 0) {
    console.error(
      `::error::REVERSE COVERAGE FAILED — push-triggered jobs are neither required nor allowlisted:`,
    )
    for (const c of ungated) console.error(`::error::  - ${c}`)
    console.error(
      `::error::Either add to required_status_checks in .github/rulesets/main-branch.json, ` +
        `have a required job depend on it via needs: (which this guard DERIVES), ` +
        `or add to WORKFLOW_NOT_REQUIRED_AS_CONTEXT in scripts/lib/ruleset-coverage-core.mjs ` +
        `(ONE definition, with its cited reason).`,
    )
    failed = true
  } else {
    const c = reverse.counts
    console.log(
      `REVERSE COVERAGE PASS: all ${reverse.denominator} push-triggered job contexts are gated — ` +
        `required ${c.required}, derivably-gated ${c['derivably-gated']}, templated ${c.templated}, ` +
        `oracle ${c.oracle} (of ${WORKFLOW_NOT_REQUIRED_AS_CONTEXT.size} oracle entries)`,
    )
  }

  if (failed) process.exit(1)
  console.log('Ruleset Drift Guard: PASS')
}

main()
