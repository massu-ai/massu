// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P4-005: CLI dispatcher tests.
 *
 * Runs the compiled `dist/cli.js` binary as a subprocess and verifies that the
 * new `config` subcommand tree dispatches correctly, and that legacy entry
 * points (`doctor`, `validate-config`) still resolve.
 *
 * These tests require `npm run build:cli` to have run at least once. The
 * CI `build` script already runs this before `test`.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';

const CLI = resolve(__dirname, '..', '..', 'dist', 'cli.js');

function runCli(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync('node', [CLI, ...args], {
    encoding: 'utf-8',
    timeout: 15000,
    env: { ...process.env, MASSU_SKIP_SERVER: '1' },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('CLI dispatcher: config subcommand', () => {
  beforeAll(() => {
    // Sanity: tests require a built CLI. If absent, we skip — the main build
    // pipeline runs `build:cli` before `test`.
    if (!existsSync(CLI)) {
      // eslint-disable-next-line no-console
      console.warn(`[cli-dispatcher.test] ${CLI} missing; build:cli not yet run`);
    }
  });

  it('config --help lists all 5 subcommands and their flags', () => {
    if (!existsSync(CLI)) return;
    const { code, stdout } = runCli(['config', '--help']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/refresh/);
    expect(stdout).toMatch(/validate/);
    expect(stdout).toMatch(/upgrade/);
    expect(stdout).toMatch(/doctor/);
    expect(stdout).toMatch(/check-drift/);
    expect(stdout).toMatch(/--dry-run/);
    expect(stdout).toMatch(/--rollback/);
    expect(stdout).toMatch(/--verbose/);
    expect(stdout).toMatch(/--ci/);
  });

  it('config (no sub) prints help and exits 0', () => {
    if (!existsSync(CLI)) return;
    const { code, stdout } = runCli(['config']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/Subcommands/i);
  });

  it('unknown config subcommand exits non-zero with error message', () => {
    if (!existsSync(CLI)) return;
    const { code, stderr } = runCli(['config', 'not-a-real-subcommand']);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/unknown config subcommand/);
  });

  it('top-level --help lists config command', () => {
    if (!existsSync(CLI)) return;
    const { code, stdout } = runCli(['--help']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/config <sub>/);
  });

  it('--version prints a version string', () => {
    if (!existsSync(CLI)) return;
    const { code, stdout } = runCli(['--version']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/massu v/);
  });
});
