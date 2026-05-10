#!/usr/bin/env node
// Copies repo-root CHANGELOG.md into website/CHANGELOG.md so that the
// Next.js build (cwd === website/) can read the canonical changelog
// without relying on a path that climbs out of the build context.
//
// Path resolution uses __dirname (this script's location at <repo>/scripts/)
// so it works regardless of where npm invokes it from (Vercel, CI, manual).
// On Vercel CLI deploys that upload only website/, the parent CHANGELOG.md
// is unavailable — the script exits 0 with a notice so `npm run build`
// proceeds and the committed/cached website/CHANGELOG.md (or the
// version-less parser fallback) handles the render.

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const source = path.join(repoRoot, 'CHANGELOG.md');
const dest = path.join(repoRoot, 'website', 'CHANGELOG.md');

if (!fs.existsSync(source)) {
  console.log(`[copy-changelog] skip: source not found at ${source} (likely Vercel build context — using existing website/CHANGELOG.md)`);
  process.exit(0);
}

fs.copyFileSync(source, dest);
console.log(`[copy-changelog] copied ${source} -> ${dest}`);
