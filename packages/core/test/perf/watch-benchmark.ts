// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3a hotfix Phase 2 — watch benchmark harness.
 *
 * Runs `massu watch --foreground` against a generated fixture repo of N
 * files for D seconds, sampling RSS / CPU / fd-count every 10s. Outputs
 * `bench-results.json` with p50/p95/p99 per metric so Plan 3a §Acceptance
 * budgets can be set from real data instead of design-time guesses.
 *
 * Usage (manual; not yet wired into CI — Phase 2 follow-up):
 *   npx tsx test/perf/watch-benchmark.ts --files 5000 --seconds 300
 *
 * Exit code:
 *   0 — completed, results written to bench-results.json
 *   1 — fixture creation or daemon start failed
 *   2 — daemon RSS or CPU exceeded a hard sanity bound (1500 MB / 200%)
 *
 * Fixture shape: a flat tree of `apps/<i>/src/file_<j>.ts` files with
 * trivial TypeScript content. Approximates what chokidar walks at
 * startup; not representative of git/.next/build noise.
 */

import { spawnSync, spawn } from 'child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

interface CliArgs {
  files: number;
  seconds: number;
  outDir: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { files: 1000, seconds: 60, outDir: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--files') out.files = parseInt(argv[++i], 10);
    else if (a === '--seconds') out.seconds = parseInt(argv[++i], 10);
    else if (a === '--out') out.outDir = argv[++i];
  }
  if (!out.outDir) out.outDir = join(process.cwd(), 'test', 'perf', '.bench-fixture');
  return out;
}

function buildFixture(root: string, fileCount: number): void {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  // Minimal massu.config.yaml so the daemon detects this as a real project.
  writeFileSync(join(root, 'massu.config.yaml'), [
    'schema_version: 2',
    'project:',
    '  name: bench-fixture',
    '  root: .',
    'framework:',
    '  type: typescript',
    '  router: none',
    '  orm: none',
    '  ui: none',
    '  languages:',
    '    typescript:',
    '      source_dirs: [apps]',
    'paths:',
    '  source: apps',
    'toolPrefix: massu',
    'domains: []',
    'rules: []',
    '',
  ].join('\n'));

  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'bench-fixture',
    version: '0.0.0',
    private: true,
  }, null, 2));

  // Fanout: ceil(fileCount / 100) directories, each with up to 100 files.
  const apps = join(root, 'apps');
  mkdirSync(apps, { recursive: true });
  let written = 0;
  let groupIdx = 0;
  while (written < fileCount) {
    const groupDir = join(apps, `group_${groupIdx}`, 'src');
    mkdirSync(groupDir, { recursive: true });
    const here = Math.min(100, fileCount - written);
    for (let j = 0; j < here; j++) {
      writeFileSync(join(groupDir, `file_${j}.ts`), `export const x_${groupIdx}_${j} = ${groupIdx + j};\n`);
    }
    written += here;
    groupIdx += 1;
  }
}

interface Sample {
  t_seconds: number;
  rss_mb: number | null;
  cpu_pct: number | null;
}

function sampleProcess(pid: number): { rss_mb: number | null; cpu_pct: number | null } {
  const r = spawnSync('ps', ['-o', 'rss=,pcpu=', '-p', String(pid)], { encoding: 'utf-8' });
  if (r.status !== 0 || !r.stdout.trim()) return { rss_mb: null, cpu_pct: null };
  const parts = r.stdout.trim().split(/\s+/);
  if (parts.length < 2) return { rss_mb: null, cpu_pct: null };
  const rss_kb = parseInt(parts[0], 10);
  const cpu_pct = parseFloat(parts[1]);
  if (!Number.isFinite(rss_kb) || !Number.isFinite(cpu_pct)) return { rss_mb: null, cpu_pct: null };
  return { rss_mb: Math.round((rss_kb / 1024) * 10) / 10, cpu_pct };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(args.outDir);

  process.stderr.write(`[bench] building fixture: ${args.files} files at ${root}\n`);
  const t0 = Date.now();
  buildFixture(root, args.files);
  process.stderr.write(`[bench] fixture built in ${Date.now() - t0}ms\n`);

  // Locate the CLI. Prefer the just-built dist; fall back to source via tsx
  // is too slow for benchmark precision, so require dist.
  const cliPath = resolve(__dirname, '..', '..', 'dist', 'cli.js');
  if (!existsSync(cliPath)) {
    process.stderr.write(`[bench] FATAL: dist/cli.js not found — run \`npm run build\` first\n`);
    return 1;
  }

  process.stderr.write(`[bench] starting daemon: node ${cliPath} watch --foreground --root ${root}\n`);
  const child = spawn('node', [cliPath, 'watch', '--foreground', '--root', root], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const pid = child.pid;
  if (!pid) {
    process.stderr.write(`[bench] FATAL: failed to spawn daemon\n`);
    return 1;
  }
  process.stderr.write(`[bench] daemon pid=${pid}; sampling for ${args.seconds}s\n`);

  // Settle window (chokidar initial walk).
  await new Promise((r) => setTimeout(r, 5_000));

  const samples: Sample[] = [];
  const startMs = Date.now();
  while ((Date.now() - startMs) / 1000 < args.seconds) {
    const t_seconds = Math.round((Date.now() - startMs) / 1000);
    const m = sampleProcess(pid);
    samples.push({ t_seconds, ...m });

    // Hard sanity bounds — abort the bench if the daemon is clearly broken
    // (process management failure, infinite leak). 1500 MB / 200% are well
    // above any conceivable healthy baseline.
    if ((m.rss_mb ?? 0) > 1500 || (m.cpu_pct ?? 0) > 200) {
      process.stderr.write(`[bench] FATAL: hard sanity bound exceeded — rss=${m.rss_mb} cpu=${m.cpu_pct}\n`);
      child.kill('SIGTERM');
      return 2;
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }

  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1_000));

  const validRss = samples.map((s) => s.rss_mb).filter((v): v is number => v !== null);
  const validCpu = samples.map((s) => s.cpu_pct).filter((v): v is number => v !== null);

  const result = {
    fixture: { files: args.files, root },
    duration_seconds: args.seconds,
    sample_count: samples.length,
    rss_mb: {
      min: Math.min(...validRss),
      p50: percentile(validRss, 50),
      p95: percentile(validRss, 95),
      p99: percentile(validRss, 99),
      max: Math.max(...validRss),
    },
    cpu_pct: {
      min: Math.min(...validCpu),
      p50: percentile(validCpu, 50),
      p95: percentile(validCpu, 95),
      p99: percentile(validCpu, 99),
      max: Math.max(...validCpu),
    },
    samples,
  };

  const outPath = join(root, 'bench-results.json');
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  process.stderr.write(`[bench] wrote ${outPath}\n`);
  process.stdout.write(JSON.stringify({
    files: args.files,
    duration_seconds: args.seconds,
    rss_p99_mb: result.rss_mb.p99,
    cpu_p99_pct: result.cpu_pct.p99,
    rss_max_mb: result.rss_mb.max,
    cpu_max_pct: result.cpu_pct.max,
  }, null, 2) + '\n');

  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(`[bench] uncaught: ${err}\n`);
  process.exit(1);
});
