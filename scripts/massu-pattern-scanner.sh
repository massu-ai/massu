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
    awk -v file="$f" -v vre="$violation_regex" -v key="$directive_key" '
      $0 ~ "pattern-scanner-allow:[[:space:]]*" key { allow_next = 1; next }
      $0 ~ vre {
        if (allow_next) { allow_next = 0; next }
        if ($0 ~ /^[[:space:]]*(\*|\/\/|\/\*)/) { allow_next = 0; next }
        print file ":" NR ":" $0
        allow_next = 0
        next
      }
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
REQUIRE_HITS=$(scan_with_directive 'require\(' 'require' '*/hooks/*')
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
YAML_HITS=$(scan_with_directive 'yaml\.parse[A-Za-z]*\(|parseYaml\(|yamlParse\(|parseDocument\(' 'yaml-parse' '*/config.ts')
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
# Check 10: Memory system patterns
# Verifies getMemoryDb() is closed after use (try/finally pattern)
# -------------------------------------------------------
echo "Check 10: Memory DB closed after use (try/finally pattern)"
MEMORY_DB_OPEN=$(grep -rn 'getMemoryDb()' "$SRC_DIR" --include="*.ts" \
  | grep -v '__tests__' \
  | grep -v 'node_modules' \
  | grep -v '\.test\.ts:' \
  | grep -v 'memory-db\.ts' \
  | wc -l | tr -d ' ')
MEMORY_DB_CLOSE=$(grep -rn 'memDb\.close()' "$SRC_DIR" --include="*.ts" \
  | grep -v '__tests__' \
  | grep -v 'node_modules' \
  | grep -v '\.test\.ts:' \
  | wc -l | tr -d ' ')
if [ "$MEMORY_DB_OPEN" -gt 0 ] && [ "$MEMORY_DB_CLOSE" -lt "$MEMORY_DB_OPEN" ]; then
  warn "getMemoryDb() called $MEMORY_DB_OPEN times but memDb.close() only $MEMORY_DB_CLOSE times (possible leak)"
else
  pass "Memory DB open/close balanced ($MEMORY_DB_OPEN opens, $MEMORY_DB_CLOSE closes)"
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
