#!/usr/bin/env bash
# =============================================================================
# P8-001 (plan-massu-resilience-layer1) — REAL cross-Node ABI self-heal regression.
#
# Proves end-to-end that a native-ABI-broken `better-sqlite3` NEVER produces the
# incident-2026-07-12 silent-death (a raw NODE_MODULE_VERSION error printed while the
# process EXITS 0). It forces a genuine ABI mismatch — fetching a prebuilt for a
# DIFFERENT Node major than the runtime via `prebuild-install --target` (needs only the
# running Node + network, not a second Node install) — then runs the built
# `consolidate --dry-run --json` under the runtime and asserts the outcome is EITHER:
#   • self-healed → valid JSON on stdout (exit 0, no dlopen error), OR
#   • a LOUD failure → non-zero exit carrying the remedy.
# It FAILS only on the forbidden shape: exit 0 with a dlopen/NODE_MODULE_VERSION error.
#
# The real better-sqlite3 binary is backed up and RESTORED on every exit path (the
# self-heal typically restores it to the correct ABI anyway). Loud SKIP (not a pass)
# when preconditions (prebuild-install bin, network, a differing target) are unavailable.
# =============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CORE="$ROOT/packages/core"
CLI="$CORE/dist/cli.js"

skip() { echo "  SKIP (loud): $1"; echo "SKIPPED"; exit 0; }
fail() { echo "  FAIL: $1" >&2; echo "FAILED"; exit 1; }
pass() { echo "  PASS: $1"; }

echo "=== test-native-abi-selfheal (CR-65) ==="

command -v node >/dev/null 2>&1 || skip "node not on PATH"
[ -f "$CLI" ] || skip "CLI not built ($CLI) — run: cd packages/core && npm run build:cli"

# Resolve the real better-sqlite3 package dir + its binary.
BS3_DIR="$(node -e "process.stdout.write(require('path').dirname(require.resolve('better-sqlite3/package.json')))" 2>/dev/null)" \
  || skip "better-sqlite3 not resolvable"
BIN="$BS3_DIR/build/Release/better_sqlite3.node"
[ -f "$BIN" ] || skip "no prebuilt binary at $BIN"

PREBUILD="$(node -e "
const {existsSync}=require('fs');const {join,dirname}=require('path');
const d=dirname(require.resolve('better-sqlite3/package.json'));
for (const c of [join(d,'node_modules','.bin','prebuild-install'),join(d,'..','.bin','prebuild-install'),join(d,'..','..','node_modules','.bin','prebuild-install')]) if(existsSync(c)){process.stdout.write(c);break;}
" 2>/dev/null)"
[ -n "$PREBUILD" ] && [ -f "$PREBUILD" ] || skip "prebuild-install bin not found (compiler-free heal path unavailable)"

RUNTIME_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
ARCH="$(node -p "process.arch")"
PLATFORM="$(node -p "process.platform")"
echo "  runtime Node major=$RUNTIME_MAJOR (ABI $(node -p "process.versions.modules")), platform=$PLATFORM-$ARCH"

# --- Back up the real binary; restore on EVERY exit path. ---
BAK="$(mktemp -d)/better_sqlite3.node.bak"
cp "$BIN" "$BAK" || skip "could not back up the native binary"
restore() { cp -f "$BAK" "$BIN" 2>/dev/null || true; rm -rf "$(dirname "$BAK")" 2>/dev/null || true; }
trap restore EXIT

# --- Force the mismatch: fetch a prebuilt for a DIFFERENT Node ABI. Try a list of
#     candidate majors (better-sqlite3 only publishes prebuilts for some) and use the
#     first that both (a) fetches AND (b) actually dlopen-fails under the runtime. ---
FORCED=0
for TARGET in 24.0.0 22.11.0 20.11.1 26.0.0; do
  TMAJOR="${TARGET%%.*}"
  [ "$TMAJOR" = "$RUNTIME_MAJOR" ] && continue
  cp -f "$BAK" "$BIN"  # start each attempt from the known-good binary
  PB_OUT="$( cd "$BS3_DIR" && node "$PREBUILD" --target="$TARGET" --runtime=node --arch="$ARCH" --platform="$PLATFORM" 2>&1 )"
  if ! grep -qi "No prebuilt binaries found" <<<"$PB_OUT"; then
    MISMATCH="$(node -e "try{new(require('better-sqlite3'))(':memory:');process.stdout.write('NOMISMATCH')}catch(e){const m=(e&&(e.message||''))+' '+(e&&e.code||'');process.stdout.write(/NODE_MODULE_VERSION|ERR_DLOPEN/.test(m)?'MISMATCH':'OTHER')}" 2>/dev/null)"
    if [ "$MISMATCH" = "MISMATCH" ]; then
      echo "  forced mismatch via target=$TARGET"
      FORCED=1
      break
    fi
  fi
done
[ "$FORCED" -eq 1 ] || skip "could not force an ABI mismatch (no differing prebuilt for $PLATFORM-$ARCH — offline, or unsupported target majors)"
pass "forced a real ABI mismatch (runtime binary now dlopen-fails)"

# --- Run the built consolidate under the runtime Node; capture stdout/stderr/exit. ---
OUT_F="$(mktemp)"; ERR_F="$(mktemp)"
( cd "$CORE" && node "$CLI" consolidate --dry-run --json ) >"$OUT_F" 2>"$ERR_F"
CODE=$?
STDOUT="$(cat "$OUT_F")"; STDERR="$(cat "$ERR_F")"
rm -f "$OUT_F" "$ERR_F"

echo "  --- consolidate --dry-run --json → exit $CODE ---"
echo "  stdout: ${STDOUT:0:400}"
[ -n "$STDERR" ] && echo "  stderr: ${STDERR:0:400}"

RAW_DLOPEN=0
if printf '%s%s' "$STDOUT" "$STDERR" | grep -qE 'NODE_MODULE_VERSION|ERR_DLOPEN_FAILED'; then
  RAW_DLOPEN=1
fi

# --- The forbidden shape: exit 0 while a dlopen error leaked = silent death. ---
if [ "$CODE" -eq 0 ] && [ "$RAW_DLOPEN" -eq 1 ]; then
  fail "SILENT DEATH REGRESSION — exit 0 with a raw NODE_MODULE_VERSION/dlopen error (incident 2026-07-12)"
fi

if [ "$CODE" -eq 0 ]; then
  # Self-heal path: stdout must be valid JSON (a real consolidation result), not empty.
  if printf '%s' "$STDOUT" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const last=d.trim().split('\n').pop();JSON.parse(last);})" >/dev/null 2>&1; then
    pass "SELF-HEALED → exit 0 with valid JSON (no dlopen error leaked)"
    echo "PASSED"; exit 0
  fi
  fail "exit 0 but stdout was not valid consolidation JSON — suspicious quiet success"
fi

# --- Non-zero exit: must be a CLEAR, remedied failure (not a bare stack). ---
if printf '%s%s' "$STDOUT" "$STDERR" | grep -qiE "massu heal|memory engine (is )?unavailable|memory-engine-unusable"; then
  pass "LOUD FAILURE → non-zero exit ($CODE) carrying the remedy (never silent)"
  echo "PASSED"; exit 0
fi

fail "non-zero exit ($CODE) but no clear remedy in output — loud but unhelpful"
