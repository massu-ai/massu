// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, afterEach, vi } from 'vitest';

// Read-recording for the work-bounding invariants at the bottom of this file.
// `vi.spyOn(fs, 'readFileSync')` CANNOT be used: an ESM module namespace is not
// configurable, so it throws rather than recording. The factory must therefore
// wrap the export at module-resolution time.
//
// BOTH specifiers are mocked. Vitest keys mocks by module id, so mocking 'fs'
// alone leaves `node:fs` importers unrecorded — and the read path spans both
// (`detect/regex-fallback.ts` uses 'fs'; `detect/adapters/file-sampler.ts` uses
// 'node:fs'). A miss here would surface as zero recorded reads, which is why
// every assertion below carries a positive control.
const { readLog } = vi.hoisted(() => ({ readLog: [] as string[] }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const readFileSync = ((...args: unknown[]) => {
    readLog.push(String(args[0]));
    return (actual.readFileSync as (...a: unknown[]) => unknown)(...args);
  }) as typeof actual.readFileSync;
  return { ...actual, default: { ...actual, readFileSync }, readFileSync };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const readFileSync = ((...args: unknown[]) => {
    readLog.push(String(args[0]));
    return (actual.readFileSync as (...a: unknown[]) => unknown)(...args);
  }) as typeof actual.readFileSync;
  return { ...actual, default: { ...actual, readFileSync }, readFileSync };
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { introspect } from '../detect/codebase-introspector.ts';
import {
  MAX_SAMPLES_PER_ADAPTER,
  PY_AUTH_DEP_PATTERN,
  PY_DJANGO_AUTH_PATTERN,
  PY_API_PREFIX_PATTERN,
  PY_TEST_ASYNC_PATTERN,
} from '../detect/regex-fallback.ts';
import { measureScalingRatio, MIN_MEASURABLE_NS } from './helpers/scaling.ts';
import { runDetection } from '../detect/index.ts';
import type { DetectionResult } from '../detect/index.ts';

/**
 * Plan #2 P3-004: Codebase introspector tests.
 *
 * Coverage:
 *   - FastAPI happy path (auth_dep + api_prefix_base + test_async_pattern)
 *   - Django happy path (login_required decorator)
 *   - Next.js / tRPC happy path (createTRPCRouter + publicProcedure)
 *   - SwiftUI happy path (api_client_class + biometric_policy)
 *   - Empty source → returns {} (no false positives)
 *   - 3+ conflicting auth deps → returns null (Risk #6)
 *   - 256KB file size cap (defends against OOM)
 *   - ReDoS-pathological input: the extraction patterns scale LINEARLY
 *   - Work-bounding: reads are gated by the name filter, not by directory size
 *   - runDetection skipIntrospect contract (P3-002 / P4-006)
 */

const createdDirs: string[] = [];

function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `massu-introspect-${prefix}-`));
  createdDirs.push(d);
  return d;
}

function cleanupAll(): void {
  while (createdDirs.length) {
    const d = createdDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

afterEach(cleanupAll);

/**
 * Run `fn` with `fs.readFileSync` recorded, and return every path it read.
 *
 * Read-counting replaces the wall-clock budgets this file used to carry: the
 * property under test ("work is bounded by the name filter, not by directory
 * size") is a claim about the CODE, so it must be asserted on the code's
 * behaviour rather than on how fast a loaded machine happens to run.
 *
 * A read count of zero is the classic blind-gate value — "the spy was never
 * wired" and "the unit read nothing" produce the same observation, and it is
 * the passing one. Every caller therefore pairs its invariant with a POSITIVE
 * CONTROL: a path that MUST appear in `paths`.
 */
function recordReads<T>(fn: () => T): { result: T; paths: string[] } {
  readLog.length = 0;
  const result = fn();
  return { result, paths: [...readLog] };
}

/** Async twin of {@link recordReads}, for the `runDetection` paths. */
async function recordReadsAsync<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; paths: string[] }> {
  readLog.length = 0;
  const result = await fn();
  return { result, paths: [...readLog] };
}

/** Build a minimal DetectionResult that the introspector can read. */
function makeDetection(
  projectRoot: string,
  language: string,
  sourceDir: string,
): DetectionResult {
  return {
    projectRoot,
    manifests: [{ path: 'manifest', language: language as 'python', framework: null, name: null, version: null } as never],
    frameworks: {} as never,
    sourceDirs: {
      [language]: {
        source_dirs: [sourceDir],
        test_dirs: [],
        file_count: 1,
      },
    } as never,
    monorepo: { type: 'single', packages: [], root: projectRoot } as never,
    domains: [],
    verificationCommands: {},
    warnings: [],
  };
}

describe('Codebase Introspector: Python+FastAPI', () => {
  it('extracts auth_dep, api_prefix_base, and test_async_pattern from a sampled router', () => {
    const root = mkTmp('fastapi');
    const routersDir = join(root, 'routers');
    mkdirSync(routersDir, { recursive: true });
    writeFileSync(
      join(routersDir, 'orders.py'),
      `from fastapi import APIRouter, Depends

router = APIRouter(prefix="/api/orders", tags=["orders"])

@router.get("/items")
async def list_items(user: dict = Depends(require_tier_or_guardian)):
    return []

@pytest.mark.asyncio
async def test_x():
    pass
`,
      'utf-8',
    );

    const out = introspect(makeDetection(root, 'python', '.'), root);
    expect(out.python?.auth_dep).toBe('require_tier_or_guardian');
    expect(out.python?.api_prefix_base).toBe('/api');
    expect(out.python?.test_async_pattern).toBe('@pytest.mark.asyncio');
    expect(out.python?._provenance?.auth_dep_source).toContain('orders.py');
  });

  it('returns null for auth_dep when 3+ different auth deps appear (Risk #6)', () => {
    const root = mkTmp('fastapi-amb');
    mkdirSync(join(root, 'routers'), { recursive: true });
    writeFileSync(
      join(root, 'routers', 'a.py'),
      'def x(user = Depends(auth_a)):\n    pass\n',
      'utf-8',
    );
    writeFileSync(
      join(root, 'routers', 'b.py'),
      'def x(user = Depends(auth_b)):\n    pass\n',
      'utf-8',
    );
    writeFileSync(
      join(root, 'routers', 'c.py'),
      'def x(user = Depends(auth_c)):\n    pass\n',
      'utf-8',
    );

    const out = introspect(makeDetection(root, 'python', '.'), root);
    expect(out.python?.auth_dep).toBeUndefined();
  });
});

describe('Codebase Introspector: Python+Django', () => {
  it('extracts the login_required decorator', () => {
    const root = mkTmp('django');
    mkdirSync(join(root, 'app'), { recursive: true });
    writeFileSync(
      join(root, 'app', 'views.py'),
      `from django.contrib.auth.decorators import login_required

@login_required
def home(request):
    pass
`,
      'utf-8',
    );

    const out = introspect(makeDetection(root, 'python', 'app'), root);
    expect(out.python?.auth_dep).toBe('login_required');
  });
});

describe('Codebase Introspector: Next.js + tRPC', () => {
  it('extracts createTRPCRouter and publicProcedure from a router file', () => {
    const root = mkTmp('trpc');
    const routersDir = join(root, 'src', 'server', 'api', 'routers');
    mkdirSync(routersDir, { recursive: true });
    writeFileSync(
      join(routersDir, 'orders.router.ts'),
      `import { createTRPCRouter, publicProcedure } from '@/server/api/trpc';

export const ordersRouter = createTRPCRouter({
  list: publicProcedure.input(z.object({})).query(async () => []),
});
`,
      'utf-8',
    );

    const out = introspect(makeDetection(root, 'typescript', 'src'), root);
    expect(out.typescript?.trpc_router_builder).toBe('createTRPCRouter');
    expect(out.typescript?.procedure_pattern).toBe('publicProcedure');
  });
});

describe('Codebase Introspector: SwiftUI', () => {
  it('extracts api_client_class and biometric_policy from a sampled View', () => {
    const root = mkTmp('swift');
    const viewsDir = join(root, 'Features', 'Orders', 'Views');
    mkdirSync(viewsDir, { recursive: true });
    writeFileSync(
      join(viewsDir, 'OrdersView.swift'),
      `import SwiftUI
import LocalAuthentication

struct OrdersView: View {
    let api = OrdersAPI()
    var body: some View {
        Text("Orders")
    }
}

func biometric() {
    let context = LAContext()
    context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, ...)
}
`,
      'utf-8',
    );

    const out = introspect(makeDetection(root, 'swift', '.'), root);
    expect(out.swift?.api_client_class).toBe('OrdersAPI');
    expect(out.swift?.biometric_policy).toBe('deviceOwnerAuthenticationWithBiometrics');
  });
});

describe('Codebase Introspector: empty / negative cases', () => {
  it('returns no python/swift fields when source is empty', () => {
    const root = mkTmp('empty');
    const out = introspect(
      {
        projectRoot: root,
        manifests: [],
        frameworks: {} as never,
        sourceDirs: {} as never,
        monorepo: { type: 'single', packages: [], root } as never,
        domains: [],
        verificationCommands: {},
        warnings: [],
      },
      root,
    );
    expect(out).toEqual({});
  });

  it('does not crash on an empty Python source directory', () => {
    const root = mkTmp('empty-py');
    const out = introspect(makeDetection(root, 'python', '.'), root);
    // No files → no fields extracted → no python block emitted at all.
    // Returning null on empty input keeps the YAML clean (provenance-only
    // blocks would clutter every consumer's massu.config.yaml).
    expect(out.python).toBeUndefined();
  });

  it('skips files larger than 256KB', () => {
    const root = mkTmp('big-file');
    mkdirSync(join(root, 'routers'), { recursive: true });
    // 300KB of harmless padding + a real auth dep that should NOT be picked up.
    const padded = 'x'.repeat(300 * 1024) + '\nDepends(should_not_match)\n';
    writeFileSync(join(root, 'routers', 'big.py'), padded, 'utf-8');

    const out = introspect(makeDetection(root, 'python', '.'), root);
    expect(out.python?.auth_dep).toBeUndefined();
  });
});

describe('Codebase Introspector: ReDoS / pathological input', () => {
  it('still extracts the real dependency past 100K leading parens', () => {
    const root = mkTmp('redos');
    mkdirSync(join(root, 'routers'), { recursive: true });
    writeFileSync(
      join(root, 'routers', 'redos.py'),
      '('.repeat(100_000) + '\nDepends(safe_dep)\n',
      'utf-8',
    );
    // Correctness only. The COMPLEXITY claim is asserted separately below,
    // against the patterns themselves — measuring it through `introspect()` is
    // not sensitive enough to mean anything (see that test's comment).
    const out = introspect(makeDetection(root, 'python', '.'), root);
    expect(out.python?.auth_dep).toBe('safe_dep');
  });

  it('every Python pattern scales LINEARLY on adversarial input (no catastrophic backtracking)', () => {
    // Was `elapsedMs < 500` on one 100KB fixture, measured through introspect().
    // Two things were wrong with that. An absolute budget is a claim about the
    // machine — the same host that ran this in 40ms idle blew a 15s budget
    // elsewhere in this file at 126,715ms under pre-push load. And routing the
    // measurement through introspect() buries the regex cost under file I/O:
    // measured 2026-07-28, the ratio across a 4x input step came out at 1.60
    // (fixed overhead dominating) and at 0.47 for a 16x step — the LARGER input
    // "faster", because 800KB exceeds MAX_FILE_BYTES and was skipped entirely.
    // A guard whose measurement is dominated by overhead cannot see the defect
    // it exists to catch, so the patterns are measured DIRECTLY.
    const patterns: ReadonlyArray<readonly [string, string, string]> = [
      ['PY_AUTH_DEP_PATTERN', PY_AUTH_DEP_PATTERN, 'gu'],
      ['PY_DJANGO_AUTH_PATTERN', PY_DJANGO_AUTH_PATTERN, 'gmu'],
      ['PY_API_PREFIX_PATTERN', PY_API_PREFIX_PATTERN, 'gu'],
      ['PY_TEST_ASYNC_PATTERN', PY_TEST_ASYNC_PATTERN, 'gmu'],
    ];

    // Pathological for greedy alternation, with the real tokens at the very end
    // so the engine must traverse the whole adversarial body.
    //
    // MANY LINES on purpose. A single 100K-paren line left the `^`-anchored
    // patterns nothing to do and the baseline measured 4,833ns — under the
    // floor, so the guard refused to assert (correctly: a ratio over noise is
    // decoration). Line-structured input gives every pattern real work; all
    // four baselines clear MIN_MEASURABLE_NS at this size, measured 2026-07-28
    // at 93,750 / 528,625 / 81,792 / 82,083 ns.
    const adversarial = (lines: number): string =>
      ('('.repeat(100) + '\n').repeat(lines) + 'Depends(safe_dep)\n@login_required\n';
    const smallInput = adversarial(20_000);
    const largeInput = adversarial(80_000); // 4x

    // A fresh RegExp per run: a `/g` instance carries `lastIndex`, so reusing
    // one would measure a different traversal each repeat.
    const scan = (source: string, flags: string, input: string) => (): void => {
      const re = new RegExp(source, flags);
      while (re.exec(input) !== null) { /* force a full traversal */ }
    };

    for (const [name, source, flags] of patterns) {
      const m = measureScalingRatio(
        scan(source, flags, smallInput),
        scan(source, flags, largeInput),
      );

      // Guard the guard: if the baseline is too fast to time, the ratio is
      // timer noise and asserting on it would be its own blind gate.
      expect(m.smallNs, `${name}: baseline too fast to measure`)
        .toBeGreaterThan(MIN_MEASURABLE_NS);
      // Linear ≈ 4, quadratic ≈ 16. 8 sits midway on a log scale, leaving 2x
      // headroom in both directions.
      expect(m.ratio, `${name}: ratio ${m.ratio.toFixed(2)} suggests super-linear scaling`)
        .toBeLessThan(8);
    }
  }, 60_000);
  // ^ Explicit budget, and it is the SECOND detection path rather than a
  // convenience. The two failure modes surface differently:
  //
  //   polynomial blowup  -> ratio exceeds 8, asserted above
  //   CATASTROPHIC blowup -> the run never finishes, caught by this timeout
  //
  // Verified 2026-07-28: a nested-quantifier control (`^(\(+)+X`) against this
  // exact input shape did not complete in 10 minutes, so an exponential pattern
  // can never sneak past as a small ratio. The 100-char paren runs are what make
  // that true — shorten them and the catastrophic path stops being reachable.
});

describe('Codebase Introspector: reads are bounded by the name filter, not by directory size', () => {
  // WHY THIS IS NOT A WALL-CLOCK TEST.
  //
  // This was `completes introspection on 10K synthetic files ... in <2s`. A wall-clock
  // budget is a claim about the MACHINE, not about the code, and on a host running
  // concurrent work it fails for reasons unrelated to the change under test: it went
  // RED at 126,715ms in the pre-push battery on 2026-07-28 while passing in 1.32s
  // in isolation on the same commit. The previous repair (2026-05-20) widened the
  // budget 5s -> 15s and added `retry: 2`; that deferred the failure to a busier
  // machine rather than removing the dependency, and `retry: 2` made the assertion
  // best-of-3, which SYSTEMATICALLY HIDES the regressions it exists to catch.
  //
  // The property the timing stood for is exactly this: `sampleFiles` gates every
  // READ behind `nameRegex.test(entry)`, so work is O(matching files), not
  // O(all files). Counting reads asserts that DIRECTLY — deterministically, and
  // independently of the machine. It is also STRICTLY STRONGER: an implementation
  // that started reading every padding file would still finish under 2000ms on a
  // fast host, and the old assertion would have passed it.
  //
  // Scale note: proving read-count INVARIANCE across a 10x directory-size step
  // subsumes what a single 10,000-file fixture demonstrated, so the fixture is an
  // order of magnitude cheaper to build as well.
  const SMALL_PADDING = 250;
  const LARGE_PADDING = 2_500;

  function buildFixture(prefix: string, paddingCount: number): string {
    const root = mkTmp(prefix);
    const padding = join(root, 'padding');
    mkdirSync(padding, { recursive: true });
    // Tiny files with a non-matching extension: the name filter must skip them
    // WITHOUT reading them.
    for (let i = 0; i < paddingCount; i++) {
      writeFileSync(join(padding, `f${i}.bin`), '', 'utf-8');
    }
    // 5 real router files the introspector should sample (capped at 3).
    const routersDir = join(root, 'routers');
    mkdirSync(routersDir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      writeFileSync(
        join(routersDir, `r${i}.py`),
        'from fastapi import APIRouter, Depends\nrouter = APIRouter(prefix="/api/x")\nx = Depends(get_current_user)\n',
        'utf-8',
      );
    }
    return root;
  }

  it('never reads a non-matching file, and reads the SAME count from a 10x larger tree', () => {
    const small = buildFixture('bounded-small', SMALL_PADDING);
    const large = buildFixture('bounded-large', LARGE_PADDING);

    const a = recordReads(() => introspect(makeDetection(small, 'python', '.'), small));
    const b = recordReads(() => introspect(makeDetection(large, 'python', '.'), large));

    // POSITIVE CONTROL. A read count of zero is the classic blind-gate value:
    // "the spy was never wired" and "the unit read nothing" are the same
    // observation, and it is the PASSING one. If this goes red, the assertions
    // below are measuring nothing.
    const routerReads = a.paths.filter((p) => p.endsWith('.py'));
    expect(routerReads.length).toBeGreaterThan(0);

    // INVARIANT 1 — not one padding file is ever read, at either size.
    expect(a.paths.filter((p) => p.endsWith('.bin'))).toEqual([]);
    expect(b.paths.filter((p) => p.endsWith('.bin'))).toEqual([]);

    // INVARIANT 2 — a 10x larger directory costs the SAME number of reads.
    // This is the O(matching), not O(all), claim stated directly.
    expect(b.paths.length).toBe(a.paths.length);

    // INVARIANT 3 — reads stay under the sampler's own cap.
    expect(routerReads.length).toBeLessThanOrEqual(MAX_SAMPLES_PER_ADAPTER * 2);

    // ...and the result is still correct at both sizes.
    expect(a.result.python?.auth_dep).toBe('get_current_user');
    expect(b.result.python?.auth_dep).toBe('get_current_user');
  });
});

describe('runDetection: skipIntrospect contract (P3-002 + P4-006)', () => {
  it('runDetection(root, undefined, { skipIntrospect: true }) returns no detected block', async () => {
    const root = mkTmp('skip-intro');
    // Create a Python manifest so detection has something to work with.
    writeFileSync(
      join(root, 'pyproject.toml'),
      '[project]\nname = "test"\n',
      'utf-8',
    );
    mkdirSync(join(root, 'routers'), { recursive: true });
    writeFileSync(
      join(root, 'routers', 'a.py'),
      'Depends(get_current_user)\n',
      'utf-8',
    );

    const result = await runDetection(root, undefined, { skipIntrospect: true });
    expect(result.detected).toBeUndefined();
  });

  it('runDetection(root) (default) populates the detected block', async () => {
    const root = mkTmp('default-intro');
    writeFileSync(
      join(root, 'pyproject.toml'),
      '[project]\nname = "test"\n',
      'utf-8',
    );
    mkdirSync(join(root, 'routers'), { recursive: true });
    writeFileSync(
      join(root, 'routers', 'a.py'),
      'from fastapi import Depends\nDepends(my_auth)\n',
      'utf-8',
    );

    const result = await runDetection(root);
    expect(result.detected).toBeDefined();
    // The python block should be present even if specific fields fall through.
    expect(result.detected?.python).toBeDefined();
  });

  it('skipIntrospect:true does NOT read the source files the default path reads', async () => {
    // Was 'skipIntrospect:true is faster than the default path on the same
    // fixture' — a title describing a COMPARISON the body never made: it timed
    // only the skipped path and asserted `skipMs < 500`, which is a statement
    // about the machine and would hold even if skipIntrospect did nothing at
    // all. Counting reads performs the comparison the title always promised,
    // and does it deterministically.
    const root = mkTmp('skip-compare');
    writeFileSync(join(root, 'pyproject.toml'), '[project]\nname = "test"\n', 'utf-8');
    mkdirSync(join(root, 'routers'), { recursive: true });
    for (let i = 0; i < 5; i++) {
      writeFileSync(
        join(root, 'routers', `r${i}.py`),
        'from fastapi import Depends\nDepends(get_current_user)\n',
        'utf-8',
      );
    }

    const skipped = await recordReadsAsync(
      () => runDetection(root, undefined, { skipIntrospect: true }),
    );
    const full = await recordReadsAsync(() => runDetection(root));

    const routerReads = (paths: string[]): string[] =>
      paths.filter((p) => p.endsWith('.py'));

    // POSITIVE CONTROL — the default path must actually read the routers.
    // Without it, "the skipped path read nothing" is equally consistent with
    // the recorder being unwired.
    expect(routerReads(full.paths).length).toBeGreaterThan(0);

    // THE PROPERTY — skipping the introspector skips those reads entirely.
    expect(routerReads(skipped.paths)).toEqual([]);
  });
});
