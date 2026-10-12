// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * `massu show-template <name>` — print the RESOLVED, RENDERED variant of a template.
 *
 * It exists to be the right-hand side of the diff the installer itself recommends when it
 * finds a locally-edited asset (`install-commands.ts`, the local-edit-protection message):
 *
 *   diff .claude/commands/massu-scaffold-router.md \
 *        <(npx massu show-template massu-scaffold-router)
 *
 * ⛔ THE WORD THAT WAS MISSING IS "RENDERED", AND IT COST THE WHOLE FEATURE.
 *
 * This command used to `readFileSync` the bundled file and print it. The installer writes
 * RENDERED bytes. Measured 2026-09-21: 43 of the 67 shipped commands carry 305 `{{…}}`
 * tokens, so for two thirds of the catalogue that diff reported hundreds of differences on a
 * file the user had never touched — and the user's reasonable conclusion is that
 * local-edit protection is noise.
 *
 * Nothing failed. Both sides produced a file; only one of them was the file being discussed.
 *
 * The fix is not "also render here": that would be a SECOND derivation of the resolved asset,
 * which is what went wrong in the first place. Both this command and the installer now call
 * `renderResolvedAsset`, so a render stage added later cannot reach one and miss the other.
 * `asset-render-parity.test.ts` holds that property over the whole shipped population.
 */

import { getConfig } from '../config.ts';
import { resolveAssetDir } from './asset-resolution.ts';
import { makeRenderContext, renderResolvedAsset } from './asset-render.ts';

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
  const rendered = renderResolvedAsset(
    baseName,
    sourceDir,
    framework,
    makeRenderContext(framework),
  );

  if (rendered.kind === 'miss') {
    process.stderr.write(`massu: no template named "${baseName}" found\n`);
    process.exit(1);
    return;
  }

  if (rendered.kind === 'error') {
    // ⛔ A TEMPLATE THAT WILL NOT RENDER MUST SAY SO ON stderr AND EXIT NON-ZERO.
    //
    // Printing the raw file here would be the tempting "graceful" fallback and it is the
    // original bug wearing an apology: the user would receive bytes that are not what the
    // installer writes, with no signal that they are looking at something else. The install
    // skips this asset too, so "it does not render" is the honest and useful answer.
    process.stderr.write(
      `massu: template "${baseName}" could not be rendered: ${rendered.message}\n`,
    );
    process.exit(1);
    return;
  }

  process.stdout.write(rendered.content);
}
