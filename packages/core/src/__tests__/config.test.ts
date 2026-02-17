// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { resolve } from 'path';
import { getConfig, getProjectRoot, getResolvedPaths, resetConfig } from '../config.ts';

/**
 * Core config function tests: getConfig(), getProjectRoot(),
 * getResolvedPaths(), resetConfig(), and findProjectRoot() behavior.
 *
 * NOTE: config-sections.test.ts covers detailed section parsing.
 * This file focuses on core mechanics: caching, defaults, resolved paths, etc.
 */

const TEST_DIR = resolve(__dirname, '../test-config-core-tmp');
const CONFIG_PATH = resolve(TEST_DIR, 'massu.config.yaml');

function writeConfig(yaml: string) {
  if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, yaml, 'utf-8');
}

describe('Core Config Functions', () => {
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

  // -------------------------------------------------------
  // 1. getConfig() returns sensible defaults when no config file exists
  // -------------------------------------------------------
  describe('getConfig() defaults (no config file)', () => {
    it('returns sensible defaults when an empty config is provided', () => {
      // Write an empty config so findProjectRoot stays in TEST_DIR
      // and the Zod defaults kick in for all fields.
      writeConfig('');
      const config = getConfig();
      expect(config.project.name).toBe('my-project');
      expect(config.framework.type).toBe('typescript');
      expect(config.framework.router).toBe('none');
      expect(config.framework.orm).toBe('none');
      expect(config.framework.ui).toBe('none');
      expect(config.paths.source).toBe('src');
      expect(config.toolPrefix).toBe('massu');
      expect(config.domains).toEqual([]);
      expect(config.rules).toEqual([]);
    });

    it('returns default paths.aliases with @ -> src', () => {
      writeConfig('');
      const config = getConfig();
      expect(config.paths.aliases).toEqual({ '@': 'src' });
    });
  });

  // -------------------------------------------------------
  // 2. getConfig() caching (second call returns same object)
  // -------------------------------------------------------
  describe('getConfig() caching', () => {
    it('returns the same object reference on consecutive calls', () => {
      writeConfig(`
project:
  name: cache-test
toolPrefix: ct
`);
      const first = getConfig();
      const second = getConfig();
      expect(first).toBe(second);
    });
  });

  // -------------------------------------------------------
  // 3. resetConfig() clears cache
  // -------------------------------------------------------
  describe('resetConfig()', () => {
    it('clears the config cache so next call re-reads from disk', () => {
      writeConfig(`
project:
  name: before-reset
`);
      const before = getConfig();
      expect(before.project.name).toBe('before-reset');

      // Write new config and reset
      writeConfig(`
project:
  name: after-reset
`);
      resetConfig();
      const after = getConfig();
      expect(after.project.name).toBe('after-reset');
    });

    it('clears project root cache', () => {
      const root1 = getProjectRoot();
      resetConfig();
      const root2 = getProjectRoot();
      // Both should resolve to a valid directory, but the cache was cleared
      // (the result may be the same path, but it was recomputed)
      expect(typeof root1).toBe('string');
      expect(typeof root2).toBe('string');
    });
  });

  // -------------------------------------------------------
  // 4. getProjectRoot() caches the result
  // -------------------------------------------------------
  describe('getProjectRoot() caching', () => {
    it('returns the same string on consecutive calls', () => {
      writeConfig(`
project:
  name: root-cache
`);
      const first = getProjectRoot();
      const second = getProjectRoot();
      expect(first).toBe(second);
      expect(typeof first).toBe('string');
    });

    it('finds the directory containing massu.config.yaml', () => {
      writeConfig(`
project:
  name: root-find
`);
      const root = getProjectRoot();
      expect(existsSync(resolve(root, 'massu.config.yaml'))).toBe(true);
    });
  });

  // -------------------------------------------------------
  // 5. getResolvedPaths() returns all expected keys
  // -------------------------------------------------------
  describe('getResolvedPaths() keys', () => {
    it('returns an object with all expected path keys', () => {
      writeConfig(`
project:
  name: paths-test
`);
      const paths = getResolvedPaths();
      const expectedKeys = [
        'codegraphDbPath',
        'dataDbPath',
        'prismaSchemaPath',
        'rootRouterPath',
        'routersDir',
        'srcDir',
        'pathAlias',
        'extensions',
        'indexFiles',
        'patternsDir',
        'claudeMdPath',
        'docsMapPath',
        'helpSitePath',
        'memoryDbPath',
      ];
      for (const key of expectedKeys) {
        expect(paths).toHaveProperty(key);
      }
    });
  });

  // -------------------------------------------------------
  // 6. getResolvedPaths() uses config.paths.source for srcDir
  // -------------------------------------------------------
  describe('getResolvedPaths() srcDir resolution', () => {
    it('resolves srcDir from config.paths.source', () => {
      writeConfig(`
project:
  name: src-test
paths:
  source: lib
`);
      const paths = getResolvedPaths();
      const root = getProjectRoot();
      expect(paths.srcDir).toBe(resolve(root, 'lib'));
    });

    it('uses default src when paths.source not specified', () => {
      writeConfig(`
project:
  name: src-default
`);
      const paths = getResolvedPaths();
      const root = getProjectRoot();
      expect(paths.srcDir).toBe(resolve(root, 'src'));
    });
  });

  // -------------------------------------------------------
  // 7. Config with custom toolPrefix
  // -------------------------------------------------------
  describe('custom toolPrefix', () => {
    it('reads custom toolPrefix from config', () => {
      writeConfig(`
project:
  name: prefix-test
toolPrefix: myprefix
`);
      const config = getConfig();
      expect(config.toolPrefix).toBe('myprefix');
    });
  });

  // -------------------------------------------------------
  // 8. Config with custom project name
  // -------------------------------------------------------
  describe('custom project name', () => {
    it('reads custom project name', () => {
      writeConfig(`
project:
  name: my-awesome-project
`);
      const config = getConfig();
      expect(config.project.name).toBe('my-awesome-project');
    });

    it('uses project name in helpSitePath', () => {
      writeConfig(`
project:
  name: cool-app
`);
      const paths = getResolvedPaths();
      expect(paths.helpSitePath).toContain('cool-app-help');
    });
  });

  // -------------------------------------------------------
  // 9. Config with domains array
  // -------------------------------------------------------
  describe('domains array', () => {
    it('parses domains from config', () => {
      writeConfig(`
project:
  name: domains-test
domains:
  - name: auth
    routers:
      - auth.ts
    pages:
      - login
    tables:
      - users
    allowedImportsFrom:
      - shared
  - name: billing
    routers:
      - billing.ts
`);
      const config = getConfig();
      expect(config.domains).toHaveLength(2);
      expect(config.domains[0].name).toBe('auth');
      expect(config.domains[0].routers).toEqual(['auth.ts']);
      expect(config.domains[0].pages).toEqual(['login']);
      expect(config.domains[0].tables).toEqual(['users']);
      expect(config.domains[0].allowedImportsFrom).toEqual(['shared']);
      expect(config.domains[1].name).toBe('billing');
    });

    it('defaults to empty array when domains not specified', () => {
      writeConfig(`
project:
  name: no-domains
`);
      const config = getConfig();
      expect(config.domains).toEqual([]);
    });
  });

  // -------------------------------------------------------
  // 10. Config with rules array
  // -------------------------------------------------------
  describe('rules array', () => {
    it('parses rules from config', () => {
      writeConfig(`
project:
  name: rules-test
rules:
  - pattern: "src/server/**"
    rules:
      - no-client-imports
      - must-have-tests
  - pattern: "src/components/**"
    rules:
      - no-direct-db-access
`);
      const config = getConfig();
      expect(config.rules).toHaveLength(2);
      expect(config.rules[0].pattern).toBe('src/server/**');
      expect(config.rules[0].rules).toEqual(['no-client-imports', 'must-have-tests']);
      expect(config.rules[1].pattern).toBe('src/components/**');
    });

    it('defaults to empty array when rules not specified', () => {
      writeConfig(`
project:
  name: no-rules
`);
      const config = getConfig();
      expect(config.rules).toEqual([]);
    });
  });

  // -------------------------------------------------------
  // 11. Config with analytics section
  // -------------------------------------------------------
  describe('analytics section', () => {
    it('populates analytics when present in config', () => {
      writeConfig(`
project:
  name: analytics-test
analytics:
  quality:
    weights:
      clean_commit: 10
  cost:
    currency: GBP
  prompts:
    max_turns_for_success: 5
`);
      const config = getConfig();
      expect(config.analytics).toBeDefined();
      expect(config.analytics!.quality!.weights!.clean_commit).toBe(10);
      expect(config.analytics!.cost!.currency).toBe('GBP');
      expect(config.analytics!.prompts!.max_turns_for_success).toBe(5);
    });

    it('is undefined when analytics not specified', () => {
      writeConfig(`
project:
  name: no-analytics
`);
      const config = getConfig();
      expect(config.analytics).toBeUndefined();
    });
  });

  // -------------------------------------------------------
  // 12. Config with governance section
  // -------------------------------------------------------
  describe('governance section', () => {
    it('populates governance when present in config', () => {
      writeConfig(`
project:
  name: gov-test
governance:
  audit:
    retention_days: 180
  validation:
    realtime: true
  adr:
    template: custom
    storage: filesystem
`);
      const config = getConfig();
      expect(config.governance).toBeDefined();
      expect(config.governance!.audit!.retention_days).toBe(180);
      expect(config.governance!.validation!.realtime).toBe(true);
      expect(config.governance!.adr!.template).toBe('custom');
      expect(config.governance!.adr!.storage).toBe('filesystem');
    });

    it('is undefined when governance not specified', () => {
      writeConfig(`
project:
  name: no-gov
`);
      const config = getConfig();
      expect(config.governance).toBeUndefined();
    });
  });

  // -------------------------------------------------------
  // 13. Config with security section
  // -------------------------------------------------------
  describe('security section', () => {
    it('populates security when present in config', () => {
      writeConfig(`
project:
  name: sec-test
security:
  auto_score_on_edit: false
  score_threshold_alert: 80
  patterns:
    - pattern: 'eval\('
      severity: critical
      category: injection
      description: No eval
`);
      const config = getConfig();
      expect(config.security).toBeDefined();
      expect(config.security!.auto_score_on_edit).toBe(false);
      expect(config.security!.score_threshold_alert).toBe(80);
      expect(config.security!.patterns).toHaveLength(1);
      expect(config.security!.patterns![0].severity).toBe('critical');
    });

    it('is undefined when security not specified', () => {
      writeConfig(`
project:
  name: no-sec
`);
      const config = getConfig();
      expect(config.security).toBeUndefined();
    });
  });

  // -------------------------------------------------------
  // 14. Config with team section
  // -------------------------------------------------------
  describe('team section', () => {
    it('populates team when present in config', () => {
      writeConfig(`
project:
  name: team-test
team:
  enabled: true
  sync_backend: supabase
  developer_id: dev-42
  share_by_default: true
`);
      const config = getConfig();
      expect(config.team).toBeDefined();
      expect(config.team!.enabled).toBe(true);
      expect(config.team!.sync_backend).toBe('supabase');
      expect(config.team!.developer_id).toBe('dev-42');
      expect(config.team!.share_by_default).toBe(true);
    });

    it('is undefined when team not specified', () => {
      writeConfig(`
project:
  name: no-team
`);
      const config = getConfig();
      expect(config.team).toBeUndefined();
    });
  });

  // -------------------------------------------------------
  // 15. Config with regression section
  // -------------------------------------------------------
  describe('regression section', () => {
    it('populates regression when present in config', () => {
      writeConfig(`
project:
  name: reg-test
regression:
  test_runner: vitest
  test_patterns:
    - "**/*.spec.ts"
  health_thresholds:
    healthy: 95
    warning: 70
`);
      const config = getConfig();
      expect(config.regression).toBeDefined();
      expect(config.regression!.test_runner).toBe('vitest');
      expect(config.regression!.test_patterns).toEqual(['**/*.spec.ts']);
      expect(config.regression!.health_thresholds!.healthy).toBe(95);
      expect(config.regression!.health_thresholds!.warning).toBe(70);
    });

    it('is undefined when regression not specified', () => {
      writeConfig(`
project:
  name: no-reg
`);
      const config = getConfig();
      expect(config.regression).toBeUndefined();
    });
  });

  // -------------------------------------------------------
  // 16. Config with cloud section
  // -------------------------------------------------------
  describe('cloud section', () => {
    it('populates cloud when present in config', () => {
      writeConfig(`
project:
  name: cloud-test
cloud:
  enabled: true
  endpoint: https://api.example.com
  sync:
    memory: true
    analytics: false
    audit: true
`);
      const config = getConfig();
      expect(config.cloud).toBeDefined();
      expect(config.cloud!.enabled).toBe(true);
      expect(config.cloud!.endpoint).toBe('https://api.example.com');
      expect(config.cloud!.sync!.memory).toBe(true);
      expect(config.cloud!.sync!.analytics).toBe(false);
      expect(config.cloud!.sync!.audit).toBe(true);
    });

    it('is undefined when cloud not specified', () => {
      writeConfig(`
project:
  name: no-cloud
`);
      const config = getConfig();
      expect(config.cloud).toBeUndefined();
    });
  });

  // -------------------------------------------------------
  // 17. Config with paths.aliases
  // -------------------------------------------------------
  describe('paths.aliases', () => {
    it('parses custom path aliases', () => {
      writeConfig(`
project:
  name: alias-test
paths:
  source: src
  aliases:
    "@": src
    "@components": src/components
    "@utils": src/utils
`);
      const config = getConfig();
      expect(config.paths.aliases).toEqual({
        '@': 'src',
        '@components': 'src/components',
        '@utils': 'src/utils',
      });
    });

    it('resolves aliases in getResolvedPaths().pathAlias', () => {
      writeConfig(`
project:
  name: alias-resolve
paths:
  source: src
  aliases:
    "@lib": lib
    "@shared": packages/shared
`);
      const paths = getResolvedPaths();
      const root = getProjectRoot();
      expect(paths.pathAlias['@lib']).toBe(resolve(root, 'lib'));
      expect(paths.pathAlias['@shared']).toBe(resolve(root, 'packages/shared'));
    });
  });

  // -------------------------------------------------------
  // 18. getResolvedPaths() includes extensions and indexFiles
  // -------------------------------------------------------
  describe('getResolvedPaths() extensions and indexFiles', () => {
    it('includes the standard file extensions', () => {
      writeConfig(`
project:
  name: ext-test
`);
      const paths = getResolvedPaths();
      expect(paths.extensions).toEqual(['.ts', '.tsx', '.js', '.jsx']);
    });

    it('includes the standard index file names', () => {
      writeConfig(`
project:
  name: idx-test
`);
      const paths = getResolvedPaths();
      expect(paths.indexFiles).toEqual(['index.ts', 'index.tsx', 'index.js', 'index.jsx']);
    });

    it('extensions and indexFiles are readonly tuples', () => {
      writeConfig(`
project:
  name: tuple-test
`);
      const paths = getResolvedPaths();
      expect(paths.extensions).toHaveLength(4);
      expect(paths.indexFiles).toHaveLength(4);
    });
  });

  // -------------------------------------------------------
  // 19. Config with knownMismatches
  // -------------------------------------------------------
  describe('knownMismatches', () => {
    it('parses knownMismatches from config', () => {
      writeConfig(`
project:
  name: mismatch-test
knownMismatches:
  imports:
    "src/legacy.ts": "Uses old import style intentionally"
  naming:
    "src/XMLParser.ts": "Third-party convention"
`);
      const config = getConfig();
      expect(config.knownMismatches).toBeDefined();
      expect(config.knownMismatches!.imports['src/legacy.ts']).toBe('Uses old import style intentionally');
      expect(config.knownMismatches!.naming['src/XMLParser.ts']).toBe('Third-party convention');
    });

    it('is undefined when knownMismatches not specified', () => {
      writeConfig(`
project:
  name: no-mismatches
`);
      const config = getConfig();
      expect(config.knownMismatches).toBeUndefined();
    });
  });

  // -------------------------------------------------------
  // 20. Config with accessScopes
  // -------------------------------------------------------
  describe('accessScopes', () => {
    it('parses accessScopes from config', () => {
      writeConfig(`
project:
  name: scopes-test
accessScopes:
  - read:code
  - write:config
  - admin:users
`);
      const config = getConfig();
      expect(config.accessScopes).toBeDefined();
      expect(config.accessScopes).toEqual(['read:code', 'write:config', 'admin:users']);
    });

    it('is undefined when accessScopes not specified', () => {
      writeConfig(`
project:
  name: no-scopes
`);
      const config = getConfig();
      expect(config.accessScopes).toBeUndefined();
    });
  });

  // -------------------------------------------------------
  // Additional: getResolvedPaths() fixed path resolution
  // -------------------------------------------------------
  describe('getResolvedPaths() fixed paths', () => {
    it('resolves codegraphDbPath under .codegraph/', () => {
      writeConfig(`
project:
  name: fixed-paths
`);
      const paths = getResolvedPaths();
      const root = getProjectRoot();
      expect(paths.codegraphDbPath).toBe(resolve(root, '.codegraph/codegraph.db'));
    });

    it('resolves dataDbPath under .massu/', () => {
      writeConfig(`
project:
  name: fixed-paths
`);
      const paths = getResolvedPaths();
      const root = getProjectRoot();
      expect(paths.dataDbPath).toBe(resolve(root, '.massu/data.db'));
    });

    it('resolves memoryDbPath under .massu/', () => {
      writeConfig(`
project:
  name: fixed-paths
`);
      const paths = getResolvedPaths();
      const root = getProjectRoot();
      expect(paths.memoryDbPath).toBe(resolve(root, '.massu/memory.db'));
    });

    it('resolves patternsDir and claudeMdPath under .claude/', () => {
      writeConfig(`
project:
  name: fixed-paths
`);
      const paths = getResolvedPaths();
      const root = getProjectRoot();
      expect(paths.patternsDir).toBe(resolve(root, '.claude/patterns'));
      expect(paths.claudeMdPath).toBe(resolve(root, '.claude/CLAUDE.md'));
    });

    it('resolves docsMapPath under .massu/', () => {
      writeConfig(`
project:
  name: fixed-paths
`);
      const paths = getResolvedPaths();
      const root = getProjectRoot();
      expect(paths.docsMapPath).toBe(resolve(root, '.massu/docs-map.json'));
    });
  });

  // -------------------------------------------------------
  // Additional: project.root resolution
  // -------------------------------------------------------
  describe('project.root resolution', () => {
    it('uses auto root when project.root is auto', () => {
      writeConfig(`
project:
  name: auto-root
  root: auto
`);
      const config = getConfig();
      const root = getProjectRoot();
      expect(config.project.root).toBe(root);
    });

    it('resolves relative project.root against project root', () => {
      writeConfig(`
project:
  name: relative-root
  root: packages/core
`);
      const config = getConfig();
      const root = getProjectRoot();
      expect(config.project.root).toBe(resolve(root, 'packages/core'));
    });
  });
});
