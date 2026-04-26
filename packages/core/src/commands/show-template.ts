// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * `massu show-template <name>` — print the resolved variant of a template.
 *
 * Used by the local-edit-protection messaging to support a workflow like:
 *
 *   diff .claude/commands/massu-scaffold-router.md \
 *        <(npx massu show-template massu-scaffold-router)
 *
 * The resolved variant honors `pickVariant` against the consumer's current
 * `massu.config.yaml`. Exits 0 on success, 1 on unknown template.
 */

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { getConfig } from '../config.ts';
import { pickVariant, resolveAssetDir } from './install-commands.ts';

/** Strip an optional trailing `.md` extension. */
function normalizeBaseName(input: string): string {
  return input.endsWith('.md') ? input.slice(0, -'.md'.length) : input;
}

export async function runShowTemplate(args: string[]): Promise<void> {
  const rawName = args[0];
  if (!rawName) {
    process.stderr.write('massu: show-template requires a template name\n');
    process.stderr.write('  usage: massu show-template <name>\n');
    process.exit(1);
    return;
  }

  const baseName = normalizeBaseName(rawName);
  const sourceDir = resolveAssetDir('commands');
  if (!sourceDir) {
    process.stderr.write('massu: could not locate the bundled commands directory\n');
    process.exit(1);
    return;
  }

  const framework = getConfig().framework;
  const choice = pickVariant(baseName, sourceDir, framework);

  if (choice.kind === 'miss') {
    process.stderr.write(`massu: no template named "${baseName}" found\n`);
    process.exit(1);
    return;
  }

  const suffix = choice.kind === 'hit' ? choice.suffix : '';
  const file = suffix === ''
    ? resolve(sourceDir, `${baseName}.md`)
    : resolve(sourceDir, `${baseName}${suffix}.md`);

  if (!existsSync(file)) {
    // Defensive: pickVariant said hit but the file isn't there.
    process.stderr.write(`massu: resolved template "${file}" no longer exists\n`);
    process.exit(1);
    return;
  }

  process.stdout.write(readFileSync(file, 'utf-8'));
}
