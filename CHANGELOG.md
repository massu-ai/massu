# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
- API routes replace `select('*')` with explicit field lists (CR-17 compliance)
- `requirePlan()` now rejects canceled/past_due subscriptions (was only checking plan tier)
- `handleSubscriptionDeleted` resets plan to `free` alongside setting status to canceled
- `massu.dev` URLs updated to `massu.ai` in CLI and init command
- `__dirname` ESM compatibility bug in init.ts (was undefined in ESM bundles)
- npm package `files` field excludes source/test files (ships only `dist/`)
- Privacy and Terms page titles no longer double-append "| Massu AI"
- Pricing page now has proper SEO metadata via layout
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
