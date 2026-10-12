#!/usr/bin/env bash
# CR-72 live-fire: plant the ORIGINAL defect in the REAL tree, run the REAL guard, demand RED
# for its own declared reason, restore, prove byte-identical, prove it OPENS again.
#
# SUBJECT: `src/__tests__/asset-render-parity.test.ts` — the guard asserting that what
# `massu show-template <name>` prints is byte-identical to what the installer writes.
#
# THE DEFECT, measured 2026-09-21. `show-template` read the bundled file and printed it RAW
# while the installer writes RENDERED bytes. The installer's own local-edit message tells the
# user to diff those two against each other:
#
#     43 of 67 shipped commands carry 305 `{{...}}` tokens
#     31 of 57 base names differed raw-vs-rendered on one stack alone
#
# ⛔ WHY IT NEEDED ATTACKING RATHER THAN A PASSING TEST. Both paths produced a FILE, so the
# failure was a diff full of noise, not an error — and a guard for a silent divergence is
# itself most likely to fail silently. The only proof it is load-bearing is putting the old
# behaviour back and watching it go red.
#
# ⛔ NO `rm -rf`, NO INTERPOLATED DELETE PATH (G17); cleanup lives in a FUNCTION, not inside a
# `trap '...'` string, because this machine's payload-safety guard refuses a shell
# metacharacter beside a destructive token inside one literal (G25/CR-88).
set -uo pipefail
# G29: never inherit a caller's git environment. Not hook-reachable; never reads the index.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
      GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" || exit 2

TARGET="packages/core/src/commands/show-template.ts"
GUARD="src/__tests__/asset-render-parity.test.ts"
[ -f "$TARGET" ] || { echo "FATAL: $TARGET not found" >&2; exit 2; }
[ -f "packages/core/$GUARD" ] || { echo "FATAL: guard not found" >&2; exit 2; }

BEFORE_SHA="$(shasum -a 256 "$TARGET" | cut -d' ' -f1)"
BACKUP="$(mktemp)" || exit 2
cp "$TARGET" "$BACKUP" || exit 2
restore_target() {
  cp "$BACKUP" "$TARGET" 2>/dev/null
}
cleanup() {
  restore_target
  rm -f "$BACKUP"
}
trap cleanup EXIT INT TERM

PASS=0; FAIL=0
ok()  { printf '  ✓ %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  ✗ %s\n' "$1"; [ -n "${2:-}" ] && printf '%s\n' "$2" | sed 's/^/      /' | tail -12; FAIL=$((FAIL+1)); }
run() { OUT="$(cd packages/core && npx vitest run "$GUARD" 2>&1)"; RC=$?; }

echo "=== 0. BASELINE — the guard passes (a brick gets disabled) ==="
run
if [ "$RC" -eq 0 ]; then ok "parity guard green"; else bad "RED before any plant" "$OUT"; exit 1; fi

echo "=== 0b. POSITIVE CONTROL — the guard really compares assets ==="
# A zero denominator would make every assertion below vacuous, and "0 compared, 0 differ" is
# what a broken derivation returns. The guard asserts compared > 20; prove that is REACHED.
COMPARED="$(cd packages/core && npx vitest run "$GUARD" --reporter=verbose 2>&1 | grep -c 'renders identically')"
if [ "${COMPARED:-0}" -ge 1 ]; then ok "the parity cases ran ($COMPARED stack case(s) reported)"
else bad "could not confirm the parity cases executed"; fi

echo "=== 1. PLANT: show-template reads the bundled file RAW (the original bug) ==="
python3 - "$TARGET" <<'PY'
import io, sys
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()
start = s.index('  const framework = getConfig().framework;')
end = s.index('  process.stdout.write(rendered.content);') + len('  process.stdout.write(rendered.content);')
old = """  const framework = getConfig().framework;
  const choice = pickVariant(baseName, sourceDir, framework);
  if (choice.kind === 'miss') {
    process.stderr.write(`massu: no template named "${baseName}" found\\n`);
    process.exit(1);
    return;
  }
  const suffix = choice.kind === 'hit' ? choice.suffix : '';
  const file = resolve(sourceDir, suffix === '' ? `${baseName}.md` : `${baseName}${suffix}.md`);
  process.stdout.write(readFileSync(file, 'utf-8'));"""
s = s[:start] + old + s[end:]
s = s.replace("import { resolveAssetDir } from './asset-resolution.ts';",
              "import { readFileSync } from 'fs';\nimport { resolve } from 'path';\nimport { resolveAssetDir, pickVariant } from './asset-resolution.ts';")
io.open(p, 'w', encoding='utf-8').write(s)
print('  planted: the raw-read show-template is back')
PY
[ $? -eq 0 ] || exit 1
run
if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -qiE 'disagree on [0-9]+ asset|not rendering|render identically'; then
  ok "a raw-reading show-template drives the guard RED, naming the divergence"
else
  bad "the raw read did NOT fail the guard — it is decoration (rc=$RC)" "$OUT"
fi
restore_target

echo "=== 2. PLANT: show-template re-derives the variant and gets it wrong ==="
# The second derivation, in its subtler form: it still renders, it just picks the unsuffixed
# default for every stack. Rendering alone is not the property — SAME FILE, rendered, is.
python3 - "$TARGET" <<'PY'
import io, sys
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()
old = """  const rendered = renderResolvedAsset(
    baseName,
    sourceDir,
    framework,
    makeRenderContext(framework),
  );"""
new = """  const rendered = renderAssetFile(
    resolve(sourceDir, `${baseName}.md`),
    `${baseName}.md`,
    makeRenderContext(framework),
  );"""
assert old in s, 'plant-2 anchor missing'
s = s.replace(old, new, 1)
s = s.replace("import { makeRenderContext, renderResolvedAsset } from './asset-render.ts';",
              "import { resolve } from 'path';\nimport { makeRenderContext, renderAssetFile } from './asset-render.ts';")
io.open(p, 'w', encoding='utf-8').write(s)
print('  planted: variant selection re-derived as "always the default"')
PY
[ $? -eq 0 ] || exit 1
run
if [ "$RC" -ne 0 ]; then
  ok "a re-derived variant rule drives the guard RED"
else
  bad "show-template ignored variants and the guard stayed green (rc=$RC)" "$OUT"
fi
restore_target

echo "=== 3. RESTORE — byte-identical, and the guard OPENS again ==="
AFTER_SHA="$(shasum -a 256 "$TARGET" | cut -d' ' -f1)"
if [ "$BEFORE_SHA" = "$AFTER_SHA" ]; then ok "restored byte-identical"
else bad "RESTORE FAILED ($BEFORE_SHA -> $AFTER_SHA)"; fi
run
if [ "$RC" -eq 0 ]; then ok "parity guard OPENS"; else bad "still RED after restore" "$OUT"; fi

echo "----"
echo "live-fire: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
