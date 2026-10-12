/**
 * resolve-static-references.ts — D-3a: static reference resolution over parsed entry points.
 *
 * Spec: `docs/plans/2026-09-22-the-guard-universe-is-declared-not-globbed.md`, section
 * `## D-3a SPEC`. This module answers "which tracked shell script does any real entry point
 * reach?" so the CR-71 question — which of them is a dead chokepoint — becomes askable.
 * It has TWO consumers (D-2's `scripts/tests/_discover_guard_universe.mjs`, and D-3's
 * adjudication), which is why it is a module and not a script with a CLI.
 *
 * WHY A PARSER AND NOT A GREP. The signal this replaces is `30 of 104 referenced`, an UPPER
 * BOUND: a grep cannot tell a reference from a comment, and printing the matches rather than
 * counting them already caught two comment false positives in this corpus. A hand-rolled
 * lexer is BANNED for this artifact — a `shlex` pass in this repo once lexed a heredoc BODY
 * as argv. Probed 2026-09-23 against the vendored grammar below, on the exact shape this
 * module must handle:
 *
 *   TOP_LEVEL_KIDS : command variable_assignment comment command command redirected_statement
 *   HEREDOC_NODES  : heredoc_start heredoc_body      <- the `rm -rf` inside a heredoc is a
 *                                                       BODY, not a command. The grammar is
 *                                                       right where the lexer was wrong.
 *
 * WHY THE GRAMMAR IS VENDORED RATHER THAN LOADED BY `tree-sitter-loader.ts`.
 * That loader downloads each grammar at first use and caches under `~/.massu/wasm-cache/`
 * (see its own header). **A gate may not depend on a network fetch.** This module's consumers
 * run from `.husky/pre-commit`, `.husky/pre-push` and CI; on a cold cache with no network the
 * downloading loader raises `GrammarUnavailableError`, and if that degraded to an empty
 * reference set the resolver would report "nothing references this script" for EVERY script —
 * indistinguishable from the real CR-71 finding it exists to produce. That is the blind-gate
 * law with a network attached.
 *
 * Strategy A's "grammars are NOT bundled" decision governs the USER-FACING npm tarball.
 * `packages/core/package.json` `files` does not list `assets/**`, and `packages/core/assets/`
 * already tracks 22MB (an ONNX model + vocab) for internal use — so a vendored grammar is
 * hermetic AND still absent from the tarball. Measured, not assumed.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../config.ts';
import { parse as parseYaml } from 'yaml';
import { Language, Parser } from 'web-tree-sitter';

/**
 * The vendored grammar, pinned by content. Provenance:
 *   https://unpkg.com/tree-sitter-bash@0.25.1/tree-sitter-bash.wasm
 *
 * ⛔ THE FIRST-PARTY PACKAGE, DELIBERATELY — NOT the `tree-sitter-wasms@0.1.13` repackager
 * that every entry in `tree-sitter-loader.ts` GRAMMAR_MANIFEST uses. That build is **ABI 14**
 * and it CANNOT PARSE A `case` STATEMENT under `web-tree-sitter ~0.25.10`: the grammar imports
 * a symbol the runtime cannot resolve, and emscripten's lazy dynamic-linking stub throws
 * `TypeError: resolved is not a function` from inside `Parser.parse`. Measured: a three-line
 * `case "$X" in / a) : ;; / esac` is enough, while plain commands, heredocs, redirected
 * heredocs, `if`, `for`, `while` and function definitions all parse fine — so the failure is
 * per-CONSTRUCT, not per-size. Exposure had this shipped: **47 of 148 tracked *.sh files (31%)
 * contain a `case`.**
 *
 * The first-party build is **ABI 15**, matches the runtime's line, and parses `case`,
 * `case` containing a `source`, redirected heredocs and the indirection idiom with
 * `hasError=false` on every one.
 *
 * SIZE WAS A CONFOUND AND NEARLY THE DIAGNOSIS. The three files first observed were 13KB (OK),
 * 16KB and 27KB (both throwing), which reads as a size limit. Bisecting to the minimal failing
 * prefix — 80 lines, ending exactly on `case "${MASSU_REPO_CONTEXT:-}" in` — is what replaced
 * a plausible correlation with the actual axis.
 *
 * The pin is what makes vendoring reviewable rather than a blob of trust: a swapped asset
 * fails the hash and this module refuses to run, instead of parsing with a grammar nobody
 * approved.
 */
export const BASH_GRAMMAR_SHA256 =
  '8292919c88a0f7d3fb31d0cd0253ca5a9531bc1ede82b0537f2c63dd8abe6a7a';

export const BASH_GRAMMAR_PROVENANCE =
  'https://unpkg.com/tree-sitter-bash@0.25.1/tree-sitter-bash.wasm';

/** Thrown when the vendored grammar is missing, unreadable, or fails its content pin. */
export class BashGrammarUnavailableError extends Error {
  public readonly grammarPath: string;
  constructor(grammarPath: string, reason: string) {
    super(
      `[resolve-static-references] refusing to parse: the vendored bash grammar at ` +
        `"${grammarPath}" ${reason}. This is a FAIL, never an empty result — a resolver ` +
        `that cannot parse would report every script as unreferenced, which is ` +
        `indistinguishable from a real finding.`
    );
    this.name = 'BashGrammarUnavailableError';
    this.grammarPath = grammarPath;
  }
}

/** Absolute path to the vendored grammar, derived from this module's own location. */
export function bashGrammarPath(): string {
  // `../../assets/tree-sitter/...` from `packages/core/src/guard-universe/`.
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../assets/tree-sitter/tree-sitter-bash.wasm');
}

let cachedLanguage: Language | undefined;
let parserInit: Promise<void> | undefined;

/**
 * Load the vendored bash grammar, verifying its content pin first.
 *
 * FAILS CLOSED (M2): a missing file, an unreadable file, or a hash mismatch throws
 * `BashGrammarUnavailableError`. It never returns a null/partial Language, because every
 * caller's next step is to conclude something about references, and "I could not parse"
 * must not be able to masquerade as "I parsed and found nothing".
 */
export async function loadBashLanguage(grammarPathOverride?: string): Promise<Language> {
  // The override exists so the failure paths can be ATTACKED with the dependency INJECTED.
  // A guard whose dependency cannot be broken from a test is decoration: "it refused" and
  // "it never ran" look identical, and only an injectable path can tell them apart (G17).
  // An override always re-reads; only the default path is memoised.
  if (grammarPathOverride === undefined && cachedLanguage) return cachedLanguage;

  const grammarPath = grammarPathOverride ?? bashGrammarPath();
  let bytes: Buffer;
  try {
    bytes = readFileSync(grammarPath);
  } catch (err) {
    throw new BashGrammarUnavailableError(
      grammarPath,
      `could not be read (${err instanceof Error ? err.message : String(err)})`
    );
  }

  if (bytes.length === 0) {
    throw new BashGrammarUnavailableError(grammarPath, 'is empty (0 bytes)');
  }

  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== BASH_GRAMMAR_SHA256) {
    throw new BashGrammarUnavailableError(
      grammarPath,
      `failed its content pin (expected ${BASH_GRAMMAR_SHA256}, got ${actual}); ` +
        `provenance is ${BASH_GRAMMAR_PROVENANCE}`
    );
  }

  parserInit ??= Parser.init();
  await parserInit;

  let lang: Language;
  try {
    lang = await Language.load(bytes);
  } catch (err) {
    throw new BashGrammarUnavailableError(
      grammarPath,
      `verified its hash but would not load under web-tree-sitter ` +
        `(${err instanceof Error ? err.message : String(err)})`
    );
  }

  if (grammarPathOverride === undefined) cachedLanguage = lang;
  return lang;
}

let cachedParser: Parser | undefined;

/**
 * A parser bound to the vendored bash grammar. Callers parse through this rather than
 * constructing their own, so there is exactly one place the grammar pin is enforced.
 *
 * ⛔ MEMOISED, AND THAT IS A MEMORY CORRECTNESS REQUIREMENT, NOT AN OPTIMISATION.
 * `Parser` and `Tree` own allocations inside the WASM module's linear memory, which the JS
 * garbage collector cannot reclaim — they are freed only by an explicit `delete()`. The first
 * version of this module built a NEW parser per call and deleted neither it nor the tree, so
 * memory grew monotonically with the number of files parsed. Parsing the 148-file corpus in
 * one worker crashed it: `# Fatal process out of memory: Zone` / `v8::base::FatalOOM`, twice,
 * on a CI runner. Every test PASSED first — the worker died afterwards — so the suite summary
 * read `4236 passed | 37 skipped` while the step exited 1, and only vitest's separate
 * `Errors 2 errors` line disclosed it.
 *
 * A single reused parser makes the cost O(1) in files instead of O(n), and matches the house
 * pattern: every adapter under `src/detect/adapters/` deletes its parser, and
 * `query-helpers.ts` deletes each tree. Reuse is safe here because a tree-sitter parser is
 * reusable across parses and this module is single-threaded.
 */
export async function bashParser(grammarPathOverride?: string): Promise<Parser> {
  // An override must never be served the memoised parser, or a test injecting a broken
  // grammar would silently be handed the good one and its assertion would pass vacuously.
  if (grammarPathOverride !== undefined) {
    const lang = await loadBashLanguage(grammarPathOverride);
    const parser = new Parser();
    parser.setLanguage(lang);
    return parser;
  }
  if (cachedParser) return cachedParser;
  const lang = await loadBashLanguage();
  const parser = new Parser();
  parser.setLanguage(lang);
  cachedParser = parser;
  return parser;
}

/** Test-only: drop the memoised grammar so a fixture can exercise the failure paths. */
export function __resetBashGrammarCacheForTests(): void {
  cachedLanguage = undefined;
  if (cachedParser) {
    try { cachedParser.delete(); } catch { /* already freed */ }
    cachedParser = undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Increment 2 — reference extraction from ONE parsed bash file.
// ─────────────────────────────────────────────────────────────────────────────────────────

/** How one file reaches another. `source` also covers the `.` builtin. */
export type ReferenceKind = 'source' | 'exec';

export interface Reference {
  /** Repo-relative path of the file containing the reference. */
  readonly from: string;
  /** 1-indexed line of the INVOCATION — where the `source`/`bash` actually runs. */
  readonly line: number;
  /** Repo-relative path of the referenced file, or null when it did not resolve. */
  readonly to: string | null;
  readonly kind: ReferenceKind;
  /** `literal` when the path was written out; `indirection` when a variable carried it. */
  readonly via: 'literal' | 'indirection';
  /**
   * 1-indexed line where an indirect path was CONSTRUCTED, when that differs from `line`.
   *
   * This field exists because of a real miscitation. The standing fixture's own retro recorded
   * the caller as `scripts/lib/leak-patterns.sh:81`, which is where the PATH IS BUILT; the
   * `source` is on line 82. Reporting only 81 names a line that invokes nothing, and reporting
   * only 82 throws away the evidence that made the reference invisible to a line-anchored grep.
   * Both are kept.
   */
  readonly constructedAtLine?: number;
  /** The unresolved word text, kept when `to` is null so a zero is never silent. */
  readonly unresolved?: string;
}

/**
 * A heredoc body that is REDIRECTED INTO A FILE, i.e. code that will execute later at another
 * path. Its references belong to `generatedPath`, never to the file that wrote it.
 *
 * The discriminator is STRUCTURAL, not a filename heuristic: a `redirected_statement` carrying
 * BOTH a `file_redirect` (where the text goes) and a `heredoc_redirect` (the text) is a
 * generator; one carrying only a `heredoc_redirect` is an ordinary heredoc and stays excluded.
 * Verified against the real AST:
 *
 *   redirected_statement  [cat > "$HOOKS_DIR/pre-push" <<EOF …]
 *     command / file_redirect / heredoc_redirect      <- generator
 *   redirected_statement  [cat <<EOF …]
 *     command / heredoc_redirect                      <- NOT a generator
 *
 * `generatedPath` is deliberately NOT constrained to the repo: `scripts/install-hooks.sh`
 * writes into `.git/hooks/`, which is untracked. That is the `local-hook` tier, and dropping
 * it would discard exactly the edges the two-tier denominator exists to report.
 */
export interface GeneratedUnit {
  /** Where the text is written, as resolved. Repo-relative when inside the repo, else absolute. */
  readonly generatedPath: string;
  /** Whether `generatedPath` landed inside the repo (tracked tier) or outside it (local tier). */
  readonly inRepo: boolean;
  /** The heredoc body — source text of the generated artifact. */
  readonly body: string;
  /** 1-indexed line of the redirection that generates it. */
  readonly line: number;
}

/** Minimal structural view of a tree-sitter node — avoids leaking the parser type outward. */
interface TSNode {
  readonly type: string;
  readonly text: string;
  readonly startPosition: { row: number };
  readonly namedChildren: TSNode[];
  readonly children: TSNode[];
  childForFieldName(name: string): TSNode | null;
  descendantsOfType(type: string): TSNode[];
}

/** Commands whose argument is a path this module must follow. */
const SOURCE_BUILTINS = new Set(['source', '.']);
const SHELL_RUNNERS = new Set(['bash', 'sh', 'zsh', 'ksh']);
/**
 * `exec <path>` REPLACES the shell with that program, so it is an invocation — and it is how a
 * generated hook body delegates. Found in the real installer:
 *
 *   exec "$(git rev-parse --show-toplevel)/scripts/massu-public-leak-guard.sh" "$@"
 *
 * Handled separately from SHELL_RUNNERS because `exec` also manipulates file descriptors
 * (`exec 3>&1`, `exec >log 2>&1`), where there is no program at all. Those forms carry no
 * path-shaped argument and so resolve to nothing rather than to a fabricated reference.
 */
const EXEC_VERB = 'exec';

/**
 * Does this command substitution compute the SCRIPT'S OWN DIRECTORY?
 *
 * Restricted to the canonical idioms ON PURPOSE. The prior art search found the
 * `$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)` family to be a small, documented,
 * closed set, and that is exactly what makes this tractable instead of open-ended. An
 * unrecognised substitution resolves to null and is REPORTED as unresolved (never guessed),
 * because a wrong guess here manufactures a reference that does not exist.
 */
function resolveScriptDirExpansion(text: string, selfDir: string): string | null {
  const t = text.replace(/\s+/g, ' ');
  if (!/BASH_SOURCE|\$0/.test(t)) return null;
  if (!/dirname/.test(t) && !/%\/\*/.test(t)) return null;

  // ⛔ THE SUFFIX IS LOAD-BEARING. An earlier version returned a boolean and the caller
  // substituted `selfDir` for the WHOLE substitution, which silently discarded a trailing
  // path segment. Measured on the real installer:
  //
  //   REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  //
  // The `/..` makes this the script's PARENT, not its directory. Ignoring it resolved
  // HOOKS_DIR to `<repo>/scripts/.git/hooks` and produced the confidently wrong generated
  // path `scripts/.git/hooks/pre-push`. A wrong path is worse than an unresolved one: it is
  // reported as resolved.
  const m = /\)([^"'&]*)"?\s*&&\s*pwd/.exec(t);
  const suffix = (m?.[1] ?? '').trim();
  return suffix ? resolve(selfDir, `.${suffix.startsWith('/') ? suffix : `/${suffix}`}`) : selfDir;
}

/**
 * Unescape a heredoc body for an UNQUOTED delimiter (`<<EOF`), where the shell performs
 * expansion and backslash escapes survive into the generated file as their bare character.
 *
 * With a QUOTED delimiter (`<<'EOF'`) the body is literal and must NOT be touched.
 *
 * Measured: every generator in `scripts/install-hooks.sh` uses `<<EOF`, and its bodies write
 * `\$BATTERY` so the generated hook contains `$BATTERY`. Parsing the raw body made `\$BATTERY`
 * a literal word, which the resolver then reported as a RESOLVED path — a fabricated
 * reference to a file that does not exist. After unescaping it is a variable reference, which
 * resolves if the body binds it and is honestly REPORTED as unresolved if not.
 */
function unescapeHeredocBody(body: string, delimiterQuoted: boolean): string {
  if (delimiterQuoted) return body;
  return body.replace(/\\([$`\\])/g, '$1');
}

/**
 * Resolve a bash `word`/`string` node to a concrete string, or null if any part is unknown.
 *
 * Handles exactly three constituents: literal text, a script-directory command substitution,
 * and a variable reference whose value is already known. Anything else — a positional
 * parameter, an array expansion, an unresolved variable — makes the whole word unresolvable,
 * which is the honest answer and is reported rather than dropped.
 */
function resolveWord(
  node: TSNode,
  selfDir: string,
  vars: Map<string, string>,
  repoRootForWord: string
): string | null {
  // A plain unquoted word with no expansion is its own text.
  if (node.type === 'word') return node.text;

  const parts: string[] = [];
  const visit = (n: TSNode): boolean => {
    switch (n.type) {
      case 'string_content':
      case 'raw_string': {
        const lit = n.type === 'raw_string' ? n.text.slice(1, -1) : n.text;
        // An ESCAPED expansion is a variable reference one level down, not path text. In a
        // double-quoted string `\$X` yields a literal `$X`, which the CONSUMING shell then
        // expands — so its value is not statically known here. Treating it as literal path
        // text fabricates a reference to a file named `\$X`. Caught by the quoted-heredoc
        // silent control, which is the same defect the unquoted branch had.
        if (/\\[$`]/.test(lit)) return false;
        parts.push(lit);
        return true;
      }
      case 'word':
        parts.push(n.text);
        return true;
      case 'command_substitution': {
        // The REPO-ROOT idiom, as canonical as the script-dir one and just as closed a form.
        // Found in a generated hook body: `exec "$(git rev-parse --show-toplevel)/scripts/x.sh"`.
        if (/git\s+rev-parse\s+--show-toplevel/.test(n.text.replace(/\s+/g, ' '))) {
          parts.push(repoRootForWord);
          return true;
        }
        const dir = resolveScriptDirExpansion(n.text, selfDir);
        if (dir !== null) { parts.push(dir); return true; }
        return false;
      }
      case 'simple_expansion':
      case 'expansion': {
        const name = n.text.replace(/^\$\{?/, '').replace(/\}$/, '');
        // Claude Code sets CLAUDE_PROJECT_DIR to the repo root for every hook it runs, and
        // `.claude/settings.json` hook commands are written against it. A closed, documented
        // form, so it is resolved rather than left unresolvable.
        if (name === 'CLAUDE_PROJECT_DIR') { parts.push(repoRootForWord); return true; }
        const known = vars.get(name);
        if (known === undefined) return false;
        parts.push(known);
        return true;
      }
      case 'string':
      case 'concatenation':
      // `command_name` wraps the executed word, so a DIRECT execution (`./scripts/x.sh`)
      // arrives as a container rather than a bare word. Omitting it made that whole
      // detection path resolve to null — caught by its own must-fire fixture, which is the
      // only reason a dead path is distinguishable from a path with nothing to find.
      case 'command_name':
        for (const c of n.children) {
          if (c.type === '"' || c.type === "'") continue;
          if (!visit(c)) return false;
        }
        return true;
      default:
        // Punctuation and structural tokens carry no text we need.
        if (/^[\s"'$(){}]+$/.test(n.type) || n.type === '$') return true;
        return false;
    }
  };
  if (!visit(node)) return null;
  const joined = parts.join('');
  return joined.length > 0 ? joined : null;
}

/** Where a variable's value came from, so an indirect reference can cite its construction. */
interface VarBinding { readonly value: string; readonly line: number }

/**
 * Extract every file reference from one parsed bash file.
 *
 * `selfPath` must be repo-relative; `repoRoot` is used only to turn an absolute resolved path
 * back into a repo-relative one. A reference outside the repo resolves to null rather than
 * escaping the repo — the question this module answers is about tracked files.
 *
 * COMMENTS AND HEREDOCS ARE EXCLUDED BY CONSTRUCTION, not by a filter. tree-sitter gives a
 * `comment` its own node type and a heredoc's contents a `heredoc_body`, so neither can ever
 * appear as a `command`. That is the whole reason this is a parser: the signal it replaces was
 * an upper bound precisely because a grep could not make that distinction.
 */
export function extractReferences(
  rootNode: unknown,
  selfPath: string,
  repoRoot: string,
  /**
   * Optional sink for heredoc GENERATORS found during the same walk. Collected here rather
   * than by a second pass because resolving the output path needs the variable bindings this
   * walk already accumulates (`cat > "$HOOKS_DIR/pre-push"` is unresolvable without them).
   */
  outGenerated?: GeneratedUnit[]
): Reference[] {
  const root = rootNode as TSNode;
  const selfDir = resolve(repoRoot, dirname(selfPath));
  const vars = new Map<string, string>();
  const varLines = new Map<string, number>();
  const refs: Reference[] = [];

  const toRepoRelative = (abs: string): string | null => {
    const full = abs.startsWith('/') ? abs : resolve(repoRoot, abs);
    const rel = full.startsWith(repoRoot + '/') ? full.slice(repoRoot.length + 1) : null;
    return rel;
  };

  const record = (kind: ReferenceKind, argNode: TSNode, invokeLine: number): void => {
    const raw = resolveWord(argNode, selfDir, vars, repoRoot);
    if (raw === null) {
      refs.push({ from: selfPath, line: invokeLine, to: null, kind, via: 'literal', unresolved: argNode.text });
      return;
    }
    // Was any part of this word carried by a variable? That decides `via`, and lets the
    // reference cite the line where the path was BUILT as well as where it is USED.
    const usedVar = argNode.descendantsOfType('simple_expansion')
      .concat(argNode.descendantsOfType('expansion'))
      .map((n) => n.text.replace(/^\$\{?/, '').replace(/\}$/, ''))
      .find((name) => vars.has(name));
    const rel = toRepoRelative(raw);
    refs.push({
      from: selfPath,
      line: invokeLine,
      to: rel,
      kind,
      via: usedVar ? 'indirection' : 'literal',
      ...(usedVar && varLines.has(usedVar) && varLines.get(usedVar) !== invokeLine
        ? { constructedAtLine: varLines.get(usedVar)! }
        : {}),
      ...(rel === null ? { unresolved: raw } : {}),
    });
  };

  const walk = (n: TSNode): void => {
    if (n.type === 'variable_assignment') {
      const name = n.childForFieldName('name')?.text;
      const valueNode = n.childForFieldName('value');
      if (name && valueNode) {
        const v = resolveWord(valueNode, selfDir, vars, repoRoot);
        // Only RESOLVED values are bound. An unresolved assignment must not shadow a
        // later one with a value we do understand, and must never bind to a partial string.
        if (v !== null) { vars.set(name, v); varLines.set(name, n.startPosition.row + 1); }
      }
    } else if (n.type === 'redirected_statement' && outGenerated) {
      // BOTH redirects present => the heredoc body is written to a file and will execute there.
      const kids = n.namedChildren;
      const fileRedirect = kids.find((c) => c.type === 'file_redirect');
      const heredoc = kids.find((c) => c.type === 'heredoc_redirect');
      if (fileRedirect && heredoc) {
        const target = fileRedirect.namedChildren.find((c) => c.type !== 'heredoc_start');
        const rawBody = heredoc.descendantsOfType('heredoc_body')[0]?.text;
        // `<<'EOF'` (quoted) is literal; `<<EOF` (unquoted) expands, so its escapes must go.
        const startText = heredoc.descendantsOfType('heredoc_start')[0]?.text ?? '';
        const quoted = /['"]/.test(startText);
        const body = rawBody === undefined ? undefined : unescapeHeredocBody(rawBody, quoted);
        const raw = target ? resolveWord(target, selfDir, vars, repoRoot) : null;
        if (raw !== null && raw !== undefined && body !== undefined) {
          const rel = toRepoRelative(raw);
          outGenerated.push({
            generatedPath: rel ?? (raw.startsWith('/') ? raw : resolve(repoRoot, raw)),
            inRepo: rel !== null,
            body,
            line: n.startPosition.row + 1,
          });
        }
      }
    } else if (n.type === 'command') {
      const nameNode = n.childForFieldName('name');
      const cmd = nameNode?.text ?? '';
      const line = n.startPosition.row + 1;
      // Arguments, in order, skipping the command name itself and any flag.
      //
      // FILTER BY NODE TYPE, NEVER BY OBJECT IDENTITY. `childForFieldName('name')` and
      // `namedChildren` return DISTINCT wrapper objects for the same underlying node, so a
      // `c !== nameNode` test silently keeps the command name in the argument list — and the
      // first "argument" then resolves to the word `source`, producing one unresolved
      // reference per call site instead of the real edge. Measured on the standing fixture:
      // it reported `{to: null, unresolved: "source"}` for `source "$_massu_op_patterns"`.
      // `variable_assignment` is excluded for the same reason as `command_name`: in
      // `MASSU_X=1 bash scripts/y.sh` the assignment precedes the name and is NOT an argument.
      // Leaving it in made the first "argument" the assignment text, so env-prefixed
      // invocations resolved to nothing and were reported as unresolved references to
      // `MASSU_LEAK_GUARD_MODE=commit` and `NODE_PATH="$REPO_ROOT/node_modules"`. Found by
      // READING all 18 unresolved entries rather than counting them.
      const args = n.namedChildren.filter(
        (c) =>
          c.type !== 'command_name' &&
          c.type !== 'file_redirect' &&
          c.type !== 'variable_assignment'
      );
      const firstNonFlag = args.find((a) => !a.text.startsWith('-'));

      if (SOURCE_BUILTINS.has(cmd) && firstNonFlag) {
        record('source', firstNonFlag, line);
      } else if (SHELL_RUNNERS.has(cmd) && firstNonFlag) {
        record('exec', firstNonFlag, line);
      } else if (cmd === EXEC_VERB && firstNonFlag && !/^\d*[<>]/.test(firstNonFlag.text)) {
        // Not a redirection-only `exec` — there is a program argument to resolve.
        record('exec', firstNonFlag, line);
      } else if (nameNode && /\.sh$/.test(cmd)) {
        // Direct execution: `./scripts/foo.sh` or `scripts/foo.sh`.
        record('exec', nameNode, line);
      }
    }
    for (const c of n.namedChildren) walk(c);
  };
  walk(root);
  return refs;
}

/**
 * Parse one repo-relative shell file and return its references.
 *
 * FAILS CLOSED: an unreadable file or a parse that yields an ERROR-bearing tree throws.
 * Returning [] on either would make "could not read" identical to "no references", which is
 * the defect this whole plan exists to eliminate.
 */
export async function referencesFrom(selfPath: string, repoRoot: string): Promise<Reference[]> {
  const abs = resolve(repoRoot, selfPath);
  let src: string;
  try {
    src = readFileSync(abs, 'utf8');
  } catch (err) {
    throw new Error(
      `[resolve-static-references] cannot read ${selfPath}: ` +
        `${err instanceof Error ? err.message : String(err)} — unreadable input is an ERROR, not an empty result`
    );
  }
  return referencesFromSource(src, selfPath, repoRoot);
}

/**
 * Extract references from a bash SNIPPET attributed to `selfPath`.
 *
 * This is the shape a workflow's `run:` block and a `package.json` script take: shell source
 * that never exists as a file of its own, but whose invocations are real. Attributing them to
 * the declaring file is what lets a workflow count as an entry point.
 *
 * FAILS CLOSED on a parse that yields no tree.
 */
export async function referencesFromSource(
  src: string,
  selfPath: string,
  repoRoot: string
): Promise<Reference[]> {
  const parser = await bashParser();
  const tree = parser.parse(src);
  if (tree === null) {
    throw new Error(`[resolve-static-references] parser returned no tree for ${selfPath}`);
  }
  const generated: GeneratedUnit[] = [];
  let refs: Reference[];
  try {
    // References are plain data, so the tree can be freed as soon as they are extracted.
    refs = extractReferences(tree.rootNode, selfPath, repoRoot, generated);
  } finally {
    // MUST run even on a throw: a leaked tree is WASM memory no GC will reclaim, and the
    // failure mode is a worker crash long after the file that caused it.
    tree.delete();
  }

  // Each generated body's references are attributed to the GENERATED path. Without this,
  // everything an installer's hooks invoke is invisible: the bodies are heredocs, and heredoc
  // bodies are excluded by construction.
  //
  // ⛔ BODIES TARGETING THE SAME PATH ARE CONCATENATED IN SOURCE ORDER, because `cat >>`
  // APPENDS — four heredocs writing to `$HOOKS_DIR/pre-push` produce ONE file, not four.
  // Parsing them separately loses bindings that cross units: the real installer assigns
  // `REPO_ROOT` and `BATTERY` in one append and invokes `"$BATTERY"` in a later one, so a
  // per-unit parse reported `UNRESOLVED("$BATTERY")` for a path the generated file resolves
  // perfectly well. Concatenation is not an optimisation; it is what the redirection means.
  const byPath = new Map<string, { body: string; line: number; inRepo: boolean }>();
  for (const unit of generated) {
    const prior = byPath.get(unit.generatedPath);
    if (prior) {
      prior.body += unit.body;
    } else {
      byPath.set(unit.generatedPath, { body: unit.body, line: unit.line, inRepo: unit.inRepo });
    }
  }
  for (const [generatedPath, unit] of byPath) {
    const genTree = parser.parse(unit.body);
    if (genTree === null) {
      throw new Error(
        `[resolve-static-references] parser returned no tree for the body generated at ` +
          `${selfPath}:${unit.line} -> ${generatedPath}`
      );
    }
    try {
      // The generated file's own directory is what its relative paths resolve against, so it
      // is parsed AS the generated path rather than as the generator.
      refs.push(...extractReferences(genTree.rootNode, generatedPath, repoRoot));
    } finally {
      genTree.delete();
    }
  }
  return refs;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// The two-tier entry-point denominator and the transitive closure.
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Which population an entry point belongs to.
 *
 * `tracked` is reproducible in any checkout. `local-hook` is MACHINE STATE: `git clone`
 * recreates `.git/hooks/`, and the machine-wide managed registry lives outside the repo
 * entirely, so a CI runner and a working copy see different sets. The tiers are reported
 * SEPARATELY and never merged, because the error direction is the dangerous one — a script
 * reachable only through a local hook would read REACHABLE here and DEAD in CI, or the
 * reverse, and a single blended number hides which.
 */
export type EntryPointTier = 'tracked' | 'local-hook';

export interface EntryPoint {
  /** Repo-relative for `tracked`; absolute for `local-hook`, which lives outside the tree. */
  readonly path: string;
  readonly tier: EntryPointTier;
  /** How its shell source is obtained — each needs a different reader. */
  readonly kind: 'shell' | 'workflow-run' | 'package-script' | 'hook' | 'claude-hook';
}

export interface ReachabilityReport {
  /** M1: printed and asserted on every run, so "scanned 0, found 0" cannot read as health. */
  readonly denominator: {
    readonly entryPoints: number;
    readonly byTier: Record<EntryPointTier, number>;
    readonly trackedShellFiles: number;
    readonly unitsParsed: number;
    readonly fixpointIterations: number;
  };
  readonly edges: readonly Reference[];
  /** Tracked shell files reachable from at least one entry point of that tier. */
  readonly reachable: Record<EntryPointTier, readonly string[]>;
  /**
   * Tracked shell files reachable from NO entry point in EITHER tier — the CR-71
   * dead-chokepoint candidates. A verdict here must always name the tier set it covers.
   */
  readonly residue: readonly string[];
  /** References whose target could not be resolved. Reported, never dropped. */
  readonly unresolved: readonly Reference[];
}

export interface ResolveOptions {
  readonly repoRoot: string;
  /**
   * Include the machine-dependent tier. Default true, because excluding it silently would
   * make a local-hook-only script look dead — but a caller comparing against CI must be able
   * to ask for the reproducible tier alone.
   */
  readonly includeLocalHooks?: boolean;
  /**
   * INJECTABLE, not resolved inline. `homedir()` inside an expression has no seam, so a
   * caller running under a different HOME — or a test — cannot redirect it. Same shim class
   * as the 2026-08-11 `massuShimPath()` defect, and the reason G30 exists: under elevation
   * `~` is `/var/root`, and a watcher resolving it inline reports health over the wrong tree.
   */
  readonly home?: string;
  /** INJECTABLE, defaulting to the configured convention rather than a hardcoded literal. */
  readonly claudeDirName?: string;
}

function gitTracked(repoRoot: string, pathspec: string): string[] {
  const out = execFileSync('git', ['-C', repoRoot, 'ls-files', '-z', '--', pathspec], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter(Boolean);
}

/** Every string value under a `run:` key, at any depth — the schema's nesting is not hardcoded. */
function collectRunBlocks(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const v of node) collectRunBlocks(v, out);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'run' && typeof v === 'string') out.push(v);
      else collectRunBlocks(v, out);
    }
  }
}

/** Every string value under a `command` key, at any depth — the settings schema is not hardcoded. */
function collectCommandStrings(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const v of node) collectCommandStrings(v, out);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'command' && typeof v === 'string') out.push(v);
      else collectCommandStrings(v, out);
    }
  }
}

/**
 * Enumerate the entry points, DERIVED rather than listed.
 *
 * The tracked shell entry points are the ones a hook or CI actually invokes; the workflows and
 * `package.json` are discovered by glob and by parsing, so a new workflow counts on its first
 * commit rather than when someone remembers to add it.
 */
export function enumerateEntryPoints(opts: ResolveOptions): EntryPoint[] {
  const { repoRoot } = opts;
  const home = opts.home ?? homedir();
  const claudeDirName = opts.claudeDirName ?? getConfig().conventions?.claudeDirName ?? '.claude';
  const eps: EntryPoint[] = [];

  for (const p of ['scripts/pre-push-light.sh', 'scripts/install-hooks.sh']) {
    if (existsSync(resolve(repoRoot, p))) eps.push({ path: p, tier: 'tracked', kind: 'shell' });
  }
  for (const wf of gitTracked(repoRoot, '.github/workflows/*.yml')) {
    eps.push({ path: wf, tier: 'tracked', kind: 'workflow-run' });
  }
  if (existsSync(resolve(repoRoot, 'package.json'))) {
    eps.push({ path: 'package.json', tier: 'tracked', kind: 'package-script' });
  }

  // ⛔ THE THIRD MECHANISM. Claude Code `.claude/settings.json` hook entries ARE shell
  // commands, and they are the only caller of most of `scripts/hooks/`. Omitting this source
  // reported 11 live scripts as unreachable residue — a FALSE CR-71 finding, the exact thing
  // this module exists to avoid producing. Found by READING the residue list, not by its count.
  //
  // A TRACKED settings file is reproducible; an UNTRACKED one (settings.local.json) is machine
  // state and belongs to the other tier, so the tier is derived from git rather than assumed.
  for (const cfg of [join(claudeDirName, 'settings.json'), join(claudeDirName, 'settings.local.json')]) {
    if (!existsSync(resolve(repoRoot, cfg))) continue;
    const isTracked = gitTracked(repoRoot, cfg).length > 0;
    eps.push({ path: cfg, tier: isTracked ? 'tracked' : 'local-hook', kind: 'claude-hook' });
  }

  if (opts.includeLocalHooks !== false) {
    const hookDir = resolve(repoRoot, '.git/hooks');
    if (existsSync(hookDir)) {
      for (const f of readdirSync(hookDir)) {
        // `*.sample` is the DISARMED state — git never executes it, so it is not an entry point.
        if (f.endsWith('.sample')) continue;
        eps.push({ path: join(hookDir, f), tier: 'local-hook', kind: 'hook' });
      }
    }
    const managed = resolve(home, claudeDirName, 'hooks', 'managed-pre-commit-checks');
    if (existsSync(managed)) {
      for (const f of readdirSync(managed)) {
        eps.push({ path: join(managed, f), tier: 'local-hook', kind: 'hook' });
      }
    }
  }
  return eps;
}

/** The shell source an entry point contributes, as one or more attributed units. */
async function unitsFor(ep: EntryPoint, repoRoot: string): Promise<{ path: string; src: string }[]> {
  const abs = ep.path.startsWith('/') ? ep.path : resolve(repoRoot, ep.path);
  let raw: string;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch (err) {
    // M2: an unreadable entry point is an ERROR. Skipping it would shrink the denominator
    // silently, which is the same defect as a gate that could not look reporting clean.
    throw new Error(
      `[resolve-static-references] entry point ${ep.path} (${ep.tier}) is unreadable: ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (ep.kind === 'workflow-run') {
    // pattern-scanner-allow: yaml-parse — this parses a GITHUB WORKFLOW, not massu config.
    // getConfig() reads massu.config.yaml and has no notion of `.github/workflows/*.yml`;
    // routing a workflow through it would be meaningless. Parsing is the point: a workflow's
    // `run:` blocks are shell, and grepping them cannot tell a command from a comment.
    const doc = parseYaml(raw) as unknown;
    const runs: string[] = [];
    collectRunBlocks(doc, runs);
    return runs.map((src) => ({ path: ep.path, src }));
  }
  if (ep.kind === 'claude-hook') {
    const cmds: string[] = [];
    collectCommandStrings(JSON.parse(raw), cmds);
    return cmds.map((src) => ({ path: ep.path, src }));
  }
  if (ep.kind === 'package-script') {
    const scripts = (JSON.parse(raw) as { scripts?: Record<string, string> }).scripts ?? {};
    return Object.values(scripts).map((src) => ({ path: ep.path, src }));
  }
  return [{ path: ep.path, src: raw }];
}

/**
 * Resolve which tracked shell files any real entry point reaches, transitively.
 *
 * TRANSITIVE TO A FIXPOINT, never one level: `scripts/lib/leak-patterns-operator.sh` is
 * sourced one level BELOW an entry point, and a one-level sweep reports it caller-less —
 * which is exactly the false CR-71 finding this module exists to avoid producing.
 */
export async function resolveStaticReferences(opts: ResolveOptions): Promise<ReachabilityReport> {
  const { repoRoot } = opts;
  const entryPoints = enumerateEntryPoints(opts);
  const trackedShell = gitTracked(repoRoot, '*.sh');

  // M1: assert the denominators BEFORE doing any work. Zero of either makes every downstream
  // number meaningless, and an empty result would otherwise look like a clean answer.
  if (entryPoints.length === 0) {
    throw new Error('[resolve-static-references] enumerated 0 entry points — refusing to report reachability');
  }
  if (trackedShell.length === 0) {
    throw new Error('[resolve-static-references] git ls-files found 0 tracked *.sh — refusing to report a residue');
  }

  const edges: Reference[] = [];
  const reachedBy: Record<EntryPointTier, Set<string>> = { tracked: new Set(), 'local-hook': new Set() };
  let unitsParsed = 0;
  let fixpointIterations = 0;

  for (const tier of ['tracked', 'local-hook'] as const) {
    const seeds = entryPoints.filter((e) => e.tier === tier);
    if (seeds.length === 0) continue;

    // Frontier BFS. `visited` holds units already parsed so a cycle terminates; `reached`
    // holds the tracked shell files this tier can get to.
    const visited = new Set<string>();
    let frontier: { path: string; src: string }[] = [];
    for (const ep of seeds) frontier.push(...(await unitsFor(ep, repoRoot)));

    while (frontier.length > 0) {
      fixpointIterations += 1;
      const next: { path: string; src: string }[] = [];
      for (const unit of frontier) {
        const key = `${unit.path}::${unit.src.length}::${unit.src.slice(0, 64)}`;
        if (visited.has(key)) continue;
        visited.add(key);
        unitsParsed += 1;
        const refs = await referencesFromSource(unit.src, unit.path, repoRoot);
        edges.push(...refs);
        for (const r of refs) {
          if (r.to === null) continue;
          if (!reachedBy[tier].has(r.to)) {
            reachedBy[tier].add(r.to);
            // Follow it only if it is a tracked file we can read — the closure is over the
            // repo, and an edge to something untracked is recorded without being expanded.
            if (trackedShell.includes(r.to)) {
              next.push({ path: r.to, src: readFileSync(resolve(repoRoot, r.to), 'utf8') });
            }
          }
        }
      }
      frontier = next;
    }
  }

  const anyTier = new Set<string>([...reachedBy.tracked, ...reachedBy['local-hook']]);
  const residue = trackedShell.filter((f) => !anyTier.has(f));

  // Both tiers walk overlapping file sets, so the same edge is discovered twice. Deduplicate
  // on its identity (from + line + target + kind) so a consumer counting edges is not misled.
  const seenEdge = new Set<string>();
  const dedupedEdges = edges.filter((e) => {
    const k = `${e.from}\u0000${e.line}\u0000${e.to ?? ''}\u0000${e.kind}\u0000${e.unresolved ?? ''}`;
    if (seenEdge.has(k)) return false;
    seenEdge.add(k);
    return true;
  });

  return {
    denominator: {
      entryPoints: entryPoints.length,
      byTier: {
        tracked: entryPoints.filter((e) => e.tier === 'tracked').length,
        'local-hook': entryPoints.filter((e) => e.tier === 'local-hook').length,
      },
      trackedShellFiles: trackedShell.length,
      unitsParsed,
      fixpointIterations,
    },
    edges: dedupedEdges,
    reachable: {
      tracked: [...reachedBy.tracked].filter((f) => trackedShell.includes(f)).sort(),
      'local-hook': [...reachedBy['local-hook']].filter((f) => trackedShell.includes(f)).sort(),
    },
    residue,
    unresolved: dedupedEdges.filter((e) => e.to === null),
  };
}
