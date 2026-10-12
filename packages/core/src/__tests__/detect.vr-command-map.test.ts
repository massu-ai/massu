// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect } from 'vitest';
import { getVRCommands } from '../detect/vr-command-map.ts';
import type { FrameworkInfo } from '../detect/framework-detector.ts';

function fwInfo(overrides: Partial<FrameworkInfo> = {}): FrameworkInfo {
  return {
    framework: null,
    version: null,
    test_framework: null,
    orm: null,
    ui_library: null,
    router: null,
    ...overrides,
  };
}

describe('detect/vr-command-map', () => {
  it('produces pytest commands for python+pytest', () => {
    const cmds = getVRCommands(
      'python',
      fwInfo({ framework: 'fastapi', test_framework: 'pytest' }),
      'apps/ai-service'
    );
    expect(cmds.test).toBe('cd apps/ai-service && python3 -m pytest -q');
    expect(cmds.type).toBe('cd apps/ai-service && python3 -m mypy .');
    // `python3 -m py_compile` with no filenames exits 2 (usage error) — a check that can
    // never pass. Corrected 2026-09-20; this expectation now pins the WORKING command.
    expect(cmds.syntax).toMatch(/compileall/);
  });

  it('produces vitest/tsc commands for TypeScript', () => {
    const cmds = getVRCommands(
      'typescript',
      fwInfo({ framework: 'next', test_framework: 'vitest' }),
      'apps/web'
    );
    expect(cmds.test).toBe('cd apps/web && npm test');
    expect(cmds.type).toBe('cd apps/web && npx tsc --noEmit');
    expect(cmds.build).toBe('cd apps/web && npm run build');
  });

  it('produces cargo commands for Rust', () => {
    const cmds = getVRCommands(
      'rust',
      fwInfo({ framework: 'actix-web' }),
      'apps/gateway'
    );
    expect(cmds.test).toBe('cd apps/gateway && cargo test');
    expect(cmds.type).toBe('cd apps/gateway && cargo check');
    expect(cmds.build).toBe('cd apps/gateway && cargo build');
  });

  it('produces xcodebuild + swift commands for Swift', () => {
    const cmds = getVRCommands(
      'swift',
      fwInfo({ framework: 'vapor' }),
      'apps/ios'
    );
    expect(cmds.build).toBe('cd apps/ios && swift build -c release');
    expect(cmds.test).toBe('cd apps/ios && swift test');
  });

  it('produces go test / vet for Go', () => {
    const cmds = getVRCommands('go', fwInfo({ framework: 'gin' }), 'cmd/server');
    expect(cmds.test).toBe('cd cmd/server && go test ./...');
    expect(cmds.type).toBe('cd cmd/server && go vet ./...');
  });

  it('user override replaces built-in test command', () => {
    const cmds = getVRCommands(
      'python',
      fwInfo({ test_framework: 'pytest' }),
      'svc',
      { test: 'pytest -xvs --no-header' }
    );
    expect(cmds.test).toBe('pytest -xvs --no-header');
    // Other keys still default
    expect(cmds.type).toBe('cd svc && python3 -m mypy .');
  });

  it('skips cd-prefix when dir is "."', () => {
    const cmds = getVRCommands(
      'typescript',
      fwInfo({ test_framework: 'vitest' }),
      '.'
    );
    expect(cmds.test).toBe('npm test');
    expect(cmds.type).toBe('npx tsc --noEmit');
  });

  it('Ruby RSpec commands', () => {
    const cmds = getVRCommands('ruby', fwInfo({ framework: 'rails' }), '.');
    // Minitest is Rails' default; rspec requires adding rspec-rails to the Gemfile, so
    // `bundle exec rspec` failed on a fresh `rails new`. Corrected 2026-09-20.
    expect(cmds.test).toBe('bin/rails test');
    expect(cmds.lint).toBe('bundle exec rubocop');
  });

  it('returns all nulls for an unknown language slot', () => {
    // @ts-expect-error intentional unknown language to hit default branch
    const cmds = getVRCommands('klingon', fwInfo(), 'x');
    expect(cmds.test).toBeNull();
    expect(cmds.type).toBeNull();
    expect(cmds.build).toBeNull();
  });
});
