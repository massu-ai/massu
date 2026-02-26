// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { resolve } from 'path';
import { getConfig, getResolvedPaths, resetConfig } from '../config.ts';

const TEST_DIR = resolve(__dirname, '../test-config-conventions-tmp');
const CONFIG_PATH = resolve(TEST_DIR, 'massu.config.yaml');

function writeConfig(yaml: string) {
  if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, yaml, 'utf-8');
}

describe('Conventions Config', () => {
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

  // P2-032: ConventionsConfigSchema parses correctly with defaults
  describe('defaults', () => {
    it('returns undefined conventions when not specified', () => {
      writeConfig('');
      const config = getConfig();
      // conventions is optional — Zod returns undefined when omitted
      expect(config.conventions).toBeUndefined();
    });

    it('returns defaults when conventions is empty object', () => {
      writeConfig('conventions: {}');
      const config = getConfig();
      expect(config.conventions).toBeDefined();
      expect(config.conventions!.claudeDirName).toBe('.claude');
      expect(config.conventions!.sessionStatePath).toBe('.claude/session-state/CURRENT.md');
      expect(config.conventions!.sessionArchivePath).toBe('.claude/session-state/archive');
      expect(config.conventions!.knowledgeSourceFiles).toEqual(['CLAUDE.md', 'MEMORY.md', 'corrections.md']);
      expect(config.conventions!.excludePatterns).toEqual(['/ARCHIVE/', '/SESSION-HISTORY/']);
    });

    it('returns 14 default knowledge categories', () => {
      writeConfig('conventions: {}');
      const config = getConfig();
      expect(config.conventions!.knowledgeCategories).toHaveLength(14);
      expect(config.conventions!.knowledgeCategories).toContain('patterns');
      expect(config.conventions!.knowledgeCategories).toContain('agents');
    });
  });

  // P2-033: claudeDirName override propagates to resolved paths
  describe('claudeDirName override', () => {
    it('propagates to claudeDir', () => {
      writeConfig(`
conventions:
  claudeDirName: ".my-claude"
`);
      const paths = getResolvedPaths();
      expect(paths.claudeDir).toContain('.my-claude');
      expect(paths.claudeDir).not.toContain('/.claude');
    });

    it('propagates to patternsDir', () => {
      writeConfig(`
conventions:
  claudeDirName: ".custom"
`);
      const paths = getResolvedPaths();
      expect(paths.patternsDir).toContain('.custom/patterns');
    });

    it('propagates to claudeMdPath', () => {
      writeConfig(`
conventions:
  claudeDirName: ".custom"
`);
      const paths = getResolvedPaths();
      expect(paths.claudeMdPath).toContain('.custom/CLAUDE.md');
    });

    it('propagates to memoryDir', () => {
      writeConfig(`
conventions:
  claudeDirName: ".custom"
`);
      const paths = getResolvedPaths();
      expect(paths.memoryDir).toContain('.custom/projects');
    });

    it('propagates to settingsLocalPath', () => {
      writeConfig(`
conventions:
  claudeDirName: ".custom"
`);
      const paths = getResolvedPaths();
      expect(paths.settingsLocalPath).toContain('.custom/settings.local.json');
    });
  });

  // P2-034: knowledgeCategories override
  describe('knowledgeCategories override', () => {
    it('overrides with custom list', () => {
      writeConfig(`
conventions:
  knowledgeCategories:
    - docs
    - patterns
    - custom
`);
      const config = getConfig();
      expect(config.conventions!.knowledgeCategories).toEqual(['docs', 'patterns', 'custom']);
      expect(config.conventions!.knowledgeCategories).toHaveLength(3);
    });
  });

  // P2-035: excludePatterns override
  describe('excludePatterns override', () => {
    it('overrides with custom list', () => {
      writeConfig(`
conventions:
  excludePatterns:
    - /ARCHIVE/
    - /OLD/
    - /TEMP/
`);
      const config = getConfig();
      expect(config.conventions!.excludePatterns).toEqual(['/ARCHIVE/', '/OLD/', '/TEMP/']);
    });
  });

  // sessionStatePath and sessionArchivePath resolved paths
  describe('session paths', () => {
    it('provides sessionStatePath in resolved paths', () => {
      writeConfig('');
      const paths = getResolvedPaths();
      expect(paths.sessionStatePath).toContain('session-state/CURRENT.md');
    });

    it('provides sessionArchivePath in resolved paths', () => {
      writeConfig('');
      const paths = getResolvedPaths();
      expect(paths.sessionArchivePath).toContain('session-state/archive');
    });

    it('overrides session paths from config', () => {
      writeConfig(`
conventions:
  sessionStatePath: ".my-claude/state/current.md"
`);
      const paths = getResolvedPaths();
      expect(paths.sessionStatePath).toContain('.my-claude/state/current.md');
    });
  });

  // mcpJsonPath and settingsLocalPath
  describe('additional resolved paths', () => {
    it('provides mcpJsonPath', () => {
      writeConfig('');
      const paths = getResolvedPaths();
      expect(paths.mcpJsonPath).toContain('.mcp.json');
    });

    it('provides settingsLocalPath', () => {
      writeConfig('');
      const paths = getResolvedPaths();
      expect(paths.settingsLocalPath).toContain('settings.local.json');
    });
  });

  // Backward compatibility: no conventions section works identically
  describe('backward compatibility', () => {
    it('works with minimal config (no conventions)', () => {
      writeConfig(`
project:
  name: test
toolPrefix: test
`);
      const config = getConfig();
      const paths = getResolvedPaths();
      expect(config.conventions).toBeUndefined();
      expect(paths.claudeDir).toContain('.claude');
      expect(paths.patternsDir).toContain('.claude/patterns');
      expect(paths.claudeMdPath).toContain('.claude/CLAUDE.md');
    });
  });
});
