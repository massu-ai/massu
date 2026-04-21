// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P5-001 tests: session-start drift banner.
 *
 * Spawns the COMPILED session-start.js hook, feeds a HookInput payload on
 * stdin, and asserts the banner shape on stdout. These tests require
 * `npm run build:hooks` to have run.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { stringify as yamlStringify } from 'yaml';

const HOOK = resolve(__dirname, '..', '..', 'dist', 'hooks', 'session-start.js');
const FIXTURES_ROOT = resolve(__dirname, '..', 'detect', '__tests__', 'fixtures');
const created: string[] = [];

afterAll(() => {
  for (const d of created) {
    if (existsSync(d)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
});

function stageFixture(name: string): string {
  const src = resolve(FIXTURES_ROOT, name);
  const dest = mkdtempSync(resolve(tmpdir(), `massu-session-drift-${name}-`));
  created.push(dest);
  cpSync(src, dest, { recursive: true });
  return dest;
}

function runHook(cwd: string, sessionId = 'test-session'): { stdout: string; stderr: string; code: number | null } {
  const input = JSON.stringify({
    session_id: sessionId,
    transcript_path: '',
    cwd,
    hook_event_name: 'SessionStart',
    source: 'startup',
  });
  const r = spawnSync('node', [HOOK], {
    encoding: 'utf-8',
    cwd,
    input,
    timeout: 15000,
    env: { ...process.env, HOME: cwd },
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status };
}

describe('session-start drift banner', () => {
  beforeAll(() => {
    if (!existsSync(HOOK)) {
      // eslint-disable-next-line no-console
      console.warn(`[session-start-drift.test] ${HOOK} missing; build:hooks not run`);
    }
  });

  it('emits NO banner when config has no stored fingerprint (v1 back-compat)', () => {
    if (!existsSync(HOOK)) return;
    const dir = stageFixture('ts-nextjs');
    // v1 config (no detection.fingerprint).
    writeFileSync(
      resolve(dir, 'massu.config.yaml'),
      yamlStringify({
        project: { name: 'x', root: 'auto' },
        framework: { type: 'typescript', router: 'none', orm: 'none', ui: 'none' },
        paths: { source: 'src', aliases: { '@': 'src' } },
        toolPrefix: 'massu',
        domains: [],
        rules: [],
      }),
      'utf-8'
    );
    const { stdout } = runHook(dir);
    expect(stdout).not.toMatch(/Massu Config Drift/);
  });

  it('emits banner when stored fingerprint does NOT match current', () => {
    if (!existsSync(HOOK)) return;
    const dir = stageFixture('ts-nextjs');
    writeFileSync(
      resolve(dir, 'massu.config.yaml'),
      yamlStringify({
        project: { name: 'x', root: 'auto' },
        framework: { type: 'typescript', router: 'none', orm: 'none', ui: 'none' },
        paths: { source: 'src', aliases: { '@': 'src' } },
        toolPrefix: 'massu',
        domains: [],
        rules: [],
        detection: { fingerprint: '0'.repeat(64) },
      }),
      'utf-8'
    );
    const { stdout } = runHook(dir);
    expect(stdout).toMatch(/Massu Config Drift/);
    expect(stdout).toMatch(/npx massu config refresh/);
  });

  it('never throws on malformed config (best-effort)', () => {
    if (!existsSync(HOOK)) return;
    const dir = stageFixture('ts-nextjs');
    writeFileSync(resolve(dir, 'massu.config.yaml'), 'not: [[\n\tvalid', 'utf-8');
    const { code } = runHook(dir);
    expect(code).toBe(0);
  });
});
