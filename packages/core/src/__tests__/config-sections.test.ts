// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { resolve } from 'path';
import { getConfig, resetConfig } from '../config.ts';

/**
 * PP0-003: Config parsing tests for new analytics, governance,
 * security, team, and regression sections.
 */

const TEST_DIR = resolve(__dirname, '../test-config-tmp');
const CONFIG_PATH = resolve(TEST_DIR, 'massu.config.yaml');

function writeConfig(yaml: string) {
  if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, yaml, 'utf-8');
}

describe('Config Section Parsing', () => {
  const originalCwd = process.cwd();

  beforeEach(() => {
    resetConfig();
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
    process.chdir(TEST_DIR);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    resetConfig();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('Minimal config (no optional sections)', () => {
    it('returns undefined for all optional sections when absent', () => {
      writeConfig(`
project:
  name: test-project
toolPrefix: tp
`);
      const config = getConfig();
      expect(config.project.name).toBe('test-project');
      expect(config.toolPrefix).toBe('tp');
      expect(config.analytics).toBeUndefined();
      expect(config.governance).toBeUndefined();
      expect(config.security).toBeUndefined();
      expect(config.team).toBeUndefined();
      expect(config.regression).toBeUndefined();
    });
  });

  describe('Analytics config', () => {
    it('parses quality weights', () => {
      writeConfig(`
project:
  name: test
analytics:
  quality:
    weights:
      bug_found: -10
      clean_commit: 8
    categories:
      - security
      - tests
`);
      const config = getConfig();
      expect(config.analytics).toBeDefined();
      expect(config.analytics!.quality!.weights!.bug_found).toBe(-10);
      expect(config.analytics!.quality!.weights!.clean_commit).toBe(8);
      expect(config.analytics!.quality!.categories).toEqual(['security', 'tests']);
    });

    it('parses cost model pricing', () => {
      writeConfig(`
project:
  name: test
analytics:
  cost:
    models:
      gpt-4:
        input_per_million: 30
        output_per_million: 60
    currency: EUR
`);
      const config = getConfig();
      expect(config.analytics!.cost!.models!['gpt-4'].input_per_million).toBe(30);
      expect(config.analytics!.cost!.currency).toBe('EUR');
    });

    it('parses prompt effectiveness indicators', () => {
      writeConfig(`
project:
  name: test
analytics:
  prompts:
    success_indicators:
      - approved
      - merged
    failure_indicators:
      - revert
    max_turns_for_success: 3
`);
      const config = getConfig();
      expect(config.analytics!.prompts!.success_indicators).toEqual(['approved', 'merged']);
      expect(config.analytics!.prompts!.failure_indicators).toEqual(['revert']);
      expect(config.analytics!.prompts!.max_turns_for_success).toBe(3);
    });
  });

  describe('Governance config', () => {
    it('parses audit settings', () => {
      writeConfig(`
project:
  name: test
governance:
  audit:
    formats:
      - summary
      - soc2
    retention_days: 730
    auto_log:
      code_changes: true
      approvals: false
`);
      const config = getConfig();
      expect(config.governance!.audit!.formats).toEqual(['summary', 'soc2']);
      expect(config.governance!.audit!.retention_days).toBe(730);
      expect(config.governance!.audit!.auto_log!.approvals).toBe(false);
    });

    it('parses validation checks', () => {
      writeConfig(`
project:
  name: test
governance:
  validation:
    realtime: false
    checks:
      rule_compliance: true
      import_existence: false
    custom_patterns:
      - pattern: 'console\\.log'
        severity: warning
        message: Remove console.log
`);
      const config = getConfig();
      expect(config.governance!.validation!.realtime).toBe(false);
      expect(config.governance!.validation!.checks!.import_existence).toBe(false);
      expect(config.governance!.validation!.custom_patterns!.length).toBe(1);
      expect(config.governance!.validation!.custom_patterns![0].pattern).toBe('console\\.log');
    });

    it('parses ADR detection phrases', () => {
      writeConfig(`
project:
  name: test
governance:
  adr:
    detection_phrases:
      - chose
      - decided
      - opted for
    storage: filesystem
    output_dir: docs/decisions
`);
      const config = getConfig();
      expect(config.governance!.adr!.detection_phrases).toContain('opted for');
      expect(config.governance!.adr!.storage).toBe('filesystem');
      expect(config.governance!.adr!.output_dir).toBe('docs/decisions');
    });
  });

  describe('Security config', () => {
    it('parses severity weights', () => {
      writeConfig(`
project:
  name: test
security:
  severity_weights:
    critical: 30
    high: 20
    medium: 10
    low: 5
`);
      const config = getConfig();
      expect(config.security!.severity_weights!.critical).toBe(30);
      expect(config.security!.severity_weights!.low).toBe(5);
    });

    it('parses restrictive licenses', () => {
      writeConfig(`
project:
  name: test
security:
  restrictive_licenses:
    - GPL
    - AGPL
    - SSPL
    - EUPL
`);
      const config = getConfig();
      expect(config.security!.restrictive_licenses).toContain('EUPL');
      expect(config.security!.restrictive_licenses!.length).toBe(4);
    });

    it('parses dependency alternatives', () => {
      writeConfig(`
project:
  name: test
security:
  dep_alternatives:
    moment:
      - date-fns
      - dayjs
    lodash:
      - radash
`);
      const config = getConfig();
      expect(config.security!.dep_alternatives!.moment).toEqual(['date-fns', 'dayjs']);
      expect(config.security!.dep_alternatives!.lodash).toEqual(['radash']);
    });

    it('parses dependency management', () => {
      writeConfig(`
project:
  name: test
security:
  auto_score_on_edit: false
  score_threshold_alert: 75
  dependencies:
    package_manager: pnpm
    blocked_packages:
      - event-stream
    max_bundle_size_kb: 200
`);
      const config = getConfig();
      expect(config.security!.auto_score_on_edit).toBe(false);
      expect(config.security!.score_threshold_alert).toBe(75);
      expect(config.security!.dependencies!.package_manager).toBe('pnpm');
      expect(config.security!.dependencies!.blocked_packages).toEqual(['event-stream']);
    });
  });

  describe('Team config', () => {
    it('parses team settings with expertise weights', () => {
      writeConfig(`
project:
  name: test
team:
  enabled: true
  sync_backend: supabase
  developer_id: dev-123
  share_by_default: true
  expertise_weights:
    session: 30
    observation: 15
  privacy:
    share_file_paths: true
    share_code_snippets: true
    share_observations: false
`);
      const config = getConfig();
      expect(config.team!.enabled).toBe(true);
      expect(config.team!.sync_backend).toBe('supabase');
      expect(config.team!.developer_id).toBe('dev-123');
      expect(config.team!.expertise_weights!.session).toBe(30);
      expect(config.team!.expertise_weights!.observation).toBe(15);
      expect(config.team!.privacy!.share_code_snippets).toBe(true);
      expect(config.team!.privacy!.share_observations).toBe(false);
    });

    it('returns defaults for minimal team config', () => {
      writeConfig(`
project:
  name: test
team:
  enabled: true
`);
      const config = getConfig();
      expect(config.team!.enabled).toBe(true);
      expect(config.team!.sync_backend).toBe('local');
      expect(config.team!.developer_id).toBe('auto');
      expect(config.team!.share_by_default).toBe(false);
      expect(config.team!.expertise_weights).toBeUndefined();
      expect(config.team!.privacy).toBeUndefined();
    });
  });

  describe('Regression config', () => {
    it('parses health thresholds', () => {
      writeConfig(`
project:
  name: test
regression:
  test_runner: vitest
  test_patterns:
    - "**/*.test.ts"
  health_thresholds:
    healthy: 90
    warning: 60
`);
      const config = getConfig();
      expect(config.regression!.test_runner).toBe('vitest');
      expect(config.regression!.test_patterns).toEqual(['**/*.test.ts']);
      expect(config.regression!.health_thresholds!.healthy).toBe(90);
      expect(config.regression!.health_thresholds!.warning).toBe(60);
    });

    it('returns defaults for minimal regression config', () => {
      writeConfig(`
project:
  name: test
regression:
  test_runner: jest
`);
      const config = getConfig();
      expect(config.regression!.test_runner).toBe('jest');
      expect(config.regression!.test_patterns).toBeDefined();
      expect(config.regression!.test_patterns!.length).toBeGreaterThan(0);
      expect(config.regression!.health_thresholds).toBeUndefined();
    });
  });

  describe('Full config (all sections)', () => {
    it('parses complete config with all optional sections', () => {
      writeConfig(`
project:
  name: full-test
toolPrefix: ft
analytics:
  quality:
    weights:
      bug: -5
governance:
  audit:
    formats:
      - summary
security:
  severity_weights:
    critical: 25
team:
  enabled: true
regression:
  test_runner: npm test
`);
      const config = getConfig();
      expect(config.project.name).toBe('full-test');
      expect(config.toolPrefix).toBe('ft');
      expect(config.analytics).toBeDefined();
      expect(config.governance).toBeDefined();
      expect(config.security).toBeDefined();
      expect(config.team).toBeDefined();
      expect(config.regression).toBeDefined();
    });
  });
});
