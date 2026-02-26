#!/bin/bash
# =============================================================================
# Knowledge Base Staleness Audit
# =============================================================================
# Purpose: Check freshness, completeness, and cross-references of .claude/ KB files
# Usage: ./scripts/kb-staleness-audit.sh [--ci] [--verbose] [--fix]
#
# Exit Codes:
#   0 - All checks pass (warnings OK)
#   1 - Failures found (or --ci mode with any FAIL)
#
# Created: February 25, 2026
# Reference: Massu Phase 9 - Infrastructure Scripts
# =============================================================================

set -e

# Project root (resolve relative to script location)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLAUDE_DIR="$PROJECT_ROOT/.claude"

# Colors for output
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Counters
TOTAL_CHECKS=0
WARNINGS=0
FAILURES=0
PASSES=0

# Parse arguments
CI_MODE=false
VERBOSE=false
FIX_MODE=false

while [[ "$#" -gt 0 ]]; do
    case $1 in
        --ci) CI_MODE=true ;;
        --verbose|-v) VERBOSE=true ;;
        --fix) FIX_MODE=true ;;
        *) echo "Unknown parameter: $1"; exit 1 ;;
    esac
    shift
done

if [ "$FIX_MODE" = true ]; then
    echo "Auto-fix not yet implemented"
    exit 0
fi

# =============================================================================
# Helper Functions
# =============================================================================

log_header() {
    echo ""
    echo -e "${BLUE}=== $1 ===${NC}"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
    ((WARNINGS++))
    ((TOTAL_CHECKS++))
}

fail() {
    echo -e "${RED}[FAIL]${NC} $1"
    ((FAILURES++))
    ((TOTAL_CHECKS++))
}

pass() {
    ((PASSES++))
    ((TOTAL_CHECKS++))
    if [ "$VERBOSE" = true ]; then
        echo -e "${GREEN}[PASS]${NC} $1"
    fi
}

# Get file age in days (macOS compatible)
file_age_days() {
    local file="$1"
    if [ ! -f "$file" ]; then
        echo "999999"
        return
    fi
    local now
    now=$(date +%s)
    local file_mod
    # macOS stat syntax
    if stat -f "%m" "$file" >/dev/null 2>&1; then
        file_mod=$(stat -f "%m" "$file")
    else
        # Linux stat syntax
        file_mod=$(stat -c "%Y" "$file")
    fi
    echo $(( (now - file_mod) / 86400 ))
}

# =============================================================================
# CHECK 1: Pattern File Staleness (30-day threshold)
# =============================================================================

log_header "PATTERN FILE STALENESS (30-day threshold)"

if [ -d "$CLAUDE_DIR/patterns" ]; then
    pattern_stale=0
    pattern_total=0
    for pfile in "$CLAUDE_DIR"/patterns/*.md; do
        [ ! -f "$pfile" ] && continue
        ((pattern_total++))
        age=$(file_age_days "$pfile")
        fname=$(basename "$pfile")
        if [ "$age" -gt 30 ]; then
            warn "Pattern file stale ($age days): $fname"
            ((pattern_stale++))
        else
            pass "Pattern file fresh ($age days): $fname"
        fi
    done
    if [ "$pattern_stale" -eq 0 ] && [ "$pattern_total" -gt 0 ]; then
        pass "All $pattern_total pattern files are fresh (< 30 days)"
    fi
else
    fail "Directory not found: .claude/patterns/"
fi

# =============================================================================
# CHECK 2: Reference File Staleness (90-day threshold)
# =============================================================================

log_header "REFERENCE FILE STALENESS (90-day threshold)"

if [ -d "$CLAUDE_DIR/reference" ]; then
    ref_stale=0
    ref_total=0
    for rfile in "$CLAUDE_DIR"/reference/*.md; do
        [ ! -f "$rfile" ] && continue
        ((ref_total++))
        age=$(file_age_days "$rfile")
        fname=$(basename "$rfile")
        if [ "$age" -gt 90 ]; then
            warn "Reference file stale ($age days): $fname"
            ((ref_stale++))
        else
            pass "Reference file fresh ($age days): $fname"
        fi
    done
    if [ "$ref_stale" -eq 0 ] && [ "$ref_total" -gt 0 ]; then
        pass "All $ref_total reference files are fresh (< 90 days)"
    fi
else
    fail "Directory not found: .claude/reference/"
fi

# =============================================================================
# CHECK 3: Incident Log Completeness
# =============================================================================

log_header "INCIDENT LOG COMPLETENESS"

CLAUDE_MD="$CLAUDE_DIR/CLAUDE.md"
INCIDENT_LOG="$CLAUDE_DIR/incidents/INCIDENT-LOG.md"

if [ -f "$CLAUDE_MD" ] && [ -f "$INCIDENT_LOG" ]; then
    # Extract "N incidents logged" from CLAUDE.md
    claimed_count=$(grep -o '[0-9]* incidents logged' "$CLAUDE_MD" 2>/dev/null | grep -o '^[0-9]*' || echo "0")

    # Extract highest ## Incident #N from INCIDENT-LOG.md
    highest_incident=$(grep -o '## Incident #[0-9]*' "$INCIDENT_LOG" 2>/dev/null | grep -o '[0-9]*' | sort -n | tail -1 || echo "0")

    if [ "$claimed_count" = "$highest_incident" ]; then
        pass "Incident count matches: CLAUDE.md claims $claimed_count, INCIDENT-LOG has #$highest_incident"
    else
        fail "Incident count MISMATCH: CLAUDE.md claims $claimed_count incidents, but highest incident is #$highest_incident"
    fi
else
    if [ ! -f "$CLAUDE_MD" ]; then
        fail "CLAUDE.md not found at $CLAUDE_MD"
    fi
    if [ ! -f "$INCIDENT_LOG" ]; then
        warn "INCIDENT-LOG.md not found at $INCIDENT_LOG (may not have incidents yet)"
    fi
fi

# =============================================================================
# CHECK 4: Agent-Command Cross-Reference
# =============================================================================

log_header "AGENT-COMMAND CROSS-REFERENCE"

AGENTS_DIR="$HOME/.claude/agents"
COMMANDS_DIR="$CLAUDE_DIR/commands"

if [ -d "$AGENTS_DIR" ] && [ -d "$COMMANDS_DIR" ]; then
    agent_unreferenced=0
    agent_total=0
    for agent_file in "$AGENTS_DIR"/*.md; do
        [ ! -f "$agent_file" ] && continue
        ((agent_total++))
        agent_name=$(basename "$agent_file" .md)
        # Search all command files for a reference to this agent name
        if grep -rql "$agent_name" "$COMMANDS_DIR"/*.md >/dev/null 2>&1; then
            pass "Agent referenced by commands: $agent_name"
        else
            warn "Agent unreferenced by any command: $agent_name"
            ((agent_unreferenced++))
        fi
    done
    if [ "$agent_unreferenced" -eq 0 ] && [ "$agent_total" -gt 0 ]; then
        pass "All $agent_total agents are referenced by at least one command"
    fi
else
    if [ ! -d "$AGENTS_DIR" ]; then
        warn "Agents directory not found: $AGENTS_DIR (skipping cross-reference)"
    fi
    if [ ! -d "$COMMANDS_DIR" ]; then
        fail "Commands directory not found: $COMMANDS_DIR"
    fi
fi

# =============================================================================
# CHECK 5: Core Package Tool Module Inventory
# Checks that tools.ts references all expected tool modules
# =============================================================================

log_header "CORE TOOL MODULE INVENTORY"

TOOLS_TS="$PROJECT_ROOT/packages/core/src/tools.ts"
TOOL_MODULES=(
    "analytics"
    "cost-tracker"
    "prompt-analyzer"
    "audit-trail"
    "validation-engine"
    "adr-generator"
    "security-scorer"
    "dependency-scorer"
    "team-knowledge"
    "regression-detector"
    "observability-tools"
    "memory-tools"
    "docs-tools"
    "sentinel-tools"
)

if [ -f "$TOOLS_TS" ]; then
    missing_modules=0
    for mod in "${TOOL_MODULES[@]}"; do
        if grep -q "$mod" "$TOOLS_TS" 2>/dev/null; then
            pass "Tool module referenced in tools.ts: $mod"
        else
            warn "Tool module NOT referenced in tools.ts: $mod"
            ((missing_modules++))
        fi
    done
    if [ "$missing_modules" -eq 0 ]; then
        pass "All ${#TOOL_MODULES[@]} tool modules referenced in tools.ts"
    fi
else
    fail "tools.ts not found at $TOOLS_TS"
fi

# =============================================================================
# CHECK 6: Memory DB Schema Freshness
# Checks that memory-db.ts exists and has recent modification
# =============================================================================

log_header "MEMORY DB SCHEMA FRESHNESS"

MEMORY_DB="$PROJECT_ROOT/packages/core/src/memory-db.ts"

if [ -f "$MEMORY_DB" ]; then
    age=$(file_age_days "$MEMORY_DB")
    if [ "$age" -gt 90 ]; then
        warn "memory-db.ts is stale ($age days old) - review schema for completeness"
    else
        pass "memory-db.ts is fresh ($age days old)"
    fi
else
    fail "memory-db.ts not found: $MEMORY_DB"
fi

# =============================================================================
# CHECK 7: Session State Freshness (7-day threshold)
# =============================================================================

log_header "SESSION STATE FRESHNESS (7-day threshold)"

SESSION_STATE="$CLAUDE_DIR/session-state/CURRENT.md"

if [ -f "$SESSION_STATE" ]; then
    session_age=$(file_age_days "$SESSION_STATE")
    if [ "$session_age" -gt 7 ]; then
        warn "Session state is stale ($session_age days old): CURRENT.md"
    else
        pass "Session state is fresh ($session_age days old): CURRENT.md"
    fi
else
    warn "Session state file not found: $SESSION_STATE"
fi

# =============================================================================
# Summary
# =============================================================================

echo ""
echo "============================================================================="
echo -e "${BLUE}KNOWLEDGE BASE STALENESS AUDIT SUMMARY${NC}"
echo "============================================================================="
echo ""
echo -e "Total Checks:  $TOTAL_CHECKS"
echo -e "Passes:        ${GREEN}$PASSES${NC}"
echo -e "Warnings:      ${YELLOW}$WARNINGS${NC}"
echo -e "Failures:      ${RED}$FAILURES${NC}"
echo ""

if [ "$FAILURES" -gt 0 ]; then
    echo -e "${RED}[X] Staleness audit has FAILURES that need attention${NC}"
    echo ""
    if [ "$CI_MODE" = true ]; then
        exit 1
    fi
elif [ "$WARNINGS" -gt 0 ]; then
    echo -e "${YELLOW}[!] Staleness audit passed with $WARNINGS warning(s)${NC}"
    echo ""
    echo "Warnings are informational and don't block. Address when convenient."
else
    echo -e "${GREEN}[OK] All knowledge base checks passed!${NC}"
fi

# Exit 1 only on failures (not warnings)
if [ "$FAILURES" -gt 0 ]; then
    exit 1
fi

exit 0
