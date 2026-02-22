// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';

// Mock config to return real project root
const PROJECT_ROOT = resolve(__dirname, '../../../../..');

vi.mock('../../config.ts', () => ({
  getConfig: () => {
    // Read actual massu.config.yaml for this test
    const configPath = resolve(PROJECT_ROOT, 'massu.config.yaml');
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, 'utf-8');
      const parsed = parseYaml(raw);
      return {
        toolPrefix: parsed.toolPrefix || 'massu',
        framework: parsed.framework || { type: 'typescript' },
        paths: parsed.paths || { source: 'src' },
        domains: parsed.domains || [],
        analytics: parsed.analytics || {},
      };
    }
    return {
      toolPrefix: 'massu',
      framework: { type: 'typescript' },
      paths: { source: 'src' },
      domains: [],
      analytics: {},
    };
  },
  getProjectRoot: () => PROJECT_ROOT,
  getResolvedPaths: () => ({
    codegraphDbPath: resolve(PROJECT_ROOT, 'codegraph.db'),
    dataDbPath: resolve(PROJECT_ROOT, 'data.db'),
  }),
}));

describe('Integration: Pricing Consistency', () => {
  it('massu.config.yaml exists and parses without errors', () => {
    const configPath = resolve(PROJECT_ROOT, 'massu.config.yaml');
    expect(existsSync(configPath)).toBe(true);

    const raw = readFileSync(configPath, 'utf-8');
    const parsed = parseYaml(raw);
    expect(parsed).toBeTruthy();
    expect(parsed.toolPrefix).toBeTruthy();
  });

  it('toolPrefix in config matches expected format', () => {
    const configPath = resolve(PROJECT_ROOT, 'massu.config.yaml');
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = parseYaml(raw);

    // toolPrefix should be a string without spaces or special chars
    expect(typeof parsed.toolPrefix).toBe('string');
    expect(parsed.toolPrefix).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('DEFAULT_MODEL_PRICING in cost-tracker has required models', () => {
    // Read cost-tracker.ts to extract pricing data
    const costTrackerPath = resolve(PROJECT_ROOT, 'packages/core/src/cost-tracker.ts');
    expect(existsSync(costTrackerPath)).toBe(true);

    const content = readFileSync(costTrackerPath, 'utf-8');

    // Must have a default model
    expect(content).toContain("'default'");

    // Must have pricing structure with input_per_million and output_per_million
    expect(content).toContain('input_per_million');
    expect(content).toContain('output_per_million');
  });

  it('config file has required top-level sections', () => {
    const configPath = resolve(PROJECT_ROOT, 'massu.config.yaml');
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = parseYaml(raw);

    // Required sections
    expect(parsed.toolPrefix).toBeTruthy();
    expect(parsed.framework).toBeTruthy();
    expect(parsed.paths).toBeTruthy();
  });
});
