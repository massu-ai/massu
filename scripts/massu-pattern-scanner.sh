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
SRC_DIR="$REPO_ROOT/packages/core/src"
VIOLATIONS=0
QUICK_MODE="${1:-}"

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
#           commands/ (CLI commands that need exit codes)
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
  | grep -v 'commands/' \
  | wc -l | tr -d ' ')
if [ "$PROCESS_EXIT_COUNT" -gt 0 ]; then
  fail "Found $PROCESS_EXIT_COUNT process.exit() calls in library code"
  grep -rn 'process\.exit' "$SRC_DIR" --include="*.ts" \
    | grep -v 'server\.ts' | grep -v '__tests__' | grep -v 'hooks/' | grep -v '\-runner\.ts' | grep -v 'backfill-' \
    | grep -v 'cli\.ts' | grep -v 'commands/' \
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
# -------------------------------------------------------
echo "Check 9: Knowledge system uses getCodeGraphDb()"
KNOWLEDGE_FILES=$(find "$SRC_DIR" -name "*.ts" \
  -not -path "*/__tests__/*" \
  -not -path "*/node_modules/*" \
  -not -name "*.test.ts" \
  -not -name "db.ts" \
  2>/dev/null)
DIRECT_SQLITE_COUNT=0
if [ -n "$KNOWLEDGE_FILES" ]; then
  DIRECT_SQLITE_COUNT=$(echo "$KNOWLEDGE_FILES" | xargs grep -l 'new Database\|sqlite3\(' 2>/dev/null \
    | grep -v 'db\.ts\|memory-db\.ts' \
    | wc -l | tr -d ' ')
fi
if [ "$DIRECT_SQLITE_COUNT" -gt 0 ]; then
  fail "Found $DIRECT_SQLITE_COUNT files opening SQLite directly (use getCodeGraphDb()/getDataDb()/getMemoryDb())"
  echo "$KNOWLEDGE_FILES" | xargs grep -l 'new Database\|sqlite3\(' 2>/dev/null | grep -v 'db\.ts\|memory-db\.ts' | head -5
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
  if grep -nE '^[[:space:]]*[^[:space:]/*]+.*getMemoryDb\(\)' "$f" 2>/dev/null | grep -qv '^[[:space:]]*//' ; then
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
    # Skip auth/checkout literal allowlist.
    if echo "$norm" | grep -qE "$AUTH_CHECKOUT_PATTERN"; then continue; fi
    # Skip dynamic routes ([slug] / [...catchall] / [id]).
    if echo "$norm" | grep -qE '\['; then continue; fi
    # Skip WEBSITE_NAV_EXEMPT entries.
    skip=0
    while IFS= read -r exempt; do
      [ -z "$exempt" ] && continue
      [ "$norm" = "$exempt" ] && { skip=1; break; }
    done <<< "$EXEMPT_PATHS"
    [ "$skip" -eq 1 ] && continue
    # Must appear in NAV_HREFS.
    if ! echo "$NAV_HREFS" | grep -qxF "$norm"; then
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
    hits=$(awk '
      # Strip inline /* ... */ comments to avoid false hits in prose.
      function strip_comments(s) { gsub(/\/\*[^*]*\*+([^/*][^*]*\*+)*\//, "", s); return s }
      # Track allowlist disable comments on preceding lines.
      /eslint-disable-next-line[^\n]*massu\/no-unbounded-sql-all/ { allow = NR + 1 }
      /\.prepare\(/ { buf = $0; line_start = NR; collecting = 1; next }
      collecting {
        buf = buf "\n" $0
        if (/\.all\(/) {
          collecting = 0
          if (NR == allow || line_start == allow) next
          tmp = strip_comments(buf)
          # Crude SELECT? + LIMIT? grep.
          if (tmp ~ /[Ss][Ee][Ll][Ee][Cc][Tt]/ &&
              tmp !~ /[Cc][Oo][Uu][Nn][Tt]\s*\(/ &&
              tmp !~ /[Ll][Ii][Mm][Ii][Tt]\s*(\$|\?|:|[0-9])/) {
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
    if head -n 30 "$f" 2>/dev/null | grep -qE '@scanner-allow:large-file'; then
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
