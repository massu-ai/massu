#!/usr/bin/env bash
# massu-skill-self-test.sh
# Phase 6 P6-003 — Validates that every VR-* reference used by skills/commands
# resolves to a non-empty command string via each of the 7 init templates.
#
# For each template, we:
#   1. Create a tmp project dir.
#   2. Produce the template config (equivalent to `massu init --template <name> --ci`).
#   3. Parse the resulting YAML using Node.
#   4. Enumerate the skill/command-referenced VR-* actions and assert each
#      resolves to a non-empty command string at
#      `config.verification.<primary_language>.<action>`.
#   5. Emit a results table and exit 0 iff every row is OK.

set -euo pipefail

ROOT="${ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
TEMPLATES_DIR="$ROOT/packages/core/templates"

# All 7 built-in templates (must match TEMPLATE_NAMES in init.ts).
TEMPLATES=(
  python-fastapi
  python-django
  ts-nextjs
  ts-nestjs
  rust-actix
  swift-ios
  multi-runtime
)

# Colors (disabled when not a TTY).
if [[ -t 1 ]]; then
  R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; B=$'\033[1m'; X=$'\033[0m'
else
  R=''; G=''; Y=''; B=''; X=''
fi

TMPROOT="$(mktemp -d -t massu-skill-self-test-XXXXXX)"
trap 'rm -rf "$TMPROOT"' EXIT

HAS_FAIL=0
ROWS=()

# Header row.
ROWS+=("TEMPLATE|PRIMARY_LANG|VR-TYPE|VR-TEST|VR-BUILD|VR-LINT|VR-SYNTAX|RESOLUTION")

# Node helper: env vars are CONFIG_PATH + EXPR.
# Prints the resolved value, or "EMPTY" if null/undefined/empty.
NODE_HELPER='
  const yaml = require("yaml");
  const fs = require("fs");
  const cfg = yaml.parse(fs.readFileSync(process.env.CONFIG_PATH, "utf-8"));
  const get = (o, p) => p.split(".").reduce((a, k) => a == null ? undefined : a[k], o);
  const v = get(cfg, process.env.EXPR);
  if (v == null || v === "") { process.stdout.write("EMPTY"); }
  else { process.stdout.write(String(v)); }
'

node_eval() {
  CONFIG_PATH="$1" EXPR="$2" NODE_PATH="$ROOT/packages/core/node_modules" \
    node --no-warnings -e "$NODE_HELPER"
}

NODE_HELPER_LANGS='
  const yaml = require("yaml");
  const fs = require("fs");
  const cfg = yaml.parse(fs.readFileSync(process.env.CONFIG_PATH, "utf-8"));
  const langs = (cfg && cfg.framework && cfg.framework.languages) || {};
  process.stdout.write(Object.keys(langs).join(" "));
'

list_languages() {
  CONFIG_PATH="$1" NODE_PATH="$ROOT/packages/core/node_modules" \
    node --no-warnings -e "$NODE_HELPER_LANGS"
}

render_template() {
  local name="$1"
  local dest_dir="$2"
  local src="$TEMPLATES_DIR/$name/massu.config.yaml"
  if [[ ! -f "$src" ]]; then
    echo "${R}FAIL:${X} template file missing: $src" >&2
    return 1
  fi
  local project_name
  project_name="$(basename "$dest_dir")"
  sed "s|{{PROJECT_NAME}}|$project_name|g" "$src" > "$dest_dir/massu.config.yaml"
}

short_cmd() {
  local v="$1"
  local short="${v:0:40}"
  [[ ${#v} -gt 40 ]] && short="${short}…"
  printf '%s' "$short"
}

for tpl in "${TEMPLATES[@]}"; do
  work="$TMPROOT/$tpl"
  mkdir -p "$work"
  if ! render_template "$tpl" "$work"; then
    HAS_FAIL=1
    ROWS+=("$tpl|-|-|-|-|-|-|${R}FAIL${X} (template file missing)")
    continue
  fi

  config="$work/massu.config.yaml"

  fw_type="$(node_eval "$config" "framework.type")"
  fw_primary="$(node_eval "$config" "framework.primary")"
  primary="$fw_type"
  if [[ "$fw_type" == "multi" ]]; then
    primary="$fw_primary"
  fi

  # Skill/command-referenced VR-* actions.
  # VR-TYPE .type and VR-TEST .test are MANDATORY.
  # VR-BUILD .build, VR-LINT .lint, VR-SYNTAX .syntax are optional.
  v_type="$(node_eval "$config" "verification.$primary.type")"
  v_test="$(node_eval "$config" "verification.$primary.test")"
  v_build="$(node_eval "$config" "verification.$primary.build")"
  v_lint="$(node_eval "$config" "verification.$primary.lint")"
  v_syntax="$(node_eval "$config" "verification.$primary.syntax")"

  row_ok=1
  cell_type="$v_type"; cell_test="$v_test"
  cell_build="$v_build"; cell_lint="$v_lint"; cell_syntax="$v_syntax"

  if [[ "$v_type" == "EMPTY" ]]; then
    cell_type="${R}MISSING${X}"; row_ok=0
  else
    cell_type="${G}$(short_cmd "$v_type")${X}"
  fi
  if [[ "$v_test" == "EMPTY" ]]; then
    cell_test="${R}MISSING${X}"; row_ok=0
  else
    cell_test="${G}$(short_cmd "$v_test")${X}"
  fi
  # optional cells
  [[ "$v_build"  == "EMPTY" ]] && cell_build="${Y}-${X}"  || cell_build="${G}$(short_cmd "$v_build")${X}"
  [[ "$v_lint"   == "EMPTY" ]] && cell_lint="${Y}-${X}"   || cell_lint="${G}$(short_cmd "$v_lint")${X}"
  [[ "$v_syntax" == "EMPTY" ]] && cell_syntax="${Y}-${X}" || cell_syntax="${G}$(short_cmd "$v_syntax")${X}"

  if [[ $row_ok -eq 1 ]]; then
    res="${G}OK${X}"
  else
    res="${R}MISSING mandatory VR-TEST/VR-TYPE${X}"
    HAS_FAIL=1
  fi

  ROWS+=("$tpl|$primary|$cell_type|$cell_test|$cell_build|$cell_lint|$cell_syntax|$res")

  # For multi-runtime templates, verify EVERY declared language has VR-TEST and VR-TYPE.
  if [[ "$fw_type" == "multi" ]]; then
    langs="$(list_languages "$config")"
    for lang in $langs; do
      [[ "$lang" == "$primary" ]] && continue
      sv_type="$(node_eval "$config" "verification.$lang.type")"
      sv_test="$(node_eval "$config" "verification.$lang.test")"
      srow_ok=1
      sc_type=""; sc_test=""
      if [[ "$sv_type" == "EMPTY" ]]; then
        sc_type="${R}MISSING${X}"; srow_ok=0
      else
        sc_type="${G}$(short_cmd "$sv_type")${X}"
      fi
      if [[ "$sv_test" == "EMPTY" ]]; then
        sc_test="${R}MISSING${X}"; srow_ok=0
      else
        sc_test="${G}$(short_cmd "$sv_test")${X}"
      fi
      if [[ $srow_ok -eq 1 ]]; then
        ROWS+=("$tpl|$lang|$sc_type|$sc_test|-|-|-|${G}OK (secondary)${X}")
      else
        ROWS+=("$tpl|$lang|$sc_type|$sc_test|-|-|-|${R}MISSING (secondary)${X}")
        HAS_FAIL=1
      fi
    done
  fi
done

# --- Render table ---
printf '\n%s\n' "${B}== Massu Skill / Command Self-Test ==${X}"
printf '%s\n' "${B}Resolves every VR-* used by skills/commands against each built-in template.${X}"
printf '\n'

for row in "${ROWS[@]}"; do
  printf '%s\n' "$row" | awk -F'|' '{ printf "%-16s %-12s %-42s %-42s %-42s %-42s %-42s %s\n", $1,$2,$3,$4,$5,$6,$7,$8 }'
done
printf '\n'

if [[ $HAS_FAIL -eq 1 ]]; then
  printf '%s\n' "${R}Self-test FAIL: one or more templates have missing VR-* commands.${X}"
  exit 1
else
  printf '%s\n' "${G}Self-test PASS: ${#TEMPLATES[@]}/${#TEMPLATES[@]} templates resolve VR-TYPE and VR-TEST.${X}"
  exit 0
fi
