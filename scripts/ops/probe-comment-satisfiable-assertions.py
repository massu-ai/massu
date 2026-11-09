#!/usr/bin/env python3
"""Which source-text guard assertions are satisfied ONLY by a COMMENT?

THE DEFECT. A drift-guard that reads a source file and asserts `toContain('<symbol>')` over
the RAW text is satisfied by any mention of that symbol — including the comment that EXPLAINS
why the symbol exists, which is the last thing anyone deletes. So the guard goes green over
the exact edit it exists to catch.

TWO STATES, AND KEEPING THEM APART IS THE POINT. Reporting one number here would have hidden
an order of magnitude:

  LIVE    the literal appears ONLY in comments, so the assertion is discharged by documentation
          today. Measured: 1.
  LATENT  the literal appears in code AND in a comment, so deleting the code occurrence leaves
          the guard green over its own subject. Measured: 11.

The example that motivated this probe is LATENT, not LIVE — and I called it live before the
probe existed, which is exactly the error the split prevents:

    reality-gate-r3-liveness-drift-guard.test.ts:66
      expect(src, 'the log seam is gone').toContain('MASSU_HOOK_FAILURE_LOG')
    scripts/massu-reality-gate.sh
      :207  # An explicitly-set MASSU_HOOK_FAILURE_LOG is different again: ...   <- a comment
      :218    local seam="${MASSU_HOOK_FAILURE_LOG:-}"                          <- ALSO in code

The assertion holds on the code today. Delete line 218 and keep line 207, and it still holds —
which is the defect, one step removed.

THE TEST IS EXECUTABLE, NOT A READING. For each (test, guarded file, literal): strip comments
from the guarded file and re-evaluate. That is a fact about the tree, not an opinion about the
code, which is why it can be counted.

The remedy already exists at ONE site: memory-render-accounting-drift-guard.test.ts pipes its
source through `codeOnly()` first, commenting "a comment mentioning EMPTY('error') is
documentation, not a call site". This probe reports how many sites still do not.

Usage:
  python3 scripts/ops/probe-comment-satisfiable-assertions.py [--list] [--json] [--repo-root DIR]

  --list  print every scanned (test -> guarded file) pair, including the ones with no findings,
          so the denominator is visible rather than asserted.

Exits 0 always: this is a MEASURING tool, not a gate. It refuses to run (exit 2) when its own
candidate set is empty, because "scanned 0, found 0" is what a broken probe also prints.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

# `const NAME = readFileSync(<expr>, ...)` / `const NAME = codeOnly(readFileSync(<expr>, ...))`
READ_ASSIGN = re.compile(
    # `rest` is captured inside a LOOKAHEAD so the match consumes nothing beyond
    # `readFileSync(`. A plain `[\s\S]{0,400}` capture is greedy AND consuming, so
    # `finditer` resumed 400 characters later and SILENTLY SKIPPED every subsequent
    # `const X = readFileSync(...)` inside that window — dropping the assertion total from
    # 99 to 93 while the numbers around it improved. The repair for a blind spot opened a
    # new one, in the same direction (fewer things looked at, no error), which is why the
    # denominator is asserted below rather than trusted.
    r'(?:const|let)\s+(\w+)\s*=\s*(?P<wrap>\w+\s*\(\s*)?readFileSync\((?=\s*(?P<rest>[\s\S]{0,400}))')


def first_arg(rest: str) -> str:
    """The first TOP-LEVEL argument of a call, given everything after its opening paren.

    The previous capture was `[^,)]+`, which stops at the first `,` or `)` — so the single
    most common shape in this repo, `readFileSync(join(SRC, 'x.ts'), 'utf8')`, yielded
    `join(SRC` and LOST the filename. No string literal survived, so `resolve_path_expr`
    returned None and the read was filed UNRESOLVABLE. That is 10 of the 24 unresolvable
    reads: not paths the probe could not resolve, but paths it never actually saw — a blind
    spot reported as a measurement. Depth-aware scanning is the only correct reading of a
    nested call; a regex cannot count parentheses.
    """
    depth, out, quote = 0, [], ''
    for ch in rest:
        if quote:
            out.append(ch)
            if ch == quote:
                quote = ''
            continue
        if ch in '\'"`':
            quote = ch; out.append(ch); continue
        if ch in '([{':
            depth += 1
        elif ch in ')]}':
            if depth == 0:
                break                      # the readFileSync( ... ) closing paren
            depth -= 1
        elif ch == ',' and depth == 0:
            break                          # end of the first argument
        out.append(ch)
    return ''.join(out).strip()
# `const NAME = resolve(A, 'b', 'c')` / join(...) — the path constants tests build first.
PATH_CONST = re.compile(
    r'(?:const|let)\s+(\w+)\s*=\s*(?:path\.)?(?:resolve|join)\(([^;]*?)\)\s*(?:;|$)', re.M)
STR_LIT = re.compile(r"['\"]([^'\"]+)['\"]")
# expect(<var>[, '...']).toContain('<literal>') | .toMatch(/re/) — literal arg only.
ASSERT_LIT = re.compile(
    r"expect\(\s*(\w+)\b[^)]*\)\s*\.\s*toContain\(\s*['\"]([^'\"]+)['\"]\s*\)")
STRIPPERS = ('codeOnly', 'stripComments', 'stripCode', 'withoutComments')

# Comment syntax by extension. Only line comments are stripped: a literal inside a block
# comment is rarer, and over-stripping would manufacture findings.
LINE_COMMENT = {
    '.sh': '#', '.bash': '#', '.py': '#', '.yml': '#', '.yaml': '#',
    '.ts': '//', '.tsx': '//', '.js': '//', '.mjs': '//', '.cjs': '//', '.json': None,
}


def tracked_files(root: Path, sub: str) -> list[str]:
    out = subprocess.run(['git', 'ls-files', '--', sub], cwd=root,
                         capture_output=True, text=True, check=True).stdout.split()
    return out


def strip_line_comments(text: str, ext: str) -> str | None:
    """Drop full-line and trailing comments. None when the extension has no comment syntax."""
    marker = LINE_COMMENT.get(ext)
    if marker is None:
        return None
    kept = []
    for line in text.splitlines():
        stripped = line.lstrip()
        if stripped.startswith(marker):
            continue
        # Trailing comment: only when the marker is not inside a quoted string. Cheap and
        # conservative — if quoting is ambiguous we keep the whole line, which can only
        # UNDER-report, never invent a finding.
        idx = line.find(marker)
        if idx > 0 and line.count("'", 0, idx) % 2 == 0 and line.count('"', 0, idx) % 2 == 0:
            line = line[:idx]
        kept.append(line)
    return '\n'.join(kept)


def comment_lines(text: str, ext: str) -> list[str]:
    """Full-line comments only — the lines strip_line_comments() drops entirely."""
    marker = LINE_COMMENT.get(ext)
    if marker is None:
        return []
    return [l for l in text.splitlines() if l.lstrip().startswith(marker)]


def strip_code_lines(text: str, ext: str) -> str:
    """The inverse of strip_line_comments: keep ONLY comment lines."""
    return '\n'.join(comment_lines(text, ext))

# A read whose base is a RUNTIME temp dir is a fixture the test wrote itself, not a committed
# source file — out of scope by construction, and counting it as an unresolved blind spot would
# overstate what this probe cannot see. Measured 2026-08-12: 21 of 45 unresolved reads.
FIXTURE_BASE = re.compile(r'\b(tmp\w*|.*[Tt]mpDir|memDir|memoryDir|targetDir|scratch\w*|workDir|dir)\b')


def resolve_path_expr(expr: str, consts: dict[str, str], root: Path, test_path: Path) -> Path | None:
    """Best-effort resolution of a path expression to a real file under the repo.

    Constants are expanded INTO the expression before literals are extracted: a test that writes
    `const SRC = resolve(REPO_ROOT, 'scripts')` then `readFileSync(join(SRC, 'x.sh'))` yields its
    literals across TWO declarations, and taking only the inner one resolves to `<root>/x.sh`,
    which does not exist -> silently unresolved. That was 23 of 45 unresolved reads.
    """
    expr = expr.strip()
    for _ in range(3):                      # bounded: constants referencing constants
        expanded = re.sub(r'\b([A-Za-z_]\w*)\b',
                          lambda m: consts.get(m.group(1), m.group(1)), expr)
        if expanded == expr:
            break
        expr = expanded
    parts = STR_LIT.findall(expr)
    if not parts:
        # NO string literal survived parsing. This is the probe failing to READ the
        # expression — the shape the truncating `[^,)]+` capture produced — and it is a
        # defect in this tool, not a fact about the tree.
        return None, 'unparsed'
    for base in (root, test_path.parent, test_path.parent.parent):
        cand = base.joinpath(*parts)
        if cand.is_file():
            return cand, 'ok'
    # A trailing relative segment set anchored anywhere in the repo.
    cand = root.joinpath(*parts)
    if cand.is_file():
        return cand, 'ok'
    # The expression PARSED and names a file this checkout does not contain. That is an
    # unavailable INPUT, not a verdict and not a resolver defect (G26/CR-89). Keeping it
    # separate is what makes the counts comparable across checkouts: the published mirror
    # ships a subset of the tree, so 22 reads that resolve internally name files that are
    # simply absent there. Collapsing the two made a ratchet impossible — internally 68/14,
    # in the mirror 37/36, with no threshold that means the same thing in both.
    return None, 'absent'


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo-root', default=os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__)))))
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--debug-unresolved', action='store_true',
                    help='print the path expressions that could not be resolved, so the blind '
                         'spot can be classified instead of merely counted')
    args = ap.parse_args()
    root = Path(args.repo_root).resolve()

    tests = [f for f in tracked_files(root, 'packages/core/src/__tests__') if f.endswith('.ts')]
    tests += [f for f in tracked_files(root, 'website/src/__tests__') if f.endswith('.ts')]
    if not tests:
        print('FATAL: 0 tracked test files — refusing to report an empty candidate set (M1).',
              file=sys.stderr)
        return 2

    scanned_pairs = 0
    assertions = 0
    unresolved = 0
    target_absent = 0
    fixture_reads = 0
    no_comment_syntax = 0
    live: list[dict] = []
    vulnerable: list[dict] = []
    pairs: list[str] = []

    for rel in tests:
        p = root / rel
        try:
            text = p.read_text(encoding='utf-8')
        except OSError as exc:
            print(f'FATAL: unreadable {rel}: {exc}', file=sys.stderr)   # M2 — never skip silently
            return 2
        # STRIP COMMENTS FROM THE TEST FILE FIRST. Without this the probe reads a
        # commented-out assertion as a live one — and the first thing it flagged after its
        # own finding was FIXED was the comment DOCUMENTING the old assertion. A detector
        # that punishes writing down what you fixed teaches people to stop writing it down
        # (CR-83). It is also the probe committing the exact defect it detects.
        text = strip_line_comments(text, '.ts') or text
        consts = {m.group(1): m.group(2) for m in PATH_CONST.finditer(text)}
        # var -> (guarded path, was it stripped at the read site?)
        reads: dict[str, tuple[Path | None, bool]] = {}
        reads_expr: dict[str, str] = {}
        read_why: dict[str, str] = {}
        for m in READ_ASSIGN.finditer(text):
            var = m.group(1)
            arg = first_arg(m.group('rest'))
            reads_expr[var] = arg
            wrapped = bool(m.group('wrap')) and any(s in m.group('wrap') for s in STRIPPERS)
            resolved_path, why = resolve_path_expr(arg, consts, root, p)
            reads[var] = (resolved_path, wrapped)
            read_why[var] = why

        for m in ASSERT_LIT.finditer(text):
            var, literal = m.group(1), m.group(2)
            if var not in reads:
                continue
            guarded, wrapped = reads[var]
            assertions += 1
            if guarded is None:
                if FIXTURE_BASE.search(reads_expr.get(var, '')):
                    fixture_reads += 1
                    continue
                if read_why.get(var) == 'absent':
                    target_absent += 1
                else:
                    unresolved += 1
                if args.debug_unresolved:
                    print(f'UNRESOLVED  {rel}  var={var}  expr={reads_expr.get(var, "?")[:70]}')
                continue
            scanned_pairs += 1
            grel = str(Path(os.path.normpath(guarded)).relative_to(root))
            pairs.append(f'{rel} -> {grel}  [{literal}]')
            if wrapped:
                continue
            try:
                gtext = guarded.read_text(encoding='utf-8')
            except OSError as exc:
                print(f'FATAL: unreadable guarded file {grel}: {exc}', file=sys.stderr)
                return 2
            stripped = strip_line_comments(gtext, guarded.suffix)
            if stripped is None:
                no_comment_syntax += 1
                continue
            if literal not in gtext:
                continue
            if literal not in stripped:
                line = next((i + 1 for i, l in enumerate(gtext.splitlines()) if literal in l), 0)
                live.append({'test': rel, 'guarded': grel, 'literal': literal,
                             'first_mention_line': line})
            elif literal not in strip_code_lines(gtext, guarded.suffix):
                # The literal IS in code today, but it is ALSO in a comment — so deleting the
                # code occurrence leaves the guard green over its own subject. Latent, not live,
                # and the distinction is load-bearing: reporting the two as one number is how a
                # "1 finding" answer hides a 40-site class (and how I overstated
                # reality-gate-r3 before this probe existed).
                pass
            elif any(literal in l for l in comment_lines(gtext, guarded.suffix)):
                vulnerable.append({'test': rel, 'guarded': grel, 'literal': literal})

    report = {
        'test_files_scanned': len(tests),
        'literal_assertions_over_a_read_file': assertions,
        'resolved_to_a_real_guarded_file': scanned_pairs,
        'runtime_fixture_read_not_a_source_guard': fixture_reads,
        'unresolvable_path_expression': unresolved,
        'target_absent_in_this_checkout': target_absent,
        'guarded_file_has_no_line_comment_syntax': no_comment_syntax,
        'LIVE_satisfied_by_a_comment_ALONE': len(live),
        'LATENT_also_mentioned_in_a_comment': len(vulnerable),
        'findings': live,
        'latent': vulnerable,
    }
    if args.json:
        print(json.dumps(report, indent=2))
        return 0
    for k, v in report.items():
        if k not in ('findings', 'latent'):
            print(f'{k:44}: {v}')
    if args.list:
        print('\nscanned pairs:')
        for s in sorted(pairs):
            print(f'  {s}')
    print()
    if vulnerable:
        print(f'LATENT — {len(vulnerable)} assertion(s) whose literal is in code AND in a comment,')
        print('         so deleting the code occurrence would leave the guard green:')
        for f in vulnerable:
            print(f"  {f['test']}  asserts '{f['literal']}' over {f['guarded']}")
        print()
    if not live:
        print('No assertion is currently discharged by a comment ALONE.')
        return 0
    print(f'LIVE — {len(live)} assertion(s) a comment alone satisfies:')
    for f in live:
        print(f"  {f['test']}")
        print(f"      asserts '{f['literal']}' over {f['guarded']}")
        print(f"      first mention is a COMMENT at :{f['first_mention_line']}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
