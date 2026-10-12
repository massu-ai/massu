/**
 * scripts/ci-adjudicate-needs.sh — the verdict both fan-in gates delegate to.
 *
 * WHY THIS FILE EXISTS. The script is marked `# CI-ONLY:` because there is no `needs` graph
 * outside a workflow run, so pre-push cannot invoke it meaningfully. But CI-ONLY must not mean
 * UNTESTED: a script whose only exercise is a production CI run is a zero-caller chokepoint
 * until it fails in front of someone (CR-71). Its contract is a pure function of NEEDS_JSON,
 * so every exit path is reachable from here.
 *
 * THE PROPERTY UNDER TEST is the one the plan exists for: a required check must not be
 * satisfiable by NOT RUNNING. GitHub counts `skipped` as a successful status, so the script
 * must fail on `failure`/`cancelled`/absent while tolerating a skip — and it must EXIT 2, never
 * 0, when it cannot see its input at all (M2: could-not-look is an error, never a pass).
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'ci-adjudicate-needs.sh')
const NEEDS_VAR = 'NEEDS_JSON'

function adjudicate(needsJson: string | undefined) {
  const childEnv: Record<string, string | undefined> = { ...process.env }
  if (needsJson === undefined) delete childEnv[NEEDS_VAR]
  else childEnv[NEEDS_VAR] = needsJson
  const r = spawnSync('bash', [SCRIPT], { env: childEnv, encoding: 'utf-8' })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

describe('ci-adjudicate-needs.sh', () => {
  it('exits 0 when every needed job succeeded, and prints its DENOMINATOR', () => {
    const r = adjudicate('{"lint":{"result":"success"},"test":{"result":"success"}}')
    expect(r.code, r.out).toBe(0)
    // M1 — a gate that does not say how many things it judged cannot be audited.
    expect(r.out).toContain('jobs judged: 2')
    expect(r.out).toContain('PASS: all 2 needed job(s)')
  })

  it('exits 1 and NAMES the offender when a needed job FAILED', () => {
    const r = adjudicate('{"lint":{"result":"success"},"windows":{"result":"failure"}}')
    expect(r.code, r.out).toBe(1)
    expect(r.out).toContain('windows=failure')
  })

  it('exits 1 when a needed job was CANCELLED — a cancelled dependency is not a pass', () => {
    const r = adjudicate('{"build":{"result":"cancelled"}}')
    expect(r.code, r.out).toBe(1)
    expect(r.out).toContain('build=cancelled')
  })

  it('exits 1 when a needed job reports NO result — absence of a verdict is not a verdict', () => {
    const r = adjudicate('{"build":{}}')
    expect(r.code, r.out).toBe(1)
    expect(r.out).toContain('build=<absent>')
  })

  it('TOLERATES a skip: that is how the repository guard excludes the non-matching repo', () => {
    // ci.public.yml's jobs carry `if: github.repository == 'massu-ai/massu'`, so in
    // massu-internal they skip BY DESIGN — that is how one committed ruleset SoT serves both
    // repos. Failing on a bare skip would break a working mechanism to fix a different one.
    const r = adjudicate('{"type-check":{"result":"skipped"},"test":{"result":"skipped"}}')
    expect(r.code, r.out).toBe(0)
  })

  it('exits 2 — not 0 — when the needs variable is UNSET (could-not-look is an error)', () => {
    const r = adjudicate(undefined)
    expect(r.code, r.out).toBe(2)
    expect(r.out).toContain('REFUSING')
  })

  it('exits 2 when the needs variable is empty', () => {
    expect(adjudicate('').code).toBe(2)
  })

  it('exits 2 when the needs variable is not valid JSON', () => {
    const r = adjudicate('{not json')
    expect(r.code, r.out).toBe(2)
    expect(r.out).toContain('did not parse')
  })

  it('exits 2 when it parses but adjudicates nothing — an empty gate is a blind gate', () => {
    expect(adjudicate('{}').code).toBe(2)
    expect(adjudicate('[]').code).toBe(2)
    expect(adjudicate('null').code).toBe(2)
  })
})
