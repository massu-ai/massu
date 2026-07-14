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

/** Lines that are not claims about the codebase: headers, quotes, code, ledger rows. */
function isSkippable(line, inFence) {
  if (inFence) return true;
  const t = line.trim();
  if (!t) return true;
  if (t.startsWith('#')) return true; // heading
  if (t.startsWith('>')) return true; // blockquote (incident narration)
  if (t.startsWith('|')) return true; // table row (incl. the ledger itself)
  if (t.startsWith('//') || t.startsWith('--')) return true;
  // A requirement/spec, not an assertion about the world as it is today.
  if (REQUIREMENT_MODALITY.test(t)) return true;
  return false;
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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (isSkippable(line, inFence)) continue;

    for (const rule of RULES) {
      if (rule.re.test(line)) {
        out.push({ line: i + 1, text: line.trim(), ruleId: rule.id, why: rule.why });
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
    const [claim, command, output, verdict] = cells;
    if (/^-+$/.test(claim) || /^claim/i.test(claim)) continue; // separator / header
    rows.push({ claim, command, output, verdict });
  }
  return rows;
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
