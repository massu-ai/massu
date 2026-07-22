#!/usr/bin/env python3
"""DISCOVER the full candidate set of scanner checks — never a hand-typed list.

CR-52 rule 2: "A universal claim requires a DISCOVERED candidate set. A set typed by hand
is your memory wearing a script's clothes — the command proves nothing no matter how it exits."

G-6's central claim is a universal one: *every* scanner check ships a proof that it can fail.
That claim is only worth anything if the word "every" is computed from the tree, so a check
added tomorrow is in the candidate set tomorrow — without anyone remembering to add it.

A hand-typed list here would defeat the entire gate. This module is the reason it can't be.

── FAIL-POINT GRANULARITY (F1, plan-2026-07-15-wave-1-g6-anti-vacuity-registry P0) ──────────
Decoration does not live per check-HEADER; it lives per fail-PREDICATE. Check 40 alone carries
16 independent `c40fail` fail-points (T-2 is ONE dead sub-predicate of those); Check 27 splits
into 27a/27b. So the true completeness denominator is the set of `fail "…"` / `cNNfail "…"`
CALL SITES — the `fail_points` array below — each mapped to its enclosing check AND its
sub-invariant (the message string). The completeness gate demands a fixture per fail-point,
not per header: a single header-level fixture would leave 15 of Check 40's 16 sub-invariants
unproven — the exact half-covered decoration G-6 exists to end.

Emits JSON on stdout:
    {"checks":       [{"id", "scanner", "check", "title", "line"}...],
     "fail_points":  [{"id", "scanner", "check", "check_num", "line", "helper", "message"}...],
     "symbol_greps": [{"scanner", "check", "line", "symbol", "target", "sense"}...]}

Usage:
    python3 scripts/tests/_discover_scanner_checks.py [--repo-root PATH]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys

# A scanner is any shell script whose name marks it as a scanner or a drift-guard.
# DISCOVERED by pattern from the scripts dir — not enumerated by hand.
# NOTE (plan P0 reconciliation): the fail-point discoverer and the check discoverer MUST
# share this exact predicate, so a fail-point added to any `*-drift.sh` tomorrow is in scope.
SCANNER_NAME_RE = re.compile(r"(scanner|drift)\.sh$")

# A check announces itself:   echo "Check 12: <title>"
CHECK_HDR_RE = re.compile(r'^echo\s+"Check\s+([0-9]+[a-z]?)\s*:\s*(.*?)"')

# A fail-point is a CALL to fail/cNNfail with a message string:  fail "…"  /  c40fail "…"
# (Excludes the helper DEFINITIONS `fail() {` / `c40fail() {`.)
FAIL_DEF_RE = re.compile(r"^\s*(c[0-9]+fail|fail)\s*\(\)\s*\{")
# Locate the helper + opening quote; the MESSAGE body is then parsed shell-aware (below),
# because a message may contain inner `"` inside a `$(basename "$x")` command substitution —
# a naive `"(…)"` capture truncates there and produces a non-distinctive, colliding key.
FAIL_HEAD_RE = re.compile(r'(?:^|[^A-Za-z0-9_])(?P<helper>c[0-9]+fail|fail)\s+"')


def _extract_shell_dquote(line: str, open_idx: int) -> str | None:
    """Extract a shell double-quoted string body starting at the opening `"` (open_idx).

    Respects `$(...)` command substitutions (whose inner `"` do NOT close the outer string)
    and `\\"` escapes. Returns the body (without the surrounding quotes), or None if unterminated.
    """
    i = open_idx + 1
    n = len(line)
    depth = 0  # $( ... ) nesting
    out: list[str] = []
    while i < n:
        c = line[i]
        if c == "\\" and i + 1 < n:
            out.append(line[i:i + 2])
            i += 2
            continue
        if c == "$" and i + 1 < n and line[i + 1] == "(":
            depth += 1
            out.append("$(")
            i += 2
            continue
        if c == ")" and depth > 0:
            depth -= 1
            out.append(")")
            i += 1
            continue
        if c == '"' and depth == 0:
            return "".join(out)
        out.append(c)
        i += 1
    return None

# A bare identifier: the shape of a symbol-grep predicate (T-3). If a check's pass/fail
# hinges on `grep -q "someSymbol" <file>`, then a COMMENT containing that symbol satisfies
# it — the gate can be deleted from the code and the check still reports "intact".
IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

# grep predicate:  [!] grep [-flags] -q[E] "PATTERN" <target>   (the -q "quiet" shape)  — OR
# the count-threshold shape:  [ "$(grep -c "SYM" …)" -lt/-eq/-gt N ]  (F2, CL-11)  — OR
# a bare `if grep "SYM" <target>` with no -q.  ALL are comment-satisfiable and must be seen.
GREP_PRED_Q_RE = re.compile(
    r"""(?P<neg>!\s*)?grep\s+(?:-[A-Za-z]+\s+)*-q[A-Za-z]*\s+
        (?P<quote>["'])(?P<pat>[^"']+)(?P=quote)\s+
        (?P<target>\S+)""",
    re.VERBOSE,
)
GREP_PRED_COUNT_RE = re.compile(
    r"""grep\s+(?:-[A-Za-z]+\s+)*-c[A-Za-z]*\s+
        (?P<quote>["'])(?P<pat>[^"']+)(?P=quote)\s+
        (?P<target>\S+)""",
    re.VERBOSE,
)
# `if grep "SYM" target` / `if ! grep "SYM" target` with NO -q and NO -c — the bare shape.
GREP_PRED_BARE_RE = re.compile(
    r"""\bif\s+(?P<neg>!\s*)?grep\s+(?:-[ELERinolwx]+\s+)*
        (?P<quote>["'])(?P<pat>[^"']+)(?P=quote)\s+
        (?P<target>\S+)""",
    re.VERBOSE,
)


def discover_scanners(repo_root: str) -> list[str]:
    scripts_dir = os.path.join(repo_root, "scripts")
    if not os.path.isdir(scripts_dir):
        # FAIL CLOSED. "I cannot see the scripts dir" must never read as "there are no scanners."
        # That conflation is the exact bug this whole workstream exists to kill.
        raise SystemExit(f"FATAL: no scripts/ dir under {repo_root} — refusing to report zero scanners.")
    found = sorted(
        os.path.join("scripts", f)
        for f in os.listdir(scripts_dir)
        if SCANNER_NAME_RE.search(f)
    )
    if not found:
        raise SystemExit(f"FATAL: discovered ZERO scanners under {scripts_dir} — that cannot be right.")
    return found


def _is_file_target(target: str) -> bool:
    """The grep target must be a file we could read: a shell var or a path."""
    return target.startswith('"$') or target.startswith("$") or "/" in target


# A grep PATTERN that is a shell variable expansion (`$VAR` / `${VAR}`) is NOT a bare-literal
# symbol-grep: the discoverer cannot know the runtime value, so reporting the VARIABLE NAME as
# "the symbol" is a false representation (a comment containing the literal text "VAR" does not
# satisfy `grep "$VAR"`). Class B/C/D of the P3 classification. The genuine T-3 bug is a HARDCODED
# identifier — `grep -q "assertAutoLearningEntitled" file` — which a comment CAN satisfy. Loop-
# driven greps over hardcoded identifiers are a real risk too, but they are converted to the AST
# helper proactively (P3), not tracked by this line-level discoverer, which by design sees only
# the hardcoded-literal form. NOTE the distinction from a regex END-anchor: `foo$` is a literal
# `foo` anchored at end (a real symbol); `$foo` is a variable expansion (skip).
_VAR_EXPANSION_RE = re.compile(r"^\$\{?[A-Za-z_]")


def _is_var_expansion(pat: str) -> bool:
    return bool(_VAR_EXPANSION_RE.match(pat))


_INTERP_RE = re.compile(r"\$\((?:[^()]|\([^()]*\))*\)|\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*")


def _match_signature(message: str) -> str:
    """The longest interpolation-free literal run of a fail message.

    The scanner's RED output shows the EXPANDED message (shell vars filled in), so we cannot
    match the raw message. But every fail-point's message carries at least one distinctive
    LITERAL run between its `$VAR` interpolations, and that run appears verbatim in the expanded
    FAIL line. Matching THAT run — attributed to the right check section — lets the runner prove
    the SPECIFIC sub-invariant fired, not merely that some sibling predicate in the same check
    went red. Without this, planting T-2's fixture and seeing "Check 40 red" could be satisfied
    by any of Check 40's other 15 c40fail sites — the exact half-covered decoration F1 exists to
    end.
    """
    # A scanner may escape `\$` so bash prints a LITERAL `${var}` in its FAIL line (the runtime
    # line therefore contains `${var}`, not an interpolated value, and — crucially — NO backslash).
    # Blanking interpolations on the RAW message would match `\${var}` starting at `$`, stranding the
    # preceding backslash inside the literal run (`…@massu/core@\`), a substring the runtime line
    # never contains → the DEFEAT match could never fire. Normalize `\$`->`$` FIRST so the literal
    # runs carry no stray backslash. `_fail_point_id` hashes the RAW message, so ids are unaffected.
    message = message.replace("\\$", "$")
    skeleton = _INTERP_RE.sub("\x00", message)
    runs = [r.strip() for r in skeleton.split("\x00")]
    runs = [r for r in runs if len(r) >= 8]
    if runs:
        return max(runs, key=len)
    # No literal run >= 8 chars (a message that is almost all interpolation). Fall back to the
    # cleaned whole message; the runner asserts non-empty, so this can never silently vanish.
    return skeleton.replace("\x00", " ").strip()


def _fail_point_id(check_id: str, message: str, seen: dict[str, int]) -> str:
    """Stable, human-anchored fail-point id: {check-id}--{msg-hash10}.

    Keyed on the MESSAGE (the sub-invariant), NOT the line number — so a fixture survives
    unrelated edits above it, and a MEANINGFUL edit to the sub-invariant's wording changes the
    id and correctly forces a fresh fixture ruling (that is a feature, not drift). Collisions
    (two identical messages in one check) are disambiguated deterministically by occurrence.
    """
    h = hashlib.md5(message.encode("utf-8")).hexdigest()[:10]
    base = f"{check_id}--{h}"
    n = seen.get(base, 0)
    seen[base] = n + 1
    return base if n == 0 else f"{base}-{n}"


def discover(repo_root: str) -> dict:
    checks: list[dict] = []
    fail_points: list[dict] = []
    symbol_greps: list[dict] = []

    for rel in discover_scanners(repo_root):
        path = os.path.join(repo_root, rel)
        lines = open(path, encoding="utf-8", errors="replace").read().split("\n")

        headers = [
            (i, m.group(1), m.group(2))
            for i, line in enumerate(lines)
            for m in [CHECK_HDR_RE.match(line)]
            if m
        ]

        # Attribute any line to the check block it falls in (most recent preceding header).
        # Fail-points before the first header (there are none today, but fail-closed if added)
        # are attributed to a synthetic "preamble" check so they are NEVER silently dropped.
        def check_num_at(line_idx: int) -> str | None:
            cur = None
            for ln, num, _ in headers:
                if ln <= line_idx:
                    cur = num
                else:
                    break
            return cur

        scanner_base = os.path.basename(rel).replace("massu-", "").replace(".sh", "")
        fp_seen: dict[str, int] = {}

        for idx, (ln, num, title) in enumerate(headers):
            end = headers[idx + 1][0] if idx + 1 < len(headers) else len(lines)
            checks.append(
                {
                    "id": f"{scanner_base}-{num}",
                    "scanner": rel,
                    "check": num,
                    "title": title,
                    "line": ln + 1,
                }
            )

            # Within this check's block, find bare-symbol grep predicates (T-3).
            for off, body in enumerate(lines[ln:end]):
                m = GREP_PRED_Q_RE.search(body)
                if not m:
                    continue
                target = m.group("target").strip()
                if not _is_file_target(target):
                    continue
                pat = m.group("pat")
                if _is_var_expansion(pat):
                    continue
                core = pat.strip("^$").replace("\\", "")
                if IDENT_RE.match(core):
                    symbol_greps.append(
                        {
                            "scanner": rel,
                            "check": num,
                            "line": ln + 1 + off,
                            "symbol": core,
                            "target": target,
                            "sense": "MISSING_FAILS" if m.group("neg") else "PRESENT_FAILS",
                        }
                    )

        # ── FAIL-POINTS (F1): every fail/cNNfail CALL SITE, whole-file scan, attributed. ──
        # Whole-file (not per-block) so a fail-point in a shared helper or before the first
        # header is still discovered and flagged — never silently dropped (blind-gate M2).
        for i, line in enumerate(lines):
            if FAIL_DEF_RE.match(line):
                continue
            m = FAIL_HEAD_RE.search(line)
            if not m:
                continue
            open_idx = line.index('"', m.end("helper"))
            message = _extract_shell_dquote(line, open_idx)
            if message is None:
                # Unterminated on this line (a multi-line message). Fail-closed: keep the
                # partial as the key so it is DISCOVERED and flagged, never silently dropped.
                message = line[open_idx + 1:]
            num = check_num_at(i)
            check_id = f"{scanner_base}-{num}" if num is not None else f"{scanner_base}-preamble"
            fail_points.append(
                {
                    "id": _fail_point_id(check_id, message, fp_seen),
                    "scanner": rel,
                    "check": check_id,
                    "check_num": num,
                    "line": i + 1,
                    "helper": m.group("helper"),
                    "message": message,
                    "match": _match_signature(message),
                }
            )

        # ── EXTRA symbol-grep shapes the -q form misses (F2, CL-11) ──────────────────────
        # Count-threshold `grep -c "SYM" … -lt/-eq/-gt N` and bare `if grep "SYM" target`.
        for i, line in enumerate(lines):
            num = check_num_at(i)
            if num is None:
                continue
            for rx, sense in ((GREP_PRED_COUNT_RE, "COUNT_THRESHOLD"), (GREP_PRED_BARE_RE, None)):
                m = rx.search(line)
                if not m:
                    continue
                target = m.group("target").strip()
                if not _is_file_target(target):
                    continue
                pat = m.group("pat")
                if _is_var_expansion(pat):
                    continue
                core = pat.strip("^$").replace("\\", "")
                if not IDENT_RE.match(core):
                    continue
                s = sense or ("MISSING_FAILS" if m.groupdict().get("neg") else "PRESENT_FAILS")
                key = (rel, num, i + 1, core)
                if any((x["scanner"], x["check"], x["line"], x["symbol"]) == key for x in symbol_greps):
                    continue
                symbol_greps.append(
                    {
                        "scanner": rel,
                        "check": num,
                        "line": i + 1,
                        "symbol": core,
                        "target": target,
                        "sense": s,
                    }
                )

    return {"checks": checks, "fail_points": fail_points, "symbol_greps": symbol_greps}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--repo-root",
        default=os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")),
    )
    args = ap.parse_args()
    result = discover(args.repo_root)
    # M1 — PROVE IT LOOKED. The denominator must be non-zero; "scanned 0, found 0" is a LOUD
    # error, never a silent pass. An empty fail-point set means the scanners changed shape
    # under us or discovery broke — either way, refuse to report success.
    if not result["fail_points"]:
        raise SystemExit("FATAL: discovered ZERO fail-points across all scanners — refusing to report an empty candidate set.")
    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
