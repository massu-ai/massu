// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * `massu config upgrade` — migrate a v1 `massu.config.yaml` to schema_version=2.
 *
 * Flags:
 *   --rollback    Restore massu.config.yaml from massu.config.yaml.bak.
 *   --ci / --yes  Non-interactive; no prompts; detector wins on conflicts.
 *
 * Safety:
 *   - Writes .bak of the original before overwriting.
 *   - Atomic write via writeConfigAtomic (tmp + rename).
 *   - Idempotent: running on a schema_version=2 config is a no-op.
 *
 * Exit codes:
 *   0  success (migrated, rolled back, or already current)
 *   1  config missing / rollback source missing
 *   2  parse or write failure
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import { runDetection } from '../detect/index.ts';
import { computeFingerprint } from '../detect/drift.ts';
import { migrateV1ToV2, type AnyConfig } from '../detect/migrate.ts';
import { renderConfigYaml, writeConfigAtomic } from './init.ts';

export interface ConfigUpgradeOptions {
  rollback?: boolean;
  ci?: boolean;
  cwd?: string;
  silent?: boolean;
}

export interface ConfigUpgradeResult {
  exitCode: 0 | 1 | 2;
  action: 'migrated' | 'already-current' | 'rolled-back' | 'none';
  message?: string;
}

export async function runConfigUpgrade(opts: ConfigUpgradeOptions = {}): Promise<ConfigUpgradeResult> {
  const cwd = opts.cwd ?? process.cwd();
  const configPath = resolve(cwd, 'massu.config.yaml');
  const bakPath = `${configPath}.bak`;
  const log = opts.silent ? () => {} : (s: string) => process.stdout.write(s);
  const err = opts.silent ? () => {} : (s: string) => process.stderr.write(s);

  if (opts.rollback) {
    if (!existsSync(bakPath)) {
      const message = `No backup found at ${bakPath}`;
      err(message + '\n');
      return { exitCode: 1, action: 'none', message };
    }
    try {
      copyFileSync(bakPath, configPath);
      unlinkSync(bakPath);
      log('Config restored from backup.\n');
      return { exitCode: 0, action: 'rolled-back' };
    } catch (e) {
      const message = `Rollback failed: ${e instanceof Error ? e.message : String(e)}`;
      err(message + '\n');
      return { exitCode: 2, action: 'none', message };
    }
  }

  if (!existsSync(configPath)) {
    const message = 'massu.config.yaml not found. Run: npx massu init';
    err(message + '\n');
    return { exitCode: 1, action: 'none', message };
  }

  let existing: AnyConfig;
  try {
    const content = readFileSync(configPath, 'utf-8');
    const parsed = parseYaml(content);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('config is not a YAML object');
    }
    existing = parsed as AnyConfig;
  } catch (e) {
    const message = `Failed to parse massu.config.yaml: ${e instanceof Error ? e.message : String(e)}`;
    err(message + '\n');
    return { exitCode: 2, action: 'none', message };
  }

  const schemaVersion = existing.schema_version;
  if (schemaVersion === 2) {
    log('Config is already at schema_version=2; nothing to do.\n');
    return { exitCode: 0, action: 'already-current' };
  }

  const detection = await runDetection(cwd);
  const v2 = migrateV1ToV2(existing, detection);
  v2.detection = {
    ...(v2.detection as Record<string, unknown> | undefined ?? {}),
    fingerprint: computeFingerprint(detection),
  };

  // Back up original before any write.
  try {
    const original = readFileSync(configPath, 'utf-8');
    writeFileSync(bakPath, original, 'utf-8');
  } catch (e) {
    const message = `Failed to write backup: ${e instanceof Error ? e.message : String(e)}`;
    err(message + '\n');
    return { exitCode: 2, action: 'none', message };
  }

  const yamlContent = renderConfigYaml(v2);
  const writeRes = writeConfigAtomic(configPath, yamlContent);
  if (!writeRes.validated) {
    const message = `Failed to write upgraded config: ${writeRes.error}`;
    err(message + '\n');
    return { exitCode: 2, action: 'none', message };
  }

  // Non-interactive mode just proceeds; interactive mode currently has no
  // prompt on migrate (the migrator is deterministic and always user-preserving).
  // --ci / --yes remain accepted for script-pipeline safety.
  void opts.ci;

  log(`Config upgraded to schema_version=2. Backup saved at ${bakPath}\n`);
  return { exitCode: 0, action: 'migrated' };
}
