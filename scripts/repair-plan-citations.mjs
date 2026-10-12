#!/usr/bin/env node
// NOT a `massu-plan-gate:` — deliberately. check-plan-gates.sh DISCOVERS gates by that
// marker in a file's header block, and a repair tool is not a gate: a gate ADJUDICATES
// and must never mutate the thing it judges. Declaring this one would have put a writer
// inside the runner's roster.
// repair-plan-citations — re-resolve a plan's drifted `path:line` citations against the tree.
//
// WHY THIS EXISTS (G24 — fix the instrument, not the symptom).
// `verify-plan-citations.mjs` says WHICH citations no longer resolve. Acting on that by hand
// is the part that does not converge: tonight a single commit shifted `config.ts` by +19
// lines and `install-commands.ts` by +23, invalidating 19 citation sites at once, and the
// two files moved by DIFFERENT amounts — so an offset is a guess (R-011). The only correct
// repair is to LOCATE THE SYMBOL and use where it actually is.
//
// ⛔ DRY-RUN BY DEFAULT (G12). `--apply` writes. `--list` prints the repairs and exits.
// Reports its DENOMINATOR every run and fails closed on an unreadable plan (M1/M2).
//
// ⛔ IT REPAIRS ONLY WHAT IT CAN PROVE. A citation is rewritten when the symbol occurs
// EXACTLY ONCE in the cited file — one occurrence localises a line, several do not, and a
// tool that picks among them is guessing. Everything else is REPORTED for a human, never
// silently "fixed": a repair tool that quietly invents an answer is worse than the drift.
//
// ⛔ IT NEVER TOUCHES AN ARCHIVED PLAN. A SHIPPED plan's citations describe the tree AS IT
// WAS; rewriting them to today's lines falsifies a historical record (see
// sweep-plan-citations.sh's scope note). Pass `--include-archived` to override deliberately.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const LIST = args.includes('--list');
const INCLUDE_ARCHIVED = args.includes('--include-archived');
const targets = args.filter((a) => !a.startsWith('--'));

const CITATION_RE = /`((?:[\w./-]+\/)?)([\w.-]+\.(?:ts|tsx|js|mjs|sh|py|json|yaml|yml|md)):(\d+)(?:-(\d+))?`/g;
const SYMBOL_RE = /`([A-Za-z_$][\w$]*)(?:\(\))?`/g;
const ARCHIVED_RE = /^\*\*Status\*\*:.*(SHIPPED|COMPLETE|IMPLEMENTED|DONE)/im;

function tracked() {
  return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf-8' })
    .split('\n')
    .filter(Boolean);
}
const TRACKED = tracked();

function resolveCited(rel) {
  if (existsSync(join(ROOT, rel))) return [rel];
  const base = basename(rel);
  return TRACKED.filter((f) => f === rel || f.endsWith('/' + rel) || basename(f) === base);
}

/** The single line a symbol occurs on, or null when 0 or >1 occurrences. */
function uniqueLineOf(absPath, symbol) {
  const lines = readFileSync(absPath, 'utf-8').split('\n');
  const rx = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  const hits = [];
  for (let i = 0; i < lines.length; i++) if (rx.test(lines[i])) hits.push(i + 1);
  return hits.length === 1 ? hits[0] : null;
}

function planFiles() {
  if (targets.length) return targets;
  const dir = join(ROOT, 'docs/plans');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join('docs/plans', f))
    .sort();
}

let scanned = 0;
let archivedSkipped = 0;
let repaired = 0;
let reported = 0;
const repairs = [];
const manual = [];

for (const rel of planFiles()) {
  const abs = join(ROOT, rel);
  let text;
  try {
    text = readFileSync(abs, 'utf-8');
  } catch (err) {
    console.error(`repair-plan-citations: UNREADABLE ${rel}: ${err.message}`);
    process.exit(2); // M2: fail closed
  }
  if (!INCLUDE_ARCHIVED && ARCHIVED_RE.test(text.slice(0, 4000))) {
    archivedSkipped++;
    continue;
  }
  scanned++;
  const lines = text.split('\n');
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const symbolHits = [...line.matchAll(SYMBOL_RE)].map((m) => ({ name: m[1], at: m.index ?? 0 }));
    for (const m of [...line.matchAll(CITATION_RE)]) {
      const [whole, dirPart, basePart, startS] = m;
      const relCited = ((dirPart || '') + basePart).replace(/^\.\//, '');
      const candidates = resolveCited(relCited);
      const start = Number(startS);
      // ⛔ IMMEDIATE ADJACENCY, NOT PROXIMITY — 30 chars, a quarter of the verifier's
      // window. A REWRITE is far more dangerous than a flag: a wrong flag costs attention,
      // a wrong rewrite FALSIFIES THE PLAN. Measured 2026-09-20 on this repo's own corpus,
      // the 120-char window produced a mix:
      //
      //   GENUINE   `getResolvedPaths()` (`config.ts:829`)      symbol 4 chars away,
      //             and the function really had moved to :878
      //   FALSE     | `scripts/hooks/pre-commit-gate.sh:46` ... | pre-commit `PreToolUse` gate |
      //             `PreToolUse` sits ~45 chars later describing a CONCEPT; :46 was
      //             CORRECT (it is the `npx tsc --noEmit` line) and the tool wanted to
      //             move it to :3, where the word happens to appear in a comment
      //
      // The discriminator is that a symbol the citation is ABOUT sits right beside it,
      // usually as `symbol` (`path:line`). A symbol elsewhere in a 1,500-char table row is
      // describing something else.
      const near = symbolHits.filter((h) => Math.abs(h.at - (m.index ?? 0)) <= 30).map((h) => h.name);

      if (candidates.length === 0) {
        manual.push(`${rel}:${i + 1}  FILE_MISSING     ${relCited}`);
        reported++;
        continue;
      }
      if (candidates.length > 1) {
        // Disambiguate ONLY when exactly one candidate contains a nearby symbol.
        const owning = candidates.filter((c) =>
          near.some((s) => uniqueLineOf(join(ROOT, c), s) !== null),
        );
        if (owning.length === 1) {
          const line2 = uniqueLineOf(join(ROOT, owning[0]), near.find((s) => uniqueLineOf(join(ROOT, owning[0]), s)));
          const replacement = `\`${owning[0]}:${line2}\``;
          repairs.push(`${rel}:${i + 1}  AMBIGUOUS -> ${whole} => ${replacement}`);
          lines[i] = lines[i].replace(whole, replacement);
          changed = true;
          repaired++;
        } else {
          manual.push(`${rel}:${i + 1}  AMBIGUOUS_PATH   ${relCited} -> ${candidates.length} candidates`);
          reported++;
        }
        continue;
      }
      // Single candidate: re-resolve the LINE if a nearby symbol pins one.
      const absCited = join(ROOT, candidates[0]);
      if (!existsSync(absCited)) continue;
      const total = readFileSync(absCited, 'utf-8').split('\n').length;
      let want = null;
      for (const s of near) {
        const at = uniqueLineOf(absCited, s);
        if (at !== null) { want = at; break; }
      }
      if (want === null) {
        if (start > total) { manual.push(`${rel}:${i + 1}  LINE_OUT_OF_RANGE ${relCited}:${start} (file has ${total})`); reported++; }
        continue;
      }
      if (Math.abs(want - start) <= 3) continue; // already resolves
      const replacement = `\`${candidates[0] === relCited ? relCited : candidates[0]}:${want}\``;
      repairs.push(`${rel}:${i + 1}  DRIFTED   ${whole} => ${replacement}`);
      lines[i] = lines[i].replace(whole, replacement);
      changed = true;
      repaired++;
    }
  }
  if (changed && APPLY) writeFileSync(abs, lines.join('\n'), 'utf-8');
}

if (scanned === 0) {
  console.error('repair-plan-citations: DENOMINATOR 0 — no in-flight plans. Refusing to report clean.');
  process.exit(2);
}

console.log(`plans scanned (denominator): ${scanned}   archived skipped: ${archivedSkipped}`);
console.log(`repairable (symbol pins exactly one line): ${repaired}`);
console.log(`needs a human: ${reported}`);
if (LIST || !APPLY) {
  for (const r of repairs) console.log(`  FIX   ${r}`);
}
for (const r of manual) console.log(`  MANUAL ${r}`);
console.log(APPLY ? 'APPLIED' : 'DRY RUN — pass --apply to write');
process.exit(0);
