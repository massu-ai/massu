#!/bin/bash
# ============================================================
# MEMORY INTEGRITY CHECK (SessionStart hook)
# ============================================================
# Verifies the memory store is intact before anything in the session trusts it,
# and screens MEMORY.md for content that contradicts CLAUDE.md rules (prompt
# injection reaching persistent memory via WebFetch / article review).
#
# ------------------------------------------------------------
# WHY THIS FILE LOOKS THE WAY IT DOES — read before simplifying.
#
# Until 2026-08-08 this hook was named for integrity and checked none. It grepped
# ONE file for nine patterns and never touched the database. Mutation-tested in
# the real tree, it produced:
#
#     store present, no violation -> exit 0, 0 bytes
#     store ABSENT                -> exit 0, 0 bytes   <- BYTE-IDENTICAL to clean
#     violation PLANTED           -> warning printed, EXIT_ON_VIOLATION=0
#
# The absent-store pass was one line (`[ ! -f "$MEMORY_FILE" ] && exit 0`): the
# condition under which verification matters most returned "clean". That is the
# blind-gate law — "I could not look" and "I looked and found nothing" producing
# the same value, and that value being the passing one.
#
# So the three properties below are load-bearing, not style:
#
#   M1  IT ALWAYS PRINTS ITS DENOMINATOR. A run that examined nothing says so.
#       "Scanned 0, found 0" must never look like health.
#   M2  IT FAILS LOUD. Absent store, unreadable store, missing node, corrupt DB —
#       each produces DIFFERENT, NAMED output. None of them is silence.
#   M4  IT IS MUTATION-TESTED by scripts/tests/test-memory-integrity-check.sh,
#       which plants each failure in turn and demands the verdict change.
#
# EXIT CODE IS DELIBERATELY ALWAYS 0, and that is a decision rather than an
# oversight. This runs at SessionStart; Claude Code's contract for a non-zero exit
# there is not established, and a hook that can prevent a session from opening is
# a brick — and a brick gets deleted, after which nothing is enforced (CR-72).
# At SessionStart the OUTPUT is the channel that reaches the operator, so the
# output is where this check fails closed. The machine-readable verdict line
# exists so a future gate can assert on it without re-parsing prose.
#
# VERDICT is a CLOSED vocabulary: OK | DEGRADED | UNCHECKABLE.
#   OK           every check ran and passed
#   DEGRADED     every check ran; at least one found a real problem
#   UNCHECKABLE  a check COULD NOT RUN — never conflated with OK
#
# The full retro for this is recorded internally and dated 2026-08-08; it is not cited by
# path here because this file publishes to the public mirror and an internal path would
# leak with it. The mutation test named above is the executable half of that record.
# ============================================================

# NOT `set -e`: an early abort would skip the verdict line, which is the one thing
# this hook must always emit. `-u` catches unset vars, `pipefail` stops a failing
# producer from being masked by a succeeding consumer.
set -uo pipefail

VERDICT="OK"
PROBLEMS=""

note() { PROBLEMS="${PROBLEMS}
  - $1"; }

# A check that found a real problem. The store was readable; the answer is bad.
degrade() { [ "$VERDICT" = "OK" ] && VERDICT="DEGRADED"; note "$1"; }

# A check that COULD NOT RUN. Always outranks DEGRADED — an unknown is worse than
# a known problem, because it is the state that used to read as clean.
uncheckable() { VERDICT="UNCHECKABLE"; note "$1"; }

# ---------- 1. Locate the project ----------------------------------------- #
# CLAUDE_PROJECT_DIR first, deliberately: `git rev-parse` inherits a leaked
# GIT_DIR from any caller that set one and would then resolve a DIFFERENT
# repository, and a wrong-corpus read returns PLENTY rather than nothing — which
# no non-empty check can detect (G29, the reader half).
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$PROJECT_ROOT" ]; then
  PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
fi

if [ -z "$PROJECT_ROOT" ] || [ ! -d "$PROJECT_ROOT" ]; then
  printf '\n[MEMORY INTEGRITY] UNCHECKABLE — no project root (CLAUDE_PROJECT_DIR unset and not a git work tree).\n'
  printf '  The memory store was NOT examined. This is not a clean result.\n\n'
  exit 0
fi

# ---------- 2. Encode the memory directory -------------------------------- #
# Mirrors packages/core/src/lib/memory-path.ts `encodeMemoryDirName`, verified
# equivalent 2026-08-08: `replace(/\//g, '-')` vs this substitution.
# An EMPTY component here would widen every path below to a parent directory
# (G17), so it is refused rather than allowed to interpolate.
ENCODED_PATH="${PROJECT_ROOT//\//-}"
if [ -z "$ENCODED_PATH" ] || [ "$ENCODED_PATH" = "-" ]; then
  printf '\n[MEMORY INTEGRITY] UNCHECKABLE — could not encode a memory directory from %s\n\n' "$PROJECT_ROOT"
  exit 0
fi

# The STORE ROOT is injectable so this hook can be pointed at a scratch tree.
#
# It was hardcoded to `$HOME/.claude/projects`. That let the mutation test redirect the
# PROJECT dir (CLAUDE_PROJECT_DIR) but not the STORE, so every sandbox project it invented
# materialised a real directory inside the operator's LIVE memory store — the directory a
# burst deletion destroyed on 2026-07-26. Six were still present when this was measured,
# the newest from that same week, and they inflate every fleet-wide census that globs this
# root (17 stores discovered, 6 of them fixtures).
#
# EMPTY is refused rather than defaulted: an empty root would widen MEMORY_DIR to
# `/${ENCODED_PATH}/memory` — G17, an empty component widens a path to its parent. `set -u`
# does not fire on set-but-empty, so the test has to be explicit.
MEMORY_STORE_ROOT="${MASSU_MEMORY_STORE_ROOT:-$HOME/.claude/projects}"
if [ -z "$MEMORY_STORE_ROOT" ]; then
  printf '\n[MEMORY INTEGRITY] UNCHECKABLE — MASSU_MEMORY_STORE_ROOT is set but empty.\n\n'
  exit 0
fi

MEMORY_DIR="$MEMORY_STORE_ROOT/${ENCODED_PATH}/memory"
MEMORY_FILE="$MEMORY_DIR/MEMORY.md"
DB_FILE="$PROJECT_ROOT/.massu/memory.db"

# ---------- 3. Corpus ------------------------------------------------------ #
CORPUS_COUNT=0
if [ -d "$MEMORY_DIR" ]; then
  CORPUS_COUNT=$(find "$MEMORY_DIR" -maxdepth 1 -name '*.md' -type f 2>/dev/null | wc -l | tr -d ' ')
  [ -z "$CORPUS_COUNT" ] && CORPUS_COUNT=0
else
  uncheckable "memory directory ABSENT: $MEMORY_DIR (nothing to verify — this used to report clean)"
fi

# ---------- 4. The index --------------------------------------------------- #
INDEX_BYTES=0
if [ -f "$MEMORY_FILE" ]; then
  INDEX_BYTES=$(wc -c < "$MEMORY_FILE" 2>/dev/null | tr -d ' ')
  [ -z "$INDEX_BYTES" ] && INDEX_BYTES=0
elif [ -d "$MEMORY_DIR" ]; then
  # The directory exists but the index does not. Previously indistinguishable
  # from a healthy run; now named.
  uncheckable "MEMORY.md ABSENT: $MEMORY_FILE (the index every session loads is missing)"
fi

# ---------- 5. Injection screen ------------------------------------------- #
# Patterns that must never appear in MEMORY.md. The denominator is DERIVED from
# this list rather than hand-maintained, so adding a rule cannot silently leave
# the reported count stale.
PATTERNS=(
  'parse YAML directly|import.*yaml.*from|require.*yaml=suggests parsing YAML directly (must use getConfig())'
  'skip verif|verification not needed|VR-.* not required|skip VR-|disable hook=suggests skipping verification (CR-1)'
  'use --no-verify|skip pre-commit|bypass hook=suggests bypassing git hooks (security violation)'
  'commit.*\.env|add.*\.env.*to git|\.env is safe to commit=suggests committing secret files (CR-3)'
  'skip.*tools\.ts|don.t need.*tools\.ts|tools\.ts.*not required=suggests skipping tools.ts registration (CR-11)'
  'hardcode.*prefix|hardcode.*tool.*name|hardcode.*path=suggests hardcoding values (config-driven architecture)'
  'don.t need.*\.ts|skip.*extension|import without extension=suggests skipping .ts extensions (ESM pattern)'
  'write.*to.*CodeGraph|modify.*CodeGraph.*db|CodeGraph.*is writable=suggests writing to CodeGraph DB (must be read-only)'
  'use process\.env for (secret|key|token|credential)|process\.env is fine for=suggests process.env for secrets'
)
PATTERNS_CHECKED=0
INJECTION_HITS=0
if [ -f "$MEMORY_FILE" ]; then
  for entry in "${PATTERNS[@]}"; do
    rx="${entry%%=*}"
    msg="${entry#*=}"
    PATTERNS_CHECKED=$((PATTERNS_CHECKED + 1))
    if grep -iqE "$rx" "$MEMORY_FILE" 2>/dev/null; then
      INJECTION_HITS=$((INJECTION_HITS + 1))
      degrade "MEMORY.md $msg"
    fi
  done
fi

# ---------- 6. Store integrity — the check the name always promised -------- #
# Uses node:sqlite, the product's own default engine (CR-69), so this verifies
# through the same path the product reads through and needs no native module.
DB_STATUS="not-checked"
DB_TABLES="-"
DB_OBS="-"
if [ ! -f "$DB_FILE" ]; then
  uncheckable "memory database ABSENT: $DB_FILE"
elif ! command -v node >/dev/null 2>&1; then
  uncheckable "node is not on PATH — the database could not be opened, so its integrity is UNKNOWN"
else
  DB_OUT=$(node -e '
    const { DatabaseSync } = require("node:sqlite");
    let db;
    try {
      db = new DatabaseSync(process.argv[1], { readOnly: true });
      const rows = db.prepare("PRAGMA integrity_check").all();
      const verdict = rows.map((r) => Object.values(r)[0]).join("; ");
      const tables = db.prepare("SELECT count(*) c FROM sqlite_master WHERE type = ?").get("table").c;
      let obs = "-";
      try { obs = db.prepare("SELECT count(*) c FROM observations").get().c; } catch { obs = "no-observations-table"; }
      process.stdout.write(verdict + "\t" + tables + "\t" + obs);
    } catch (err) {
      process.stdout.write("ERROR\t-\t" + String(err && err.message ? err.message : err).slice(0, 160));
      process.exitCode = 1;
    } finally {
      try { if (db) db.close(); } catch { /* already closed */ }
    }
  ' "$DB_FILE" 2>&1)
  DB_EXIT=$?

  if [ -z "$DB_OUT" ]; then
    # Empty output is exactly the shape this whole rewrite exists to refuse.
    uncheckable "database probe produced NO OUTPUT (exit $DB_EXIT) — integrity is UNKNOWN, not ok"
  else
    DB_STATUS=$(printf '%s' "$DB_OUT" | cut -f1)
    DB_TABLES=$(printf '%s' "$DB_OUT" | cut -f2)
    DB_OBS=$(printf '%s' "$DB_OUT" | cut -f3)
    if [ "$DB_EXIT" -ne 0 ] || [ "$DB_STATUS" = "ERROR" ]; then
      uncheckable "memory database could not be opened or queried: $DB_OBS"
      DB_STATUS="unreadable"
    elif [ "$DB_STATUS" != "ok" ]; then
      degrade "PRAGMA integrity_check FAILED: $DB_STATUS — the memory database is CORRUPT. Restore with: massu db restore --latest memory"
    fi
  fi
fi

# ---------- 7. Verdict + denominator (M1) ---------------------------------- #
DENOM="db=${DB_STATUS} tables=${DB_TABLES} observations=${DB_OBS} | corpus=${CORPUS_COUNT} files | MEMORY.md=${INDEX_BYTES}B | injection-screen=${PATTERNS_CHECKED} patterns, ${INJECTION_HITS} hit(s)"

if [ "$VERDICT" = "OK" ]; then
  printf '[MEMORY INTEGRITY] OK — %s\n' "$DENOM"
else
  printf '\n[MEMORY INTEGRITY] %s — %s\n' "$VERDICT" "$DENOM"
  printf '%s\n' "$PROBLEMS"
  if [ "$VERDICT" = "UNCHECKABLE" ]; then
    printf '\n  UNCHECKABLE means a check could not run. It is NOT a clean result, and it is\n'
    printf '  NOT the same as "no problems found" — treat the memory store as unverified.\n'
  else
    printf '\n  These entries may have been injected via external content (WebFetch, article review),\n'
    printf '  or the store may be damaged. Review before trusting recalled memory this session.\n'
  fi
  printf '\n'
fi

exit 0
