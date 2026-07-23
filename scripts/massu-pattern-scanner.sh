#!/usr/bin/env bash
#
# massu-pattern-scanner.sh - Massu Pattern Compliance Checker
#
# Checks for coding pattern violations in the Massu codebase.
# Exit 0 = PASS (no violations), Exit 1 = FAIL (violations found)
#
# Usage: bash scripts/massu-pattern-scanner.sh [--quick]

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# CWD-independence (incident 2026-07-20): several checks (26, 27, 43, …) use
# repo-root-RELATIVE paths (e.g. `scripts/pre-push-light.sh`, `packages/core/templates`).
# When invoked from a non-root CWD — e.g. npm runs `prepublishOnly` from
# `packages/core/` — those relative paths resolve against the wrong dir, so Check 26
# and Check 43 FAIL-CLOSED (blocked the 1.16.3 publish) and Check 27 silently SKIPS
# (false green). Pin the working dir to REPO_ROOT so EVERY check — relative or
# $REPO_ROOT-absolute — resolves correctly regardless of invocation cwd.
cd "$REPO_ROOT" || { echo "FATAL: cannot cd to REPO_ROOT $REPO_ROOT" >&2; exit 2; }
SRC_DIR="$REPO_ROOT/packages/core/src"
VIOLATIONS=0
QUICK_MODE="${1:-}"

# SF-2 (audit 2026-07-14) — THE BLIND-GATE GUARD. Nearly every check greps a file
# list rooted at a scan directory. If that directory is missing/renamed, `find`
# and `grep` return NOTHING, every check's loop runs zero times, and the scanner
# reports "all clean" while having looked at nothing — "could not look" and
# "looked, found nothing" collapse to the same PASS. Assert the scan roots are
# present AND non-empty BEFORE any check runs, so a moved source tree FAILS LOUD
# (M1 prove-it-looked / M2 fail-closed) instead of silently passing.
assert_scan_root_nonempty() {
  local dir="$1"
  if [[ ! -d "$dir" ]]; then
    echo "FATAL: pattern-scanner scan root '$dir' does not exist — cannot see the code it must check. Refusing to report clean (SF-2)." >&2
    exit 3
  fi
  local count
  count=$(find "$dir" -type f -name "*.ts" 2>/dev/null | head -n 1 | wc -l | tr -d ' ')
  if [[ "$count" -eq 0 ]]; then
    echo "FATAL: pattern-scanner scan root '$dir' contains zero *.ts files — a blind scan would report clean. Refusing (SF-2)." >&2
    exit 3
  fi
}
assert_scan_root_nonempty "$SRC_DIR"
# website/src is a scan target for several checks; assert it too when the website
# package is present (a website-less checkout, e.g. the public repo, legitimately
# has no website/ — but a renamed website/src while website/ exists must FAIL).
if [[ -d "$REPO_ROOT/website" ]]; then
  assert_scan_root_nonempty "$REPO_ROOT/website/src"
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Awk portability shim (P-E-003): macOS ships BSD awk which rejects ERE
# escapes like `require\(`. Prefer GNU awk (gawk) when available — falls
# back to system awk + caller-side `[(]` escaping for portability.
if command -v gawk >/dev/null 2>&1; then
  AWK="gawk"
else
  AWK="awk"
fi

pass() { echo -e "  ${GREEN}PASS${NC}: $1"; }
fail() { echo -e "  ${RED}FAIL${NC}: $1"; VIOLATIONS=$((VIOLATIONS + 1)); }
warn() { echo -e "  ${YELLOW}WARN${NC}: $1"; }

# ast_present <file> <symbol> [kind] [min-count]
#   Exit 0 iff <symbol> occurs as REAL CODE in <file> (per <kind>), NOT merely as text in a
#   comment or a string literal. The comment-and-string-immune replacement for the T-3
#   symbol-greps (plan P3 / F5): `grep -q "X" file` is satisfied by a COMMENT — the CR-54 gate
#   was DELETED and the identifier survived in a comment, and Check 30 reported "wiring intact."
#   TS/JS → TypeScript-compiler AST; SQL/shell → comment+string-strip then whole-word token.
#   FAIL-CLOSED: a missing/unreadable file or unknown extension exits 2 (an ERROR, never "absent").
AST_SYMBOL_PRESENT="$REPO_ROOT/scripts/lib/ast-symbol-present.mjs"
ast_present() { # <file> <symbol> [kind=reference] [min-count]
  local f="$1" s="$2" k="${3:-reference}" mc="${4:-}"
  if [ -n "$mc" ]; then
    node "$AST_SYMBOL_PRESENT" --file "$f" --symbol "$s" --kind "$k" --min-count "$mc"
  else
    node "$AST_SYMBOL_PRESENT" --file "$f" --symbol "$s" --kind "$k"
  fi
}

# ----------------------------------------------------------
# scan_with_directive — context-aware violation matcher
# (Plan 2026-05-07-pattern-scanner-fail-fixes / CR-46 #2)
#
# Per-line `grep` cannot consult the previous line, so the previous
# scanner could not honor a `// pattern-scanner-allow: <key>` directive
# placed on the line BEFORE a violating call. This helper uses awk to
# track the immediately-preceding line's directive marker and skip
# matching call sites whose preceding line authorized them.
#
# Usage:
#   scan_with_directive '<violation_extended_regex>' '<directive_key>' \
#     [<extra-bash-glob-exclude>...]
#
# Args:
#   $1 = ERE regex matching the call shape (passed to awk via $0 ~ ...)
#   $2 = directive key (matched against `pattern-scanner-allow:[ws]<key>`)
#   $@ = optional extra `case`-style glob patterns; files matching ANY
#        glob are skipped. (Always-skipped: __tests__/, node_modules/,
#        *.test.ts.) The match runs on the absolute file path.
#
# Output: lines as `path:lineno:content` for every UNAUTHORIZED hit.
# Comment-only lines (JSDoc `*`, inline `//`, block `/*`) are dropped
# even without a directive so doc strings that mention an API name
# do not false-positive.
# ----------------------------------------------------------
scan_with_directive() {
  local violation_regex="$1"
  local directive_key="$2"
  shift 2
  local extra_excludes=("$@")

  while IFS= read -r f; do
    [ -z "$f" ] && continue
    local skip=0
    for pat in "${extra_excludes[@]}"; do
      case "$f" in
        $pat) skip=1; break ;;
      esac
    done
    [ "$skip" = "1" ] && continue
    "$AWK" -v file="$f" -v vre="$violation_regex" -v key="$directive_key" '
      # Directive line — set allow for the next NON-COMMENT, NON-BLANK line.
      $0 ~ "pattern-scanner-allow:[[:space:]]*" key { allow_next = 1; next }
      # Violation candidate.
      $0 ~ vre {
        if (allow_next) { allow_next = 0; next }
        # Skip if the match itself is inside a comment line.
        if ($0 ~ /^[[:space:]]*(\*|\/\/|\/\*)/) { next }
        print file ":" NR ":" $0
        next
      }
      # Allow flag persists through comment-only and blank lines so a
      # multi-line allow rationale (block-comment style) does not break
      # the bridge between directive and the actual call line. Reset only
      # on the first NON-COMMENT, NON-BLANK line.
      $0 ~ /^[[:space:]]*$/ { next }
      $0 ~ /^[[:space:]]*(\*|\/\/|\/\*)/ { next }
      { allow_next = 0 }
    ' "$f"
  done < <(find "$SRC_DIR" -name "*.ts" \
    -not -path "*/node_modules/*" \
    -not -path "*/__tests__/*" \
    -not -name "*.test.ts" \
    2>/dev/null)
}

echo "=== Massu Pattern Scanner ==="
echo ""

# -------------------------------------------------------
# Check 1: No require() in source (ESM only)
# Excludes: hooks/ (bundled by esbuild, require is valid)
#
# Plan 2026-05-07-pattern-scanner-fail-fixes refactor:
#   - Uses scan_with_directive helper (awk-based context-aware match).
#   - Comment-line filter (JSDoc `*`, inline `//`, block `/*`) is built
#     into the helper, so doc strings that document attack vectors
#     containing `require()` no longer false-positive.
#   - Per-line directive recognizer (`// pattern-scanner-allow: require
#     — reason: <reason>` placed on the line BEFORE the call) lets
#     legitimate require sites carry an in-source allow directive,
#     mirroring scripts/massu-public-leak-guard.sh:179.
# -------------------------------------------------------
echo "Check 1: No require() in source files"
REQUIRE_HITS=$(scan_with_directive 'require[(]' 'require' '*/hooks/*')
REQUIRE_COUNT=$(printf '%s\n' "$REQUIRE_HITS" | grep -c . || true)
if [ "$REQUIRE_COUNT" -gt 0 ]; then
  fail "Found $REQUIRE_COUNT require() calls in src/ (use ESM imports OR add a // pattern-scanner-allow: require directive on the line BEFORE the call)"
  printf '%s\n' "$REQUIRE_HITS" | head -5
else
  pass "No require() calls found"
fi

# -------------------------------------------------------
# Check 2: No hardcoded tool prefixes (should use getConfig().toolPrefix)
# Detects string literals like 'massu_ or "massu_ that indicate hardcoded prefixes
# -------------------------------------------------------
echo "Check 2: No hardcoded tool prefixes in source"
HARDCODED_PREFIX_COUNT=$(grep -rn "'massu_\|\"massu_" "$SRC_DIR" --include="*.ts" \
  | grep -v '__tests__' \
  | grep -v 'node_modules' \
  | grep -v '\.test\.ts:' \
  | grep -v '// ' \
  | wc -l | tr -d ' ')
if [ "$HARDCODED_PREFIX_COUNT" -gt 0 ]; then
  warn "Found $HARDCODED_PREFIX_COUNT hardcoded tool prefix references (should use getConfig().toolPrefix)"
  grep -rn "'massu_\|\"massu_" "$SRC_DIR" --include="*.ts" \
    | grep -v '__tests__' | grep -v 'node_modules' | grep -v '\.test\.ts:' \
    | head -5
else
  pass "No hardcoded tool prefixes found"
fi

# -------------------------------------------------------
# Check 3: No process.exit() in library code
# Excludes: server.ts (entrypoint), hooks/ (standalone scripts),
#           *-runner.ts (standalone CLI scripts), cli.ts (CLI entry),
#           commands/ (CLI commands that need exit codes),
#           lib/node-bootstrap.ts (CR-70 launcher chokepoint — `bootstrapNodeOrExit`
#             re-execs or exits by contract; same process-controlling class as cli.ts).
# -------------------------------------------------------
echo "Check 3: No process.exit() in library code"
PROCESS_EXIT_COUNT=$(grep -rn 'process\.exit' "$SRC_DIR" --include="*.ts" \
  | grep -v 'server\.ts' \
  | grep -v '__tests__' \
  | grep -v '\.test\.ts:' \
  | grep -v 'node_modules' \
  | grep -v 'hooks/' \
  | grep -v '\-runner\.ts' \
  | grep -v 'backfill-' \
  | grep -v 'cli\.ts' \
  | grep -v 'lib/node-bootstrap\.ts' \
  | grep -v 'commands/' \
  | wc -l | tr -d ' ')
if [ "$PROCESS_EXIT_COUNT" -gt 0 ]; then
  fail "Found $PROCESS_EXIT_COUNT process.exit() calls in library code"
  grep -rn 'process\.exit' "$SRC_DIR" --include="*.ts" \
    | grep -v 'server\.ts' | grep -v '__tests__' | grep -v 'hooks/' | grep -v '\-runner\.ts' | grep -v 'backfill-' \
    | grep -v 'cli\.ts' | grep -v 'lib/node-bootstrap\.ts' | grep -v 'commands/' \
    | head -5
else
  pass "No process.exit() in library code"
fi

# -------------------------------------------------------
# Check 4: ESM exports only (no module.exports)
# -------------------------------------------------------
echo "Check 4: No module.exports in source"
MODULE_EXPORTS_COUNT=$(grep -rn 'module\.exports' "$SRC_DIR" --include="*.ts" \
  | grep -v '__tests__' \
  | grep -v 'node_modules' \
  | grep -v '\.test\.ts:' \
  | wc -l | tr -d ' ')
if [ "$MODULE_EXPORTS_COUNT" -gt 0 ]; then
  fail "Found $MODULE_EXPORTS_COUNT module.exports (use ESM export)"
  grep -rn 'module\.exports' "$SRC_DIR" --include="*.ts" | grep -v '__tests__' | head -5
else
  pass "No module.exports found"
fi

# -------------------------------------------------------
# Check 5: Config via getConfig() only (no direct yaml.parse)
#
# Plan 2026-05-07-pattern-scanner-fail-fixes restructure:
#   - The previous regex `parse.*yaml` was overbroad: matched ANY line
#     containing `parse` followed by `yaml`, including comments like
#     `// Re-parse via getConfig() to validate the mutated yaml`.
#   - The previous file-name exclusion list (8 files: 5 commands +
#     hooks/ + memory-file-ingest + monorepo-detector) was the N+1th
#     alias map — every legitimate yaml-parse needed a scanner edit.
#     CR-46 #3 forbids that pattern; this check now uses per-call-site
#     directives instead, co-located with the code they document.
#
# Restructured via scan_with_directive helper:
#   - Tightened regex (`yaml\.parse[A-Za-z]*\(|parseYaml\(|yamlParse\(|
#     parseDocument\(`) requires an opening paren — only call sites
#     match, NOT comment mentions or import statements.
#   - Comment-line filter is built into the helper.
#   - Per-line directive `// pattern-scanner-allow: yaml-parse` placed
#     on the line BEFORE the call exempts the call. Mirrors leak-guard's
#     `# leak-guard-allow:` pattern at scripts/massu-public-leak-guard.sh:179.
#   - Single excluded path: config.ts (THE canonical getConfig
#     implementation; exempting via directive would be redundant).
# -------------------------------------------------------
echo "Check 5: Config access via getConfig() only"
YAML_HITS=$(scan_with_directive 'yaml\.parse[A-Za-z]*[(]|parseYaml[(]|yamlParse[(]|parseDocument[(]' 'yaml-parse' '*/config.ts')
YAML_COUNT=$(printf '%s\n' "$YAML_HITS" | grep -c . || true)
if [ "$YAML_COUNT" -gt 0 ]; then
  fail "Found $YAML_COUNT direct YAML parse calls outside config.ts (use getConfig() OR add a // pattern-scanner-allow: yaml-parse directive on the line BEFORE the call)"
  printf '%s\n' "$YAML_HITS" | head -5
else
  pass "Config access via getConfig() only"
fi

# -------------------------------------------------------
# Check 6: `as any` count below threshold
# -------------------------------------------------------
echo "Check 6: 'as any' usage below threshold"
AS_ANY_THRESHOLD=20
AS_ANY_COUNT=$(grep -rn 'as any' "$SRC_DIR" --include="*.ts" \
  | grep -v '__tests__' \
  | grep -v 'node_modules' \
  | grep -v '\.test\.ts:' \
  | wc -l | tr -d ' ')
if [ "$AS_ANY_COUNT" -gt "$AS_ANY_THRESHOLD" ]; then
  fail "Found $AS_ANY_COUNT 'as any' casts (threshold: $AS_ANY_THRESHOLD)"
else
  pass "'as any' count ($AS_ANY_COUNT) within threshold ($AS_ANY_THRESHOLD)"
fi

# -------------------------------------------------------
# Check 7: Test files in __tests__/ directories
# -------------------------------------------------------
echo "Check 7: Test files in __tests__/ directories"
MISPLACED_TESTS=$(find "$SRC_DIR" -name "*.test.ts" -not -path "*/__tests__/*" -not -path "*/node_modules/*" 2>/dev/null | wc -l | tr -d ' ')
if [ "$MISPLACED_TESTS" -gt 0 ]; then
  fail "Found $MISPLACED_TESTS test files outside __tests__/ directories"
  find "$SRC_DIR" -name "*.test.ts" -not -path "*/__tests__/*" -not -path "*/node_modules/*" | head -5
else
  pass "All test files in __tests__/ directories"
fi

# -------------------------------------------------------
# Check 8: No secrets in source
# Excludes: regex patterns that reference secret keywords
#           for redaction/detection purposes
# -------------------------------------------------------
echo "Check 8: No hardcoded secrets in source"
SECRETS_COUNT=$(grep -rn 'sk-[a-zA-Z0-9]\{20,\}\|password.*=.*["\x27][^"\x27]\{8,\}' "$SRC_DIR" --include="*.ts" \
  | grep -v '__tests__' \
  | grep -v 'node_modules' \
  | grep -v 'process\.env' \
  | grep -v '\.test\.ts:' \
  | grep -v '\.replace(' \
  | grep -v 'RegExp\|regex\|REDACT\|redact\|sanitize\|mask' \
  | wc -l | tr -d ' ')
if [ "$SECRETS_COUNT" -gt 0 ]; then
  fail "Found $SECRETS_COUNT potential hardcoded secrets"
  grep -rn 'sk-[a-zA-Z0-9]\{20,\}\|password.*=.*["\x27][^"\x27]\{8,\}' "$SRC_DIR" --include="*.ts" \
    | grep -v '__tests__' | grep -v 'process\.env' | grep -v '\.replace(' \
    | grep -v 'RegExp\|regex\|REDACT\|redact\|sanitize\|mask' \
    | head -5
else
  pass "No hardcoded secrets found"
fi

# -------------------------------------------------------
# Check 9: Knowledge system file patterns
# Verifies getCodeGraphDb() is used (not direct sqlite opens) in knowledge-related files
#
# T-1 FIX (plan-2026-07-15-wave-1-g6-anti-vacuity-registry P1): the old predicate grepped
# 'new Database\|sqlite3\(' as a BRE. The `\(` is an UNBALANCED group in a BRE — real grep
# errors "parentheses not balanced" and exits 2; `2>/dev/null` swallowed it; the count was 0;
# the check reported PASS and had NEVER run. Replaced with an ERE that matches the literal
# open `new Database(`, and the `2>/dev/null` is REMOVED so a future regex error is LOUD (CR-69).
#
# ACCESSOR ALLOWLIST (F4 / R2-2/R2-3) — excluded by EXACT basename. Because the ERE now really
# matches, the accessor modules AND the six legitimate non-accessor openers match too; without
# an allowlist the check would go RED on the pristine tree. Each exclusion is RULED, never a
# blanket to make the tree pass (that would be the exact CR-11 laundering this check prevents):
#   • db.ts / memory-db.ts / knowledge-db.ts — the accessor modules THEMSELVES (they ARE the
#     canonical openers; the old over-broad `db\.ts` regex silently also matched knowledge-db.ts,
#     R2-2, so it was never ruled — exact-basename fixes that).
#   • preflight.ts / validate-features-runner.ts / db-backup.ts — read-only integrity/validation
#     probes that open a caller-PROVIDED, possibly-MISSING DB path with `{ readonly: true }`; the
#     accessors open FIXED resolved paths and auto-create, which is wrong for probing. None write.
#   • hooks/post-edit-context.ts / hooks/pre-delete-check.ts / hooks/session-start.ts — hooks are
#     esbuild-bundled STANDALONE with `--external:better-sqlite3` and must not import the heavy
#     accessor module graph (CLAUDE.md: "Never import heavy dependencies in hooks"). Read-only.
#   • lib/sqlite-loader.ts — the SSOT native-load chokepoint (CR-65, plan-massu-resilience-
#     layer1). Every accessor/probe/hook now routes its construction through openDatabase()
#     HERE; this is the ONE place allowed to construct better-sqlite3 directly, so the ABI
#     failure is detected, self-healed, and typed-error'd once. Enforced by Check 42 + the
#     sqlite-loader-drift-guard test (which assert nothing ELSE value-loads better-sqlite3).
# A NEW file opening a DB directly is NOT in this list → it is counted and the check goes RED,
# forcing a fresh per-opener ruling. (10 openers today: 3 accessors + 6 probes/hooks + the loader.)
# -------------------------------------------------------
echo "Check 9: Knowledge system uses getCodeGraphDb()"
CHECK9_ACCESSOR_ALLOWLIST='(^|/)(db|memory-db|knowledge-db|preflight|validate-features-runner|db-backup|post-edit-context|pre-delete-check|session-start|sqlite-loader)\.ts$'
KNOWLEDGE_FILES=$(find "$SRC_DIR" -name "*.ts" \
  -not -path "*/__tests__/*" \
  -not -path "*/node_modules/*" \
  -not -name "*.test.ts" \
  2>/dev/null)
DIRECT_SQLITE_COUNT=0
DIRECT_SQLITE_FILES=""
if [ -n "$KNOWLEDGE_FILES" ]; then
  # NOTE: no 2>/dev/null on the classifying grep (CR-69) — a regex error must be LOUD, not
  # swallowed into a silent count of 0. `grep -l` exiting 1 on no-match is normal, not an error.
  DIRECT_SQLITE_FILES=$(echo "$KNOWLEDGE_FILES" | xargs grep -lE 'new Database\(' \
    | grep -vE "$CHECK9_ACCESSOR_ALLOWLIST" || true)
  DIRECT_SQLITE_COUNT=$(printf '%s' "$DIRECT_SQLITE_FILES" | grep -c . || true)
fi
if [ "$DIRECT_SQLITE_COUNT" -gt 0 ]; then
  fail "Found $DIRECT_SQLITE_COUNT files opening SQLite directly (use getCodeGraphDb()/getDataDb()/getMemoryDb())"
  printf '%s\n' "$DIRECT_SQLITE_FILES" | head -5
else
  pass "Knowledge system uses DB accessor functions only"
fi

# -------------------------------------------------------
# Check 10: Memory system patterns (P-E-004 — per-file leak detection)
# Verifies every file that calls getMemoryDb() also contains a .close()
# call on SOME variable. The original count-based check produced false
# positives when files used variable names other than `memDb` (db, memoryDb,
# mdb) or used a centralized close helper.
# -------------------------------------------------------
echo "Check 10: Memory DB closed after use (try/finally pattern)"
MEMORY_LEAK_FILES=""
MEMORY_LEAK_COUNT=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  # File contains getMemoryDb() (excluding the helper itself)?
  case "$f" in
    */memory-db.ts) continue ;;
    */__tests__/*) continue ;;
    *.test.ts) continue ;;
  esac
  # Detect actual getMemoryDb() CALLS (not comment-line references).
  # here-string, not a `grep … | grep -q` pipeline (broken-pipe-race-free; incident 2026-07-16).
  mem_calls="$(grep -nE '^[[:space:]]*[^[:space:]/*]+.*getMemoryDb\(\)' "$f" 2>/dev/null)"
  if [ -n "$mem_calls" ] && grep -qv '^[[:space:]]*//' <<<"$mem_calls" ; then
    # Look for ANY `.close()` or `?.close()` call in the same file
    # (try/finally, helper, optional-chain — all valid close patterns).
    if ! grep -qE '\b[A-Za-z_][A-Za-z0-9_]*\??\.close\(\)' "$f" 2>/dev/null; then
      MEMORY_LEAK_FILES="$MEMORY_LEAK_FILES$f\n"
      MEMORY_LEAK_COUNT=$((MEMORY_LEAK_COUNT + 1))
    fi
  fi
done < <(find "$SRC_DIR" -name "*.ts" -not -path "*/node_modules/*" 2>/dev/null)

if [ "$MEMORY_LEAK_COUNT" -gt 0 ]; then
  warn "$MEMORY_LEAK_COUNT file(s) call getMemoryDb() but contain no .close() — possible leaks:"
  printf '%b' "$MEMORY_LEAK_FILES" | head -5
else
  pass "Memory DB open/close balanced (every file calling getMemoryDb() has a matching .close())"
fi

# -------------------------------------------------------
# Check 11: Shell hook existence
# Verifies that compiled hooks exist for each hook source
# -------------------------------------------------------
echo "Check 11: Compiled hooks exist for each hook source"
HOOKS_SRC_DIR="$SRC_DIR/hooks"
HOOKS_DIST_DIR="$REPO_ROOT/packages/core/dist/hooks"
MISSING_HOOKS=0
if [ -d "$HOOKS_SRC_DIR" ]; then
  for hook_src in "$HOOKS_SRC_DIR"/*.ts; do
    [ ! -f "$hook_src" ] && continue
    hook_name=$(basename "$hook_src" .ts)
    compiled="$HOOKS_DIST_DIR/${hook_name}.js"
    if [ ! -f "$compiled" ]; then
      warn "Compiled hook missing: dist/hooks/${hook_name}.js (run: npm run build:hooks)"
      MISSING_HOOKS=$((MISSING_HOOKS + 1))
    fi
  done
  if [ "$MISSING_HOOKS" -eq 0 ]; then
    pass "All hook sources have compiled counterparts in dist/hooks/"
  fi
else
  warn "Hooks source directory not found: $HOOKS_SRC_DIR"
fi

# -------------------------------------------------------
# Check 12: Adapter import direction guard (Plan 3c Phase 9b P-B-005)
# Verifies that `packages/core/src/` only imports from `@massu/adapter-*`
# inside the re-export shims at `packages/core/src/detect/adapters/<id>.ts`.
# Anywhere else creates circular runtime deps (core depends on adapters,
# adapters depend on core via @massu/core/adapter).
# -------------------------------------------------------
echo "Check 12: Adapter import direction guard"
DIRECTION_VIOLATIONS=$(grep -rn "from '@massu/adapter-" "$SRC_DIR" --include="*.ts" 2>/dev/null \
  | grep -v "__tests__" \
  | grep -v "\.test\.ts:" \
  | grep -v "/detect/adapters/\(rails\|phoenix\|aspnet\|spring\|go-chi\)\.ts:" \
  || true)
if [ -n "$DIRECTION_VIOLATIONS" ]; then
  fail "Forbidden imports from @massu/adapter-* outside re-export shims:"
  echo "$DIRECTION_VIOLATIONS" | head -10
else
  pass "Adapter import direction respected (core → adapter only via shims)"
fi

# -------------------------------------------------------
# Check 13: Generalization compliance
# Runs the generalization scanner to verify no project-specific
# references leaked into shipped files
# -------------------------------------------------------
echo "Check 13: Generalization compliance"
GEN_SCANNER="$REPO_ROOT/scripts/massu-generalization-scanner.sh"
if [ -f "$GEN_SCANNER" ]; then
  if bash "$GEN_SCANNER" > /tmp/gen-scanner.log 2>&1; then
    pass "Generalization scanner passed"
  else
    fail "Generalization scanner found violations (see: bash scripts/massu-generalization-scanner.sh)"
    tail -5 /tmp/gen-scanner.log
  fi
else
  warn "Generalization scanner not found: $GEN_SCANNER"
fi

# -------------------------------------------------------
# Check 14: Tool DB-needs manifest completeness (plan-1.6.2-server-lazy-db-deps P-B-004)
# Every tool registered via `name: p('...')` or `name: \`${pfx}_...\``
# in packages/core/src/*.ts MUST have a corresponding entry in
# packages/core/src/tool-db-needs.ts. Grep-level safety net before the
# AST completeness test (tool-db-needs-completeness.test.ts) runs.
# -------------------------------------------------------
echo "Check 14: Tool DB-needs manifest completeness"
MANIFEST="$REPO_ROOT/packages/core/src/tool-db-needs.ts"
if [ -f "$MANIFEST" ]; then
  MISSING=0
  MISSING_TOOLS=""
  # Extract tool short-names from all *-tools.ts and listed handler modules.
  # Pattern 1: `name: p('<short>'),` — used in tools.ts
  # Pattern 2: `name: \`${prefix}_<short>\`,` — used in module *-tools.ts files
  TOOL_NAMES=$(grep -rE "name: \`?\\\$\{(prefix|pfx)\}_[a-z_]+\`?|name: p\('[a-z_]+'\)" \
    "$REPO_ROOT/packages/core/src/"*.ts 2>/dev/null \
    | grep -v "__tests__\|tool-db-needs.ts\|test-" \
    | sed -nE "s/.*[\`']([a-z_]+)[\`'].*/\1/p" \
    | sed -nE "s/.*\\\$\{(prefix|pfx)\}_([a-z_]+).*/\2/p" \
    | sort -u)
  # Fallback: use a simpler grep pipeline if the complex one returned nothing
  if [ -z "$TOOL_NAMES" ]; then
    TOOL_NAMES=$(grep -hoE "name: \`?\\\$\{(prefix|pfx)\}_[a-z_]+\`?|name: p\('[a-z_]+'\)" \
      "$REPO_ROOT/packages/core/src/"*.ts 2>/dev/null \
      | sed -E "s/name: p\('([a-z_]+)'\)/\1/; s/name: \`?\\\$\{(prefix|pfx)\}_([a-z_]+)\`?/\2/" \
      | grep -E "^[a-z_]+$" \
      | sort -u)
  fi
  while IFS= read -r tool; do
    [ -z "$tool" ] && continue
    if ! grep -q "^  ${tool}:" "$MANIFEST"; then
      MISSING=$((MISSING + 1))
      MISSING_TOOLS="$MISSING_TOOLS $tool"
    fi
  done <<< "$TOOL_NAMES"
  if [ "$MISSING" -eq 0 ]; then
    pass "All registered tools have a TOOL_DB_NEEDS manifest entry"
  else
    fail "$MISSING tool(s) missing from TOOL_DB_NEEDS manifest:$MISSING_TOOLS"
    info "Add entries to packages/core/src/tool-db-needs.ts"
  fi
else
  warn "TOOL_DB_NEEDS manifest not found: $MANIFEST"
fi

# -------------------------------------------------------
# Check 15: Public page nav-link coverage (plan-1.6.3-website-feature-discoverability P-B-001)
# Every public page under website/src/app/ that is NOT under a hidden-prefix
# (dashboard, etc.) AND is not in the auth/checkout flow AND is not a
# dynamic [slug] route AND is not in WEBSITE_NAV_EXEMPT MUST be linked from
# either Navbar.mainNav or Footer.linkGroups. Eliminates the orphan-page
# bug class (CR-39 inverse: a feature with no nav link is not shipped).
#
# Override per-page via website/src/data/nav-exempt.ts:WEBSITE_NAV_EXEMPT
# (each entry requires a JSDoc explaining the intentional exemption).
# -------------------------------------------------------
echo "Check 15: Public page nav-link coverage"
NAV_EXEMPT_FILE="$REPO_ROOT/website/src/data/nav-exempt.ts"
NAVIGATION_FILE="$REPO_ROOT/website/src/data/navigation.ts"
FOOTER_FILE="$REPO_ROOT/website/src/components/layout/Footer.tsx"
APP_DIR="${MASSU_TEST_ORPHAN_DIR:-$REPO_ROOT/website/src/app}"

if [ ! -f "$NAV_EXEMPT_FILE" ] || [ ! -f "$NAVIGATION_FILE" ] || [ ! -f "$FOOTER_FILE" ]; then
  warn "Check 15 skipped: required file(s) missing (nav-exempt.ts, navigation.ts, or Footer.tsx)"
elif [ ! -d "$APP_DIR" ]; then
  warn "Check 15 skipped: app dir not found at $APP_DIR"
else
  # Extract hidden prefixes from nav-exempt.ts. Greps `'/foo'` literal entries
  # in the WEBSITE_NAV_HIDDEN_PREFIXES block; falls back to the canonical
  # default '/dashboard' if the parse returns nothing.
  HIDDEN_PREFIXES=$(awk '/WEBSITE_NAV_HIDDEN_PREFIXES/,/\] as const/' "$NAV_EXEMPT_FILE" \
    | grep -oE "'/[a-z][a-z0-9_-]*'" | tr -d "'" | sort -u)
  if [ -z "$HIDDEN_PREFIXES" ]; then
    HIDDEN_PREFIXES="/dashboard"
  fi
  # Extract WEBSITE_NAV_EXEMPT exact-match path list.
  EXEMPT_PATHS=$(awk '/WEBSITE_NAV_EXEMPT/,/\] as const/' "$NAV_EXEMPT_FILE" \
    | grep -oE "'/[a-z][a-z0-9_/-]*'" | tr -d "'" | sort -u)
  # Auth + checkout literal allowlist (intentionally not in main nav).
  AUTH_CHECKOUT_PATTERN='^/(login|signup|forgot-password|activate|invite|checkout)(/|$)'
  # Collect ALL nav hrefs from navigation.ts + Footer.tsx (union).
  NAV_HREFS=$( ( grep -hoE "href: '[^']+'" "$NAVIGATION_FILE" "$FOOTER_FILE" 2>/dev/null \
                  | sed -E "s/href: '([^']+)'/\1/" ; \
                  grep -hoE "href=\"[^\"]+\"" "$FOOTER_FILE" 2>/dev/null \
                  | sed -E 's/href="([^"]+)"/\1/' ) \
              | grep -vE '^https?://|^mailto:|^#' | sort -u)
  # Enumerate every public page route.
  ROUTES=$(find "$APP_DIR" -type f \( -name "page.tsx" -o -name "page.mdx" \) 2>/dev/null \
    | sed "s|$APP_DIR||" | sed -E 's#/page\.(tsx|mdx)$##' | sort -u)
  ORPHANS=""
  ORPHAN_COUNT=0
  while IFS= read -r route; do
    [ -z "$route" ] && continue
    [ "$route" = "" ] && continue
    # Normalize empty (root) → "/"
    norm="$route"
    [ -z "$norm" ] && norm="/"
    # Skip root (linked by Navbar logo).
    [ "$norm" = "/" ] && continue
    # Skip if matches any hidden prefix.
    skip=0
    while IFS= read -r prefix; do
      [ -z "$prefix" ] && continue
      case "$norm" in
        "$prefix"|"$prefix"/*) skip=1; break ;;
      esac
    done <<< "$HIDDEN_PREFIXES"
    [ "$skip" -eq 1 ] && continue
    # Skip auth/checkout literal allowlist. (here-string, not `echo | grep -q` — broken-pipe-race-free)
    if grep -qE "$AUTH_CHECKOUT_PATTERN" <<<"$norm"; then continue; fi
    # Skip dynamic routes ([slug] / [...catchall] / [id]).
    if grep -qE '\[' <<<"$norm"; then continue; fi
    # Skip WEBSITE_NAV_EXEMPT entries.
    skip=0
    while IFS= read -r exempt; do
      [ -z "$exempt" ] && continue
      [ "$norm" = "$exempt" ] && { skip=1; break; }
    done <<< "$EXEMPT_PATHS"
    [ "$skip" -eq 1 ] && continue
    # Must appear in NAV_HREFS. (here-string, not `echo | grep -q` — broken-pipe-race-free)
    if ! grep -qxF "$norm" <<<"$NAV_HREFS"; then
      ORPHAN_COUNT=$((ORPHAN_COUNT + 1))
      ORPHANS="$ORPHANS $norm"
    fi
  done <<< "$ROUTES"
  if [ "$ORPHAN_COUNT" -eq 0 ]; then
    pass "All public pages have nav links or are explicitly exempt"
  else
    fail "$ORPHAN_COUNT public page(s) missing nav link:$ORPHANS"
    info "Add to website/src/data/navigation.ts mainNav OR website/src/components/layout/Footer.tsx OR website/src/data/nav-exempt.ts WEBSITE_NAV_EXEMPT (with JSDoc)"
  fi
fi

# -------------------------------------------------------
# Check 16: Public website content leak guard (plan-public-content-leak-guard)
# Forbidden patterns (private-repo refs, internal commands prefix,
# contributor machine paths, raw 7-40 hex SHAs) MUST NOT appear in any
# file under website/content/** unless the file is in
# WEBSITE_CONTENT_LEAK_GUARD_EXEMPT. CR-49 enforcement. Pattern catalog
# is enumerated in scripts/lib/leak-patterns.sh:CONTENT_PATTERNS — never
# duplicate the literal pattern list here (sync-block trigger).
# -------------------------------------------------------
echo "Check 16: Public website content leak guard"
WEBSITE_CONTENT_GUARD="$REPO_ROOT/scripts/massu-website-content-leak-guard.sh"
if [ ! -f "$WEBSITE_CONTENT_GUARD" ]; then
  warn "Check 16 skipped: $WEBSITE_CONTENT_GUARD not found"
else
  if bash "$WEBSITE_CONTENT_GUARD" > /tmp/massu-website-content-leak-guard.log 2>&1; then
    pass "No leaks in website/content/**"
  else
    fail "Public-content leak detected (see /tmp/massu-website-content-leak-guard.log)"
    tail -10 /tmp/massu-website-content-leak-guard.log
  fi
fi

# -------------------------------------------------------
# Check 19: console.* on hot paths in packages/core (plan-stage-d-medium-sweep P-M-035)
# Closes wave2-architecture F-ARCH-008. MCP server protocol requires stdout
# to be JSON-RPC ONLY. A console.log on a code path reachable during server
# lifecycle corrupts the JSON-RPC frame → silent client disconnect. This
# check forbids console.log/error/warn in packages/core/src outside the
# `hooks/`, `commands/`, `__tests__/` dirs and explicit `@stdout-allow:`
# allowlist comments on the preceding line.
# -------------------------------------------------------
echo "Check 19: console.* on hot paths (P-M-035)"
CHECK19_VIOLATIONS=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    *"/hooks/"*) continue ;;
    *"/commands/"*) continue ;;
    *"/__tests__/"*) continue ;;
    *.test.ts) continue ;;
    *"/cli.ts") continue ;;
    *"/backfill-sessions.ts") continue ;;
    *"/knowledge-indexer.ts") continue ;;
  esac
  # Use awk to inspect the previous line for the allowlist marker.
  hits=$(awk '
    /(\@stdout-allow|pattern-scanner-allow:\s*stdout)/ { allow = NR + 1; next }
    /console\.(log|error|warn)\s*\(/ {
      if (NR == allow) next
      print FILENAME ":" NR ":" $0
    }
  ' "$f" 2>/dev/null)
  if [ -n "$hits" ]; then
    echo "$hits" >> /tmp/massu-check19-violations.log
    CHECK19_VIOLATIONS=$((CHECK19_VIOLATIONS + 1))
  fi
done < <(find "$SRC_DIR" -type f -name "*.ts" 2>/dev/null)

if [ "$CHECK19_VIOLATIONS" -gt 0 ]; then
  fail "Check 19: $CHECK19_VIOLATIONS file(s) have console.* on hot paths"
  cat /tmp/massu-check19-violations.log 2>/dev/null | head -20
  rm -f /tmp/massu-check19-violations.log
else
  pass "No console.log/error/warn on hot paths in packages/core/src"
fi

# -------------------------------------------------------
# Check 23: TODO/FIXME without plan-token or issue-link (plan-stage-d-medium-sweep P-M-037)
# Closes wave2-architecture F-ARCH-014 silent-skip class. Any new TODO,
# FIXME, "workaround", "for now", "good enough" comment in packages/core
# source MUST carry an `@plan:<token>` or `@issue:<#>` reference so the
# follow-up is discoverable. Bare TODOs that never get closed are
# permanent rot. The check warns rather than fails when retrofitting
# pre-existing entries — new commits add markers as they touch code.
# -------------------------------------------------------
echo "Check 23: TODO/FIXME require @plan: or @issue: tag (P-M-037)"
CHECK23_VIOLATIONS=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    *"/__tests__/"*) continue ;;
    *.test.ts) continue ;;
    *"/dist/"*) continue ;;
    *"/node_modules/"*) continue ;;
  esac
  # Match comment lines containing TODO/FIXME/workaround/for now/good enough
  # AND missing @plan: or @issue: markers, AND not already marked
  # @stdout-allow (covered by Check 19) or pattern-scanner-allow.
  hits=$(awk '
    /(\/\/|\*)\s*(TODO|FIXME|workaround|for now|good enough)/ {
      if (/@plan\s*:|@issue\s*:|@stdout-allow|pattern-scanner-allow/) next
      print FILENAME ":" NR ":" $0
    }
  ' "$f" 2>/dev/null)
  if [ -n "$hits" ]; then
    echo "$hits" >> /tmp/massu-check23-violations.log
    CHECK23_VIOLATIONS=$((CHECK23_VIOLATIONS + 1))
  fi
done < <(find "$SRC_DIR" -type f \( -name "*.ts" -o -name "*.tsx" \) 2>/dev/null)

if [ "$CHECK23_VIOLATIONS" -gt 0 ]; then
  warn "Check 23: $CHECK23_VIOLATIONS file(s) have untagged TODO/FIXME (warn — non-blocking)"
  head -10 /tmp/massu-check23-violations.log 2>/dev/null
  rm -f /tmp/massu-check23-violations.log
else
  pass "No untagged TODO/FIXME/workaround comments in packages/core/src"
fi

# -------------------------------------------------------
# Check 22: audit_log direct-insert ban (plan-stage-d-medium-sweep P-M-034)
# Closes wave2-architecture F-ARCH-007. Every audit-log write across the
# website codebase MUST go through `auditWrite()` from
# `website/src/lib/audit-write.ts`. Direct `from('audit_log').insert(...)`
# calls bypass the helper's null-org routing (audit_log_unattributed),
# violate CR-39 (silent-skip), and create schema-drift surface across the
# 28+ historical callsites. The helper file itself is the only legal
# location for the pattern; tests are excluded as fixtures.
# -------------------------------------------------------
echo "Check 22: audit_log direct-insert ban (P-M-034)"
CHECK22_VIOLATIONS=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    *"audit-write.ts"*) continue ;;
    */__tests__/*) continue ;;
    *.test.ts) continue ;;
  esac
  grep -nE "\.from\([\"']audit_log[\"']\)[[:space:]]*\.insert\b" "$f" >> /tmp/massu-check22-violations.log 2>/dev/null && \
    CHECK22_VIOLATIONS=$((CHECK22_VIOLATIONS + 1))
done < <(find "$REPO_ROOT/website/src" -type f \( -name "*.ts" -o -name "*.tsx" \) 2>/dev/null)

if [ "$CHECK22_VIOLATIONS" -gt 0 ]; then
  fail "Check 22: $CHECK22_VIOLATIONS file(s) bypass auditWrite() helper"
  cat /tmp/massu-check22-violations.log 2>/dev/null
  rm -f /tmp/massu-check22-violations.log
else
  pass "All audit_log writes go through auditWrite() helper"
fi

# -------------------------------------------------------
# Check 24: Public-command docs completeness (plan-stage-d-medium-sweep P-M-040)
# -------------------------------------------------------
# Closes wave3-help-sync DRIFT-06. Every `.claude/commands/massu-*.md`
# (NOT `massu-internal-*`) MUST have a corresponding doc page at
# `website/content/docs/commands/<name>.mdx`. Delegate to the dedicated
# script so the same enforcement runs in pre-push, CI, and ceremony pre-flight.
# Triage-pending commands listed in `.claude/commands/.docs-triage-pending.txt`
# are exempt (operator-coordinated triage tracked separately).
# -------------------------------------------------------
echo "Check 24: Public-command docs completeness (P-M-040)"
if bash "$REPO_ROOT/scripts/diff-commands-vs-docs.sh" >/tmp/massu-check24-out.log 2>&1; then
  pass "All public commands have docs (or are triage-pending allowlisted)"
else
  fail "Check 24: Public-command docs drift detected"
  cat /tmp/massu-check24-out.log 2>/dev/null
fi
rm -f /tmp/massu-check24-out.log

# -------------------------------------------------------
# Check 25: SQL .all() must carry LIMIT (plan-stage-d-medium-sweep P-DG-001)
# -------------------------------------------------------
# Grep-level safety net mirroring the ESLint rule `massu/no-unbounded-sql-all`.
# The ESLint rule walks the AST and is the authoritative gate when running
# `npx eslint`. This scanner check is a CI tripwire that runs even when
# ESLint is not invoked (e.g., during a pre-commit Bash flow). It flags any
# `db.prepare(...)... .all()` chain where the literal SQL appears not to
# contain a LIMIT clause. False positives can be silenced with an inline
# `// eslint-disable-next-line massu/no-unbounded-sql-all -- <reason>` (the
# ESLint disable comment doubles as the scanner allowlist marker).
# -------------------------------------------------------
echo "Check 25: SQL .all() bounded by LIMIT (P-DG-001)"
CHECK25_VIOLATIONS=0
check25_scan() {
  local root="$1"
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    case "$f" in
      */__tests__/*) continue ;;
      *.test.ts) continue ;;
      */dist/*) continue ;;
      */node_modules/*) continue ;;
      */.next/*) continue ;;
    esac
    # Awk pass extracts `.prepare(... ).all()` chains, checks whether the
    # captured SQL contains LIMIT, and emits violations.
    #
    # CI-vs-local drift fix (2026-05-18 ceremony post-mortem): the original
    # script used a /*...*/ comment-strip regex that BSD awk parses as
    # "nonterminated character class" and silently exits → 0 output → no
    # violations counted. On Linux/gawk it parsed correctly and surfaced
    # 6 real violations the local pre-push had been missing. Two structural
    # changes here:
    #   1. Drop the /*...*/ strip — it was load-bearing only for prose that
    #      contained SQL inside a block comment, which we don't have in
    #      this codebase. (Verified by post-fix grep across packages/core/src.)
    #   2. Replace `\s` (gawk-specific shorthand) with `[[:space:]]` (POSIX
    #      character class — works on BSD awk AND gawk identically).
    hits=$("$AWK" '
      # Block-comment state machine (skips JSDoc / multi-line block comments
      # so prose mentioning `.prepare(` does NOT false-positive). Works on
      # BSD awk + gawk identically — no /*...*/ regex needed.
      #
      # IMPORTANT: only OPEN a block if not already in one. Without the
      # `!in_block` guard, a JSDoc continuation line containing the literal
      # `/*` (e.g. `python/*.ts` glob in prose) would spuriously re-open
      # the state machine, leading to lines AFTER the real */ being
      # treated as code instead of comment.
      !in_block && /\/\*/ && !/\*\// { in_block = 1; next }
      in_block {
        if (/\*\//) in_block = 0
        next
      }
      # Skip pure-comment single-line patterns:
      #   - lines that begin with `//` or `*` (JSDoc continuation lines)
      /^[[:space:]]*\/\// { next }
      /^[[:space:]]*\*/ { next }
      # Track allowlist disable comments on preceding lines.
      /eslint-disable-next-line.*massu\/no-unbounded-sql-all/ { allow = NR + 1 }
      /\.prepare\(/ { buf = $0; line_start = NR; collecting = 1; next }
      collecting {
        buf = buf "\n" $0
        if (/\.all\(/) {
          collecting = 0
          if (NR == allow || line_start == allow) next
          # SELECT? + LIMIT?-presence test. POSIX [[:space:]] is portable.
          if (buf ~ /[Ss][Ee][Ll][Ee][Cc][Tt]/ &&
              buf !~ /[Cc][Oo][Uu][Nn][Tt][[:space:]]*\(/ &&
              buf !~ /[Ll][Ii][Mm][Ii][Tt][[:space:]]*([$?:]|[0-9])/) {
            print FILENAME ":" line_start ":" buf
          }
        }
      }
    ' "$f" 2>/dev/null)
    if [ -n "$hits" ]; then
      echo "$hits" >> /tmp/massu-check25-violations.log
      CHECK25_VIOLATIONS=$((CHECK25_VIOLATIONS + 1))
    fi
  done < <(find "$root" -type f \( -name "*.ts" -o -name "*.tsx" \) 2>/dev/null)
}
check25_scan "$SRC_DIR"
if [ -d "$REPO_ROOT/website/src" ]; then
  check25_scan "$REPO_ROOT/website/src"
fi

if [ "$CHECK25_VIOLATIONS" -gt 0 ]; then
  fail "Check 25: $CHECK25_VIOLATIONS file(s) have unbounded .prepare(...).all() chains"
  head -30 /tmp/massu-check25-violations.log 2>/dev/null
  rm -f /tmp/massu-check25-violations.log
else
  pass "All .prepare(SELECT ...).all() chains carry LIMIT (or are allowlisted)"
fi

# -------------------------------------------------------
# Check 26: Pre-push ↔ CI parity (plan-2026-05-18-pre-push-ci-parity P3-002)
# -------------------------------------------------------
# CR-50 / VR-CI-PARITY. Closes the structural bug class where CI catches
# failure modes that local pre-push-light cannot (2026-05-18 incident: 4 CI-only
# failure modes on SHA b26fbb1). Two sub-checks:
#   26a: every scripts/ci-*.sh is referenced from pre-push-light.sh OR has
#        '# CI-ONLY:' first-comment AND is in CI_ONLY_SCRIPTS_BASH allowlist.
#   26b: no .github/workflows/*.yml (excluding WORKFLOW_FILE_EXCLUSIONS mirror)
#        has a multi-line shell block (>5 lines) that doesn't delegate to
#        scripts/ci-*.sh.
# -------------------------------------------------------
echo "Check 26: Pre-push ↔ CI parity (CR-50 / VR-CI-PARITY)"
CHECK26_VIOLATIONS=0

# 26a: scripts/ci-*.sh policy. CI_ONLY_SCRIPTS_BASH MUST mirror
# packages/core/src/__tests__/ci-prepush-parity.test.ts:CI_ONLY_SCRIPTS — the
# drift-guard test asserts byte-equivalence of the two arrays.
CI_ONLY_SCRIPTS_BASH="ci-fresh-install.sh ci-config-drift.sh ci-anti-vacuity.sh"

# Strip shell COMMENTS from pre-push-light.sh ONCE, into a variable (P3 hardening: a
# commented-out reference `# TODO: run ci-foo.sh` must not satisfy the parity check; only a
# `#` at line-start or after whitespace is a comment, so `${#x}` / `$#` survive).
#
# ⛔ CRITICAL — this MUST NOT be a `sed … | grep -q` pipeline (incident 2026-07-16,
# docs/incidents/2026-07-16-check26-sed-grep-q-broken-pipe-false-fail.md). `grep -q`
# short-circuits on the FIRST match; when the matched reference is early in the 566-line
# file, sed still has ~150 lines left to write, gets SIGPIPE, and exits non-zero — and
# `set -o pipefail` (top of file) then makes the whole pipeline non-zero, so a reference
# that IS present reads as ABSENT (false FAIL). It is a timing race (~13% on the CI Linux
# runner, ~0% on macOS pipe buffering) — which is exactly why it was invisible locally.
# Capturing sed's output first and matching with a here-string removes the pipe entirely.
PREPUSH_NONCOMMENT="$(sed -E 's/(^|[[:space:]])#.*/\1/' scripts/pre-push-light.sh)"
# FAIL CLOSED (blind-gate M2): an unreadable/empty pre-push-light.sh must be a LOUD error,
# never a silent "nothing is referenced → flag every ci-*.sh" and never a silent pass.
if [ ! -s scripts/pre-push-light.sh ] || [ -z "$PREPUSH_NONCOMMENT" ]; then
  fail "Check 26: scripts/pre-push-light.sh is missing, empty, or produced no non-comment text — cannot verify CI parity (fail-closed)"
  CHECK26_VIOLATIONS=$((CHECK26_VIOLATIONS + 1))
else
  for ci_script in scripts/ci-*.sh; do
    [ -e "$ci_script" ] || continue
    script_base=$(basename "$ci_script")
    # `-F` fixed-string: the basename contains `.` which would otherwise be a regex any-char.
    # here-string (NO pipeline) — immune to the sed|grep-q broken-pipe race documented above.
    if grep -qF "$script_base" <<<"$PREPUSH_NONCOMMENT"; then
      continue  # referenced in real (non-comment) code — OK
    fi
    # `head -3` captured to a variable then matched via here-string (same broken-pipe-free idiom).
    ci_script_head3="$(head -3 "$ci_script")"
    if grep -qE '^#[[:space:]]*CI-ONLY:' <<<"$ci_script_head3"; then
      if grep -q " $script_base " <<<" $CI_ONLY_SCRIPTS_BASH "; then
        continue  # explicit opt-out + on allowlist — OK
      fi
      fail "Check 26: $ci_script has '# CI-ONLY:' comment but is NOT in CI_ONLY_SCRIPTS allowlist (add to scripts/massu-pattern-scanner.sh CI_ONLY_SCRIPTS_BASH AND packages/core/src/__tests__/ci-prepush-parity.test.ts:CI_ONLY_SCRIPTS — must mirror)"
      CHECK26_VIOLATIONS=$((CHECK26_VIOLATIONS + 1))
      continue
    fi
    fail "Check 26: $ci_script not referenced in pre-push-light.sh and no '# CI-ONLY:' opt-out comment"
    CHECK26_VIOLATIONS=$((CHECK26_VIOLATIONS + 1))
  done
fi

# 26b: workflow YAML inline-shell-block scan. Exclusion list MUST mirror
# WORKFLOW_FILE_EXCLUSIONS in ci-prepush-parity.test.ts.
CI_INLINE_OFFENDERS=""
for workflow in .github/workflows/*.yml; do
  [ -e "$workflow" ] || continue
  base=$(basename "$workflow")
  case "$base" in
    ci.public.yml|apply-ruleset.yml|branch-protection-audit.yml|leak-guard.yml|leak-guard-retro.yml|leak-guard-scheduled.yml|leak-guard-source-of-truth.yml)
      continue ;;  # see WORKFLOW_FILE_EXCLUSIONS in ci-prepush-parity.test.ts for rationale per entry
  esac
  # Match all YAML block-scalar variants: `run: |`, `run: |-`, `run: |+`, `run: >`,
  # `run: >-`, `run: >+`. A previous regex (`run: |` only) missed `|-` chomping
  # variants — would silently bypass Check 26 (HIGH arch finding 2026-05-18).
  OFFENDER=$(awk -v file="$base" '
    /^[[:space:]]+run:[[:space:]]*[|>][+-]?[[:space:]]*$/ { in_block=1; line_count=0; first_line=NR; found_script=0; next }
    in_block && /^[[:space:]]+[a-z_-]+:/ { if (line_count > 5 && !found_script) print file ":" first_line ":+" line_count; in_block=0; found_script=0; next }
    in_block { line_count++; if ($0 ~ /bash scripts\/ci-/) found_script=1 }
    END { if (in_block && line_count > 5 && !found_script) print file ":" first_line ":+" line_count }
  ' "$workflow")
  if [ -n "$OFFENDER" ]; then
    CI_INLINE_OFFENDERS+="$OFFENDER "
  fi
done
if [ -n "$CI_INLINE_OFFENDERS" ]; then
  fail "Check 26: CI workflow(s) have inline shell blocks >5 lines not delegating to scripts/ci-*.sh: $CI_INLINE_OFFENDERS"
  CHECK26_VIOLATIONS=$((CHECK26_VIOLATIONS + 1))
fi

if [ "$CHECK26_VIOLATIONS" -eq 0 ]; then
  pass "Check 26: Pre-push ↔ CI parity"
fi

# -------------------------------------------------------
# Check 27: Security-sensitive env vars must use a guard helper
#          (plan-2026-05-18-security-medium-sweep P6-001 / CR-51)
# -------------------------------------------------------
# Closes the structural bug class where the same security-sensitive env var
# is read with `?? ''` silent-fallback in one route and explicit-throw in
# another (M-1 finding 2026-05-18: IP_HASH_PEPPER read in two ways across
# evidence/[id]/download/route.ts and license/activate/route.ts).
#
# Three-layer enforcement (this check is layer 1):
#   27a: process.env.<NAME>_(PEPPER|SECRET|KEY) outside the guard file glob
#        — caller MUST go through a dedicated lib/<purpose>/<purpose>-guard.ts
#   27b: any `process.env.<NAME> ?? <literal>` pattern in a security-sensitive
#        path emits a WARN (silent-fallback is the original M-1 footgun).
#
# Framework-required keys (NEXTAUTH_SECRET, STRIPE_*, SUPABASE_*, NEXT_PUBLIC_*)
# are EXEMPT — they're platform contracts, not Massu security primitives.
# -------------------------------------------------------
echo "Check 27: Security-sensitive env vars use guard helper (CR-51 / VR-PEPPER-GUARD)"
CHECK27_VIOLATIONS=0

if [ -d website/src ]; then
  # 27a: bare reads of *_PEPPER outside the guard helper. The helper file
  # glob covers any current/future lib/<purpose>/<purpose>-guard.ts module.
  # Test files (__tests__/) are exempt: drift-guard tests + integration tests
  # that vi.stubEnv legitimately reference the env var name.
  CHECK27A_HITS=$(grep -rnE 'process\.env\.[A-Z][A-Z0-9_]*_(PEPPER)\b' website/src/ --include='*.ts' --include='*.tsx' 2>/dev/null \
    | grep -vE 'website/src/lib/[a-z-]+/[a-z-]+-guard\.ts' \
    | grep -vE 'website/src/__tests__/' || true)
  if [ -n "$CHECK27A_HITS" ]; then
    fail "Check 27a: *_PEPPER env var read outside guard helper. Use requireIpHashPepper() / hashIpWithPepper() from @/lib/ip/pepper-guard. Offenders:"
    echo "$CHECK27A_HITS" | sed 's/^/    /' >&2
    CHECK27_VIOLATIONS=$((CHECK27_VIOLATIONS + 1))
  fi

  # 27b: silent-fallback patterns adjacent to *_PEPPER / *_SECRET / *_KEY.
  # Excludes framework-required platform keys.
  CHECK27B_HITS=$(grep -rnE 'process\.env\.[A-Z][A-Z0-9_]*_(PEPPER|SECRET|KEY)[[:space:]]*\?\?[[:space:]]*['\''"]' website/src/ --include='*.ts' --include='*.tsx' 2>/dev/null \
    | grep -vE 'process\.env\.(NEXTAUTH_SECRET|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|SUPABASE_SERVICE_ROLE_KEY|NEXT_PUBLIC_[A-Z_]+)' \
    | grep -vE 'website/src/__tests__/' || true)
  if [ -n "$CHECK27B_HITS" ]; then
    fail "Check 27b: security-sensitive env var read with '?? <literal>' silent-fallback. Promote to a dedicated guard helper (fail-closed in production). Offenders:"
    echo "$CHECK27B_HITS" | sed 's/^/    /' >&2
    CHECK27_VIOLATIONS=$((CHECK27_VIOLATIONS + 1))
  fi
fi

if [ "$CHECK27_VIOLATIONS" -eq 0 ]; then
  pass "Check 27: Security-sensitive env vars use guard helper"
fi

# -------------------------------------------------------
# Check 28: Loop multi-perspective review evidence
#          (plan-loop-multi-perspective-enforcement / CR-52 / VR-LOOP-MULTI-PERSPECTIVE)
# -------------------------------------------------------
# Closes the structural bug class where `multi_perspective_review_spawned`
# was silent self-attestation, not enforcement. Discovered 2026-05-19T00:09:00Z
# when plan-2026-05-18-security-medium-sweep scored 3/4 and shipped anyway.
#
# Scans `.claude/metrics/command-scores.jsonl` for every entry where
# `.command in {massu-loop,massu-golden-path,massu-loop-playwright}` and
# `.timestamp > LEGACY_CUTOFF_ISO`, asserting `.scores.multi_perspective_review_spawned == true`.
#
# `LEGACY_PRE_FIX_ENTRY_*` allowlist below mirrors the vitest array in
# `packages/core/src/__tests__/loop-multi-perspective-enforcement.test.ts:LEGACY_PRE_FIX_ENTRIES`.
# Drift-guard test enforces the two arrays stay in sync (LMP-04 mirror parity).
# -------------------------------------------------------
echo "Check 28: Loop multi-perspective review evidence (CR-52 / VR-LOOP-MULTI-PERSPECTIVE)"
CHECK28_VIOLATIONS=0

# Mirror set — order, exact tuples MUST match the TS file in
# packages/core/src/__tests__/loop-multi-perspective-enforcement.test.ts:LEGACY_PRE_FIX_ENTRIES.
# Field separator is ASCII unit-separator \x1f (POSIX-canonical, cannot appear
# in any field). Drift-guard test LMP-04 enforces parity.
LEGACY_PRE_FIX_ENTRY_1=$'2026-05-19T00:09:00Z\x1fplan-2026-05-18-security-medium-sweep\x1f3/4'

LEGACY_CUTOFF_ISO_CHECK28="2026-05-19T00:09:01Z"

SCORES_FILE_CHECK28=".claude/metrics/command-scores.jsonl"

if [ -f "$SCORES_FILE_CHECK28" ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    # Parse with jq if available; skip on parse failure (matches existing scanner convention).
    if ! echo "$line" | jq -e . >/dev/null 2>&1; then
      continue
    fi
    cmd=$(echo "$line" | jq -r '.command // ""')
    ts=$(echo "$line" | jq -r '.timestamp // ""')
    input_summary=$(echo "$line" | jq -r '.input_summary // ""')
    pass_rate=$(echo "$line" | jq -r '.pass_rate // ""')
    review_spawned=$(echo "$line" | jq -r '.scores.multi_perspective_review_spawned // false')

    # Filter: only looping commands.
    case "$cmd" in
      massu-loop|massu-golden-path|massu-loop-playwright) ;;
      *) continue ;;
    esac

    # Time filter: must be STRICTLY AFTER cutoff.
    if [ ! "$ts" \> "$LEGACY_CUTOFF_ISO_CHECK28" ]; then
      continue
    fi

    # Legacy allowlist match — check all entries. Uses \x1f separator (mirror
    # parity with TS LEGACY_PRE_FIX_ENTRIES).
    entry_key=$'\x1f'  # placeholder to silence shellcheck SC2034 if ever flagged
    entry_key="${ts}"$'\x1f'"${input_summary}"$'\x1f'"${pass_rate}"
    case "$entry_key" in
      "$LEGACY_PRE_FIX_ENTRY_1") continue ;;
    esac

    # Assert.
    if [ "$review_spawned" != "true" ]; then
      fail "Check 28: looping-command entry past ${LEGACY_CUTOFF_ISO_CHECK28} has multi_perspective_review_spawned != true: ${entry_key}"
      CHECK28_VIOLATIONS=$((CHECK28_VIOLATIONS + 1))
    fi
  done < "$SCORES_FILE_CHECK28"
fi

if [ "$CHECK28_VIOLATIONS" -eq 0 ]; then
  pass "Check 28: Loop multi-perspective review evidence"
fi

# -------------------------------------------------------
# Check 21: File-size cap on packages/core/src TypeScript modules
#          (plan-stage-d-medium-sweep P-M-031)
# -------------------------------------------------------
# Closes wave2-architecture F-ARCH-004. Single files >1000 LOC accrue
# god-module gravity: tests cascade, refactors stall, ownership blurs.
# This check enforces the upper bound structurally. Files that legitimately
# exceed the cap MUST add a `// @scanner-allow:large-file <reason>` comment
# in the first 30 lines documenting WHY. Future modules cannot accidentally
# grow past the cap without an explicit acknowledgement.
# -------------------------------------------------------
echo "Check 21: File-size cap (packages/core/src) (P-M-031)"
CHECK21_VIOLATIONS=0
CHECK21_CAP=1000
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    */__tests__/*) continue ;;
    *.test.ts) continue ;;
    */dist/*) continue ;;
    */node_modules/*) continue ;;
  esac
  loc=$(wc -l < "$f" 2>/dev/null | tr -d ' ')
  [ -z "$loc" ] && continue
  if [ "$loc" -gt "$CHECK21_CAP" ]; then
    # Allow if the file head carries an explicit allowlist marker.
    head30_check21="$(head -n 30 "$f" 2>/dev/null)"
    if grep -qE '@scanner-allow:large-file' <<<"$head30_check21"; then
      continue
    fi
    echo "$f:$loc lines" >> /tmp/massu-check21-violations.log
    CHECK21_VIOLATIONS=$((CHECK21_VIOLATIONS + 1))
  fi
done < <(find "$SRC_DIR" -type f -name "*.ts" 2>/dev/null)

if [ "$CHECK21_VIOLATIONS" -gt 0 ]; then
  fail "Check 21: $CHECK21_VIOLATIONS file(s) exceed $CHECK21_CAP LOC without @scanner-allow:large-file marker"
  cat /tmp/massu-check21-violations.log 2>/dev/null
  rm -f /tmp/massu-check21-violations.log
else
  pass "All packages/core/src TypeScript modules within $CHECK21_CAP LOC cap"
fi

# -------------------------------------------------------
# Check 29: Auto-generated scanner additions must carry marker comment
# (plan-v0.2-interactive-rule-approval P-D-006). The `/massu-rule approve`
# slash command appends pattern-scanner checks via `applyRuleCandidate()`;
# every auto-generated check block MUST be preceded by a marker line
# `# auto-generated by /massu-rule approve <prompt_hash> (slug=<slug>)`
# so the operator can audit the provenance and so a `Check N:` line that
# appears WITHOUT the preceding marker is a hand-edit (which is allowed)
# rather than a corrupted auto-append (which is not).
# -------------------------------------------------------
echo ""
echo "Check 29: Auto-generated scanner additions carry provenance marker (P-D-006)"
CHECK29_VIOLATIONS=0
CHECK29_SCANNER="$REPO_ROOT/scripts/massu-pattern-scanner.sh"
if [ -f "$CHECK29_SCANNER" ]; then
  while IFS=: read -r lineno _; do
    [ -z "$lineno" ] && continue
    NEXT_LINES=$(sed -n "$((lineno + 1)),$((lineno + 4))p" "$CHECK29_SCANNER")
    if ! grep -qE "^# Check [0-9]+:" <<<"$NEXT_LINES"; then
      CHECK29_VIOLATIONS=$((CHECK29_VIOLATIONS + 1))
      echo "  marker at line $lineno not followed by '# Check N:' within 4 lines"
    fi
  done < <(grep -n "^# auto-generated by /massu-rule approve" "$CHECK29_SCANNER" 2>/dev/null || true)
fi
if [ "$CHECK29_VIOLATIONS" -gt 0 ]; then
  fail "Check 29: $CHECK29_VIOLATIONS auto-generated marker(s) malformed"
else
  pass "Check 29: Auto-generated scanner additions carry provenance marker"
fi

# -------------------------------------------------------
# Check 30: Auto-learning tier-gate wiring (CR-54 / VR-AUTO-LEARNING-TIER)
# (plan-2026-05-27-tier-gate-auto-learning P1-009).
# -------------------------------------------------------
# Auto-learning (rule-candidate emission + promotion) is a Pro+ feature.
# The gate lives at a single chokepoint reading a single source-of-truth
# module. This check is the bash mirror of the vitest drift-guard
# `auto-learning-tier-gate-drift-guard.test.ts` (vitest <-> scanner parity,
# the CR-50/CR-52 convention). It asserts the three invariants:
#   1. the promotion chokepoint references the entitlement SoT AND is async;
#   2. the emission hook references the cache-only reader + predicate + the
#      upgrade-message SoT (no re-hardcoded upgrade string);
#   3. the SoT module pins the minimum tier to 'pro'.
# A silent regression that drops the gate fails this check at pre-commit time.
# -------------------------------------------------------
echo ""
echo "Check 30: Auto-learning tier-gate wiring (CR-54 / VR-AUTO-LEARNING-TIER)"
CHECK30_VIOLATIONS=0
CHECK30_ENTITLEMENT="$SRC_DIR/auto-learning-entitlement.ts"
CHECK30_APPLIER="$SRC_DIR/rule-candidate-applier.ts"
CHECK30_HOOK="$SRC_DIR/hooks/user-prompt.ts"

# Invariant 3: SoT module exists and pins the minimum tier to 'pro'.
if [ -f "$CHECK30_ENTITLEMENT" ]; then
  if ! grep -qE "AUTO_LEARNING_MIN_TIER: ToolTier = 'pro'" "$CHECK30_ENTITLEMENT"; then
    fail "Check 30: auto-learning-entitlement.ts does not pin AUTO_LEARNING_MIN_TIER to 'pro'"
    CHECK30_VIOLATIONS=$((CHECK30_VIOLATIONS + 1))
  fi
else
  fail "Check 30: auto-learning-entitlement.ts (entitlement SoT) is missing"
  CHECK30_VIOLATIONS=$((CHECK30_VIOLATIONS + 1))
fi

# Invariant 1: the promotion chokepoint references the SoT AND is async.
if [ -f "$CHECK30_APPLIER" ]; then
  if ! ast_present "$CHECK30_APPLIER" assertAutoLearningEntitled call; then
    fail "Check 30: rule-candidate-applier.ts does not reference assertAutoLearningEntitled (gate removed?)"
    CHECK30_VIOLATIONS=$((CHECK30_VIOLATIONS + 1))
  fi
  if ! grep -qE "export async function applyRuleCandidate" "$CHECK30_APPLIER"; then
    fail "Check 30: applyRuleCandidate is not declared async (the gate is async-resolved)"
    CHECK30_VIOLATIONS=$((CHECK30_VIOLATIONS + 1))
  fi
else
  fail "Check 30: rule-candidate-applier.ts (promotion chokepoint) is missing"
  CHECK30_VIOLATIONS=$((CHECK30_VIOLATIONS + 1))
fi

# Invariant 2: the emission hook references the cache-only reader + predicate.
if [ -f "$CHECK30_HOOK" ]; then
  if ! ast_present "$CHECK30_HOOK" getCachedTierReadOnly; then
    fail "Check 30: hooks/user-prompt.ts does not reference getCachedTierReadOnly (emission gate removed?)"
    CHECK30_VIOLATIONS=$((CHECK30_VIOLATIONS + 1))
  fi
  if ! ast_present "$CHECK30_HOOK" entitledForAutoLearning; then
    fail "Check 30: hooks/user-prompt.ts does not reference entitledForAutoLearning (emission gate removed?)"
    CHECK30_VIOLATIONS=$((CHECK30_VIOLATIONS + 1))
  fi
  # Single-SoT (CR-46 #3): the sub-Pro upgrade nudge MUST derive from
  # autoLearningUpgradeMessage(), never a re-hardcoded string in the hook.
  if ! ast_present "$CHECK30_HOOK" autoLearningUpgradeMessage; then
    fail "Check 30: hooks/user-prompt.ts does not use autoLearningUpgradeMessage (upgrade text must come from the SoT, not be hardcoded)"
    CHECK30_VIOLATIONS=$((CHECK30_VIOLATIONS + 1))
  fi
else
  fail "Check 30: hooks/user-prompt.ts (emission hook) is missing"
  CHECK30_VIOLATIONS=$((CHECK30_VIOLATIONS + 1))
fi

if [ "$CHECK30_VIOLATIONS" -eq 0 ]; then
  pass "Check 30: Auto-learning tier-gate wiring intact"
fi

# Check 31: Command tier-gate wiring (CR-46 structural anti-regression).
# -------------------------------------------------------
# A Pro-gated slash command must not silently lose its gate. For every public
# command file (.claude/commands/massu-*.md, excluding massu-internal-*) whose
# body contains the gate marker "## Tier requirement (Requires", the SAME file
# MUST also contain the gate line "license check --min". Marker implies gate.
# This is the bash mirror of the vitest drift-guard
# `command-tier-gate-drift-guard.test.ts` (vitest <-> scanner parity, the
# CR-50 convention). A half-removed gate (marker kept, gate line dropped) fails
# this check at pre-commit time. The command set is derived from the filesystem
# (CR-46 / derive-from-SoT) so a newly-added gated command is covered too.
# -------------------------------------------------------
echo ""
echo "Check 31: Command tier-gate wiring (CR-46)"
CHECK31_MARKER="## Tier requirement (Requires"
CHECK31_GATE="license check --min"
CHECK31_DIR="$REPO_ROOT/.claude/commands"
CHECK31_VIOLATIONS=0
if [ -d "$CHECK31_DIR" ]; then
  for cmd in "$CHECK31_DIR"/massu-*.md; do
    [ -f "$cmd" ] || continue
    case "$(basename "$cmd")" in
      massu-internal-*) continue ;;
    esac
    if grep -qF "$CHECK31_MARKER" "$cmd"; then
      if ! grep -qF "$CHECK31_GATE" "$cmd"; then
        fail "Check 31: $(basename "$cmd") declares the Tier-requirement marker but is missing the '$CHECK31_GATE' gate line"
        CHECK31_VIOLATIONS=$((CHECK31_VIOLATIONS + 1))
      fi
    fi
  done
else
  fail "Check 31: commands dir not found at $CHECK31_DIR"
  CHECK31_VIOLATIONS=$((CHECK31_VIOLATIONS + 1))
fi
if [ "$CHECK31_VIOLATIONS" -eq 0 ]; then
  pass "Check 31: Command tier-gate wiring intact"
fi

# Check 32: Team-shared rule promotion structural invariants (CR-55).
# -------------------------------------------------------
# Approval-before-apply + the H1 destination allowlist must not regress. Bash
# mirror of the vitest drift-guard `team-shared-promotion-drift-guard.test.ts`
# (vitest <-> scanner parity, CR-50 convention). Asserts: (i) the team min-tier
# SoT is pinned to 'team'; (ii) the applier carries the H1 allowlist + team gate
# symbols; (iii) the pull module (team-rule-sync.ts) NEVER references any
# apply/destination-write function — a pulled rule can only become a reviewable
# candidate, never auto-apply.
# -------------------------------------------------------
echo ""
echo "Check 32: Team-shared rule promotion invariants (CR-55)"
CHECK32_VIOLATIONS=0
ENT32="$REPO_ROOT/packages/core/src/auto-learning-entitlement.ts"
APPLIER32="$REPO_ROOT/packages/core/src/rule-candidate-applier.ts"
SYNC32="$REPO_ROOT/packages/core/src/team-rule-sync.ts"

if [ -f "$ENT32" ]; then
  if ! grep -qE "TEAM_SHARED_PROMOTION_MIN_TIER[^=]*=[^']*'team'" "$ENT32"; then
    fail "Check 32: auto-learning-entitlement.ts does not pin TEAM_SHARED_PROMOTION_MIN_TIER to 'team'"
    CHECK32_VIOLATIONS=$((CHECK32_VIOLATIONS + 1))
  fi
else
  fail "Check 32: auto-learning-entitlement.ts (entitlement SoT) is missing"
  CHECK32_VIOLATIONS=$((CHECK32_VIOLATIONS + 1))
fi

if [ -f "$APPLIER32" ]; then
  if ! ast_present "$APPLIER32" TEAM_SHAREABLE_DESTINATIONS; then
    fail "Check 32: rule-candidate-applier.ts is missing the TEAM_SHAREABLE_DESTINATIONS SoT"
    CHECK32_VIOLATIONS=$((CHECK32_VIOLATIONS + 1))
  fi
  for sym in entitledForTeamSharedPromotion signature_verified isTeamShareableDestination; do
    if ! ast_present "$APPLIER32" "$sym"; then
      fail "Check 32: rule-candidate-applier.ts no longer references '$sym' (team gate regressed?)"
      CHECK32_VIOLATIONS=$((CHECK32_VIOLATIONS + 1))
    fi
  done
else
  fail "Check 32: rule-candidate-applier.ts (promotion chokepoint) is missing"
  CHECK32_VIOLATIONS=$((CHECK32_VIOLATIONS + 1))
fi

if [ -f "$SYNC32" ]; then
  for forbidden in applyRuleCandidate writeDestination appendMemoryIndexLine writeCorrectionsMd writePatternScanner writeClaudeMdCr writeCustomDestination; do
    if ast_present "$SYNC32" "$forbidden"; then
      fail "Check 32: team-rule-sync.ts references '$forbidden' — pull path must NEVER apply (approval-before-apply violated)"
      CHECK32_VIOLATIONS=$((CHECK32_VIOLATIONS + 1))
    fi
  done
else
  fail "Check 32: team-rule-sync.ts (pull path) is missing"
  CHECK32_VIOLATIONS=$((CHECK32_VIOLATIONS + 1))
fi

# PA3-006 (Phase 3 Stream A / CR-57): hardened-path invariants. The executable
# destinations may propagate cross-seat ONLY behind the hardened-review path; the
# non-hardened allowlist must NOT be widened; the render-only preview MUST NOT exec.
HARDENED32="$REPO_ROOT/packages/core/src/rule-candidate-hardened.ts"
PREVIEW32="$REPO_ROOT/packages/core/src/rule-candidate-preview.ts"
SYNC_FN32="$REPO_ROOT/website/supabase/functions/sync/index.ts"
MIG045="$REPO_ROOT/website/supabase/migrations/045_hardened_promotion.sql"

if [ -f "$HARDENED32" ]; then
  # Hardened SoT + apply-gate validator live in rule-candidate-hardened.ts.
  if ! ast_present "$HARDENED32" TEAM_HARDENED_SHAREABLE_DESTINATIONS; then
    fail "Check 32: rule-candidate-hardened.ts is missing TEAM_HARDENED_SHAREABLE_DESTINATIONS (hardened SoT)"
    CHECK32_VIOLATIONS=$((CHECK32_VIOLATIONS + 1))
  fi
  for hsym in review_attestation second_operator_id dry_run_ack validateHardenedApplyGate; do
    if ! ast_present "$HARDENED32" "$hsym"; then
      fail "Check 32: rule-candidate-hardened.ts no longer references '$hsym' (hardened apply gate regressed?)"
      CHECK32_VIOLATIONS=$((CHECK32_VIOLATIONS + 1))
    fi
  done
else
  fail "Check 32: rule-candidate-hardened.ts (hardened SoT + apply-gate validator) is missing"
  CHECK32_VIOLATIONS=$((CHECK32_VIOLATIONS + 1))
fi

# The applier must actually USE the hardened gate (import + call).
if [ -f "$APPLIER32" ]; then
  for usym in isHardenedShareableDestination validateHardenedApplyGate; do
    if ! ast_present "$APPLIER32" "$usym"; then
      fail "Check 32: rule-candidate-applier.ts no longer uses '$usym' (hardened apply gate not wired?)"
      CHECK32_VIOLATIONS=$((CHECK32_VIOLATIONS + 1))
    fi
  done
fi

if [ -f "$PREVIEW32" ]; then
  # Render-only invariant: the preview helper MUST NOT exec untrusted input. Match
  # actual import/require/call syntax (not the word in doc comments).
  if grep -qE "from ['\"](node:)?child_process['\"]|require\(['\"](node:)?child_process|execSync\(|\bspawn(Sync)?\(" "$PREVIEW32"; then
    fail "Check 32: rule-candidate-preview.ts imports/uses child_process — RENDER-ONLY invariant violated (it must NEVER execute untrusted input)"
    CHECK32_VIOLATIONS=$((CHECK32_VIOLATIONS + 1))
  fi
else
  fail "Check 32: rule-candidate-preview.ts (render-only hardened preview) is missing"
  CHECK32_VIOLATIONS=$((CHECK32_VIOLATIONS + 1))
fi

if [ -f "$SYNC_FN32" ]; then
  if ! ast_present "$SYNC_FN32" TEAM_HARDENED_DESTINATIONS; then
    fail "Check 32: sync/index.ts is missing the server TEAM_HARDENED_DESTINATIONS const (hardened ingest gate)"
    CHECK32_VIOLATIONS=$((CHECK32_VIOLATIONS + 1))
  fi
fi

if [ -f "$MIG045" ]; then
  # The widened CHECK must condition the executable destinations on hardened + attestation.
  if ! ast_present "$MIG045" promoted_rules_destination_hardened_check; then
    fail "Check 32: migration 045 is missing the widened destination CHECK (promoted_rules_destination_hardened_check)"
    CHECK32_VIOLATIONS=$((CHECK32_VIOLATIONS + 1))
  fi
fi

if [ "$CHECK32_VIOLATIONS" -eq 0 ]; then
  pass "Check 32: Team-shared rule promotion invariants intact (incl. Phase 3 hardened path)"
fi

# -------------------------------------------------------
# Check 33: Ed25519 verifier consolidation (CR-46 / plan-2026-06-01-team-shared-promotion-phase-3 PC-004).
# -------------------------------------------------------
# Both signed-envelope verifiers MUST delegate to the single parametric core
# `ed25519-envelope-verifier.ts` (no duplicated `crypto.verify(null,` body in
# either wrapper). Bash mirror of the vitest drift-guard
# `ed25519-verifier-consolidation-drift-guard.test.ts` (vitest <-> scanner parity).
# -------------------------------------------------------
echo ""
echo "Check 33: Ed25519 verifier consolidation (CR-46)"
CHECK33_VIOLATIONS=0
CORE33="$REPO_ROOT/packages/core/src/security/ed25519-envelope-verifier.ts"
PROMO33="$REPO_ROOT/packages/core/src/security/promotion-envelope-verifier.ts"
LIC33="$REPO_ROOT/packages/core/src/security/license-response-verifier.ts"

if [ -f "$CORE33" ]; then
  if ! grep -q "export function verifyEd25519SignedEnvelope" "$CORE33"; then
    fail "Check 33: ed25519-envelope-verifier.ts does not export verifyEd25519SignedEnvelope (the shared core)"
    CHECK33_VIOLATIONS=$((CHECK33_VIOLATIONS + 1))
  fi
else
  fail "Check 33: ed25519-envelope-verifier.ts (shared verifier core) is missing"
  CHECK33_VIOLATIONS=$((CHECK33_VIOLATIONS + 1))
fi

for wrapper in "$PROMO33" "$LIC33"; do
  if [ -f "$wrapper" ]; then
    if ! ast_present "$wrapper" verifyEd25519SignedEnvelope; then
      fail "Check 33: $(basename "$wrapper") no longer delegates to verifyEd25519SignedEnvelope (consolidation regressed?)"
      CHECK33_VIOLATIONS=$((CHECK33_VIOLATIONS + 1))
    fi
    # No duplicated verify core in the wrapper — the crypto.verify(null, body must
    # live ONLY in the shared core after consolidation.
    if grep -qE "cryptoVerify\(\s*null|verify\(\s*null" "$wrapper"; then
      fail "Check 33: $(basename "$wrapper") contains a duplicated crypto.verify(null,...) core — it must delegate to ed25519-envelope-verifier.ts"
      CHECK33_VIOLATIONS=$((CHECK33_VIOLATIONS + 1))
    fi
  else
    fail "Check 33: $(basename "$wrapper") (verifier wrapper) is missing"
    CHECK33_VIOLATIONS=$((CHECK33_VIOLATIONS + 1))
  fi
done

if [ "$CHECK33_VIOLATIONS" -eq 0 ]; then
  pass "Check 33: Ed25519 verifier consolidation intact"
fi

# -------------------------------------------------------
# Check 34: API-key edge functions must declare verify_jwt=false (CR-58).
# -------------------------------------------------------
# Every Supabase edge function that authenticates ms_live_ API keys itself
# (imports verifyApiKeyHash) MUST have a `[functions.<slug>] verify_jwt = false`
# block in website/supabase/config.toml. The platform JWT check is incompatible
# with API-key auth (401 UNAUTHORIZED_INVALID_JWT_FORMAT) — incident 2026-06-01.
# Mirror of the vitest drift-guard edge-verify-jwt-config-drift.test.ts.
# -------------------------------------------------------
echo ""
echo "Check 34: API-key edge functions declare verify_jwt=false (CR-58)"
CHECK34_VIOLATIONS=0
FN_DIR="$REPO_ROOT/website/supabase/functions"
CFG_TOML="$REPO_ROOT/website/supabase/config.toml"
if [ -d "$FN_DIR" ]; then
  if [ ! -f "$CFG_TOML" ]; then
    fail "Check 34: website/supabase/config.toml is missing — API-key functions need declared verify_jwt=false"
    CHECK34_VIOLATIONS=$((CHECK34_VIOLATIONS + 1))
  else
    # Every function whose index.ts imports verifyApiKeyHash must be declared.
    while IFS= read -r idx; do
      slug="$(basename "$(dirname "$idx")")"
      # Extract the [functions.<slug>] block and confirm verify_jwt = false within it.
      block="$(awk -v s="[functions.$slug]" '$0==s{f=1;next} /^\[/{f=0} f' "$CFG_TOML")"
      if ! grep -qE "verify_jwt[[:space:]]*=[[:space:]]*false" <<<"$block"; then
        fail "Check 34: function '$slug' uses verifyApiKeyHash but config.toml lacks [functions.$slug] verify_jwt = false (would 401 on deploy — incident 2026-06-01)"
        CHECK34_VIOLATIONS=$((CHECK34_VIOLATIONS + 1))
      fi
    done < <(grep -rl "verifyApiKeyHash" "$FN_DIR"/*/index.ts 2>/dev/null)
  fi
fi
if [ "$CHECK34_VIOLATIONS" -eq 0 ]; then
  pass "Check 34: all API-key edge functions declare verify_jwt=false"
fi

# -------------------------------------------------------
# Check 35: Promotion-funnel event-enum parity (P1-004 / CR-39)
# -------------------------------------------------------
# The promotion-funnel event enum MUST be byte-identical across the four surfaces
# that read/write it; any drift silently breaks the funnel (server CHECK rejects a
# client event, or the dashboard counts a stage that never arrives). Bash mirror of
# the vitest drift-guard promotion-events-enum-parity.test.ts (vitest↔scanner parity).
#   1. CLIENT SoT      — RulePromotionEventType union (packages/core/src/memory-db.ts)
#   2. SERVER INGEST   — RULE_PROMOTION_EVENT_TYPES (website/supabase/functions/sync/index.ts)
#   3. MIGRATION CHECK — event_type IN (...) (website/supabase/migrations/046_rule_promotion_events.sql)
#   4. DASHBOARD READER— PROMOTION_FUNNEL_EVENT_TYPES (website/src/lib/promotion-analytics-data.ts)
# -------------------------------------------------------
echo ""
echo "Check 35: Promotion-funnel event-enum parity (P1-004)"
CHECK35_VIOLATIONS=0

# Extract the sorted, comma-joined single-quoted lowercase tokens from a line
# matching a marker in a file. Returns empty string when the file/marker is absent.
enum_tokens() {
  local file="$1" marker="$2"
  [ -f "$file" ] || { echo ""; return; }
  grep -E "$marker" "$file" 2>/dev/null | grep -oE "'[a-z_]+'" | tr -d "'" | sort -u | tr '\n' ','
}

C35_MEMDB="$REPO_ROOT/packages/core/src/memory-db.ts"
C35_SYNC="$REPO_ROOT/website/supabase/functions/sync/index.ts"
C35_MIG="$REPO_ROOT/website/supabase/migrations/046_rule_promotion_events.sql"
C35_DASH="$REPO_ROOT/website/src/lib/promotion-analytics-data.ts"

# Client SoT is the anchor. The expected canonical enum (sorted): approved,dismissed,proposed,shown
C35_CANON="approved,dismissed,proposed,shown,"
C35_CLIENT="$(enum_tokens "$C35_MEMDB" 'export type RulePromotionEventType')"

if [ -z "$C35_CLIENT" ]; then
  fail "Check 35: client SoT RulePromotionEventType not found in packages/core/src/memory-db.ts"
  CHECK35_VIOLATIONS=$((CHECK35_VIOLATIONS + 1))
elif [ "$C35_CLIENT" != "$C35_CANON" ]; then
  fail "Check 35: client SoT enum '$C35_CLIENT' != canonical '$C35_CANON'"
  CHECK35_VIOLATIONS=$((CHECK35_VIOLATIONS + 1))
fi

# The three website surfaces are only checked when the website tree is present
# (a public-mirror checkout has no website/; the vitest skipIf mirrors this).
if [ -d "$REPO_ROOT/website" ]; then
  C35_SERVER="$(enum_tokens "$C35_SYNC" 'const RULE_PROMOTION_EVENT_TYPES')"
  C35_MIGRATION="$(enum_tokens "$C35_MIG" 'event_type IN')"
  C35_DASHBOARD="$(enum_tokens "$C35_DASH" 'PROMOTION_FUNNEL_EVENT_TYPES')"
  for pair in "server:$C35_SERVER" "migration:$C35_MIGRATION" "dashboard:$C35_DASHBOARD"; do
    name="${pair%%:*}"; val="${pair#*:}"
    if [ "$val" != "$C35_CANON" ]; then
      fail "Check 35: $name enum '$val' != canonical '$C35_CANON' (funnel drift)"
      CHECK35_VIOLATIONS=$((CHECK35_VIOLATIONS + 1))
    fi
  done
fi

if [ "$CHECK35_VIOLATIONS" -eq 0 ]; then
  pass "Check 35: promotion-funnel event-enum parity intact"
fi

# -------------------------------------------------------
# Check 36: Rule-pack enforcement-bridge no-apply invariant (P2-004).
# -------------------------------------------------------
# The rule-pack client PULL module (rule-pack-sync.ts) materializes a pulled pack
# rule as a reviewable candidate sidecar and NEVER applies it — exactly the
# approval-before-apply posture Check 32 enforces on team-rule-sync.ts. It must
# reference NONE of the applier's promotion-apply / destination-write functions.
# Bash mirror of the vitest drift-guard rule-pack-enforcement-bridge.test.ts
# (vitest <-> scanner parity, the CR-50 convention).
# -------------------------------------------------------
echo ""
echo "Check 36: Rule-pack enforcement-bridge no-apply invariant (P2-004)"
CHECK36_VIOLATIONS=0
SYNC36="$REPO_ROOT/packages/core/src/rule-pack-sync.ts"

if [ -f "$SYNC36" ]; then
  for forbidden in applyRuleCandidate writeDestination appendMemoryIndexLine writeCorrectionsMd writePatternScanner writeClaudeMdCr writeCustomDestination; do
    if grep -q "$forbidden" "$SYNC36"; then
      fail "Check 36: rule-pack-sync.ts references '$forbidden' — pack pull path must NEVER apply (materialize-never-apply violated)"
      CHECK36_VIOLATIONS=$((CHECK36_VIOLATIONS + 1))
    fi
  done
else
  fail "Check 36: rule-pack-sync.ts (pack pull path) is missing"
  CHECK36_VIOLATIONS=$((CHECK36_VIOLATIONS + 1))
fi

if [ "$CHECK36_VIOLATIONS" -eq 0 ]; then
  pass "Check 36: rule-pack enforcement-bridge no-apply invariant intact"
fi

# -------------------------------------------------------
# Check 37: Enterprise governance gate invariant (PA1-004 / CR-55 generalized).
# -------------------------------------------------------
# The generalized org-level N-of-M governance gate (validateGovernanceGate) must
# exist in the canonical hardened module, validateHardenedApplyGate must DELEGATE
# to it (the N=2 special case — CR-10 preserves the symbol + 4 refs), the
# entitlement SoT must declare ENTERPRISE_GOVERNANCE_MIN_TIER='enterprise', and
# the server migration (when present) must gate on role_rank() — never a bare
# lexicographic TEXT >= — + carry the approval_state lifecycle + the
# approval_recorded event. Bash mirror of governance-gate-invariant.test.ts
# (vitest <-> scanner parity, CR-50 convention).
# -------------------------------------------------------
echo ""
echo "Check 37: Enterprise governance gate invariant (PA1-004)"
CHECK37_VIOLATIONS=0
HARDENED37="$REPO_ROOT/packages/core/src/rule-candidate-hardened.ts"
ENTITLE37="$REPO_ROOT/packages/core/src/auto-learning-entitlement.ts"
MIGRATION37="$REPO_ROOT/website/supabase/migrations/049_promotion_governance.sql"

if [ -f "$HARDENED37" ]; then
  if ! grep -q "export function validateGovernanceGate" "$HARDENED37"; then
    fail "Check 37: rule-candidate-hardened.ts does not export validateGovernanceGate (generalized N-of-M gate)"
    CHECK37_VIOLATIONS=$((CHECK37_VIOLATIONS + 1))
  fi
  # validateHardenedApplyGate must delegate to the generalized gate.
  gov_gate_delegation="$(awk '/export function validateHardenedApplyGate/{f=1} f&&/validateGovernanceGate\(/{print; exit}' "$HARDENED37")"
  if ! grep -q "validateGovernanceGate" <<<"$gov_gate_delegation"; then
    fail "Check 37: validateHardenedApplyGate no longer delegates to validateGovernanceGate (N=2 generalization regressed?)"
    CHECK37_VIOLATIONS=$((CHECK37_VIOLATIONS + 1))
  fi
else
  fail "Check 37: rule-candidate-hardened.ts is missing"
  CHECK37_VIOLATIONS=$((CHECK37_VIOLATIONS + 1))
fi

if [ -f "$ENTITLE37" ]; then
  if ! ast_present "$ENTITLE37" ENTERPRISE_GOVERNANCE_MIN_TIER; then
    fail "Check 37: auto-learning-entitlement.ts lacks ENTERPRISE_GOVERNANCE_MIN_TIER (governance entitlement SoT)"
    CHECK37_VIOLATIONS=$((CHECK37_VIOLATIONS + 1))
  fi
else
  fail "Check 37: auto-learning-entitlement.ts is missing"
  CHECK37_VIOLATIONS=$((CHECK37_VIOLATIONS + 1))
fi

# Server migration: present only in the private repo (website/ is sync-excluded).
if [ -f "$MIGRATION37" ]; then
  if ! ast_present "$MIGRATION37" role_rank; then
    fail "Check 37: migration 049 does not use role_rank() — a bare lexicographic role >= is a privilege-escalation bug"
    CHECK37_VIOLATIONS=$((CHECK37_VIOLATIONS + 1))
  fi
  if ! ast_present "$MIGRATION37" approval_state; then
    fail "Check 37: migration 049 lacks the approval_state two-phase lifecycle column"
    CHECK37_VIOLATIONS=$((CHECK37_VIOLATIONS + 1))
  fi
  if ! ast_present "$MIGRATION37" rejected_hardened_required; then
    fail "Check 37: migration 049 does not consume require_hardened_review (dead governance knob)"
    CHECK37_VIOLATIONS=$((CHECK37_VIOLATIONS + 1))
  fi
fi

if [ "$CHECK37_VIOLATIONS" -eq 0 ]; then
  pass "Check 37: Enterprise governance gate invariant intact"
fi

# -------------------------------------------------------
# Check 38: Auth email routes through Resend + targets massu.ai.
# -------------------------------------------------------
# Supabase Auth confirmation/recovery emails MUST use Resend custom SMTP
# (host smtp.resend.com, sender noreply@massu.ai) — NOT Supabase's throttled
# default sender which silently dropped real signups (incident 2026-07-05).
# site_url MUST be the production domain massu.ai (a stale preview host broke
# the confirm-link redirect AND GitHub OAuth return). Mirror of the vitest
# drift-guard auth-email-smtp-config-drift.test.ts.
# -------------------------------------------------------
echo ""
echo "Check 38: Auth email routes through Resend + targets massu.ai (incident 2026-07-05)"
CHECK38_VIOLATIONS=0
CFG_TOML38="$REPO_ROOT/website/supabase/config.toml"
if [ -f "$CFG_TOML38" ]; then
  if ! grep -qE 'host[[:space:]]*=[[:space:]]*"smtp\.resend\.com"' "$CFG_TOML38"; then
    fail "Check 38: [auth.email.smtp] does not use host smtp.resend.com — Auth email may be on the throttled default sender (incident 2026-07-05)"
    CHECK38_VIOLATIONS=$((CHECK38_VIOLATIONS + 1))
  fi
  if ! grep -qE 'site_url[[:space:]]*=[[:space:]]*"https://massu\.ai"' "$CFG_TOML38"; then
    fail "Check 38: [auth].site_url is not https://massu.ai — confirm-link redirect + OAuth return would break"
    CHECK38_VIOLATIONS=$((CHECK38_VIOLATIONS + 1))
  fi
  if grep -q "website-eight-jet-53.vercel.app" "$CFG_TOML38"; then
    fail "Check 38: stale preview host website-eight-jet-53.vercel.app must not appear in Auth config"
    CHECK38_VIOLATIONS=$((CHECK38_VIOLATIONS + 1))
  fi
  if grep -qE 'pass[[:space:]]*=[[:space:]]*"re_' "$CFG_TOML38"; then
    fail "Check 38: SMTP password appears hardcoded (re_...) — must be an env() reference (config.toml is public-synced)"
    CHECK38_VIOLATIONS=$((CHECK38_VIOLATIONS + 1))
  fi
fi
if [ "$CHECK38_VIOLATIONS" -eq 0 ]; then
  pass "Check 38: Auth email routes through Resend + targets massu.ai"
fi

# -------------------------------------------------------
# Check 39: Single API-key resolver + leak-safe default endpoint (CR-59).
# -------------------------------------------------------
# The API key + cloud endpoint are resolved by ONE module (credentials.ts).
# A second ad-hoc env read is exactly how runtime and `doctor` diverged
# (dogfooding incident 2026-07-05: key set but tier still Free). The default
# endpoint must be a branded api.massu.ai host with NO Supabase project ref so
# it passes the public-content leak-guard. Grep-level mirror of the vitest
# drift-guard api-key-resolution-drift-guard.test.ts.
# -------------------------------------------------------
echo ""
echo "Check 39: Single API-key resolver + leak-safe default endpoint (CR-59)"
CHECK39_VIOLATIONS=0
CORE_SRC39="$REPO_ROOT/packages/core/src"
CREDS39="$CORE_SRC39/credentials.ts"
if [ -d "$CORE_SRC39" ]; then
  # (a) Only credentials.ts may read the API-key / endpoint env vars directly.
  ENV_OFFENDERS="$(grep -rlE 'process\.env\.MASSU_API_KEY|process\.env\.MASSU_CLOUD_ENDPOINT' "$CORE_SRC39" --include='*.ts' 2>/dev/null | grep -v '__tests__' | grep -v 'credentials\.ts' || true)"
  if [ -n "$ENV_OFFENDERS" ]; then
    fail "Check 39: direct MASSU_API_KEY/MASSU_CLOUD_ENDPOINT env read outside credentials.ts: $ENV_OFFENDERS"
    CHECK39_VIOLATIONS=$((CHECK39_VIOLATIONS + 1))
  fi
  # (b) No Supabase project-ref URL may ship in the public core package.
  SUPA_OFFENDERS="$(grep -rlE '[a-z0-9]{20}\.supabase\.co' "$CORE_SRC39" --include='*.ts' 2>/dev/null | grep -v '__tests__' || true)"
  if [ -n "$SUPA_OFFENDERS" ]; then
    fail "Check 39: Supabase project-ref URL leaks to the public core package: $SUPA_OFFENDERS"
    CHECK39_VIOLATIONS=$((CHECK39_VIOLATIONS + 1))
  fi
  # (c) The default endpoint must be the branded api.massu.ai host.
  if [ -f "$CREDS39" ]; then
    if ! grep -qE "DEFAULT_CLOUD_ENDPOINT[[:space:]]*=[[:space:]]*'https://api\.massu\.ai/" "$CREDS39"; then
      fail "Check 39: DEFAULT_CLOUD_ENDPOINT in credentials.ts must be the branded https://api.massu.ai/ host"
      CHECK39_VIOLATIONS=$((CHECK39_VIOLATIONS + 1))
    fi
  else
    fail "Check 39: packages/core/src/credentials.ts is missing (single-resolver SoT)"
    CHECK39_VIOLATIONS=$((CHECK39_VIOLATIONS + 1))
  fi
fi
if [ "$CHECK39_VIOLATIONS" -eq 0 ]; then
  pass "Check 39: single API-key resolver + leak-safe default endpoint (CR-59)"
fi

# -------------------------------------------------------
# Check 40: Memory integrity invariants (CR-61)
# -------------------------------------------------------
# Incident 2026-07-12: FIVE silent data-loss defects in the memory subsystem, all
# with a green suite (the tests asserted the buggy behavior). The grep layer of
# CR-61's three-layer enforcement — the drift-guard tests are layer 1, the single
# shared MEMORY_FILE_TITLE_LIKE chokepoint is layer 3.
echo "Check 40: Memory integrity invariants (CR-61)"
# ABSOLUTE, anchored to the script's own repo root — like every other check in this file.
#
# This was `packages/core/src`, a RELATIVE path, and it only ever worked because the scanner
# happened to be invoked from the repo root. `npm` runs `prepublishOnly` with the cwd set to
# `packages/core/`, so `prepublish-check.sh`'s Check 5 — which exists precisely to run this
# scanner before a publish — invoked it from the wrong directory. Every one of Check 40's file
# probes then read a path that does not exist, every probe "failed", and the publish aborted with
# a wall of violations that were not real.
#
# Note the shape of it: a check that is GREEN from one directory and RED from another is not
# checking the code, it is checking the cwd. Had the paths resolved to something that existed but
# was wrong, it would have failed the other way — green while checking nothing — which is the
# exact failure class this whole session has been chasing. Anchor the path; do not rely on where
# the caller happened to stand.
CORE_SRC="$REPO_ROOT/packages/core/src"
CHECK40_VIOLATIONS=0
c40fail() { fail "$1"; CHECK40_VIOLATIONS=$((CHECK40_VIOLATIONS + 1)); }

# (a) The two value-decay predicates MUST exempt file-backed rows. A memory file on
#     disk is the human's standing assertion that the memory is LIVE; a usage counter
#     may not overrule it. Without these, a memory file nobody happened to retrieve
#     went permanently invisible ~93 days after ingest, while sitting untouched on
#     disk, with no way back.
if ! grep -q "AND title NOT LIKE ?" "$CORE_SRC/memory-db.ts" 2>/dev/null; then
  c40fail "Check 40: expireOldLowValueObservations must exempt file-backed rows (CR-61a) — a memory file must never be expired by value-decay"
fi
if ! grep -q "AND o.title NOT LIKE ?" "$CORE_SRC/memory-consolidate.ts" 2>/dev/null; then
  c40fail "Check 40: stageReweight DEMOTE + stageDedupe must exempt file-backed rows (CR-61a) — demotion feeds the expiry floor, and dedupe would supersede the operator's near-paraphrase Laws"
fi
if ! ast_present "$CORE_SRC/memory-consolidate.ts" MEMORY_FILE_TITLE_LIKE reference 2; then
  c40fail "Check 40: memory-consolidate.ts must bind MEMORY_FILE_TITLE_LIKE in BOTH the demote and the dedupe predicates (CR-61a)"
fi

# (b) No hard delete of a memory, anywhere. The allowlist is EMPTY.
# Scan CODE, not prose: session-start.ts documents the exact SQL that used to wipe
# the projection, and a guard that fires on its own incident write-up teaches people
# to delete the write-up. Drop comment lines (`//`, ` *`, `/*`) before matching.
MEM_DELETES=$(grep -rE "DELETE[[:space:]]+FROM[[:space:]]+(observations|architecture_decisions|sessions|memory_files)\b" \
  "$CORE_SRC" --include='*.ts' 2>/dev/null \
  | grep -v '__tests__/' \
  | grep -vE '^[^:]+:[[:space:]]*(//|\*|/\*)' \
  | wc -l | tr -d ' ')
if [ "$MEM_DELETES" -ne 0 ]; then
  c40fail "Check 40: hard DELETE of a memory table found in non-test source (CR-61b) — supersede/EXPIRE instead; the no-hard-delete ALLOWLIST is EMPTY"
fi

# (c) Ingest must read the key the CORPUS writes (nested metadata.type), not just the
#     top-level one. 55 of the operator's 69 memories nest it; reading only the
#     top-level key filed every one of their Laws as a generic 'discovery'.
if grep -q "fm\.type as string" "$CORE_SRC/memory-file-ingest.ts" 2>/dev/null; then
  c40fail "Check 40: memory-file-ingest.ts must not read a bare top-level fm.type (CR-61f) — the corpus nests type under metadata:"
fi
if ! ast_present "$CORE_SRC/memory-file-ingest.ts" readMemoryKey; then
  c40fail "Check 40: memory-file-ingest.ts must read type/confidence via readMemoryKey (CR-61f)"
fi

# (d) Resurrect-on-contact: ingest clears the retirement when the file reappears.
if ! grep -q "expired_at = NULL" "$CORE_SRC/memory-file-ingest.ts" 2>/dev/null; then
  c40fail "Check 40: ingest must clear expired_at (CR-61d, resurrect-on-contact) — else a retired row can never come back"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 4B RENDER CLAUSES (S-1). CR-61's invariant grows one sentence:
#   "...and Massu never writes a file it cannot prove it authored, and never
#    un-deletes a file the human deleted."
# These are the grep layer; the drift-guard vitests are layer 1 and the single shared
# chokepoints are layer 3.
# ═══════════════════════════════════════════════════════════════════════════════

# (e) renderEnabled DEFAULTS TO FALSE. A brand-new capability that writes into the
#     user's memory directory may NEVER auto-enable.
if ! grep -qE "renderEnabled:[[:space:]]*false" "$CORE_SRC/memory-files-config.ts" 2>/dev/null; then
  c40fail "Check 40: memory.files.renderEnabled MUST default to false (CR-61e / B-12) — a capability that writes into the operator's memory directory may never auto-enable"
fi
if grep -qE "renderEnabled:[[:space:]]*true" "$CORE_SRC/memory-files-config.ts" 2>/dev/null; then
  c40fail "Check 40: the shipped default for renderEnabled is true (CR-61e / B-12) — it MUST be false"
fi

# (f) The default-off refusal is the FIRST thing the chokepoint does. A gate that fires
#     after a path is computed, a credential minted, a backup taken or a snapshot written
#     is a gate that has ALREADY touched the operator's disk.
if [ -f "$CORE_SRC/memory-renderer.ts" ]; then
  C40_GATE_LINE=$(grep -n "if (!config.renderEnabled)" "$CORE_SRC/memory-renderer.ts" 2>/dev/null | head -1 | cut -d: -f1)
  if [ -z "$C40_GATE_LINE" ]; then
    c40fail "Check 40: memory-renderer.ts has no renderEnabled gate (CR-61e / B-12)"
  else
    C40_FN_LINE=$(grep -n "export function renderMemoryFiles" "$CORE_SRC/memory-renderer.ts" | head -1 | cut -d: -f1)
    C40_SIDE_EFFECT=$(sed -n "${C40_FN_LINE},${C40_GATE_LINE}p" "$CORE_SRC/memory-renderer.ts" \
      | grep -vE '^[[:space:]]*(//|\*|/\*)' \
      | grep -cE "mintAuthorship|ensureRenderKey|takeBackup|takeSnapshots|computeRenderPath|atomicWriteFileSync|withMemoryIndexLock" || true)
    if [ "${C40_SIDE_EFFECT:-0}" -ne 0 ]; then
      c40fail "Check 40: a side effect (key mint / backup / snapshot / path / write / lock) runs BEFORE the renderEnabled gate in renderMemoryFiles (CR-61e / B-12) — a refusal must cost ZERO side effects"
    fi
  fi
fi

# (g) Authorship is a CREDENTIAL, not a public hash. `sha256` is a PUBLIC function: a
#     body-hash in the frontmatter proves INTEGRITY, not AUTHORSHIP, and the human whose
#     git repo the memory dir IS can compute one in ten seconds. This exact defect has
#     already been reintroduced ONCE during this workstream, wearing a longer string.
if [ -f "$CORE_SRC/memory-authorship.ts" ]; then
  if ! ast_present "$CORE_SRC/memory-authorship.ts" createHmac; then
    c40fail "Check 40: memory-authorship.ts must mint an HMAC (CR-61g / OD-1) — a credential anyone can compute is not a credential"
  fi
  if grep -qE "createHash[[:space:]]*\(" "$CORE_SRC/memory-authorship.ts" 2>/dev/null; then
    c40fail "Check 40: memory-authorship.ts uses createHash (CR-61g / OD-1) — a body-hash is PUBLICLY COMPUTABLE and therefore forgeable by the human. Use an HMAC keyed by the per-install secret."
  fi
  if ! grep -q "randomBytes(32)" "$CORE_SRC/memory-authorship.ts" 2>/dev/null; then
    c40fail "Check 40: the render key must be GENERATED locally via randomBytes(32) (CR-61g / OD-1) — never shipped, bundled, defaulted, or committed"
  fi
  # T-2 FIX (plan-2026-07-15-wave-1-g6-anti-vacuity-registry P2): the old predicate was
  #   grep -qE PATTERN … | grep -qv '__tests__/'
  # `-q` is QUIET — the left grep prints nothing, so the right grep read EMPTY stdin and under
  # real /usr/bin/grep (BSD) `grep -qv` on empty stdin exits 1: the `if` could NEVER fire. The
  # render-key forgery guard (CR-61g) was dead. FIX: CAPTURE the matching file paths with `-rl`
  # (list, not quiet), exclude test files by PATH, and assert the list is NON-EMPTY with an
  # explicit terminal `[ -n ]`. No `2>/dev/null` swallowing (CR-69). `grep -rlE` + `grep -v` are
  # portable across /usr/bin/grep (BSD, local pre-push) AND GNU grep (CI) — proven both in §4.
  RENDER_ENV_MATCHES=$(grep -rlE "process\.env\.[A-Za-z_]*RENDER_KEY" "$CORE_SRC" --include='*.ts' \
    | grep -v '__tests__/' || true)
  if [ -n "$RENDER_ENV_MATCHES" ]; then
    c40fail "Check 40: a render key is read from the environment (CR-61g / OD-1) — whoever sets that env var can forge every stamp"
  fi
fi

# (h) Tombstones live in the CORPUS, not only the DB. `.massu/*.db` is gitignored and
#     the memory files are NOT, so a DB-only tombstone dies in any fresh clone — and the
#     render arm then RE-CREATES the file the human deleted, forever, on every machine.
#     A deletion you have to repeat is not a deletion.
if [ -f "$CORE_SRC/memory-tombstones.ts" ]; then
  if ! grep -q "massu-tombstones.jsonl" "$CORE_SRC/memory-tombstones.ts" 2>/dev/null; then
    c40fail "Check 40: the tombstone ledger must be a file in the memory dir (CR-61h / OD-2) — a DB-only tombstone is wiped by any fresh clone and the deleted file comes back forever"
  fi
fi

if [ "$CHECK40_VIOLATIONS" -eq 0 ]; then
  pass "Check 40: Memory integrity invariants (CR-61)"
fi

# -------------------------------------------------------
# Check 41: Claim Ledger (CR-63)
# -------------------------------------------------------
# A universal quantifier or a capability assertion is a CLAIM ABOUT REALITY: reading a
# plan cannot validate it, only executing something can. A plan audited to ZERO gaps
# across six passes still shipped two false premises, each one shell command from being
# caught. The ANTI-VACUITY self-test runs first: if the detector no longer fires on
# those two real-world misses, this gate is decoration and must fail loudly.
echo "Check 41: Claim Ledger (CR-63)"
CHECK41_VIOLATIONS=0
if command -v node >/dev/null 2>&1 && [ -f scripts/massu-claim-ledger.mjs ]; then
  if ! node scripts/massu-claim-ledger.mjs --self-test >/dev/null 2>&1; then
    fail "Check 41: the claim-ledger detector FAILED its anti-vacuity self-test — it no longer fires on the two claims that actually shipped. It is decoration, not a gate."
    CHECK41_VIOLATIONS=$((CHECK41_VIOLATIONS + 1))
  elif ! node scripts/massu-claim-ledger.mjs >/dev/null 2>&1; then
    fail "Check 41: a plan has universal/capability claims with NO executed evidence (CR-63). Run: node scripts/massu-claim-ledger.mjs"
    CHECK41_VIOLATIONS=$((CHECK41_VIOLATIONS + 1))
  fi
fi
if [ "$CHECK41_VIOLATIONS" -eq 0 ]; then
  pass "Check 41: Claim Ledger (CR-63)"
fi

# -------------------------------------------------------
# Check 42: SSOT SQLite loader — no direct better-sqlite3 value-load (CR-65)
# -------------------------------------------------------
# better-sqlite3 is a NATIVE module: an ABI mismatch dlopen-FAILS lazily INSIDE the
# Database constructor (incident 2026-07-12). Every value/dynamic load MUST route
# through the single lib/sqlite-loader.ts chokepoint so the failure is detected,
# self-healed, and typed-error'd in ONE place — never swallowed, never exit 0.
# `import type Database from 'better-sqlite3'` is erased at compile time → EXEMPT.
# Mirrors the sqlite-loader-drift-guard.test.ts negative scan (three-layer, CR-65).
echo "Check 42: SSOT SQLite loader (CR-65)"
CHECK42_VIOLATIONS=0
CHECK42_HITS=$(grep -rnE "^import Database from 'better-sqlite3'|await import\('better-sqlite3'\)" packages/core/src --include='*.ts' 2>/dev/null \
  | grep -v '__tests__' \
  | grep -v 'lib/sqlite-loader.ts' || true)
if [ -n "$CHECK42_HITS" ]; then
  echo "$CHECK42_HITS"
  fail "Check 42: better-sqlite3 value/dynamic load outside lib/sqlite-loader.ts (CR-65). Route it through openDatabase()/loadBetterSqlite3(). 'import type' is exempt."
  CHECK42_VIOLATIONS=$((CHECK42_VIOLATIONS + 1))
fi
if [ "$CHECK42_VIOLATIONS" -eq 0 ]; then
  pass "Check 42: SSOT SQLite loader (CR-65)"
fi

# -------------------------------------------------------
# Check 43: Template verification block binds to vr-command-map SoT (CR-66)
# -------------------------------------------------------
# A config-template's `verification.<lang>` block is authored in TWO places today —
# the code SoT (vr-command-map.ts:getVRCommands) and hand-copied YAML in each
# templates/<id>/massu.config.yaml — with nothing binding them, so they drift
# silently (incident 2026-07-18: go-chi/rails/spring already diverged; swift-ios
# happened to agree). vr-command-map.ts is the SINGLE authority. This is the
# grep-mirror of template-verification-vr-map-drift.test.ts (layer 1): every
# template ships a verification: block, and the filed exemplar swift-ios's four
# swift commands match the map's `case 'swift'` literals.
echo "Check 43: Template verification block binds to vr-command-map SoT (CR-66)"
CHECK43_VIOLATIONS=0
TEMPLATES_ROOT="packages/core/templates"
# Layer-1 drift-guard MUST exist — else deleting it silently unenforces the whole
# invariant while every gate stays green (the three-layer claim would be hollow).
CHECK43_DRIFT_TEST="packages/core/src/__tests__/template-verification-vr-map-drift.test.ts"
if [ ! -f "$CHECK43_DRIFT_TEST" ]; then
  fail "Check 43: layer-1 drift-guard $CHECK43_DRIFT_TEST is MISSING — the CR-66 invariant is unenforced"
  CHECK43_VIOLATIONS=$((CHECK43_VIOLATIONS + 1))
fi
if [ -d "$TEMPLATES_ROOT" ]; then
  for cfg in "$TEMPLATES_ROOT"/*/massu.config.yaml; do
    [ -e "$cfg" ] || continue
    if ! grep -qE "^verification:" "$cfg"; then
      fail "Check 43: $cfg has no 'verification:' block (CR-66)"
      CHECK43_VIOLATIONS=$((CHECK43_VIOLATIONS + 1))
    fi
  done
  # swift-ios exemplar: its four swift commands must match the map literals.
  SWIFT_CFG="$TEMPLATES_ROOT/swift-ios/massu.config.yaml"
  VRMAP="packages/core/src/detect/vr-command-map.ts"
  for cmd in "swift test" "swift build" "xcodebuild build" "swiftlint"; do
    if ! grep -qF "$cmd" "$SWIFT_CFG"; then
      fail "Check 43: swift-ios template missing swift command '$cmd' (CR-66)"
      CHECK43_VIOLATIONS=$((CHECK43_VIOLATIONS + 1))
    fi
    if ! grep -qF "$cmd" "$VRMAP"; then
      fail "Check 43: vr-command-map.ts missing swift literal '$cmd' — SoT drift (CR-66)"
      CHECK43_VIOLATIONS=$((CHECK43_VIOLATIONS + 1))
    fi
  done
  # swift-ios must NOT be in the intentional-divergence allowlist.
  if grep -qE "['\"]swift-ios['\"][[:space:]]*:" "$VRMAP"; then
    fail "Check 43: swift-ios appears in TEMPLATE_VERIFICATION_MAP_EXEMPT — it is LOCKED, not exempt (CR-66)"
    CHECK43_VIOLATIONS=$((CHECK43_VIOLATIONS + 1))
  fi
else
  fail "Check 43: $TEMPLATES_ROOT not found (CR-66)"
  CHECK43_VIOLATIONS=$((CHECK43_VIOLATIONS + 1))
fi
if [ "$CHECK43_VIOLATIONS" -eq 0 ]; then
  pass "Check 43: Template verification block binds to vr-command-map SoT (CR-66)"
fi

# -------------------------------------------------------
# Check 44: Cross-repo surfacing crossing invariants (CR-67 / VR-CROSS-REPO-SURFACING)
# -------------------------------------------------------
# Slice 5's LAW: nothing crosses a repo boundary without a human act on both sides,
# and nothing crossed is ever an instruction. This is the LAYER-3 backstop to the
# per-item vitest drift-guards (layer 2) and the code gates (layer 1) — it FAILS the
# build if any of the crossing invariants regresses:
#   (a) ONE origin vocabulary + fail-closed predicate (memory-origin.ts SoT).
#   (b) accept/refuse are CLI-ONLY — NO MCP tool maps to them (tools.ts is clean).
#   (c) the verify->pending->accept half imports no concrete transport / no global fetch.
#   (d) accept RE-VERIFIES the retained envelope bytes (D2 closed for the cross-repo path).
#   (e) export is fail-closed via the DETECTOR (containsSecret), never redactSecrets.
#   (f) the pending recall arm reads NO candidate content (zero-byte injection defence).
echo "Check 44: Cross-repo surfacing crossing invariants (CR-67)"
CHECK44_SRC="$REPO_ROOT/packages/core/src"
CHECK44_OK=1
# (a) origin SoT + fail-closed
if ! grep -q "export function isLocalOrigin" "$CHECK44_SRC/memory-origin.ts" 2>/dev/null; then
  fail "Check 44: memory-origin.ts is missing the isLocalOrigin SoT predicate (CR-67a)"; CHECK44_OK=0
fi
# (b) no MCP accept/refuse tool — the model may read attacker text
if grep -qE "acceptSharedMemory|refuseSharedMemory|runMemoryShareCli|memory-share-cli" "$CHECK44_SRC/tools.ts" 2>/dev/null; then
  fail "Check 44: tools.ts references a cross-repo accept/refuse handler — accept MUST be CLI-only (CR-67b)"; CHECK44_OK=0
fi
# (c) the sync half is transport-agnostic (code AND comments)
if grep -qE "\bLocalFsTransport\b|(^|[^.a-zA-Z0-9_])fetch\s*\(" "$CHECK44_SRC/shared-memory-sync.ts" 2>/dev/null; then
  fail "Check 44: shared-memory-sync.ts names a concrete transport or a global fetch — the verify->accept half MUST be transport-agnostic (CR-67c)"; CHECK44_OK=0
fi
# (d) accept re-verifies the retained bytes — AST call/reference SITES, not comment-satisfiable
#     bare-identifier greps (T-3: a `// verifyLocalShareEnvelope` comment must NOT satisfy this).
if ! ast_present "$CHECK44_SRC/shared-memory-sync.ts" verifyLocalShareEnvelope call || \
   ! ast_present "$CHECK44_SRC/shared-memory-sync.ts" envelope_raw reference; then
  fail "Check 44: shared-memory-sync.ts accept path does not re-verify the retained envelope (D2 regressed?) (CR-67d)"; CHECK44_OK=0
fi
# (e) export uses the DETECTOR, never the redactor — AST CALL-site, not a bare-identifier grep (T-3).
if ! ast_present "$CHECK44_SRC/shared-memory-export.ts" containsSecret call; then
  fail "Check 44: shared-memory-export.ts does not use the containsSecret DETECTOR — export must REFUSE, never redact (CR-67e)"; CHECK44_OK=0
fi
if grep -qE "redactSecrets\s*\(" "$CHECK44_SRC/shared-memory-export.ts" 2>/dev/null; then
  fail "Check 44: shared-memory-export.ts CALLS redactSecrets — a shared memory must never be silently rewritten (CR-67e)"; CHECK44_OK=0
fi
# (f) the pending recall arm reads no candidate content. Capture the pendingPointer
#     body into a here-string (NEVER pipe a streaming grep into `grep -q` — broken-pipe
#     false-verdict class, incident 2026-07-16).
CHECK44_PP="$("$AWK" '/export function pendingPointer/{f=1} f{print} f&&/^}/{exit}' "$CHECK44_SRC/shared-memory-recall.ts" 2>/dev/null || true)"
if grep -qE "record_json|envelope_raw|\.title|\.detail" <<< "$CHECK44_PP"; then
  fail "Check 44: pendingPointer reads candidate content — the pending arm MUST emit zero candidate-derived bytes (CR-67f)"; CHECK44_OK=0
fi
# layer-2 drift-guards must exist
for CHECK44_G in shared-memory-sync-drift-guard shared-memory-cli-drift-guard shared-memory-recall-drift-guard shared-memory-slice4b-seam-drift-guard; do
  if [ ! -f "$CHECK44_SRC/__tests__/$CHECK44_G.test.ts" ]; then
    fail "Check 44: layer-2 drift-guard $CHECK44_G.test.ts is MISSING — a CR-67 invariant is unenforced"; CHECK44_OK=0
  fi
done
# no duplicate check numbers (this check must be the ONLY 44)
CHECK44_DUP=$(grep -oE 'echo "Check [0-9]+' "${BASH_SOURCE[0]}" | grep -oE '[0-9]+' | sort | uniq -d | tr '\n' ' ')
if [ -n "$CHECK44_DUP" ]; then
  fail "Check 44: duplicate pattern-scanner check number(s): $CHECK44_DUP"; CHECK44_OK=0
fi
if [ "$CHECK44_OK" -eq 1 ]; then
  pass "Check 44: Cross-repo surfacing crossing invariants intact (CR-67)"
fi

# -------------------------------------------------------
# Check 45: Handoff completeness — every session handoff is turn-key (CR-68 / VR-HANDOFF)
# -------------------------------------------------------
# Operator directive 2026-07-21: never hand back an "Operator TODO" bullet list. Every
# new/changed `.claude/session-state/{RECAP,HANDOFF}-*.md` must carry a complete
# `## Next-Session Runbook` (per-item **Vehicle**/**Steps**/**Stop**/**Acceptance**).
# Layer 3 backstop to the drift-guard vitest (layer 2) and the gate script (layer 1).
echo "Check 45: Handoff completeness (CR-68)"
CHECK45_OK=1
CHECK45_GATE="$REPO_ROOT/scripts/massu-handoff-completeness.sh"
if [ ! -f "$CHECK45_GATE" ]; then
  fail "Check 45: scripts/massu-handoff-completeness.sh is MISSING — the handoff gate is unenforced (CR-68)"; CHECK45_OK=0
else
  # The gate must OPEN and CLOSE (its own mutation self-test) — a gate that cannot fail is decoration.
  if ! bash "$CHECK45_GATE" --self-test >/dev/null 2>&1; then
    fail "Check 45: the handoff gate self-test FAILED — it no longer opens/closes (CR-68)"; CHECK45_OK=0
  fi
  # Every handoff written/changed in this branch must be complete.
  if ! bash "$CHECK45_GATE" --changed >/dev/null 2>&1; then
    fail "Check 45: a new/changed handoff is INCOMPLETE. Run: bash scripts/massu-handoff-completeness.sh --changed (see .claude/templates/handoff-runbook.md) (CR-68)"; CHECK45_OK=0
  fi
fi
if [ "$CHECK45_OK" -eq 1 ]; then
  pass "Check 45: handoff docs are turn-key (CR-68)"
fi

# -------------------------------------------------------
# Check 46: DB-driver adapter — node:sqlite is the sole-adapter engine (Layer 2, CR-69)
# -------------------------------------------------------
# Layer 2 makes Node's built-in node:sqlite the DEFAULT DB engine (native-free — no ABI
# to break, incident 2026-07-12), behind the single swappable db-driver.ts adapter.
# node:sqlite MUST be value-loaded ONLY in db-driver.ts, and openDatabase MUST be imported
# from the adapter everywhere (the loader's openDatabase is the adapter's bs3-driver
# delegate only). Grep-mirror of db-driver-drift-guard.test.ts (three-layer, CR-69).
# `import type` is erased at compile time → EXEMPT.
echo "Check 46: DB-driver adapter — node:sqlite sole-loader (Layer 2)"
CHECK46_VIOLATIONS=0
# (b) node:sqlite value/dynamic-loaded or DatabaseSync constructed outside the adapter.
# IDIOM-AGNOSTIC: the `\(['\"]node:sqlite['\"]\)` call-form catches require(), import(),
# AND the createRequire-alias `req('node:sqlite')` idiom the adapter itself uses (which a
# 4-regex plain-string set missed — closed after the CR-69 pattern review). A user-facing
# label like 'node:sqlite (native-free)' in doctor/heal has trailing text → not matched.
CHECK46_NODE_HITS=$(grep -rnE "from ['\"]node:sqlite['\"]|\(['\"]node:sqlite['\"]\)|new DatabaseSync\(" packages/core/src --include='*.ts' 2>/dev/null \
  | grep -v '__tests__' \
  | grep -v 'db-driver.ts' || true)
if [ -n "$CHECK46_NODE_HITS" ]; then
  echo "$CHECK46_NODE_HITS"
  fail "Check 46: node:sqlite value-load / DatabaseSync outside db-driver.ts (Layer 2, CR-69). Route DB opens through openDatabase() from db-driver.ts. 'import type' is exempt."
  CHECK46_VIOLATIONS=$((CHECK46_VIOLATIONS + 1))
fi
# (c) openDatabase imported from the Layer-1 loader anywhere but the adapter.
CHECK46_OPEN_HITS=$(grep -rnE "import[[:space:]]*\{[^}]*\bopenDatabase\b[^}]*\}[[:space:]]*from[[:space:]]*['\"][^'\"]*lib/sqlite-loader\.ts['\"]" packages/core/src --include='*.ts' 2>/dev/null \
  | grep -v '__tests__' \
  | grep -v 'db-driver.ts' || true)
if [ -n "$CHECK46_OPEN_HITS" ]; then
  echo "$CHECK46_OPEN_HITS"
  fail "Check 46: openDatabase imported from lib/sqlite-loader.ts outside the adapter (Layer 2, CR-69). Import openDatabase from db-driver.ts."
  CHECK46_VIOLATIONS=$((CHECK46_VIOLATIONS + 1))
fi
if [ "$CHECK46_VIOLATIONS" -eq 0 ]; then
  pass "Check 46: DB-driver adapter — node:sqlite sole-loader (Layer 2)"
fi

# -------------------------------------------------------
# Check 47: Node-bootstrap chokepoint + exec-safety (Layer 2, CR-70)
# -------------------------------------------------------
# CR-70 Layer 2: @massu/core self-bootstraps a compatible Node at the SINGLE cli.ts
# chokepoint ABOVE the dispatch switch (covering both the hook-runner and MCP-server paths of
# the one bin), so a hook can never launch under a Node the server would reject (incident
# 2026-07-22-native-abi-hooks-bare-node-launch). L2-7: discovery is confined to a strict
# absolute-path allowlist — it MUST NOT read PATH / `which` and re-exec MUST use an argv array
# (no shell). Grep-mirror of node-bootstrap-drift-guard + node-bootstrap-exec-safety tests.
echo "Check 47: Node-bootstrap chokepoint + exec-safety (CR-70)"
CHECK47_OK=1
NB_FILE="$SRC_DIR/lib/node-bootstrap.ts"
CLI_FILE="$SRC_DIR/cli.ts"
if [ ! -f "$NB_FILE" ]; then
  fail "Check 47: lib/node-bootstrap.ts is MISSING — the self-bootstrap launcher SoT (CR-70)"
  CHECK47_OK=0
fi
BOOT_LINE=$(grep -n "bootstrapNodeOrExit(" "$CLI_FILE" 2>/dev/null | grep -v "import" | head -1 | cut -d: -f1)
SWITCH_LINE=$(grep -n "switch (subcommand)" "$CLI_FILE" 2>/dev/null | head -1 | cut -d: -f1)
if [ -z "$BOOT_LINE" ]; then
  fail "Check 47: bootstrapNodeOrExit() is not invoked in cli.ts — the launcher never self-bootstraps (CR-70)"
  CHECK47_OK=0
elif [ -z "$SWITCH_LINE" ]; then
  fail "Check 47: 'switch (subcommand)' not found in cli.ts — cannot verify chokepoint ordering (CR-70)"
  CHECK47_OK=0
elif [ "$BOOT_LINE" -ge "$SWITCH_LINE" ]; then
  fail "Check 47: bootstrapNodeOrExit() (line $BOOT_LINE) must PRECEDE the dispatch switch (line $SWITCH_LINE) so it covers both hook-runner and MCP-server paths (CR-70)"
  CHECK47_OK=0
fi
if [ -f "$NB_FILE" ]; then
  # Strip block + line comments so the module's own prose ("never PATH / which") never trips this.
  NB_CODE=$(perl -0pe 's{/\*.*?\*/}{}gs; s{//[^\n]*}{}g' "$NB_FILE" 2>/dev/null)
  if printf '%s' "$NB_CODE" | grep -qE "process\.env\.PATH|env\.PATH\b|\bwhich\b|shell[[:space:]]*:[[:space:]]*true"; then
    fail "Check 47: node-bootstrap.ts reads PATH/which or uses shell:true — discovery MUST use the strict absolute-path allowlist + argv-array exec (CR-70 L2-7)"
    CHECK47_OK=0
  fi
  # CR-70 Windows parity (Layer 2-W): the win32 discovery branch MUST NOT consult the Windows PATH
  # resolver (`where.exe`), the `%PATH%` env expansion, or `process.env.Path`/`env.Path` (the
  # Windows-cased analogue of the forbidden `which`/`env.PATH`). It uses the strict absolute-path
  # allowlist keyed to Windows install-dir env pointers only. Distinct message = a NEW anti-vacuity
  # fail-point (registered in gate-registry.json, P4-005).
  if printf '%s' "$NB_CODE" | grep -qE "where\.exe|%PATH%|process\.env\.Path\b|env\.Path\b"; then
    fail "Check 47: node-bootstrap.ts touches Windows PATH / where.exe / %PATH% — win32 discovery MUST use the strict absolute-path allowlist (CR-70 L2-7 Windows parity)"
    CHECK47_OK=0
  fi
fi
if [ "$CHECK47_OK" -eq 1 ]; then
  pass "Check 47: Node-bootstrap chokepoint + exec-safety (CR-70)"
fi

# -------------------------------------------------------
# Check 48: Installer launch symmetry — no divergent mechanism (Layer 3, CR-70)
# -------------------------------------------------------
# CR-70 Layer 3: the two init.ts emitters — registerMcpServer (.mcp.json server command) and
# hookCmd/buildHooksConfig (hook commands) — MUST share ONE launch mechanism (both
# `npx -y @massu/core@<version>`, the hook only appending `hook-runner <name>`). A hand-wrapped
# `node@<ver> npx …` on either side is the wrapped-server/bare-hooks asymmetry the incident rode
# in on — forbidden. Grep-mirror of installer-launch-symmetry-drift-guard test.
echo "Check 48: Installer launch symmetry (CR-70)"
CHECK48_OK=1
INIT_FILE="$SRC_DIR/commands/init.ts"
if ! grep -qF "command: 'npx'" "$INIT_FILE" 2>/dev/null; then
  fail "Check 48: registerMcpServer no longer emits command:'npx' — the .mcp.json server launcher drifted (CR-70)"
  CHECK48_OK=0
fi
if ! grep -qF 'npx -y @massu/core@${version} hook-runner' "$INIT_FILE" 2>/dev/null; then
  fail "Check 48: hookCmd no longer emits 'npx -y @massu/core@\${version} hook-runner' — the hook launcher drifted (CR-70)"
  CHECK48_OK=0
fi
NODEWRAP=$(grep -nE "node@[0-9]+" "$INIT_FILE" 2>/dev/null || true)
if [ -n "$NODEWRAP" ]; then
  echo "$NODEWRAP"
  fail "Check 48: init.ts contains a 'node@<ver>' launcher wrapper — the wrapped-server/bare-hooks asymmetry (incident 2026-07-22) MUST NOT be reintroduced (CR-70)"
  CHECK48_OK=0
fi
if [ "$CHECK48_OK" -eq 1 ]; then
  pass "Check 48: Installer launch symmetry (CR-70)"
fi

# -------------------------------------------------------
# Check 49: Doctor canary hook-execution present + registered (Layer 4, CR-70)
# -------------------------------------------------------
# CR-70 Layer 4: doctor must prove hooks EXECUTE, not merely that they are configured (gap G-3
# — a hook that crashes at load with ERR_DLOPEN_FAILED read green). checkHookExecution runs a
# real canary end-to-end and MUST be wired into runDoctor's checks array. Grep-mirror of
# doctor-hook-execution-drift-guard test.
echo "Check 49: Doctor canary hook-execution (CR-70)"
CHECK49_OK=1
DOCTOR_FILE="$SRC_DIR/commands/doctor.ts"
if ! grep -qE "export async function checkHookExecution" "$DOCTOR_FILE" 2>/dev/null; then
  fail "Check 49: checkHookExecution is not defined in doctor.ts — runtime hook health (L4) missing (CR-70)"
  CHECK49_OK=0
fi
if ! grep -qE "await checkHookExecution\(" "$DOCTOR_FILE" 2>/dev/null; then
  fail "Check 49: checkHookExecution is not invoked in runDoctor's checks array — the canary never runs (CR-70)"
  CHECK49_OK=0
fi
if [ "$CHECK49_OK" -eq 1 ]; then
  pass "Check 49: Doctor canary hook-execution (CR-70)"
fi

# -------------------------------------------------------
# Check 50: Workspace ↔ @massu/core dependency + engine coherence (CR-71)
# -------------------------------------------------------
# A first-party workspace (packages/adapter-*) that declares a @massu/core peer/dep range NOT
# satisfying core's version, or an engines.node NARROWER than core's, breaks a clean `npm ci`
# (ERESOLVE) — invisible to `npm test` (reuses node_modules). Latent since the 2.0.0 major
# (adapters kept `^1.6.0`); incident 2026-07-23-npm-ci-workspace-peer-drift. Grep-mirror of
# workspace-dependency-coherence.test.ts (CR-71), using node+semver for a correct range check.
echo "Check 50: Workspace dependency coherence (CR-71)"
CHECK50_ERR=$(node -e '
const fs=require("fs"),path=require("path"),semver=require("semver");
const pkgs=path.join(process.argv[1],"packages");
const core=JSON.parse(fs.readFileSync(path.join(pkgs,"core","package.json"),"utf8"));
const cv=core.version, ce=core.engines&&core.engines.node;
const bad=[];
for(const d of fs.readdirSync(pkgs)){
  if(d==="core")continue;
  const pj=path.join(pkgs,d,"package.json");
  if(!fs.existsSync(pj))continue;
  const p=JSON.parse(fs.readFileSync(pj,"utf8"));
  for(const f of ["dependencies","peerDependencies","devDependencies"]){
    const r=p[f]&&p[f]["@massu/core"];
    if(!r||r.startsWith("workspace:")||r.startsWith("file:"))continue;
    if(!semver.satisfies(cv,r))bad.push(`${p.name} ${f} @massu/core "${r}" !satisfies core ${cv}`);
  }
  const we=p.engines&&p.engines.node;
  if(we&&ce){const cm=semver.minVersion(ce);
    if(cm&&!semver.satisfies(cm.version,we))bad.push(`${p.name} engines "${we}" excludes core floor ${cm.version}`);
    for(const m of [22,23,24,25,26,27,28]){const v=m+".13.0"; if(semver.satisfies(v,ce)&&!semver.satisfies(v,we)){bad.push(`${p.name} engines "${we}" excludes core-allowed ${v}`);break;}}
  }
}
if(bad.length){console.error(bad.join(" | "));process.exit(1);}
' "$REPO_ROOT" 2>&1)
if [ $? -eq 0 ]; then
  pass "Check 50: Workspace dependency coherence (CR-71)"
else
  fail "Check 50: workspace incoherent with @massu/core — $CHECK50_ERR (CR-71)"
fi

# -------------------------------------------------------
# Summary
# -------------------------------------------------------
echo ""
echo "=== Pattern Scanner Summary ==="
if [ "$VIOLATIONS" -gt 0 ]; then
  echo -e "${RED}FAIL: $VIOLATIONS violation(s) found${NC}"
  exit 1
else
  echo -e "${GREEN}PASS: All pattern checks passed${NC}"
  exit 0
fi
