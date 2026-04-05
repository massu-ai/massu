// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * npm postinstall hook — auto-runs `massu init` in the consumer's project root.
 *
 * Uses INIT_CWD (set by npm/yarn/pnpm to the directory where `npm install`
 * was invoked) so init targets the project, not node_modules/@massu/core/.
 *
 * Fails silently — postinstall must never break `npm install`.
 */

import { execSync } from 'child_process';
import { resolve } from 'path';
import { existsSync } from 'fs';

const projectRoot = process.env.INIT_CWD;

if (!projectRoot) {
  // Not running inside an npm lifecycle — skip silently
  process.exit(0);
}

// Don't run during massu's own development (monorepo self-install)
const isSelfInstall = projectRoot.includes('massu/packages/');
if (isSelfInstall) {
  process.exit(0);
}

// Don't run if there's no package.json (e.g., global install)
if (!existsSync(resolve(projectRoot, 'package.json'))) {
  process.exit(0);
}

try {
  // Use the CLI we just installed — it's in the same dist/ directory
  const cliPath = resolve(__dirname, 'cli.js');
  execSync(`node ${cliPath} init`, {
    cwd: projectRoot,
    stdio: 'inherit',
    timeout: 30_000,
  });
} catch {
  // Postinstall must never fail the install — swallow all errors
  process.exit(0);
}
