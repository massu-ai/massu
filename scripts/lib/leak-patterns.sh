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
  # Operator-specific Supabase MCP server aliases. Public command files MUST
  # reference the user's OWN configured Supabase MCP server(s) via generic
  # placeholders (e.g. `mcp__supabase__<your-env-alias>__...` or the wildcard
  # `mcp__supabase__*`) — NOT a concrete operator-named environment alias.
  # This GENERIC signal flags any concrete `mcp__supabase__<ALIAS>__` reference
  # (alphanumeric/underscore alias, e.g. a concrete environment name) without
  # disclosing the operator's exact ref-IDs (those live in the sync-excluded
  # leak-patterns-operator.sh). Placeholder forms with `<`/`>` or `*` are NOT
  # matched (those characters fall outside the alias character class), so the
  # generic genericized docs pass clean. Closes incident
  # docs/incidents/2026-05-27-supabase-projectid-public-leak.md.
  'mcp__supabase__[A-Za-z0-9_]+__'
  # Supabase project-host URLs embed the 20-char project-ref ID. A bare 20-char
  # token regex is too false-positive-prone, but anchored to the `.supabase.co`
  # host suffix it reliably flags a leaked DB/API host (e.g.
  # `<ref>.supabase.co`) without matching arbitrary hex/base32 blobs.
  '[a-z0-9]{20}\.supabase\.co'
)

# Operator-specific patterns (local-machine paths + private-project names)
# live in an INTERNAL-ONLY companion file that is NOT synced to the public
# OSS repo — publishing those detection literals would itself disclose the
# operator's username + private project name. Source it IF PRESENT: in the
# internal context the patterns are appended; in the public mirror the file
# is absent and the source is skipped (graceful absence by design).
_massu_op_patterns="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/leak-patterns-operator.sh"
[ -f "$_massu_op_patterns" ] && source "$_massu_op_patterns"
unset _massu_op_patterns

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
  # ── Model assets: upstream data blobs, not authored content (added 2026-07-13) ──
  # `assets/embedder/vocab.txt` is a 30,522-token BERT WordPiece vocabulary. It contains every
  # common English word — including "confidential" and "proprietary" — so the content scan matches
  # it on EVERY run, forever. Nobody wrote those words there; they are the English language.
  #
  # This is a PRECISION fix, not a security exception. A permanent false positive is not cosmetic:
  # it is how a gate dies. Someone gets tired of it and the fix they reach for is to weaken the
  # patterns or bypass the guard — and then it is not protecting anything at all. Exempting the one
  # data file keeps every pattern at full strength everywhere it can actually mean something.
  'packages/core/assets/embedder/vocab.txt'
  # `massu-incident-coverage.sh` is a script whose JOB is to check that incidents are documented
  # under docs/incidents/. It must name that path to do its work — the same "enumerates the pattern
  # by definition" case as the guard scripts below.
  'scripts/massu-incident-coverage.sh'
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
  # Supabase MCP-alias leak-guard drift-guard (incident 2026-05-27): the FAKE
  # fixture intentionally contains a Supabase MCP alias (`mcp__supabase__<env>__`
  # + fake id) to exercise the generic pattern; the test file references the
  # generic pattern literal + a fake alias in a comment. Both must be exempt so
  # the public-sync verifier accepts them while the generic pattern keeps
  # blocking real alias references in non-fixture files.
  'packages/core/src/__tests__/fixtures/leak-guard-commit-mode/expected-supabase-alias-leak.md'
  'packages/core/src/__tests__/supabase-alias-leak-guard.test.ts'
  # plan-public-content-leak-guard P-A-006: shared pattern catalog and
  # the new website-content scanner are synced to public via
  # scripts/sync-public.sh:53 (`rsync -a --delete scripts/`). Both
  # legitimately enumerate the trigger patterns in their array literal,
  # so they need self-reference allowlisting in the public-repo guard.
  'scripts/lib/leak-patterns.sh'
  'scripts/massu-website-content-leak-guard.sh'
  # P-M-040 / P-E-019 follow-on (plan-stage-e-low-info-sweep ceremony
  # 2026-05-18): these two scripts legitimately enumerate the
  # `massu-internal-` exclusion convention as part of their job —
  # diff-commands-vs-docs.sh excludes the internal-prefix from its
  # public-docs completeness check, and massu-pattern-scanner.sh
  # Check 24 enforces that public commands have docs (and explicitly
  # NOT internal ones).
  'scripts/diff-commands-vs-docs.sh'
  'scripts/massu-pattern-scanner.sh'
  # plan-stage-d P-M-040: docs-triage-pending allowlist file legitimately
  # enumerates `massu-internal-` command filenames as the canonical list
  # of internal-only commands the pattern scanner Check 24 will permit
  # not-yet-documented. Synced to public via sync-public.sh:171.
  '.claude/commands/.docs-triage-pending.txt'
  # packages/core/CHANGELOG.md is the published-package CHANGELOG (copy of
  # root CHANGELOG.md, written by prepublishOnly hook in package.json).
  # Inherits the same self-reference exemption as root CHANGELOG.md above.
  'packages/core/CHANGELOG.md'
  # website/CHANGELOG.md is the byte-equal website mirror of root CHANGELOG.md
  # (un-gitignored per CR-48; parity enforced by website-changelog-matches-root
  # .test.ts). It carries the identical release-note content — including the
  # `massu-internal-*` public/internal-split disclosure and docs/incidents/
  # references — so it inherits the same self-reference exemption as root
  # CHANGELOG.md above.
  'website/CHANGELOG.md'
  # plan-2026-05-18-pre-push-ci-parity P1-002: extracted CI sync-check script
  # enumerates the secret patterns (TRADE-SECRET, Stripe regex, Supabase ref)
  # as part of its job — the in-mirror grep needs the literal pattern.
  'scripts/ci-sync-check.sh'
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
