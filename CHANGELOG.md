# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.0] - 2026-02-25

### Added
- **Tier enforcement** — Free (14 tools), Pro (63+), Team, Enterprise tiers with license gating
- **License validation** — `license.ts` module with `getCurrentTier()`, `getToolTier()`, `isToolAllowed()`, and `annotateToolDefinitions()`
- **`massu_license_status` tool** — Check current tier, available tools, and upgrade path from any session
- **Conventions config** — `conventions` section in `massu.config.yaml` for project-specific coding rules
- **Generalization scanner** — `scripts/massu-generalization-scanner.sh` verifies no hardcoded project-specific data in shipped files

### Changed
- Tool descriptions now include tier labels (e.g., "[Pro]") when not on the free tier
- README and CLAUDE.public.md updated with tier information and tool counts
- Package description updated to mention tiered tooling

## [Unreleased]

### Added
- BSL 1.1 license (Phase 1A)
- Supabase schema with RLS policies (Phase 1A)
- Auth flow: login, signup, forgot-password, OAuth (Phase 1B)
- Dashboard with session analytics (Phase 1E)
- Stripe checkout and billing integration (Phase 1C)
- API key management with bcrypt hashing (Phase 1D)
- Cloud sync edge functions (Phase 1D)
- Terms of Service and Privacy Policy pages
- CI/CD pipeline with lint, type-check, test, and build jobs (GitHub Actions)
- Website test infrastructure (vitest + Playwright E2E stubs)
- Sentry error monitoring configuration stubs
- Docker and docker-compose setup for local development
- Contributor License Agreement (CLA.md)
- Comprehensive security hardening (audit remediation)
- Toast notification system
- Shared UI components (TextInput, GitHubIcon, CopyInstallCommand)
- Public/private visibility classification for observations
- Zod runtime validation for config parsing (replaced ~35 type assertions)
- Plugin README documenting planned Claude Code plugin

### Changed
- Contributing guide updated with environment variable and config documentation
- Cookie security and CSRF protection documented in code comments
- API key lookup uses unique key prefix for efficient index queries
- Hook git commands use spawnSync instead of execSync for safety

### Fixed
- Stripe checkout redirect SSRF vulnerability
- XSS via javascript: URLs in MarkdownRenderer
- CSP unsafe-eval removed
- CORS restricted on edge functions
- Webhook secret validation
- Stripe price ID env var naming mismatch
- Dashboard billing nav link path
- Checkout session plan assignment
- Domain inconsistency (massu.dev to massu.ai)
- Password visibility toggle keyboard accessibility
- Multiple silent error handling blocks

### Security
- Added RLS INSERT/UPDATE/DELETE policies
- Input validation on sync edge function
- UUID validation on org IDs
- Server-side org ID derivation
- Rate limiting on auth forms
- LIKE wildcard escaping
- Redirect parameter validation
- Auth error message normalization

### Dependency Audit
- 5 moderate vulnerabilities found, all in dev-only toolchain (esbuild <=0.24.2 via vite/vitest)
- These affect only the development server, not production builds
- Fix requires breaking change to esbuild 0.27+ (`npm audit fix --force`)
- No production runtime vulnerabilities detected
