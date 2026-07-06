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

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..')
const RULESET_PATH = path.join(REPO_ROOT, '.github', 'rulesets', 'main-branch.json')
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows')

/**
 * Jobs whose contexts are intentionally NOT required as gating status checks.
 * Each entry MUST cite the reason. Renames or removals here are intentional
 * changes that should go through code review.
 *
 * KEEP IN SYNC with WORKFLOW_NOT_REQUIRED_AS_CONTEXT in
 * website/src/__tests__/ruleset-context-coverage.test.ts.
 */
const WORKFLOW_NOT_REQUIRED_AS_CONTEXT = new Set([
  // schedule-only workflow; never runs on push; requiring it as a context
  // would block every push.
  'Weekly retroactive leak-guard audit',
  // matrix-shaped install verification (fresh-install-matrix.yml). The job
  // name is the LITERAL TEMPLATE STRING 'init --ci on ${{ matrix.fixture }}'
  // at YAML level — neither the regex parser here nor yaml.parse() in the
  // vitest test expand the ${{ ... }} GitHub Actions expression; the 6
  // expanded check-run names exist only at GitHub runtime. Allowlisting the
  // literal is sufficient for the rename-drift class.
  'init --ci on ${{ matrix.fixture }}',
  // the rule-apply workflow itself shouldn't gate the rule it creates
  // (chicken-and-egg).
  'Apply Ruleset',
  // read-only audit; informational, not gating.
  'Branch Protection Audit',
  // matrix-shaped Node-major native-module verification (ci.yml). The job
  // name is the LITERAL TEMPLATE STRING 'Native Module (Node ${{ matrix.node }})'
  // at YAML level — the 5 expanded check-run names exist only at GitHub
  // runtime, so the matrix job cannot be a required context. The static
  // 'Native Module Gate' aggregator IS the required gating context
  // (main-branch.json); this allowlists the matrix.
  'Native Module (Node ${{ matrix.node }})',
])

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
function jobContextNames(yamlContent) {
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

function isPushTriggered(yamlContent) {
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

  // Reverse coverage: every push-triggered job is required or allowlisted
  const ungated = [...pushTriggeredContexts].filter(
    (c) => !requiredContexts.includes(c) && !WORKFLOW_NOT_REQUIRED_AS_CONTEXT.has(c),
  )
  if (ungated.length > 0) {
    console.error(
      `::error::REVERSE COVERAGE FAILED — push-triggered jobs are neither required nor allowlisted:`,
    )
    for (const c of ungated) console.error(`::error::  - ${c}`)
    console.error(
      `::error::Either add to required_status_checks in .github/rulesets/main-branch.json, ` +
        `or add to WORKFLOW_NOT_REQUIRED_AS_CONTEXT in this script + the vitest test (with JSDoc reason).`,
    )
    failed = true
  } else {
    console.log(
      `REVERSE COVERAGE PASS: all ${pushTriggeredContexts.size} push-triggered job contexts are either required (${requiredContexts.length}) or allowlisted (${WORKFLOW_NOT_REQUIRED_AS_CONTEXT.size})`,
    )
  }

  if (failed) process.exit(1)
  console.log('Ruleset Drift Guard: PASS')
}

main()
