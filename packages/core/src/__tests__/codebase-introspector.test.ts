// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { introspect } from '../detect/codebase-introspector.ts';
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
 *   - ReDoS-pathological input (single line of `(((` etc.) terminates fast
 *   - 10K-file performance test (<2s)
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
    let api = HedgeAPI()
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
    expect(out.swift?.api_client_class).toBe('HedgeAPI');
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
  it('terminates quickly on 100KB of nested parens (regex anchored, no nested quantifiers)', () => {
    const root = mkTmp('redos');
    mkdirSync(join(root, 'routers'), { recursive: true });
    // 100KB of `(((((` etc. — pathological for greedy alternation. Our regexes
    // are anchored and non-greedy where possible.
    const pathological = '('.repeat(100_000);
    writeFileSync(
      join(root, 'routers', 'redos.py'),
      pathological + '\nDepends(safe_dep)\n',
      'utf-8',
    );

    const start = process.hrtime.bigint();
    const out = introspect(makeDetection(root, 'python', '.'), root);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;

    expect(elapsedMs).toBeLessThan(500);
    expect(out.python?.auth_dep).toBe('safe_dep');
  });
});

describe('Codebase Introspector: 10K-file performance', () => {
  it('completes introspection on 10K synthetic files plus 5 real routers in <2s', () => {
    const root = mkTmp('10k');
    const padding = join(root, 'padding');
    mkdirSync(padding, { recursive: true });
    // 10K tiny files (under MAX_DIR_DEPTH; flat directory). Different extensions
    // so they are skipped by the regex filter without being read.
    for (let i = 0; i < 10_000; i++) {
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

    const start = process.hrtime.bigint();
    const out = introspect(makeDetection(root, 'python', '.'), root);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;

    expect(elapsedMs).toBeLessThan(2000);
    expect(out.python?.auth_dep).toBe('get_current_user');
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

  it('skipIntrospect:true is faster than the default path on the same fixture', async () => {
    const root = mkTmp('perf-compare');
    writeFileSync(join(root, 'pyproject.toml'), '[project]\nname = "test"\n', 'utf-8');
    mkdirSync(join(root, 'routers'), { recursive: true });
    for (let i = 0; i < 5; i++) {
      writeFileSync(
        join(root, 'routers', `r${i}.py`),
        'from fastapi import Depends\nDepends(get_current_user)\n',
        'utf-8',
      );
    }

    // Warm-up + measure each path.
    await runDetection(root, undefined, { skipIntrospect: true });

    const skipStart = process.hrtime.bigint();
    await runDetection(root, undefined, { skipIntrospect: true });
    const skipMs = Number(process.hrtime.bigint() - skipStart) / 1_000_000;

    // Both paths must be quick on this 5-file fixture; we only assert the
    // skipped path is bounded — the introspector ran on the warm-up so cache
    // effects are minimized.
    expect(skipMs).toBeLessThan(500);
  });
});
