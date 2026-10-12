#!/usr/bin/env bash
# measure-asset-conformance — the population this plan acts on, as a COMMAND.
#
# P1.1 of docs/plans/2026-09-20-stack-conformant-asset-rendering.md.
#
# Every number downstream phases consume is derived here and NEVER typed as a literal
# (G32). The script asserts its own identities: a split that does not sum to its
# denominator is exit 2, not a warning — because a miscount that still prints looks
# exactly like a correct count (THE BLIND-GATE LAW).
#
#   M1  the DENOMINATOR is printed on every run and asserted non-zero.
#   M2  an unreadable input is an ERROR; a zero denominator is exit 2, never "clean".
#   G3  the --json key set is CLOSED; nothing outside it is emitted.
#
# Usage:
#   measure-asset-conformance.sh [--root <dir>] [--json]
#     --root   repository root to measure (default: this script's repo)
#     --json   machine-readable emission consumed by P5/P7 via
#              scripts/ops/assert-conformance-json.sh
set -euo pipefail

# G29: `cd` does not scope git. GIT_DIR outranks the working directory and is inherited
# from any caller that sets it. This script only reads, but a leaked GIT_DIR would make
# it read a DIFFERENT repository and report plenty — from the wrong tree.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
      GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SELF_DIR/.." && pwd)"
JSON=0

while [ $# -gt 0 ]; do
  case "$1" in
    --root) [ $# -ge 2 ] || { echo "measure-asset-conformance: --root needs a value" >&2; exit 2; }
            ROOT="$2"; shift 2 ;;
    --json) JSON=1; shift ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    # R-011: an unrecognised argument is an ERROR, never silently ignored.
    *) echo "measure-asset-conformance: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

[ -d "$ROOT" ] || { echo "measure-asset-conformance: root not a directory: $ROOT" >&2; exit 2; }

CORE="$ROOT/packages/core"
ASSET_TYPES="commands agents patterns protocols reference"
TEMPLATES="$CORE/templates"

# The TS-toolchain predicate. Split deliberately into two halves so P4.1's TOOLCHAIN/PROSE
# partition is DERIVED from which half matched, not from a second hand-written list (G32).
#   VOCAB  — expressible as {{verify.*}} / {{paths.*}}; the vocabulary can fix it.
#   PROSE  — massu's OWN repo layout leaked into the product; no vocabulary can fix it.
#
# ⛔ THE PATTERNS ARE NOT WRITTEN HERE. They live in scripts/lib/stack-foreign-tokens.json,
# because P4's gate (packages/core/src/__tests__/stack-asset-conformance.test.ts) judges the
# SAME property from TypeScript. Two instruments that answer one question must not hold two
# copies of its definition — a token added here and not there makes the measurement and the
# gate disagree silently, in the passing direction, which is the exact class this plan
# exists to end (G32/CR-74). The JSON is an ORACLE and is hand-maintained on purpose; see
# its own `oracle` field for why it may never be derived.
#
# M2: fail CLOSED. A missing or unreadable oracle is an ERROR, never an empty pattern —
# an empty $ALL_PAT would make `grep -E ''` match EVERY line and invert the whole
# measurement, and an unset one would match nothing and report a flawless corpus.
TOKENS_JSON="$ROOT/scripts/lib/stack-foreign-tokens.json"
[ -r "$TOKENS_JSON" ] || {
  echo "measure-asset-conformance: cannot read the token oracle: $TOKENS_JSON" >&2
  echo "        Refusing to measure: with no patterns this reports a flawless corpus." >&2
  exit 2
}
read_half() {  # read_half <vocabulary|prose> -> alternation, or empty on failure
  python3 -c '
import json, sys
half = json.load(open(sys.argv[1]))[sys.argv[2]]
sys.stdout.write("|".join(e["pattern"] for e in half))
' "$TOKENS_JSON" "$1"
}
VOCAB_PAT="$(read_half vocabulary)"
PROSE_PAT="$(read_half prose)"
[ -n "$VOCAB_PAT" ] && [ -n "$PROSE_PAT" ] || {
  echo "measure-asset-conformance: the token oracle yielded an EMPTY half" >&2
  echo "        vocabulary='$VOCAB_PAT'  prose='$PROSE_PAT'" >&2
  echo "        An empty alternation matches every line or none; both are wrong answers." >&2
  exit 2
}
ALL_PAT="$VOCAB_PAT|$PROSE_PAT"

GREP=/usr/bin/grep   # G9: the session shell's `grep` honours .gitignore and under-counts.

# --- collect the asset file list (the DENOMINATOR) ------------------------------------
ASSET_LIST="$(mktemp -t massu-assets-XXXXXXXX)"
trap 'rm -f "$ASSET_LIST"' EXIT INT TERM
: > "$ASSET_LIST"
for d in $ASSET_TYPES; do
  [ -d "$CORE/$d" ] || continue
  # `! -name README.md` — a directory's own README is CORPUS FRONT MATTER, not an asset.
  # It must match the installer's population exactly (install-commands.ts, the
  # `entry === 'README.md'` skip): a measurement whose denominator differs from what the
  # product actually renders is measuring a corpus nobody ships (G18/CR-74).
  /usr/bin/find "$CORE/$d" -type f -name '*.md' ! -name 'README.md' >> "$ASSET_LIST"
done
LC_ALL=C sort -o "$ASSET_LIST" "$ASSET_LIST"

ASSETS="$(wc -l < "$ASSET_LIST" | tr -d ' ')"
if [ "$ASSETS" -eq 0 ]; then
  echo "measure-asset-conformance: DENOMINATOR 0 — no assets found under $CORE" >&2
  echo "  Scanned 0, found 0 is a LOUD ERROR, never a pass (M1)." >&2
  exit 2
fi

# --- classify -------------------------------------------------------------------------
# NESTED = the asset sits in a subdirectory of its type dir. pickVariant() is gated on
# `if (topLevel)` (install-commands.ts:472), so a nested asset is unreachable by the
# variant mechanism — the measurement that decides this plan's architecture.
hardcoding=0; hc_nested=0; hc_top=0
toolchain=0; prose=0
fm=0; nofm=0; nofm_nested=0; nofm_top=0

while IFS= read -r f; do
  [ -n "$f" ] || continue
  rel="${f#"$CORE"/}"                 # e.g. commands/massu-loop/references/x.md
  sub="${rel#*/}"                     # strip the asset-type dir
  case "$sub" in */*) depth=nested ;; *) depth=top ;; esac

  # M2: an unreadable asset is an ERROR, not an absent match.
  [ -r "$f" ] || { echo "measure-asset-conformance: unreadable asset: $f" >&2; exit 2; }

  if $GREP -qE "$ALL_PAT" "$f"; then
    hardcoding=$((hardcoding + 1))
    if [ "$depth" = nested ]; then hc_nested=$((hc_nested + 1)); else hc_top=$((hc_top + 1)); fi
    # An asset carrying ANY prose-only hit is PROSE: the vocabulary cannot close it, so it
    # needs a rewrite or a variant file. Classifying it TOOLCHAIN would hide human work.
    if $GREP -qE "$PROSE_PAT" "$f"; then prose=$((prose + 1)); else toolchain=$((toolchain + 1)); fi
  fi

  if [ "$(head -n 1 "$f")" = "---" ]; then
    fm=$((fm + 1))
  else
    nofm=$((nofm + 1))
    if [ "$depth" = nested ]; then nofm_nested=$((nofm_nested + 1)); else nofm_top=$((nofm_top + 1)); fi
  fi
done < "$ASSET_LIST"

# grep exits 1 for "no matches" and >=2 for a real error. Under `set -euo pipefail` a bare
# pipeline conflates them with each other AND with success, so the script died silently at
# exempt_count=0. `|| true` would "fix" it by making a BROKEN grep report zero exemptions —
# the blind-gate shape (CR-69: never silence a command you depend on). Distinguish instead.
set +e
exempt_list="$($GREP -rlE 'massu-stack-exempt' "$CORE" --include='*.md')"
exempt_rc=$?
set -e
case "$exempt_rc" in
  0) exempt_count="$(printf '%s\n' "$exempt_list" | LC_ALL=C sort -u | wc -l | tr -d ' ')" ;;
  1) exempt_count=0 ;;   # no matches — a legitimate zero, distinct from a failure
  *) echo "measure-asset-conformance: grep failed (rc=$exempt_rc) scanning for exempt markers" >&2
     exit 2 ;;
esac

# --- stacks + verify key populations --------------------------------------------------
STACKS=0
if [ -d "$TEMPLATES" ]; then
  STACKS="$(/usr/bin/find "$TEMPLATES" -mindepth 2 -maxdepth 2 -name massu.config.yaml | wc -l | tr -d ' ')"
fi
[ "$STACKS" -gt 0 ] || { echo "measure-asset-conformance: DENOMINATOR 0 — no stack templates under $TEMPLATES" >&2; exit 2; }

# PRIMARY vs ANY are two different populations and they DIVERGE on `build` (4 vs 5).
# Emitting one unlabelled number is the defect that froze the non-governing figure (G28).
VERIFY_JSON="$(cd "$CORE" && node -e '
const fs=require("fs"),path=require("path"),YAML=require("yaml");
const dir=process.argv[1];
const stacks=fs.readdirSync(dir).filter(s=>fs.existsSync(path.join(dir,s,"massu.config.yaml"))).sort();
if(stacks.length===0){console.error("no stacks");process.exit(2);}
const KEYS=["test","type","lint","build","syntax"];
const primary={},any={};
for(const k of KEYS){primary[k]=0;any[k]=0;}
for(const s of stacks){
  const d=YAML.parse(fs.readFileSync(path.join(dir,s,"massu.config.yaml"),"utf8"))||{};
  const v=d.verification||{};
  const fw=d.framework||{};
  const prim=fw.primary||fw.type;
  const seen=new Set();
  for(const lang of Object.keys(v)) for(const k of Object.keys(v[lang]||{})) if(KEYS.includes(k)) seen.add(k);
  for(const k of seen) any[k]++;
  const pv=(prim&&v[prim])?v[prim]:null;
  if(pv) for(const k of KEYS) if(Object.prototype.hasOwnProperty.call(pv,k)) primary[k]++;
}
process.stdout.write(JSON.stringify({primary,any}));
' "$TEMPLATES")"

vp() { node -e 'const j=JSON.parse(process.argv[1]);process.stdout.write(String(j[process.argv[2]][process.argv[3]]))' "$VERIFY_JSON" "$1" "$2"; }

# --- adjudication record (P3.1) -------------------------------------------------------
# A MISSING file is exit 2 in --json mode, never `adjudicated: 0`: "nobody adjudicated"
# and "the record is gone" must not produce the same value.
ADJ_FILE="$ROOT/scripts/lib/stack-test-command-adjudication.json"
adjudicated="ABSENT"
if [ -f "$ADJ_FILE" ]; then
  # A record that PARSES but yields zero complete rows is a DEFECT, not a legitimate zero.
  # The first version of this read `a.stacks` while the record uses `entries`, and reported
  # `adjudicated: 0` — inventing a third state ("present but unreadable") indistinguishable
  # from "nobody adjudicated". Accept every shape the record may take, then assert non-zero.
  adjudicated="$(node -e '
    const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    const need=["stack","before","after","canonical_source","justification"];
    const rows=Array.isArray(a)?a:(a.entries||a.stacks||[]);
    const ok=rows.filter(r=>r&&need.every(f=>r[f]!==undefined&&r[f]!==""));
    process.stdout.write(String(new Set(ok.map(r=>r.stack)).size));
  ' "$ADJ_FILE")"
  if [ "$adjudicated" -eq 0 ]; then
    echo "measure-asset-conformance: adjudication record at $ADJ_FILE parsed but yielded 0" >&2
    echo "  complete entries. A present-but-unreadable record must not report the same value" >&2
    echo "  as an absent one (M2)." >&2
    exit 2
  fi
elif [ "$JSON" -eq 1 ]; then
  echo "measure-asset-conformance: adjudication record absent: $ADJ_FILE" >&2
  echo "  P3.1 has not landed. Refusing to emit adjudicated:0 — 'nobody adjudicated' and" >&2
  echo "  'the record is gone' must not be the same value (M2)." >&2
  exit 2
fi

# --- assert the identities ------------------------------------------------------------
fail_identity() { echo "measure-asset-conformance: IDENTITY VIOLATED — $1" >&2; exit 2; }
[ $((fm + nofm)) -eq "$ASSETS" ]      || fail_identity "front_matter($fm) + no_front_matter($nofm) != assets($ASSETS)"
[ $((nofm_nested + nofm_top)) -eq "$nofm" ] || fail_identity "no_front_matter_nested($nofm_nested) + no_front_matter_top_level($nofm_top) != no_front_matter($nofm)"
[ $((hc_top + hc_nested)) -eq "$hardcoding" ] || fail_identity "hardcoding_top_level($hc_top) + hardcoding_nested($hc_nested) != hardcoding($hardcoding)"
[ $((toolchain + prose)) -eq "$hardcoding" ] || fail_identity "toolchain($toolchain) + prose($prose) != hardcoding($hardcoding)"

# --- emit -----------------------------------------------------------------------------
if [ "$JSON" -eq 1 ]; then
  node -e '
    const a=process.argv;
    const v=JSON.parse(a[15]);
    // CLOSED key set (G3): exactly these fifteen, nothing else.
    process.stdout.write(JSON.stringify({
      assets:+a[1], hardcoding:+a[2], hardcoding_nested:+a[3], hardcoding_top_level:+a[4],
      toolchain:+a[5], prose:+a[6], stacks:+a[7], adjudicated:+a[8],
      front_matter:+a[9], no_front_matter:+a[10],
      no_front_matter_nested:+a[11], no_front_matter_top_level:+a[12],
      exempt_count:+a[13],
      verify_primary:v.primary, verify_any:v.any
    },null,2)+"\n");
  ' "$ASSETS" "$hardcoding" "$hc_nested" "$hc_top" "$toolchain" "$prose" "$STACKS" \
    "$([ "$adjudicated" = ABSENT ] && echo 0 || echo "$adjudicated")" \
    "$fm" "$nofm" "$nofm_nested" "$nofm_top" "$exempt_count" "x" "$VERIFY_JSON"
  exit 0
fi

echo "=== asset conformance — measured at $(TZ=America/Los_Angeles date '+%Y-%m-%d %H:%M %Z') ==="
echo "root                $ROOT"
echo ""
printf 'assets              %s        (DENOMINATOR — asserted non-zero)\n' "$ASSETS"
printf 'hardcoding          %s       (%s top-level / %s nested)\n' "$hardcoding" "$hc_top" "$hc_nested"
printf '  of which          TOOLCHAIN %s / PROSE %s        (asserted to sum to hardcoding)\n' "$toolchain" "$prose"
printf 'stacks              %s\n' "$STACKS"
printf 'declaration surface %s front-matter / %s no-front-matter  (%s + %s = %s, asserted)\n' "$fm" "$nofm" "$fm" "$nofm" "$ASSETS"
printf '  of the %s:        %s nested (inherit from parent) / %s top-level (hand-authored sidecar)\n' "$nofm" "$nofm_nested" "$nofm_top"
printf '                    (%s + %s = %s, asserted)\n' "$nofm_nested" "$nofm_top" "$nofm"
echo "verify keys, by PRIMARY language  (GOVERNING — what {{verify.<key>}} resolves against):"
printf '                    test=%s  type=%s  lint=%s  build=%s   syntax=%s\n' \
  "$(vp primary test)" "$(vp primary type)" "$(vp primary lint)" "$(vp primary build)" "$(vp primary syntax)"
echo "verify keys, by ANY declared language (informational only):"
printf '                    test=%s  type=%s  lint=%s  build=%s   syntax=%s\n' \
  "$(vp any test)" "$(vp any type)" "$(vp any lint)" "$(vp any build)" "$(vp any syntax)"
printf 'exempt_count        %s\n' "$exempt_count"
printf 'adjudicated         %s' "$adjudicated"
[ "$adjudicated" = ABSENT ] && printf '   (P3.1 has not landed; --json exits 2 here by design)'
echo ""
