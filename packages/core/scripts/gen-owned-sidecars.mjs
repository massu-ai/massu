#!/usr/bin/env node
// Regenerate the integrity sidecar (<file>.sha256) for every MASSU-OWNED file.
//
// A massu-owned file (the verification laws) is force-delivered to consumers by the installer,
// which refuses to overwrite unless the source matches this sidecar. The sidecar therefore MUST be
// regenerated whenever the owned file changes — a stale sidecar would refuse a legitimate update.
// Running this at build time makes drift impossible: the shipped sidecar always matches the shipped
// file. `verify-owned-sidecars` (in the test suite) fails CI if they ever disagree.
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Keep in lockstep with MASSU_OWNED_PATHS in src/commands/install-commands.ts.
const OWNED = ['commands/_verification-laws.md'];

function canonicalize(content) {
  return content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .trim();
}

let wrote = 0;
for (const rel of OWNED) {
  const p = resolve(CORE, rel);
  if (!existsSync(p)) {
    console.error(`gen-owned-sidecars: MISSING owned file ${rel}`);
    process.exit(1);
  }
  const hash = createHash('sha256').update(canonicalize(readFileSync(p, 'utf-8'))).digest('hex');
  writeFileSync(`${p}.sha256`, hash + '\n');
  console.log(`  ${rel}.sha256 = ${hash}`);
  wrote++;
}
console.log(`gen-owned-sidecars: wrote ${wrote} sidecar(s).`);
