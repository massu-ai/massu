#!/usr/bin/env node
// AST / tokenizer symbol-presence checker — the comment-and-string-immune replacement for the
// T-3 symbol-greps (plan-2026-07-15-wave-1-g6-anti-vacuity-registry P3 / F5).
//
// THE BUG THIS KILLS: a scanner check that decides pass/fail with `grep -q "someSymbol" file`
// is satisfied by a COMMENT. The CR-54 incident: the tier gate was DELETED from production code,
// the identifier `assertAutoLearningEntitled` survived in a comment, and Check 30 reported
// "wiring intact." A naive comment-strip is NOT enough (the old gate-30 oracle stripped only
// line-leading `//`, so a trailing `// x` or block `/* x */` comment survived it). This checker
// recognises the symbol as REAL CODE:
//   • TypeScript/JS  → parse with the TypeScript compiler; comments are not AST nodes and
//                      identifiers inside string/template text are not Identifier nodes, so
//                      neither can satisfy the check. --kind call|import|reference|any.
//   • SQL / shell    → strip the language's comments AND string literals, then whole-word match
//                      the identifier in what REMAINS (real DDL / real shell code).
//
// Exit 0 = present (per --kind, and per --min-count if given). Exit 1 = absent. Exit 2 = ERROR
// (unreadable file / unknown extension / parse failure) — FAIL CLOSED, never a silent "absent".
//
// Usage:
//   node scripts/lib/ast-symbol-present.mjs --file F --symbol S [--kind reference] [--min-count N] [--count]
//     --kind: reference (default; any real code identifier) | call | import | any
//     --count:      print the number of code occurrences and exit 0
//     --min-count N: exit 0 iff occurrences >= N (else exit 1)

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const a = { kind: 'reference' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--file') a.file = argv[++i];
    else if (k === '--symbol') a.symbol = argv[++i];
    else if (k === '--kind') a.kind = argv[++i];
    else if (k === '--min-count') a.minCount = parseInt(argv[++i], 10);
    else if (k === '--count') a.printCount = true;
    else { console.error(`unknown arg: ${k}`); process.exit(2); }
  }
  if (!a.file || !a.symbol) { console.error('usage: --file F --symbol S [--kind] [--min-count N] [--count]'); process.exit(2); }
  return a;
}

function readOrDie(file) {
  try { return readFileSync(file, 'utf8'); }
  catch (e) { console.error(`FATAL: cannot read ${file}: ${e.message}`); process.exit(2); }
}

const TS_EXT = new Set(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs']);

// ── TypeScript / JS: real AST occurrence count for `symbol` per kind ─────────────────────────
function countTs(file, src, symbol, kind) {
  let ts;
  try { ts = require('typescript'); }
  catch (e) { console.error(`FATAL: typescript not resolvable: ${e.message}`); process.exit(2); }
  let sf;
  try {
    sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, /*setParentNodes*/ true,
      file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  } catch (e) { console.error(`FATAL: TS parse failed for ${file}: ${e.message}`); process.exit(2); }

  let count = 0;
  const visit = (node) => {
    if (kind === 'call') {
      if (ts.isCallExpression(node)) {
        const c = node.expression;
        if ((ts.isIdentifier(c) && c.text === symbol) ||
            (ts.isPropertyAccessExpression(c) && c.name.text === symbol)) count++;
      }
    } else if (kind === 'import') {
      if (ts.isImportSpecifier(node) && node.name.text === symbol) count++;
      else if (ts.isImportClause(node) && node.name && node.name.text === symbol) count++;
      else if (ts.isNamespaceImport(node) && node.name.text === symbol) count++;
    } else { // 'reference' | 'any' — any Identifier node with this name = a real code occurrence
      if (ts.isIdentifier(node) && node.text === symbol) count++;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return count;
}

// ── SQL: strip COMMENTS only, KEEP string literals ──────────────────────────────────────────
// In SQL migrations a `'value'` string is usually MEANINGFUL DATA — an enum/status/constraint
// value the check legitimately looks for (e.g. `approval_state IN ('rejected_hardened_required')`).
// Stripping strings would false-negative those. The real T-3 vector for SQL is a COMMENTED-OUT
// DDL line (`-- role_rank ...`), so we remove comments (string-aware: a `--` INSIDE a string is
// not a comment) and keep string contents. Whole-word match then sees real DDL identifiers AND
// real string values, but never a token that lives only in a comment.
function stripSql(src) {
  let out = '';
  let i = 0; const n = src.length; let inStr = false;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (inStr) {
      if (c === "'") { if (d === "'") { out += "''"; i += 2; continue; } inStr = false; }
      out += c; i++; continue;
    }
    if (c === "'") { inStr = true; out += c; i++; continue; }
    if (c === '-' && d === '-') { while (i < n && src[i] !== '\n') i++; out += ' '; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; out += ' '; continue; }
    out += c; i++;
  }
  return out;
}
function stripShell(src) {
  return src
    .replace(/'[^']*'/g, ' ')             // 'single' (no escapes inside)
    .replace(/"(?:[^"\\]|\\.)*"/g, ' ')   // "double"
    .replace(/(^|[^\\])#[^\n]*/g, '$1 '); // # comment (not an escaped \#)
}
function countTokens(stripped, symbol) {
  const re = new RegExp(`(?<![A-Za-z0-9_])${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'g');
  return (stripped.match(re) || []).length;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const src = readOrDie(a.file);
  const ext = (a.file.split('.').pop() || '').toLowerCase();
  let count;
  if (TS_EXT.has(ext)) count = countTs(a.file, src, a.symbol, a.kind);
  else if (ext === 'sql') count = countTokens(stripSql(src), a.symbol);
  else if (ext === 'sh' || ext === 'bash') count = countTokens(stripShell(src), a.symbol);
  else { console.error(`FATAL: unsupported extension .${ext} for ${a.file} — refusing to guess.`); process.exit(2); }

  if (a.printCount) { process.stdout.write(String(count) + '\n'); process.exit(0); }
  const threshold = Number.isInteger(a.minCount) ? a.minCount : 1;
  process.exit(count >= threshold ? 0 : 1);
}

main();
