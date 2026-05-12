#!/usr/bin/env bash
# scripts/lib/leak-patterns.sh — SOLE source of truth for leak-guard pattern catalogs.
#
# Purpose: this file defines the CONTENT_PATTERNS regex catalog used by BOTH
# public-repo and website-content leak-guards. Per CR-46 / Rule 0
# (enterprise-grade) and CR-49 (public-content-leak-guard), the patterns MUST
# live in ONE place — duplicating the list across multiple scanner scripts
# creates a future divergence bug-class (one updated, the others forgotten).
#
# Consumers (must `source` this file):
#   - scripts/massu-public-leak-guard.sh        — scans repo paths/content
#                                                   destined for github.com/massu-ai/massu
#                                                   (the PUBLIC OSS repo)
#   - scripts/massu-website-content-leak-guard.sh — scans website/content/**/*.mdx
#                                                   destined for massu.ai
#                                                   (the PUBLIC website)
#
# To add a new forbidden pattern: append to CONTENT_PATTERNS below. To add a
# new allowlisted file: append to the appropriate
# CONTENT_SCAN_SELF_REFERENCE_FILES_* array AND mirror in
# website/src/data/leak-guard-exempt.ts when adding to the website-content
# array (drift-guard test enforces parity).
#
# Plan reference: docs/plans/2026-05-11-public-content-leak-guard.md
# Plan Token: plan-public-content-leak-guard

# Path-based allowlist catches "wrong directory" leaks. Content scan
# catches the harder case: a legitimate path (e.g. packages/core/src/foo.ts)
# accidentally containing a trade-secret comment, customer name, internal
# project codename, etc.
#
# Each pattern below is ERE-compatible. To add a new denied pattern,
# append a line. Patterns are case-insensitive (egrep -i). False
# positives can be silenced by inserting a `# leak-guard-allow: <reason>`
# comment on the same line as the match. For MDX content, prefer the
# HTML-comment form `<!-- leak-guard-allow: <reason> -->` (renders
# invisibly); the bash-style `#` form is supported for parity but NOT
# RECOMMENDED for MDX (renders as visible page text).

CONTENT_PATTERNS=(
  # Internal project markers
  'TRADE[ -]?SECRET'
  'CONFIDENTIAL'
  'INTERNAL[ -]?ONLY'
  'NOT[ -]FOR[ -]PUBLIC'
  'DO[ -]NOT[ -]SHIP'
  'PROPRIETARY'
  # Internal-doc references the manifest forbids
  'docs/internal/'
  'docs/strategy/'
  'docs/security/'
  'docs/incidents/'
  'reports/gap-analysis/'
  # Internal-only command prefix
  'massu-internal-'
  # User-machine paths (a leaked /Users/operator/... discloses the
  # contributor username + local layout)
  '/Users/operator/'
  # Customer / downstream-consumer name leaks. `example-project` is a private
  # trading project that was the original test bed for many massu
  # features — its name should NEVER appear in public source. Word-
  # boundary anchors avoid false positives like "hedged" or "hedgehog".
  '\bhedge\b'
  '\bexample_svc\b'
  '\bexample-svc\b'
  '\bexample-api\b'
)

# Raw-SHA pattern — applies ONLY to the website-content scanner, NOT the
# public-repo guard (the public repo legitimately cites its own commit
# SHAs in CHANGELOG.md, release notes, etc.). Internal git SHAs from
# massu-internal cannot resolve in the public repo and are confusing
# leaks when shipped to the public website (see 2026-05-11 incident:
# 6 internal SHAs in website/content/releases/1.5-to-1.6.mdx caught at
# operator review). Pattern accepts 7-40 hex chars with word boundaries
# (excludes 3-6 char hex colors like #fff/#abc123 and 64-char SHA-256
# fingerprints which are typically signing keys, not SHAs).
RAW_SHA_PATTERN='\b[0-9a-f]{7,40}\b'

# Files in the public-repo allowlist that DEFINE or DOCUMENT the leak-
# guard patterns themselves — these legitimately need to mention the
# strings without triggering. Adding paths here is a structural choice,
# not an escape hatch — these are the files whose JOB it is to enumerate
# the patterns. Any other legitimate-looking content match should use
# the per-line `# leak-guard-allow:` trailer instead.
CONTENT_SCAN_SELF_REFERENCE_FILES_PUBLIC_REPO=(
  # Guard infrastructure — these enumerate the patterns by definition.
  'scripts/massu-public-leak-guard.sh'
  'scripts/install-hooks.sh'
  '.github/workflows/leak-guard.yml'
  '.github/workflows/leak-guard-retro.yml'
  '.github/workflows/leak-guard-source-of-truth.yml'
  '.github/workflows/leak-guard-scheduled.yml'
  '.claude/CLAUDE.md'
  # Workflow / command boundary documentation — their JOB is to point
  # users at private workflows when public ones don't apply, OR to
  # document a user-side path convention (e.g. reports/gap-analysis/
  # where the user saves THEIR own gap reports, not where massu-
  # internal stores them).
  'docs/features/workflow-commands.mdx'
  '.claude/commands/massu-gap-enhancement-analyzer.md'
  '.claude/commands/massu-refactor.md'
  'packages/core/commands/massu-gap-enhancement-analyzer.md'
  'packages/core/commands/massu-refactor.md'
  # Code whose contract IS the user-side path (the incident-pipeline
  # hook fires on writes to the user's docs/incidents/ directory; that
  # path is part of the public API, not an internal secret).
  'packages/core/src/hooks/incident-pipeline.ts'
  # Internal-command-aware scanners — their comments enumerate
  # known internal command filenames as part of their pattern catalog.
  'scripts/massu-generalization-scanner.sh'
  'scripts/massu-security-scanner.sh'
  # Release documentation — CHANGELOG.md legitimately enumerates the
  # `massu-internal-*` exclusion convention as part of release notes
  # describing what slash commands are shipped publicly. Public-facing
  # documentation MUST be able to disclose the public/internal split.
  # (plan-1.7.0-cohesive-cleanup P-A-005)
  'CHANGELOG.md'
  # CLI Reference doc legitimately enumerates the `massu-internal-`
  # exclusion convention as part of explaining the 59 external slash
  # commands ship publicly and internal ones are operator-only.
  'docs/reference/cli-reference.mdx'
  # Leak-guard test fixtures + their test file — these intentionally
  # contain the trigger patterns to validate the guard catches them.
  # Adding them here lets the public-sync verifier accept the test
  # corpus while preserving real-content blocking.
  # (plan-leak-guard-range-mode-verify Stage B+C fixtures)
  'packages/core/src/__tests__/fixtures/leak-guard-commit-mode/expected-leak.md'
  'packages/core/src/__tests__/fixtures/leak-guard-commit-mode/expected-mixed.md'
  'packages/core/src/__tests__/fixtures/leak-guard-commit-mode/expected-clean.md'
  'packages/core/src/__tests__/leak-guard-commit-mode.test.ts'
  # plan-public-content-leak-guard P-A-006: shared pattern catalog and
  # the new website-content scanner are synced to public via
  # scripts/sync-public.sh:53 (`rsync -a --delete scripts/`). Both
  # legitimately enumerate the trigger patterns in their array literal,
  # so they need self-reference allowlisting in the public-repo guard.
  'scripts/lib/leak-patterns.sh'
  'scripts/massu-website-content-leak-guard.sh'
)

# Files under website/content/** whose job IS to mention forbidden
# patterns (e.g. enumerating the internal-vs-public command split).
# IMPORTANT: this list MUST mirror website/src/data/leak-guard-exempt.ts
# :WEBSITE_CONTENT_LEAK_GUARD_EXEMPT — the drift-guard test in P-C-002
# enforces byte-equivalent membership (length + set + ordering).
CONTENT_SCAN_SELF_REFERENCE_FILES_WEBSITE_CONTENT=(
  # Workflow commands list — enumerates massu-internal-* commands as
  # part of explaining the public/internal split.
  'website/content/docs/features/workflow-commands.mdx'
  # CLI reference — documents the public/internal command convention.
  'website/content/docs/reference/cli-reference.mdx'
  # Python intelligence docs — uses fake example SHAs in code blocks to
  # illustrate the migration-graph feature.
  'website/content/docs/features/python-intelligence.mdx'
  # Cost tracking docs — references Anthropic model identifier
  # (claude-sonnet-4-5-20250929) which contains a hex-pattern suffix.
  'website/content/docs/features/cost-tracking.mdx'
  # Configuration docs — same Anthropic model identifier reference as
  # cost-tracking.
  'website/content/docs/getting-started/configuration.mdx'
)
