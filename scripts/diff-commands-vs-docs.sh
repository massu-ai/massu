#!/usr/bin/env bash
# P-M-040 (plan-stage-d-medium-sweep): list every `.claude/commands/massu-*.md`
# that lacks a corresponding `website/content/docs/commands/<name>.mdx`.
# Excludes the internal-prefix glob (intentionally not synced to public docs).
#
# Used by:
#   - P-R-002 ceremony step 0 (pre-flight): fail the ceremony if count > 0
#     UNLESS every offender is in the triage-pending allowlist below.
#   - Pattern Scanner Check 24 (grep-level safety-net).
#   - vitest `commands-docs-completeness.test.ts` (AST-level enforcement).
#
# Allowlist semantics: the file
# `.claude/commands/.docs-triage-pending.txt` lists commands whose triage
# (publicize vs internalize) is pending operator decision. Commands in that
# file are NOT counted as drift. Adding to that file requires referencing
# the plan token that will resolve the triage.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
COMMANDS_DIR="$REPO_ROOT/.claude/commands"
DOCS_DIR="$REPO_ROOT/website/content/docs/commands"
ALLOWLIST="$REPO_ROOT/.claude/commands/.docs-triage-pending.txt"

if [ ! -d "$COMMANDS_DIR" ]; then
  echo "diff-commands-vs-docs: $COMMANDS_DIR not found" >&2
  exit 1
fi

MISSING=()
while IFS= read -r cmd_file; do
  base=$(basename "$cmd_file" .md)
  # Skip internal-prefixed commands (intentionally not synced).
  case "$base" in
    massu-internal-*) continue ;;
    massu-*) ;;
    *) continue ;;
  esac
  doc_file="$DOCS_DIR/$base.mdx"
  if [ ! -f "$doc_file" ]; then
    # Allowlist check
    if [ -f "$ALLOWLIST" ] && grep -qxF "$base" "$ALLOWLIST"; then
      continue
    fi
    MISSING+=("$base")
  fi
done < <(find "$COMMANDS_DIR" -maxdepth 1 -type f -name 'massu-*.md' 2>/dev/null)

if [ "${#MISSING[@]}" -eq 0 ]; then
  echo "diff-commands-vs-docs: all public commands have docs (or are allowlisted)"
  exit 0
fi

echo "diff-commands-vs-docs: ${#MISSING[@]} public commands missing docs:" >&2
for m in "${MISSING[@]}"; do
  echo "  - $m" >&2
done
echo "" >&2
echo "Fix: write doc page at website/content/docs/commands/<name>.mdx" >&2
echo "  OR: rename .claude/commands/$base.md to .claude/commands/massu-internal-$base.md" >&2
echo "  OR (operator-coordinated only): add $base to $ALLOWLIST with plan-token comment" >&2
exit 1
