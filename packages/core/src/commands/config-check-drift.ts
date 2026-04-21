// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * `massu config check-drift` — CI-safe drift gate.
 *
 * Reads massu.config.yaml, runs detection, and compares the result with both
 * the stored fingerprint (if present) and the structural detectDrift() check.
 *
 * Flags:
 *   --verbose   Emit the full changes[] to stdout (field: before -> after).
 *
 * Exit codes:
 *   0  no drift
 *   1  drift detected
 *   2  config missing or unparseable
 */

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import { runDetection } from '../detect/index.ts';
import { computeFingerprint, detectDrift, type DriftChange } from '../detect/drift.ts';
import type { AnyConfig } from '../detect/migrate.ts';

export interface ConfigCheckDriftOptions {
  verbose?: boolean;
  cwd?: string;
  silent?: boolean;
}

export interface ConfigCheckDriftResult {
  exitCode: 0 | 1 | 2;
  drifted: boolean;
  changes: DriftChange[];
  storedFingerprint: string | null;
  currentFingerprint: string | null;
  message?: string;
}

function renderChanges(changes: DriftChange[]): string {
  if (changes.length === 0) return '(none)\n';
  return changes
    .map((c) => `  ${c.field}: ${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}`)
    .join('\n') + '\n';
}

export async function runConfigCheckDrift(
  opts: ConfigCheckDriftOptions = {}
): Promise<ConfigCheckDriftResult> {
  const cwd = opts.cwd ?? process.cwd();
  const configPath = resolve(cwd, 'massu.config.yaml');
  const log = opts.silent ? () => {} : (s: string) => process.stdout.write(s);
  const err = opts.silent ? () => {} : (s: string) => process.stderr.write(s);

  if (!existsSync(configPath)) {
    const message = 'massu.config.yaml not found. Run: npx massu init';
    err(message + '\n');
    return {
      exitCode: 2,
      drifted: false,
      changes: [],
      storedFingerprint: null,
      currentFingerprint: null,
      message,
    };
  }

  let config: AnyConfig;
  try {
    const content = readFileSync(configPath, 'utf-8');
    const parsed = parseYaml(content);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('config is not a YAML object');
    }
    config = parsed as AnyConfig;
  } catch (e) {
    const message = `Failed to parse massu.config.yaml: ${e instanceof Error ? e.message : String(e)}`;
    err(message + '\n');
    return {
      exitCode: 2,
      drifted: false,
      changes: [],
      storedFingerprint: null,
      currentFingerprint: null,
      message,
    };
  }

  const detection = await runDetection(cwd);
  const currentFp = computeFingerprint(detection);
  const storedFp =
    typeof (config.detection as Record<string, unknown> | undefined)?.fingerprint === 'string'
      ? ((config.detection as Record<string, unknown>).fingerprint as string)
      : null;

  const report = detectDrift(config, detection);
  const fingerprintDrift = storedFp !== null && storedFp !== currentFp;
  const drifted = report.drifted || fingerprintDrift;

  if (!drifted) {
    log('No drift detected.\n');
    if (opts.verbose) {
      log(`Fingerprint: ${currentFp}\n`);
    }
    return {
      exitCode: 0,
      drifted: false,
      changes: report.changes,
      storedFingerprint: storedFp,
      currentFingerprint: currentFp,
    };
  }

  err('Config drift detected; run `npx massu config refresh` to update.\n');
  if (opts.verbose) {
    if (storedFp !== null) {
      log(`Fingerprint: ${storedFp.slice(0, 16)} -> ${currentFp.slice(0, 16)}\n`);
    } else {
      log(`Fingerprint (new): ${currentFp.slice(0, 16)}\n`);
    }
    log('Changes:\n');
    log(renderChanges(report.changes));
  }
  return {
    exitCode: 1,
    drifted: true,
    changes: report.changes,
    storedFingerprint: storedFp,
    currentFingerprint: currentFp,
  };
}
