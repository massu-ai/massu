#!/usr/bin/env node
// massu-plan-gate: plan | structure lint
// lint-plan-structure — mechanical defects in a plan's MARKUP, not its prose.
//
// WHY (G24/CR-87 — fix the INSTRUMENT). Three audit passes on one plan each had to
// hand-catch the same two classes with throwaway scripts. Measured 2026-09-20:
//   iteration 2: a repair put prose inside a table cell across 3 physical lines
//   iteration 3: the SAME class again (an unescaped `|` giving 4 cells in a 3-col table),
//                plus 3 NESTED HTML comments — comments do not nest, so audit prose and a
//                bare `-->` leaked into the rendered document and one swallowed a whole
//                risk-register cell.
// A class caught by hand three times is a class that needs a command.
//
// Reports its DENOMINATOR (M1). Fails closed on an unreadable plan (M2).
// Verdict vocabulary is CLOSED (G3).

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

function fail(m, c = 2) { console.error(`lint-plan-structure: ${m}`); process.exit(c); }
const arg = process.argv[2];
if (!arg) fail('usage: lint-plan-structure.mjs <plan.md> [--quiet]');
const QUIET = process.argv.includes('--quiet');
const p = resolve(process.cwd(), arg);
if (!existsSync(p)) fail(`plan not found: ${p}`);
let text; try { text = readFileSync(p, 'utf-8'); } catch (e) { fail(`unreadable: ${e.message}`); }

const lines = text.split('\n');
const findings = [];

// ---- CHECK 1: nested HTML comments -----------------------------------------
// `<!--` inside an open comment does not nest; the FIRST `-->` closes it and the
// remainder leaks into the rendered document.
{
  let depth = 0, openedAt = 0;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    let j = 0;
    while (j < L.length) {
      const o = L.indexOf('<!--', j), c = L.indexOf('-->', j);
      if (o === -1 && c === -1) break;
      if (o !== -1 && (c === -1 || o < c)) {
        if (depth > 0) findings.push({ kind: 'NESTED_COMMENT', line: i + 1, detail: `<!-- inside a comment opened at line ${openedAt}; the first --> closes it and the rest leaks` });
        else openedAt = i + 1;
        depth++; j = o + 4;
      } else { if (depth > 0) depth--; j = c + 3; }
    }
  }
  if (depth > 0) findings.push({ kind: 'UNCLOSED_COMMENT', line: openedAt, detail: 'comment opened and never closed' });
}

// ---- CHECK 2: markdown table column consistency ----------------------------
// Count cells by splitting on unescaped pipes, ignoring pipes inside `code spans`.
function cellCount(line) {
  let n = 1, inCode = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '`') { inCode = !inCode; continue; }
    if (ch === '|' && !inCode) n++;
  }
  const t = line.trim();
  if (t.startsWith('|')) n--;
  if (t.endsWith('|') && !t.endsWith('\\|')) n--;
  return n;
}
{
  let inFence = false, header = null, headerLine = 0, expect = 0;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i], t = L.trim();
    if (/^\s*(```|~~~)/.test(L)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const isRow = t.startsWith('|') && t.endsWith('|') && t.length > 2;
    if (!isRow) { header = null; continue; }
    if (header === null) { header = t; headerLine = i + 1; expect = cellCount(t); continue; }
    if (/^\|[\s:|-]+\|$/.test(t)) continue; // separator
    const got = cellCount(t);
    if (got !== expect) findings.push({ kind: 'TABLE_CELL_MISMATCH', line: i + 1, detail: `${got} cells, header at line ${headerLine} has ${expect}` });
  }
}

const tableRows = lines.filter((l) => { const t = l.trim(); return t.startsWith('|') && t.endsWith('|') && t.length > 2; }).length;
const comments = (text.match(/<!--/g) || []).length;
const denom = tableRows + comments;
if (denom === 0) fail(`DENOMINATOR 0 — ${arg} has no tables and no comments; nothing was linted. Not a pass.`, 3);

if (!QUIET) for (const f of findings) console.log(`${f.kind.padEnd(22)} plan:${String(f.line).padEnd(5)} ${f.detail}`);
console.log('----');
console.log(`PLAN:                 ${arg}`);
console.log(`TABLE ROWS SCANNED:   ${tableRows}`);
console.log(`COMMENTS SCANNED:     ${comments}`);
console.log(`DENOMINATOR:          ${denom}`);
console.log(`FINDINGS:             ${findings.length}`);
console.log(`RESULT: ${findings.length === 0 ? 'PASS' : 'FAIL'}`);
process.exit(findings.length === 0 ? 0 : 1);
