#!/usr/bin/env node
// npm dependency audit gate with per-advisory, dated, reasoned exemptions.
//
// ⛔ WHY THIS EXISTS. `npm audit --audit-level=info` is all-or-nothing: npm has no
// `--ignore-advisory`. On 2026-10-11 GHSA-vfj7-8cjw-p6xm (braces, high, published 2026-09-18)
// covered EVERY braces release (`<= 3.0.3`, first_patched_version null; 3.0.3 is the newest
// braces on npm) — so the plain step could never pass again, on any branch, whatever anyone did.
// The only levers npm offers are to raise the threshold (stop watching a whole severity band)
// or delete the step. Both are a dead gate. This replaces the step with the mechanism npm lacks:
// enumerate EVERY advisory at every severity, and subtract only those a human exempted BY ID,
// per lockfile, WITH a reason, a reachability statement, and an expiry.
//
// ⛔ BORROWED, NOT INVENTED. The design ports an existing Python npm-audit gate written for the
// same advisory on the same day, which is itself the expiring-exception pattern of audit-ci's
// allowlist `expiry` and better-npm-audit's `.nsprc` `expiry`. Built here: a Node port (this
// repo's CI has no PyYAML), a REQUIRED `reachability` field, surfaces passed explicitly so the
// public mirror (no website/) can run the same gate, and a test seam (`--audit-json`).
//
// BLIND-GATE DEFENCES (this file is a gate, so it is held to M1/M2/G3):
//   M1  prints its DENOMINATOR every run — per surface: advisories examined, exempted, blocking.
//   M2  fails CLOSED (exit 2): npm could not run, empty stdout, unparseable JSON, an `error`
//       object, no `auditReportVersion`, an unreadable exemptions file. `npm audit` exits non-zero
//       merely because findings exist, so its exit code cannot tell "found" from "did not run" —
//       the payload is what is trusted, never the status.
//   M1' TOTALS vs DETAILS: if npm's own metadata counts findings but enumeration produced none,
//       the `via` schema moved underneath this parser; a clean verdict would be a lie -> exit 2.
//   G3  CLOSED VOCABULARY: an unknown key, a missing field, an empty reason/reachability, a bad
//       date, a duplicate, or an expiry not after `added` is an ERROR, never a quietly skipped row.
//   STALE: an exemption for an AUDITED surface that matches no live advisory FAILS — a stale row
//       silently widens the gate the day its advisory returns. EXPIRED rows stop suppressing.
//
// Exit codes: 0 clean (after exemptions) | 1 blocking advisory / expired / stale / invalid row
//             | 2 could not look. Never conflated.
//
// Usage:
//   node scripts/npm-audit-gate.mjs                       # surfaces: . and website
//   node scripts/npm-audit-gate.mjs --surface .           # public mirror (no website/)
//   node scripts/npm-audit-gate.mjs --audit-json website=fixture.json   # test seam: no npm call
//   options: --exemptions <file>  --today YYYY-MM-DD

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_EXEMPTIONS = join(REPO, 'scripts', 'npm-audit-exemptions.json');
const DEFAULT_SURFACES = ['.', 'website'];

export const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
const REQUIRED_KEYS = ['advisory', 'package', 'surface', 'severity', 'reason', 'reachability', 'added', 'expires'];
const ALLOWED_KEYS = new Set(REQUIRED_KEYS);
const GHSA_RE = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class CouldNotLook extends Error {}

function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  // Round-trip guards against 2026-02-31 silently becoming March 3rd.
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
}

/** Validate one audit payload's envelope. Throws CouldNotLook on anything not a real report. */
export function assertAuditPayload(payload, surface) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new CouldNotLook(`${surface}: audit payload is not an object`);
  }
  if ('error' in payload) {
    throw new CouldNotLook(`${surface}: npm reported an error: ${JSON.stringify(payload.error).slice(0, 400)}`);
  }
  if (!('auditReportVersion' in payload)) {
    throw new CouldNotLook(`${surface}: audit payload has no auditReportVersion — refusing to judge an unknown schema`);
  }
}

/** Flatten npm's package-keyed report into one row per (advisory, package). */
export function enumerateAdvisories(payload, surface) {
  const rows = new Map();
  for (const [pkgName, entry] of Object.entries(payload.vulnerabilities ?? {})) {
    for (const item of entry?.via ?? []) {
      // A bare string is an edge ("vulnerable because of X"); X appears in its own right.
      if (typeof item === 'string') continue;
      if (item === null || typeof item !== 'object') {
        throw new CouldNotLook(`${surface}: via entry for ${pkgName} is ${typeof item}, expected object or string`);
      }
      const m = GHSA_RE.exec(String(item.url ?? ''));
      const advisory = m ? m[0] : `npm-source:${item.source}`;
      const pkg = item.name ?? pkgName;
      rows.set(`${advisory}\u0000${pkg}`, {
        advisory,
        package: pkg,
        severity: item.severity ?? entry.severity ?? 'unknown',
        title: String(item.title ?? ''),
        surface,
      });
    }
  }
  return [...rows.keys()].sort().map((k) => rows.get(k));
}

/** npm's own totals vs what was enumerated. A counted-but-unenumerated finding = schema drift. */
export function assertTotalsAgree(payload, found, surface) {
  const meta = payload?.metadata?.vulnerabilities;
  if (meta === null || typeof meta !== 'object') {
    throw new CouldNotLook(`${surface}: metadata.vulnerabilities is missing`);
  }
  if (typeof meta.total !== 'number') {
    throw new CouldNotLook(`${surface}: metadata.vulnerabilities.total is missing`);
  }
  if (meta.total > 0 && found.length === 0) {
    throw new CouldNotLook(
      `${surface}: npm counts ${meta.total} vulnerable package(s) but enumeration produced ZERO advisories — ` +
        `the via schema moved under this parser, and a clean verdict here would be a lie`,
    );
  }
}

/** Structural problems in the exemptions oracle (closed vocabulary). */
export function validateExemptions(rows) {
  const problems = [];
  const seen = new Set();
  rows.forEach((row, i) => {
    const where = `exemptions[${i}]`;
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      problems.push(`${where}: not an object`);
      return;
    }
    const unknown = Object.keys(row).filter((k) => !ALLOWED_KEYS.has(k));
    if (unknown.length) problems.push(`${where}: unknown key(s) ${unknown.join(', ')} — a typo'd key must never read as valid`);
    const missing = REQUIRED_KEYS.filter((k) => !(k in row));
    if (missing.length) {
      problems.push(`${where}: missing required key(s) ${missing.join(', ')}`);
      return;
    }
    if (!GHSA_RE.test(String(row.advisory)) && !/^npm-source:\d+$/.test(String(row.advisory))) {
      problems.push(`${where}: advisory ${JSON.stringify(row.advisory)} is not a GHSA id (or npm-source:<n>)`);
    }
    for (const k of ['package', 'surface', 'reason', 'reachability']) {
      if (typeof row[k] !== 'string' || !row[k].trim()) problems.push(`${where}: \`${k}\` is empty — an exemption without it is a hole`);
    }
    if (!SEVERITIES.includes(row.severity)) problems.push(`${where}: severity ${JSON.stringify(row.severity)} is not one of ${SEVERITIES.join('|')}`);
    const added = parseDate(row.added);
    const expires = parseDate(row.expires);
    if (!added) problems.push(`${where}: \`added\` must be a real YYYY-MM-DD date, got ${JSON.stringify(row.added)}`);
    if (!expires) problems.push(`${where}: \`expires\` must be a real YYYY-MM-DD date, got ${JSON.stringify(row.expires)}`);
    if (added && expires && expires <= added) problems.push(`${where}: \`expires\` (${expires}) must be after \`added\` (${added})`);
    const key = `${row.advisory}\u0000${row.package}\u0000${row.surface}`;
    if (seen.has(key)) problems.push(`${where}: duplicate exemption for ${row.advisory} / ${row.package} / ${row.surface}`);
    seen.add(key);
  });
  return problems;
}

/**
 * Pure decision core. `audits` maps surface -> raw npm audit payload. Returns
 * { code, lines } — the gate's verdict and every line it would print.
 */
export function evaluateNpmAudit({ audits, exemptions, today }) {
  const lines = [];
  const surfaces = Object.keys(audits);
  if (surfaces.length === 0) throw new CouldNotLook('no surface was audited — a gate that scanned nothing never reports clean');

  const problems = validateExemptions(exemptions);
  if (problems.length) {
    lines.push('EXEMPTION FILE INVALID:', ...problems.map((p) => `  - ${p}`));
    return { code: 1, lines };
  }

  const index = new Map(exemptions.map((r) => [`${r.advisory}\u0000${r.package}\u0000${r.surface}`, r]));
  const used = new Set();
  const blocking = [];
  const expired = [];
  const exempted = [];
  let examined = 0;

  for (const surface of surfaces) {
    const payload = audits[surface];
    assertAuditPayload(payload, surface);
    const found = enumerateAdvisories(payload, surface);
    assertTotalsAgree(payload, found, surface);
    examined += found.length;
    const surfaceBlocking = [];
    for (const row of found) {
      const key = `${row.advisory}\u0000${row.package}\u0000${surface}`;
      const ex = index.get(key);
      if (!ex) {
        surfaceBlocking.push(row);
        continue;
      }
      used.add(key);
      if (ex.expires < today) {
        expired.push(`${row.advisory} (${row.package}, ${surface}) — exemption EXPIRED ${ex.expires}`);
        surfaceBlocking.push(row);
      } else {
        exempted.push(`${row.advisory} (${row.package}, ${surface}) until ${ex.expires}`);
      }
    }
    lines.push(
      `── npm audit: surface=${surface} advisories_examined=${found.length} ` +
        `exempted=${found.length - surfaceBlocking.length} blocking=${surfaceBlocking.length}`,
    );
    for (const r of surfaceBlocking) lines.push(`     ${r.severity.toUpperCase().padEnd(8)} ${r.advisory}  ${r.package}  ${r.title.slice(0, 80)}`);
    blocking.push(...surfaceBlocking);
  }

  // Stale = declared for a surface that WAS audited this run, yet matched nothing. A row for a
  // surface not audited (the public mirror has no website/) is out of scope, not stale.
  const inScope = [...index.entries()].filter(([, r]) => surfaces.includes(r.surface));
  const stale = inScope.filter(([k]) => !used.has(k)).map(([, r]) => `${r.advisory} (${r.package}, ${r.surface})`);

  lines.push(
    '',
    `DENOMINATOR: surfaces=${surfaces.length} [${surfaces.join(', ')}] advisories_examined=${examined} floor=info ` +
      `exemptions_declared=${index.size} in_scope=${inScope.length} used=${used.size} ` +
      `blocking=${blocking.length} expired=${expired.length} stale=${stale.length}`,
  );
  if (exempted.length) lines.push('EXEMPTED (each carries a reason, a reachability statement and an expiry):', ...exempted.map((l) => `  - ${l}`));

  let code = 0;
  if (expired.length) {
    lines.push('', 'EXPIRED EXEMPTIONS — they no longer suppress anything:', ...expired.map((l) => `  - ${l}`));
    code = 1;
  }
  if (stale.length) {
    lines.push('', 'STALE EXEMPTIONS — they match no live advisory and must be deleted:', ...stale.map((l) => `  - ${l}`));
    code = 1;
  }
  if (blocking.length) {
    lines.push(
      '',
      `FAIL: ${blocking.length} blocking npm advisory(ies) (floor=info, every severity).`,
      '  Fix them (npm audit fix, or a proper upgrade). Exempt ONLY when no fix exists upstream,',
      '  with advisory + package + surface + reason + reachability + expiry, in scripts/npm-audit-exemptions.json.',
    );
    code = 1;
  }
  if (code === 0) lines.push(`PASS: no un-exempted npm advisory at any severity on ${surfaces.length} surface(s) (${used.size} exemption(s) applied)`);
  return { code, lines };
}

function runNpmAudit(surface) {
  const cwd = resolve(REPO, surface);
  if (!existsSync(join(cwd, 'package-lock.json'))) {
    throw new CouldNotLook(`${surface}: no package-lock.json at ${cwd}`);
  }
  const proc = spawnSync('npm', ['audit', '--json'], { cwd, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
  if (proc.error) throw new CouldNotLook(`${surface}: could not run npm audit: ${proc.error.message}`);
  if (!proc.stdout || !proc.stdout.trim()) {
    throw new CouldNotLook(`${surface}: npm audit --json produced no stdout (exit ${proc.status}); stderr: ${String(proc.stderr).slice(0, 400)}`);
  }
  try {
    return JSON.parse(proc.stdout);
  } catch (e) {
    throw new CouldNotLook(`${surface}: npm audit --json emitted unparseable JSON: ${e.message}`);
  }
}

function readJson(path, what) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new CouldNotLook(`${what} unreadable: ${path}: ${e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CouldNotLook(`${what} is not valid JSON: ${path}: ${e.message}`);
  }
}

export function loadExemptions(path) {
  const doc = readJson(path, 'exemptions file');
  if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.exemptions)) {
    throw new CouldNotLook(`${path}: expected an object with an \`exemptions\` array (use [] for none — an absent oracle is not an empty one)`);
  }
  return doc.exemptions;
}

function parseArgs(argv) {
  const out = { surfaces: [], auditJson: {}, exemptions: DEFAULT_EXEMPTIONS, today: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new CouldNotLook(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--surface') out.surfaces.push(next());
    else if (a === '--exemptions') out.exemptions = resolve(next());
    else if (a === '--today') out.today = next();
    else if (a === '--audit-json') {
      const v = next();
      const eq = v.indexOf('=');
      if (eq < 1) throw new CouldNotLook(`--audit-json wants <surface>=<file>, got ${v}`);
      out.auditJson[v.slice(0, eq)] = resolve(v.slice(eq + 1));
    } else throw new CouldNotLook(`unknown argument ${a}`);
  }
  return out;
}

function main(argv) {
  try {
    const args = parseArgs(argv);
    const today = args.today ?? new Date().toISOString().slice(0, 10);
    if (!parseDate(today)) throw new CouldNotLook(`--today ${today} is not a YYYY-MM-DD date`);
    let surfaces = args.surfaces;
    if (surfaces.length === 0) surfaces = Object.keys(args.auditJson).length ? Object.keys(args.auditJson) : DEFAULT_SURFACES;
    const exemptions = loadExemptions(args.exemptions);
    const audits = {};
    for (const s of surfaces) {
      audits[s] = s in args.auditJson ? readJson(args.auditJson[s], `audit fixture for ${s}`) : runNpmAudit(s);
    }
    const { code, lines } = evaluateNpmAudit({ audits, exemptions, today });
    for (const l of lines) console.log(l);
    return code;
  } catch (e) {
    if (e instanceof CouldNotLook) {
      console.error(`NPM AUDIT GATE: COULD NOT LOOK — ${e.message}`);
      return 2;
    }
    throw e;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // exitCode, not exit(): stdout to a pipe is async in Node, and exit() can truncate the report.
  process.exitCode = main(process.argv.slice(2));
}
