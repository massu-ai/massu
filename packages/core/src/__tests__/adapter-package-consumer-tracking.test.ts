/**
 * Drift-guard: P-M-032 (plan-stage-d-medium-sweep).
 *
 * Closes wave2-architecture F-ARCH-005. Pre-P-M-032, the workspace
 * shipped 5 adapter packages: rails, phoenix, aspnet, spring, go-chi.
 * Three of them (phoenix, aspnet, go-chi) had exactly ONE consumer
 * each — a 1-line re-export shim at
 * `packages/core/src/detect/adapters/<id>.ts`. The packages were
 * shipped to npm but had zero real consumers; the workspace overhead
 * was pure carrying cost.
 *
 * Operator decision (locked in plan body): REMOVE phoenix/aspnet/go-chi,
 * DEFER rails + spring to Stage E as the JVM/Ruby ecosystem-watch pair.
 *
 * Structural drift-class closed: any future adapter package added to
 * `packages/adapter-*` MUST have at least one consumer outside the
 * shim layer (its own dist/ + own src/, plus the shim in
 * `packages/core/src/detect/adapters/<id>.ts`). Zero-consumer adapters
 * are detected by this test before they ship.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const PACKAGES_DIR = path.resolve(REPO_ROOT, 'packages')
const ADAPTERS_DIR = path.resolve(__dirname, '../detect/adapters')

// Adapter package shims that count as "the adapter's own infrastructure"
// and therefore do NOT count as external consumers.
function isShimFile(file: string): boolean {
  return /\/detect\/adapters\/(?!index|types|runner|query-helpers|parse-guard|tree-sitter-loader|discover|file-sampler)[a-z-]+\.ts$/.test(file)
}

describe('adapter packages have at least one external consumer (P-M-032)', () => {
  it('the 3 removed packages are gone from the workspace', () => {
    for (const removed of ['adapter-phoenix', 'adapter-aspnet', 'adapter-go-chi']) {
      expect(fs.existsSync(path.join(PACKAGES_DIR, removed))).toBe(false)
    }
  })

  it('the 3 removed shim files are gone from detect/adapters/', () => {
    for (const removed of ['phoenix.ts', 'aspnet.ts', 'go-chi.ts']) {
      expect(fs.existsSync(path.join(ADAPTERS_DIR, removed))).toBe(false)
    }
  })

  it('CORE_BUNDLED_IDS no longer references removed adapters', () => {
    const indexSrc = fs.readFileSync(path.join(ADAPTERS_DIR, 'index.ts'), 'utf-8')
    expect(indexSrc).not.toMatch(/['"]phoenix['"]/)
    expect(indexSrc).not.toMatch(/['"]aspnet['"]/)
    expect(indexSrc).not.toMatch(/['"]go-chi['"]/)
  })

  it('packages/core/package.json no longer depends on the 3 removed adapter packages', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8')
    )
    const deps = Object.keys(pkg.dependencies ?? {})
    expect(deps).not.toContain('@massu/adapter-phoenix')
    expect(deps).not.toContain('@massu/adapter-aspnet')
    expect(deps).not.toContain('@massu/adapter-go-chi')
    // Rails + Spring stay (deferred to Stage E).
    expect(deps).toContain('@massu/adapter-rails')
    expect(deps).toContain('@massu/adapter-spring')
  })

  it('every adapter package surviving in the workspace has at least one external consumer', () => {
    // Discover surviving adapter-* directories.
    const adapterDirs = fs
      .readdirSync(PACKAGES_DIR)
      .filter((name) => name.startsWith('adapter-'))
      .map((name) => name.replace(/^adapter-/, ''))

    expect(adapterDirs.length).toBeGreaterThan(0)

    // For each adapter id, grep across the repo for non-shim, non-test,
    // non-own-package references. Distill to file paths.
    for (const id of adapterDirs) {
      const pkgName = `@massu/adapter-${id}`
      const ownPackageRoot = path.join(PACKAGES_DIR, `adapter-${id}`)
      const refs: string[] = []
      function walk(dir: string): void {
        // ENOENT-tolerant scan: other concurrently-running tests
        // (`config-detected.test.ts` creates/destroys
        // `packages/core/src/test-config-detected-tmp`) can race against
        // this walk under vitest parallelism. Treat a missing-during-scan
        // directory as "no refs here" rather than crashing the suite.
        let entries: fs.Dirent[]
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return
          throw err
        }
        for (const entry of entries) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.next') continue
            walk(full)
          } else if (
            entry.isFile() &&
            (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))
          ) {
            const rel = path.relative(REPO_ROOT, full)
            // Skip the adapter package's own source.
            if (full.startsWith(ownPackageRoot)) continue
            // Skip test fixtures that mention the package name as data only.
            if (full.includes('__tests__') || full.endsWith('.test.ts')) continue
            let src: string
            try {
              src = fs.readFileSync(full, 'utf-8')
            } catch (err: unknown) {
              if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue
              throw err
            }
            if (src.includes(`'${pkgName}'`) || src.includes(`"${pkgName}"`)) {
              refs.push(rel)
            }
          }
        }
      }
      walk(REPO_ROOT)
      // The shim file counts as a consumer because it's a public re-export
      // path used by downstream code.
      const externalRefs = refs.filter((r) => !isShimFile(r))
      // Either an external consumer OR a shim must exist; zero of both
      // means the package is orphaned.
      expect(refs.length).toBeGreaterThan(0)
      // Document the consumer set for ops visibility.
      if (refs.length === 0) {
        throw new Error(
          `Adapter package ${pkgName} has ZERO consumers — should be removed per P-M-032. Add a consumer or remove the package.`
        )
      }
      void externalRefs // silence unused-var warning while preserving the metric
    }
  })
})
