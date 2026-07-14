#!/usr/bin/env node
/**
 * MANIFEST QUARANTINE — retroactively un-tell the lies the fail-open already recorded.
 *
 * WHY THIS EXISTS
 * ---------------
 * The installer used to record the hash of a file it did NOT write (the first-install ambiguity
 * branch). That made the manifest claim "massu authored this" about the operator's own work. The
 * fail-open is now fixed (install-commands.ts) — but the fix only stops NEW lies. It cannot
 * un-tell one already written, and a poisoned entry is a standing authorisation to overwrite.
 *
 * Verified on the real repos, real installer, two runs, scratch copies:
 *     repos with no prior manifest                                ->  0 files altered (safe)
 *     one repo with an existing manifest                          -> 31 files altered (NOT safe)
 *
 * WHAT COUNTS AS A LIE — and why we do NOT try to compute it
 * ---------------------------------------------------------
 * The tempting test is "does the recorded hash match some published version of this file?" It is
 * wrong, and it is wrong in the dangerous direction. The bytes the installer writes are NOT the
 * package's bytes: it resolves a VARIANT (a `swift:` block in the repo's config makes `massu-scaffold-page.md`
 * resolve to `massu-scaffold-page.swift.md`) and then RENDERS TEMPLATES (106 `{{...}}`
 * substitutions across 9 shipped files). So the installed bytes are a function of the repo's
 * massu.config.yaml, and any re-derivation of them here would be a second implementation of the
 * installer — which is precisely how the git and npm filters drifted apart, and how every prior
 * version of the command-sync plan failed.
 *
 * So we do not re-derive anything. WE ASK THE INSTALLER.
 *
 * THE ORACLE
 * ----------
 *   1. Copy the repo's .claude/ to a scratch dir.
 *   2. Run the REAL installer against it, once.
 *   3. Every file it CHANGED is a file whose manifest entry authorises an overwrite.
 *   4. Drop those entries from the real manifest.
 *
 * After that the installer can no longer prove it wrote those files, so it falls into the (now
 * fail-closed) ambiguity branch and KEEPS them — on every run, forever.
 *
 * THE DELIBERATE COST, stated rather than hidden
 * ---------------------------------------------
 * This over-quarantines. A file massu genuinely wrote at an older version, that nobody has
 * touched, ALSO loses its entry and stops auto-upgrading. It freezes: safe, but stale.
 *
 * That is the correct trade today, and not only on principle: the 31 changed files in the affected repo are not
 * 31 destructions. Exactly ONE is a poisoned entry. The other 30 are the installer working
 * CORRECTLY — faithfully delivering an upstream that `8fff05d` gutted. A "successful" install on
 * the consumer repo right now removes 803 lines and added 638 — a net LOSS of 165 lines. Freezing those 30
 * is not collateral damage; it is the desired outcome until upstream is repaired.
 *
 * Un-freezing later is explicit and per-file: repair upstream, then `rm <file> && massu
 * install-commands` for each file you have NOT customized — or wait for the three-way merge.
 *
 * NOTHING IS WRITTEN WITHOUT --apply. Default is a dry run.
 *
 * Usage:
 *   node scripts/quarantine-poisoned-manifest.mjs --repo ~/the consumer repo            # dry run (default)
 *   node scripts/quarantine-poisoned-manifest.mjs --repo ~/the consumer repo --apply    # write it
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';

const args = process.argv.slice(2);
const repoIdx = args.indexOf('--repo');
if (repoIdx === -1 || !args[repoIdx + 1]) {
  console.error('usage: quarantine-poisoned-manifest.mjs --repo <path> [--apply]');
  process.exit(2);
}
const REPO = resolve(args[repoIdx + 1].replace(/^~/, process.env.HOME));
const APPLY = args.includes('--apply');

const CLI = resolve(new URL('.', import.meta.url).pathname, '../packages/core/dist/cli.js');
const MANIFEST = join(REPO, '.claude', '.massu', 'install-manifest.json');

// ── FAIL CLOSED ──────────────────────────────────────────────────────────────────────────────
if (!existsSync(CLI)) {
  console.error(`FATAL: installer not built at ${CLI}. Run: (cd packages/core && npm run build)`);
  console.error('  Refusing to quarantine without the oracle. A guess here corrupts the manifest.');
  process.exit(2);
}
if (!existsSync(MANIFEST)) {
  console.log(`${REPO}: no install-manifest.json — nothing to quarantine (and nothing at risk).`);
  process.exit(0);
}

function sha(p) { return createHash('sha256').update(readFileSync(p)).digest('hex'); }

function snapshot(dir) {
  const out = new Map();
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (e.endsWith('.md')) out.set(relative(dir, p), sha(p));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

// ── THE ORACLE: run the REAL installer on a scratch copy and see what it would touch ──────────
const scratch = mkdtempSync(join(tmpdir(), 'massu-quarantine-'));
try {
  cpSync(join(REPO, '.claude'), join(scratch, '.claude'), { recursive: true });
  const cfg = join(REPO, 'massu.config.yaml');
  if (existsSync(cfg)) cpSync(cfg, join(scratch, 'massu.config.yaml'));
  // Point the scratch repo at THIS build of massu, so the oracle is the installer we ship.
  //
  // SYMLINK, not a copy. Copying packages/core leaves its runtime dependencies behind (better-
  // sqlite3, yaml, zod, …) — they live in massu-internal's node_modules, one level up — and the
  // CLI dies with ERR_MODULE_NOT_FOUND. A symlink resolves them naturally.
  mkdirSync(join(scratch, 'node_modules', '@massu'), { recursive: true });
  symlinkSync(resolve(CLI, '../..'), join(scratch, 'node_modules', '@massu', 'core'), 'dir');

  const cmdDir = join(scratch, '.claude', 'commands');
  const before = snapshot(cmdDir);

  try {
    execFileSync('node', [join(scratch, 'node_modules', '@massu', 'core', 'dist', 'cli.js'), 'install-commands'],
      { cwd: scratch, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    // FAIL CLOSED. If the oracle cannot run, we do not know what the installer would do — and a
    // guess here corrupts the manifest. Never quietly proceed to "found nothing to quarantine".
    console.error('FATAL: the oracle (real installer) failed to run on the scratch copy.');
    console.error(String(e.stderr ?? e.message).split('\n').slice(0, 6).join('\n'));
    console.error('Refusing to quarantine. "I could not look" is not "there is nothing there".');
    process.exit(2);
  }

  const after = snapshot(cmdDir);

  // Anti-vacuity: if the oracle saw no files at all, it proved nothing. Refuse.
  if (before.size < 10) {
    console.error(`FATAL: the oracle scanned only ${before.size} file(s). It is blind. Refusing.`);
    process.exit(2);
  }

  const overwritten = [];
  for (const [rel, h] of before) {
    if (after.has(rel) && after.get(rel) !== h) overwritten.push(rel);
  }

  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf-8'));
  const toDrop = overwritten
    .map((rel) => `commands/${rel}`)
    .filter((k) => k in manifest.entries);

  console.log(`repo:              ${REPO}`);
  console.log(`command files:     ${before.size}`);
  console.log(`manifest entries:  ${Object.keys(manifest.entries).length}`);
  console.log('');
  console.log(`The installer WOULD OVERWRITE ${overwritten.length} file(s).`);
  console.log(`Of those, ${toDrop.length} are authorised by a manifest entry — these are the standing`);
  console.log('authorisations to destroy. Quarantining them makes the installer keep the files instead.');
  console.log('');
  for (const k of toDrop) console.log(`   drop  ${k}`);

  if (!toDrop.length) {
    console.log('\nNothing to quarantine. This repo is already safe against the install path.');
    process.exit(0);
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to quarantine.');
    process.exit(0);
  }

  // Back it up before touching it. Prove-before-you-destroy.
  const backup = `${MANIFEST}.pre-quarantine.${Date.now()}.json`;
  writeFileSync(backup, readFileSync(MANIFEST));
  for (const k of toDrop) delete manifest.entries[k];
  manifest.quarantinedAt = new Date().toISOString();
  manifest.quarantineNote =
    'Entries removed because they authorised the installer to overwrite a file it could not ' +
    'prove it wrote. See scripts/quarantine-poisoned-manifest.mjs.';
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`\nAPPLIED. ${toDrop.length} entries dropped.`);
  console.log(`  backup: ${backup}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
