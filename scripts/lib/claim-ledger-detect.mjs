// CLAIM LEDGER — the detector. (CR-63)
//
// THE BUG CLASS
// -------------
// A plan was audited to ZERO gaps across six opus passes and still shipped two FALSE
// PREMISES, each one shell command from being caught:
//
//   1. "The knowledge graph is the ONLY store that isn't per-account."
//      The audit confirmed the knowledge-graph half (true). Nobody enumerated the
//      OTHER stores to test the word "only". Five more had the same defect — one of
//      them ten lines away, byte-identical. The fix as written closed 1 of 6 instances
//      of its own bug class.
//
//   2. "Run the seeder suite against the point-in-time corpus."
//      Not one seeder imports the corpus. `grep -l corpus <seeders>` returns nothing.
//      The milestone was mis-scoped as "run a script" when it was a multi-file build —
//      and as written would have rebuilt a learning system from hindsight-contaminated
//      data, looking successful the whole time.
//
// The audit verified that every file:line the plan CITED exists. It never ran a command
// to test whether the plan's claims about the WORLD were TRUE. Reading a plan cannot
// validate a universal quantifier or a capability assertion — only executing something
// can. Adversarial reviewers caught both instantly, not because they were smarter, but
// because they ran commands instead of reading assertions.
//
// THE DETECTOR MUST BE PRECISE, NOT BROAD
// ---------------------------------------
// A naive /only|all|every|never/ flags 145 lines in a single real plan. A guard that
// noisy gets switched off, and a switched-off guard is how this rots — which is exactly
// why there is NO exempt escape hatch. So we flag only sentences that are CLAIMS ABOUT
// THE STATE OF THE CODEBASE:
//
//   - a universal quantifier ANCHORED to a code entity (a backticked identifier, a
//     path, or a plural code noun: files/modules/callsites/stores/tables/functions…),
//   - or a capability assertion about a named code entity ("X reads Y", "X imports Y",
//     "run X against Y", "X already does W", "X supports Z").
//
// Design intent ("Massu may never overwrite a human file", "the renderer MUST refuse")
// is a REQUIREMENT, not a claim about current reality, and is not flagged: it is
// enforced by tests, not by a ledger.

/** A plural code noun — "every X", "all the X", "no other X" over these is a claim. */
const CODE_NOUNS =
  '(?:files?|modules?|callsites?|call sites?|stores?|tables?|columns?|functions?|methods?|' +
  'hooks?|scripts?|tests?|routes?|endpoints?|handlers?|commands?|packages?|repos?|' +
  'adapters?|seeders?|producers?|migrations?|records?|rows?|queries?|imports?|' +
  'consumers?|writers?|readers?|callers?|entry ?points?|instances?|occurrences?)';

/** Something that names a code entity: `backticked`, a path, or a dotted/snake symbol. */
const CODE_REF = '(?:`[^`]+`|[\\w./-]+\\.(?:ts|tsx|js|mjs|py|sh|sql|json|yaml|yml|md)\\b|\\b\\w+\\(\\))';

const UNIVERSAL = '(?:only|sole|solely|no other|nothing else|none of|every|all of|each of|always|never)';

/** Capability verbs: an assertion that some component DOES something today. */
const CAPABILITY_VERB =
  '(?:reads?|imports?|supports?|calls?|invokes?|uses?|consumes?|writes? to|already (?:does|has|is|supports)|' +
  'is wired|is enabled|is turned on|can (?:read|access|see|load|parse|reach))';

/**
 * Patterns that constitute a CLAIM ABOUT REALITY. Each must be verified by an executed
 * command, not by reading.
 */
const RULES = [
  {
    id: 'universal-over-code-entity',
    // "the ONLY store that…", "the only `foo.ts` that…", "no other module…"
    re: new RegExp(
      `\\b(?:the\\s+)?(?:only|sole|no other|nothing else)\\b[^.!?\\n]{0,80}?(?:${CODE_NOUNS}|${CODE_REF})`,
      'i',
    ),
    why: 'A universal claim ("only"/"sole"/"no other") about a code entity. Enumerate the WHOLE candidate set and show every other candidate fails the predicate. A spot-check of the one example the plan mentions is not evidence.',
  },
  {
    id: 'universal-quantifier-over-code-nouns',
    // "every module in the codebase", "all 6 stores", "none of the seeders"
    re: new RegExp(
      `\\b(?:every|all(?:\\s+\\d+)?(?:\\s+the)?|none of(?:\\s+the)?|each of(?:\\s+the)?)\\s+(?:\\w+\\s+){0,2}${CODE_NOUNS}\\b`,
      'i',
    ),
    why: 'A universal quantifier over a set of code entities. Enumerate the set with a command; do not assert it.',
  },
  {
    id: 'capability-assertion',
    // "the seeders read the corpus", "`x.ts` already supports Y", "run X against Y"
    re: new RegExp(
      `(?:${CODE_REF}|\\b${CODE_NOUNS})\\s+(?:\\w+\\s+){0,2}${CAPABILITY_VERB}\\b`,
      'i',
    ),
    why: 'A capability assertion — that some component DOES something today. Probe it (an import check, a call, a query returning rows). A docstring saying it does something is not evidence that it is wired up or turned on.',
  },
  {
    id: 'run-x-against-y',
    re: /\brun\s+(?:the\s+)?[\w./`-]+\s+(?:suite\s+)?against\s+(?:the\s+)?[\w./`-]+/i,
    why: 'A capability assertion in imperative clothing ("run X against Y") — it presumes X can reach Y. Prove the wiring exists before scoping the work as "run a script".',
  },
];

/**
 * REQUIREMENT MODALITY IS NOT A CLAIM ABOUT REALITY.
 *
 * "The renderer MUST refuse a non-local row" / "the transport WILL write to ~/.massu"
 * are SPECS for what the plan is about to build. They are enforced by TESTS, not by a
 * ledger — there is nothing to enumerate, because the thing does not exist yet.
 *
 * "The seeders READ the corpus" is an ASSERTION about the world today, and it was FALSE.
 * That is the difference this gate exists to catch, and it is exactly the indicative /
 * imperative split. Without this, a plan is pushed toward asserting its future components
 * exist — the opposite of what we want.
 */
const REQUIREMENT_MODALITY =
  /\b(?:must|shall|should|will|would|to be built|is to be|planned|proposed|acceptance)\b/i;

/**
 * Lines that are not claims about the codebase: headers, code fences, comments, specs.
 *
 * ⚠ THE HOLE THIS USED TO HAVE (found 2026-07-14, by an adversarial audit that RAN THE
 * DETECTOR instead of reading it):
 *
 *     if (t.startsWith('|')) return true;   // table row
 *     if (t.startsWith('>')) return true;   // blockquote
 *
 * **The gate could not see a claim written in a markdown table or a blockquote.** Same
 * sentence, both ways:
 *
 *     as prose      -> 1 claim detected
 *     as table cell -> 0 claims detected
 *
 * So ANY plan could pass Check 41 by putting its claims in a table — and one did: a
 * 482-line plan whose entire load-bearing content (a closures table, a dead-function
 * table, a tier table) lived in tables was certified GREEN while asserting things that
 * were false. **The anti-blind-gate gate was itself a blind gate**, and it was passed by
 * writing the claims where it could not look.
 *
 * The ledger's OWN rows must still be skipped — they are the evidence, not claims — but
 * that is a question of WHERE the row is (inside the `## CLAIM LEDGER` section), not of
 * whether it starts with a pipe. `inLedger` carries that.
 */
function isSkippable(line, inFence, inLedger) {
  if (inFence) return true;
  const t = line.trim();
  if (!t) return true;
  if (t.startsWith('#')) return true; // heading
  if (t.startsWith('//') || t.startsWith('--')) return true;
  // The ledger's own rows are EVIDENCE, not claims. Skip the section, not the syntax.
  if (inLedger) return true;
  if (/^\|[\s|:-]*\|?$/.test(t)) return true; // a table's ---|---|--- separator row
  // A requirement/spec, not an assertion about the world as it is today.
  if (REQUIREMENT_MODALITY.test(t)) return true;
  return false;
}

/**
 * Strip markdown containers so the claim TEXT inside them is scannable.
 * A claim does not stop being a claim because it is in a cell or a quote.
 */
function unwrap(line) {
  let t = line.trim();
  // Blockquote: peel any number of leading '>' markers.
  while (t.startsWith('>')) t = t.slice(1).trim();
  // Table row: the cells are the prose. Join them so a claim spanning a cell is seen.
  if (t.startsWith('|')) {
    t = t
      .split('|')
      .slice(1, -1) // drop the empty edges created by the leading/trailing pipes
      .join(' ')
      .trim();
  }
  return t;
}

/**
 * Scan plan markdown. Returns the flagged claims (deduped by line).
 * @param {string} text
 * @returns {{line: number, text: string, ruleId: string, why: string}[]}
 */
export function detectClaims(text) {
  const out = [];
  const lines = text.split('\n');
  let inFence = false;
  let inLedger = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    // Track the CLAIM LEDGER section: its rows are evidence, and a new heading ends it.
    if (/^##+[ \t]*CLAIM LEDGER[ \t]*\r?$/i.test(line)) {
      inLedger = true;
      continue;
    }
    if (inLedger && /^##+[ \t]+\S/.test(line)) inLedger = false;

    if (isSkippable(line, inFence, inLedger)) continue;

    const scannable = unwrap(line);
    if (!scannable) continue;

    for (const rule of RULES) {
      if (rule.re.test(scannable)) {
        out.push({ line: i + 1, text: scannable, ruleId: rule.id, why: rule.why });
        break; // one finding per line
      }
    }
  }
  return out;
}

/**
 * Parse the `## CLAIM LEDGER` table. A row COUNTS only when it carries a real
 * verification command AND pasted output AND a verdict — a ledger row with an empty
 * output column is decoration, and decoration is what this gate exists to prevent.
 */
export function parseLedger(text) {
  const rows = [];
  // Two explicit steps, not one clever regex. Both single-regex attempts were WRONG in
  // ways that made the gate UNPASSABLE — which is as useless as a gate nothing fails,
  // and would have been "fixed" by switching it off:
  //   1. `\Z` is a Python/PCRE escape, not JavaScript (in JS it is the literal 'Z').
  //   2. With the `m` flag, `$` matches END OF LINE — so a lazy capture terminated at
  //      the very first newline and the section was always empty.
  const lines = text.split('\n');
  const startIx = lines.findIndex((l) => /^##+[ \t]*CLAIM LEDGER[ \t]*\r?$/i.test(l));
  if (startIx === -1) return rows;

  /** Column roles, adopted from the header row. Null until a header is seen. */
  let colIx = null;

  let endIx = lines.length;
  for (let i = startIx + 1; i < lines.length; i++) {
    if (/^##[ \t]/.test(lines[i])) {
      endIx = i;
      break;
    }
  }
  const m = [null, lines.slice(startIx + 1, endIx).join('\n')];

  for (const line of m[1].split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    // Split on UNESCAPED pipes only. GitHub-flavored markdown requires `\|` inside a
    // table cell — even inside a code span — so a verification command containing a pipe
    // (`grep … | grep -v …`, a regex alternation, SQL) MUST be escaped. Splitting on a
    // raw `|` shredded exactly the commands most worth recording.
    const cells = t
      .split(/(?<!\\)\|/)
      .map((c) => c.trim().replace(/\\\|/g, '|'))
      .filter((c, ix, a) => !(ix === 0 || ix === a.length - 1));
    if (cells.length < 4) continue;

    // THE TABLE DECLARES ITS OWN SCHEMA; THE PARSER ASKS (2026-08-11).
    //
    // This used to be `const [claim, command, output, verdict] = cells` — a POSITIONAL
    // destructure behind a length FLOOR. Any table with an extra column (`#`, `Type`)
    // shifted every field one place: `verdict` read the OUTPUT cell, `command` read the
    // header text, and the header row itself was no longer recognised (the header check
    // tested cell[0], which was now `#` rather than `Claim`). MEASURED across the repo
    // before this fix: 99 of 490 parsed rows in 5 tracked plans were mis-mapped, and
    // `docs/plans/2026-07-22-windows-node-bootstrap-layer2.md` scored 0 of 22 rows
    // substantive — a full ledger of evidenced claims that validated NOTHING while
    // looking complete.
    //
    // Binding by HEADER NAME instead makes the extra column a non-event and makes a
    // genuinely malformed table LOUD (see below) rather than silently reinterpreted.
    // Written up 2026-08-11 in the internal incident log under the slug
    // `claim-ledger-parser-silently-mis-mapped-a-five-column-table`. No internal doc PATH is
    // cited here on purpose: this file is mirrored to the PUBLIC repo, where such a citation
    // leaks an internal filename and resolves to nothing.
    if (isSeparatorRow(cells)) continue;

    const asHeader = headerIndexes(cells);
    if (asHeader) {
      colIx = asHeader; // this row IS the header — adopt its mapping, emit nothing
      continue;
    }
    // NO HEADER SEEN YET. Fall back to the historical POSITIONAL reading, but ONLY for an
    // exactly-4-cell row — which is precisely the shape the positional form was always
    // correct for. This is deliberate: a header-only parser SILENTLY returned 0 rows for
    // two tracked plans whose header says "Verbatim output" (caught by re-measuring, not
    // by reading the diff — G10, a fix is a new instance of the defect until proven
    // otherwise). Dropping rows silently is the exact failure being repaired, so the
    // fallback guarantees this change can only ever ADD correctly-mapped rows.
    if (!colIx) {
      if (cells.length !== 4) continue; // unmappable: no header, non-canonical arity
      const [claim, command, output, verdict] = cells;
      if (/^claim/i.test(claim)) continue;
      rows.push({ claim, command, output, verdict });
      continue;
    }

    rows.push({
      claim: cells[colIx.claim] ?? '',
      command: cells[colIx.command] ?? '',
      output: cells[colIx.output] ?? '',
      verdict: cells[colIx.verdict] ?? '',
    });
  }
  return rows;
}

/** `|---|---|` and friends. */
function isSeparatorRow(cells) {
  return cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '');
}

/**
 * Map a candidate header row to column indexes, or `null` if it is not a header.
 *
 * Synonyms are taken from the shapes ALREADY IN USE in tracked plans (measured, not
 * imagined): "Claim (verbatim)", "Verification command", "Pasted output", "Verdict".
 * A row is only treated as a header when ALL FOUR required roles resolve — a partial
 * match is not a header, which keeps an ordinary data row from being swallowed.
 */
function headerIndexes(cells) {
  const norm = cells.map((c) => c.toLowerCase().replace(/\*\*/g, '').trim());
  const find = (re) => {
    const ix = norm.findIndex((c) => re.test(c));
    return ix === -1 ? null : ix;
  };
  // CONTAINS, not prefix. Measured shapes in tracked plans include "Claim (verbatim)",
  // "Verification command", "Pasted output" AND "Verbatim output" — a prefix match missed
  // the last one and silently yielded 0 rows for two plans.
  const claim = find(/\bclaim\b/);
  const command = find(/\bcommand\b|\bprobe\b/);
  const output = find(/\boutput\b|\bresult\b/);
  const verdict = find(/\bverdict\b/);
  if (claim === null || command === null || output === null || verdict === null) return null;
  if (new Set([claim, command, output, verdict]).size !== 4) return null; // ambiguous
  return { claim, command, output, verdict };
}

/** A ledger row is VALID only with a command, non-empty output, and a verdict. */
export function rowIsSubstantive(row) {
  const empty = (s) => !s || /^[-\u2013\u2014\s]*$/.test(s) || /^(tbd|todo|n\/a|pending)$/i.test(s);
  if (empty(row.command) || empty(row.output) || empty(row.verdict)) return false;
  return /(CONFIRMED|REFUTED)/i.test(row.verdict);
}

/**
 * A STANDING refuted claim fails the audit outright — the plan rests on a false premise.
 *
 * But "REFUTED" must also be RECORDABLE, or the gate makes its own best outcome
 * unspeakable: a premise disproven and then FIXED is the whole point of the exercise, and
 * a rule that fails you for documenting it teaches people to delete the evidence. So a
 * verdict of `REFUTED -> CORRECTED` / `-> FIXED` / `-> REWRITTEN` (the premise was
 * disproven AND the plan was changed) passes; a bare `REFUTED` (still standing) fails.
 */
export function refutedRows(rows) {
  return rows.filter((r) => {
    const v = (r.verdict || '').trim();
    if (!/REFUTED/i.test(v)) return false;
    // Resolved: the premise was disproven and the plan was rewritten.
    if (/(->|\u2192|then\b)[^.]{0,60}?\b(corrected|fixed|rewritten|removed|resolved|re-?scoped)\b/i.test(v)) {
      return false;
    }
    return true;
  });
}

/**
 * A flagged claim is COVERED when a substantive ledger row quotes it. Matching is on a
 * normalized substring so the ledger can quote the claim rather than the whole line.
 */
export function claimIsCovered(claim, rows) {
  const norm = (s) =>
    s
      .toLowerCase()
      // A pipe inside a ledger cell MUST be markdown-escaped (`\|`) or it splits the
      // table. Strip the escapes, or a correctly-written row can never match the claim
      // it quotes — and the gate becomes unpassable for exactly the claims (regex
      // alternations, SQL) most worth verifying.
      .replace(/\\([|`*_[\]()])/g, '$1')
      .replace(/[`*_[\]()"'\u201c\u201d\u2018\u2019]/g, '') // quotes: a ledger SHOULD quote the claim verbatim
      .replace(/\s+/g, ' ')
      .trim();
  const c = norm(claim.text);
  for (const r of rows) {
    if (!rowIsSubstantive(r)) continue;
    const rc = norm(r.claim);
    if (rc.length < 12) continue; // too vague to be a real quotation
    if (c.includes(rc) || rc.includes(c)) return true;
  }
  return false;
}
