# Issue Remediation Plan: Full-Scope Review Findings

**Source**: `docs/2026-02-21-full-scope-review.md`
**Created**: 2026-02-21
**Status**: COMPLETE - All 44 deliverables verified (2026-02-21)
**Scope**: 54 open issues from the 119-finding full-scope review (10 already fixed by prevention plan, 15 INFO, 39 ENHANCEMENTS excluded)

---

## Overview

This plan addresses the remaining open issues from the full-scope review, organized into 5 phases by priority and dependency order. Each phase can be implemented independently.

**Total deliverables**: 44 (plus 4 deferred design decisions)
**Estimated phases**: 5

---

## Phase 1: Critical Security Fixes (7 deliverables)

These must be fixed before any public launch. Security vulnerabilities that could be exploited.

### P1-001: Fix SSO Authentication Bypass [1.2]

**Problem**: SSO callback validates CSRF state but does NOT validate SAML assertion or OIDC code. Attacker can bypass auth with fabricated assertion.

**File**: `/Users/eko3/massu-internal/website/src/app/api/sso/callback/route.ts`

**Action**: Either complete SSO implementation with proper assertion validation against IdP configuration, OR remove the SSO callback endpoint entirely until properly implemented. Given the complexity of SAML/OIDC implementation and the risk of getting it wrong, **removing the endpoint is the safer option** until a proper SSO library (e.g., `@auth/core` SAML provider or `saml2-js`) is integrated.

**Verification**: `grep -n 'In a full implementation' /Users/eko3/massu-internal/website/src/app/api/sso/callback/route.ts` should return 0 matches.

---

### P1-002: Add Webhook URL SSRF Validation [1.3]

**Problem**: Webhook creation accepts any URL. Attacker could probe internal infrastructure via `http://169.254.169.254/`, localhost, etc.

**Files**:
- `/Users/eko3/massu-internal/website/src/app/api/v1/webhooks/route.ts` (POST handler)
- `/Users/eko3/massu-internal/website/src/lib/validations.ts` (schema)

**Action**:
1. Create URL validation function `validateWebhookUrl(url: string)` in `validations.ts` that:
   - Requires HTTPS scheme
   - Rejects RFC 1918 IPs (10.x, 172.16-31.x, 192.168.x)
   - Rejects loopback (127.x, ::1, localhost)
   - Rejects link-local (169.254.x)
   - Rejects metadata endpoints (169.254.169.254)
2. Apply validation in POST handler before insert
3. Apply same validation in PATCH handler

**Verification**: `grep -n 'validateWebhookUrl' /Users/eko3/massu-internal/website/src/app/api/v1/webhooks/route.ts` returns match.

---

### P1-003: Stop Exposing Webhook Secret in GET [1.4]

**Problem**: GET endpoints use `select('*')` which includes the `secret` field.

**Files**:
- `/Users/eko3/massu-internal/website/src/app/api/v1/webhooks/route.ts` (list)
- `/Users/eko3/massu-internal/website/src/app/api/v1/webhooks/[id]/route.ts` (single)

**Action**: Replace `.select('*')` with explicit column list: `.select('id, url, events, description, enabled, created_at, updated_at')` in both GET handlers.

**Verification**:
- `grep -c "select('*')" /Users/eko3/massu-internal/website/src/app/api/v1/webhooks/route.ts` returns 0 (currently 1)
- `grep -c "select('*')" /Users/eko3/massu-internal/website/src/app/api/v1/webhooks/[id]/route.ts` returns 0 (currently 2)

---

### P1-004: Fix Encryption Silent Plaintext Fallback [2.4]

**Problem**: Sync function catches encryption errors with empty `catch {}` and stores data in plaintext. Violates CR-15.

**File**: `/Users/eko3/massu-internal/website/supabase/functions/sync/index.ts` (lines 355-360)

**Current code** (line 358): `} catch {` with comment `// If encryption fails, store unencrypted`

**Action**: Replace empty `catch {` block with `catch (error) { throw new Error('Encryption failed: ' + (error instanceof Error ? error.message : 'unknown')); }`. Encryption must fail hard, not fall back to plaintext.

**Verification**: `grep -A5 'shouldEncrypt' /Users/eko3/massu-internal/website/supabase/functions/sync/index.ts | grep -c 'store unencrypted'` returns 0.

---

### P1-005: Add Path Traversal Protection to Schema Verify [2.5]

**Problem**: MCP `schema verify` tool resolves user-provided paths without `ensureWithinRoot()`.

**File**: `/Users/eko3/massu/packages/core/src/tools.ts` (line 799)

**Action**:
1. Add import at top of file: `import { ensureWithinRoot } from './security-utils.ts';` (note: `ensureWithinRoot` is already exported from security-utils.ts at line 17, but NOT currently imported in tools.ts)
2. Add validation call before line 799 (`const absPath = resolve(getProjectRoot(), file);`):
```typescript
ensureWithinRoot(file, getProjectRoot());
```

**Verification**: `grep -n 'ensureWithinRoot' /Users/eko3/massu/packages/core/src/tools.ts` returns match near schema verify.

---

### P1-006: Add Rate Limiting to Unprotected API Routes [2.1]

**Problem**: Only 3 of ~28 API routes have rate limiting. Dashboard routes lack protection entirely.

**Files**: Multiple API routes in `/Users/eko3/massu-internal/website/src/app/api/`

**Action**: Add `rateLimit()` calls to these unprotected routes:
- `/api/settings/route.ts`
- `/api/evidence/route.ts`
- `/api/export/route.ts`
- `/api/invitations/*/route.ts`
- `/api/sso/route.ts`
- `/api/badge/[orgSlug]/[type]/route.ts`
- `/api/github-stars/route.ts`

Use appropriate limits per route type (authenticated: 60/min, public: 20/min).

**Verification**: `grep -rn 'rateLimit' /Users/eko3/massu-internal/website/src/app/api/ | wc -l` should be >= 16 (currently 9 across 3 files; adding 7 routes should bring total to >= 16).

---

### P1-007: Add Dashboard Plan Gating [1.5]

**Problem**: Free-tier users can access paid dashboard features by URL. Only navigation hides links.

**Files**: Dashboard pages missing `requirePlan()`:
- `/Users/eko3/massu-internal/website/src/app/dashboard/cost/page.tsx`
- `/Users/eko3/massu-internal/website/src/app/dashboard/cost/budget/page.tsx`
- `/Users/eko3/massu-internal/website/src/app/dashboard/cost/compare/page.tsx`
- `/Users/eko3/massu-internal/website/src/app/dashboard/sessions/compare/page.tsx`
- `/Users/eko3/massu-internal/website/src/app/dashboard/sessions/[id]/page.tsx`
- Other pages as determined by pricing model

**Action**: Add `await requirePlan('cloud_pro')` (or appropriate tier) at the top of each page's server component. Audit each page against the pricing tiers in `pricing.ts` to determine the correct tier.

**Verification**: `grep -rl 'requirePlan' /Users/eko3/massu-internal/website/src/app/dashboard/ | wc -l` should increase from current 29 files. The pages listed above (cost/*, sessions/compare, sessions/[id]) should all contain `requirePlan` after implementation.

---

## Phase 2: High-Priority Fixes (5 deliverables)

Important issues that affect correctness, adoption, or code quality.

### P2-001: Make NPM Package Publishable [1.1]

**Problem**: `main`, `exports`, `bin` point to `.ts` files. No compiled output exists for server/CLI.

**File**: `/Users/eko3/massu/packages/core/package.json`

**Action**:
1. Add esbuild server compilation step to `build` script (similar to hooks build)
2. Compile `src/server.ts` and `src/cli.ts` to `dist/`
3. Update `main`, `exports`, `bin` to point to `dist/` output
4. Update `prepublishOnly` to run the full build
5. Add `dist/` to `.gitignore` and `files` whitelist in package.json

**Verification**: `ls /Users/eko3/massu/packages/core/dist/server.js` exists after `npm run build`.

---

### P2-002: Extract Duplicated Helper Functions [1.7]

**Problem**: `p()` duplicated in 15 files and `text()` duplicated in 15 files (30 copies total of those two helpers).

**Action**:
1. Create `/Users/eko3/massu/packages/core/src/tool-helpers.ts` with:
   - `export function p(baseName: string): string` (tool prefix helper)
   - `export function text(content: string): ToolResult` (result wrapper)
   - `export function stripPrefix(name: string): string` (prefix stripper -- currently only in tools.ts but should be shared since tool modules use inline prefix stripping)
2. Remove the local `p()` and `text()` definitions from all 15 modules; remove `stripPrefix()` from tools.ts
3. Add `import { p, text, stripPrefix } from './tool-helpers.ts'` to each module that needs them

**Files to modify**: `analytics.ts`, `cost-tracker.ts`, `regression-detector.ts`, `audit-trail.ts`, `observability-tools.ts`, `prompt-analyzer.ts`, `memory-tools.ts`, `team-knowledge.ts`, `validation-engine.ts`, `tools.ts`, `docs-tools.ts`, `sentinel-tools.ts`, `security-scorer.ts`, `dependency-scorer.ts`, `adr-generator.ts`

**Verification**: `grep -rn 'function p(' packages/core/src/ | grep -v tool-helpers | grep -v __tests__ | wc -l` returns 0.

---

### P2-003: Fix Model Pricing Defaults [1.9]

**Problem**: `DEFAULT_MODEL_PRICING` in cost-tracker.ts has two issues:
1. The `claude-haiku-4-5-20251001` key uses Haiku 3.5 pricing ($0.80/$4) but the model key name suggests Haiku 4.5 (which costs $1/$5 per MTok).
2. Opus 4.6 pricing ($5/$25) is correct per official Anthropic pricing (https://platform.claude.com/docs/en/about-claude/pricing). The $15/$75 price applies to the older Opus 4.0/4.1 models.

**File**: `/Users/eko3/massu/packages/core/src/cost-tracker.ts` (line 20)

**Action**: Update DEFAULT_MODEL_PRICING to match current Anthropic pricing:
- `claude-opus-4-6`: input_per_million: 5, output_per_million: 25, cache_read_per_million: 0.50, cache_write_per_million: 6.25 (already correct)
- `claude-sonnet-4-5`: input_per_million: 3, output_per_million: 15 (already correct)
- `claude-sonnet-4-6`: input_per_million: 3, output_per_million: 15 (already correct)
- `claude-haiku-4-5-20251001`: Determine correct model identity. If this key maps to Haiku 3.5 (released 2024-10-22), pricing is correct ($0.80/$4) but key name is misleading. If it maps to Haiku 4.5, update to input_per_million: 1, output_per_million: 5, cache_read_per_million: 0.10, cache_write_per_million: 1.25. Recommend renaming key to match actual model (e.g., `claude-3-5-haiku-20241022` or `claude-haiku-4-5`).
- `default`: update to match Sonnet pricing (already correct)

**Verification**: `grep -A1 'haiku' /Users/eko3/massu/packages/core/src/cost-tracker.ts` shows pricing consistent with the model identity (either $0.80/$4 for Haiku 3.5 or $1/$5 for Haiku 4.5).

---

### P2-004: Fix Repository URL Mismatch [1.11]

**Problem**: Root package.json uses `ethankowen-73/massu`, core uses `massu-ai/massu`.

**Files**:
- `/Users/eko3/massu/package.json` (line 21)
- `/Users/eko3/massu/packages/core/package.json` (line 54)

**Action**: Align both to the canonical `massu-ai/massu` URL. Also update `bugs.url` to match.

**Verification**: `grep -rn 'ethankowen-73' /Users/eko3/massu/package.json` returns 0 matches.

---

### P2-005: Fix Features Page Tier Badges [1.8]

**Problem**: Every tool shows a hardcoded `<Badge variant="success">Free</Badge>` regardless of tier.

**File**: `/Users/eko3/massu-internal/website/src/app/features/page.tsx` (lines 257-262)

**Action**: Replace hardcoded "Free" badge with tier-appropriate badge based on `tool.tier`:
```tsx
const tierBadge = {
  'open-source': { label: 'Free', variant: 'success' },
  'cloud-pro': { label: 'Pro', variant: 'info' },
  'cloud-team': { label: 'Team', variant: 'warning' },
  'cloud-enterprise': { label: 'Enterprise', variant: 'purple' },
}
```

**Note**: If all tools genuinely ARE open-source/free, update `features.ts` to remove unused tier values and clean up the `Feature` interface. The current state where the data model supports tiers but the UI ignores them creates confusion.

**Verification**: `grep -n 'variant="success"' /Users/eko3/massu-internal/website/src/app/features/page.tsx | grep -v '//'` returns 0 matches (currently 1 at line 258). The hardcoded `variant="success"` on the tier badge is the signature of the bug; after the fix, the variant will be dynamic (e.g., `variant={tierBadge[tool.tier].variant}`). Note: `grep -c 'Free'` is NOT a valid check because "Free" appears in comments (line 26) and in "Install Free" (line 464) which should remain.

---

## Phase 3: Code Quality & Architecture (10 deliverables)

Refactoring, code structure, and technical debt reduction.

### P3-001: Split memory-db.ts God File [1.12]

**Problem**: 1357-line single file with schema, migrations, and 19+ query functions.

**File**: `/Users/eko3/massu/packages/core/src/memory-db.ts`

**Action**: Split into:
- `memory-db.ts` - Connection factory + schema initialization (keep `getMemoryDb()`)
- `memory-queries.ts` - CRUD operations (all `getX()`, `insertX()`, `updateX()` functions)
- Keep cloud sync in existing `cloud-sync.ts`

**Verification**: `wc -l packages/core/src/memory-db.ts` should be < 400 lines.

---

### P3-002: Extract Core Tools from tools.ts [2.10]

**Problem**: tools.ts is 847 lines with 7 core tools defined inline.

**File**: `/Users/eko3/massu/packages/core/src/tools.ts`

**Action**: Extract inline core tools (sync, context, trpc_map, coupling_check, impact, domains, schema) into `core-tools.ts` using the 3-function pattern, then wire into tools.ts like other modules.

**Verification**: `wc -l packages/core/src/tools.ts` should be < 300 lines.

---

### P3-003: Migrate Legacy 2-Function Tool Modules [2.9]

**Problem**: 3 legacy modules use old 2-function pattern instead of 3-function.

**Files**: `memory-tools.ts`, `docs-tools.ts`, `sentinel-tools.ts`

**Action**: Add `isXTool()` function to each module and update tools.ts routing to use it instead of inline `startsWith()` checks.

**Verification**: `grep 'startsWith.*_memory_\|startsWith.*_docs_\|startsWith.*_sentinel_' packages/core/src/tools.ts | wc -l` returns 0 (note: `startsWith` in `stripPrefix()` function at line 59 is not a routing call and should remain).

---

### P3-004: Extract Repeated getMemoryDb Pattern [2.8]

**Problem**: `getMemoryDb()` try/finally pattern repeated 12 times in tools.ts.

**File**: `/Users/eko3/massu/packages/core/src/tools.ts`

**Action**: Create helper function:
```typescript
function withMemoryDb<T>(fn: (db: Database.Database) => T): T {
  const memDb = getMemoryDb();
  try { return fn(memDb); }
  finally { memDb.close(); }
}
```
Replace all 12 occurrences with `return withMemoryDb(db => handleXToolCall(name, args, db))`.

**Verification**: `grep -c 'getMemoryDb' packages/core/src/tools.ts` returns 2 (the import statement and the helper definition). Currently there are 13 occurrences (1 import + 12 usage sites).

---

### P3-005: Cache Schema Initialization [2.7]

**Problem**: ~20+ DDL statements execute on every `getMemoryDb()` call even though they're idempotent.

**File**: `/Users/eko3/massu/packages/core/src/memory-db.ts`

**Action**: Add a per-database-path initialization flag:
```typescript
const initializedPaths = new Set<string>();
export function getMemoryDb(): Database.Database {
  const dbPath = getResolvedPaths().dataDbPath;
  const db = new Database(dbPath);
  if (!initializedPaths.has(dbPath)) {
    initMemorySchema(db);
    initializedPaths.add(dbPath);
  }
  return db;
}
```

**Verification**: Run two consecutive `getMemoryDb()` calls; second should skip schema init.

---

### P3-006: Fix FTS5 Silent Error Swallowing [3.1]

**Problem**: FTS5 creation errors caught with empty `catch (_e)` - hides real errors.

**File**: `/Users/eko3/massu/packages/core/src/memory-db.ts`

**Current state**: 4 occurrences of `catch (_e)` at lines 93, 161, 245 (FTS5-related), and 1042 (JSON parse in `getCrossTaskProgress`).

**Action**: Replace the 3 FTS5 `catch (_e)` blocks (lines 93, 161, 245) with stderr logging:
```typescript
catch (e) {
  // FTS5 may fail if table exists with different schema or extension unavailable
  process.stderr.write(`FTS5 setup warning: ${e instanceof Error ? e.message : String(e)}\n`);
}
```
The `catch (_e)` at line 1042 (JSON parse in `getCrossTaskProgress`) should remain as-is or be converted to a similar warning, since skipping invalid JSON is valid behavior.

**Verification**: `grep -cn 'catch (_e)' packages/core/src/memory-db.ts` returns 1 or 0 (depending on whether line 1042 is also updated).

---

### P3-007: Add uncaughtException Exit [3.6]

**Problem**: Server continues in undefined state after uncaught exception.

**File**: `/Users/eko3/massu/packages/core/src/server.ts` (line 183)

**Action**: Add `process.exit(1)` after stderr write in the uncaughtException handler (line 184).

**Verification**: `grep -A2 'uncaughtException' packages/core/src/server.ts | grep 'process.exit'` returns match.

---

### P3-008: Fix Hardcoded 'my-project' Default [3.2]

**Problem**: SQLite schema uses `DEFAULT 'my-project'` in 3 tables.

**File**: `/Users/eko3/massu/packages/core/src/memory-db.ts`

**Action**: Remove the `DEFAULT 'my-project'` from schema DDL. Ensure all INSERT statements supply the project name from `getConfig()`.

**Verification**: `grep 'my-project' packages/core/src/memory-db.ts` returns 0.

---

### P3-009: Remove Unused packages/shared [3.18]

**Problem**: `packages/shared` exports types that nothing imports.

**Action**: Verify no imports exist in any package, then remove:
1. `grep -rn '@massu/shared' /Users/eko3/massu/packages/` confirms 0 imports (only self-reference in its own package.json). Also check website repo: `grep -rn '@massu/shared' /Users/eko3/massu-internal/website/` confirms 0 imports.
2. Remove `packages/shared/` directory (currently contains: `package.json`, `src/index.ts`, `src/types.ts`, `tsconfig.json`)
3. Remove `"packages/shared"` from `workspaces` array in root `package.json` (line 8)

**Verification**: `ls packages/shared` returns "No such file or directory".

---

### P3-010: Fix set -uo pipefail [2.24]

**Problem**: Shell scripts use `set -uo pipefail` without `-e` (errexit).

**Files**: All 6 shell scripts in `scripts/`

**Action**: Review each script. If the script handles errors manually (expected), add a comment explaining why `-e` is omitted. If not intentional, add `-e`. This is likely intentional since the scripts use `|| true` patterns and track violations via counter variables.

**Verification**: Each script either has `set -euo pipefail` or has a comment explaining the omission.

---

## Phase 4: Website & UI Fixes (14 deliverables)

### P4-001: Add Login/Signup Page Metadata [2.12]

**Files**:
- `/Users/eko3/massu-internal/website/src/app/login/page.tsx`
- `/Users/eko3/massu-internal/website/src/app/signup/page.tsx`

**Action**: Add `export const metadata` with title and description to each page.

**Verification**: `grep -l 'export const metadata' /Users/eko3/massu-internal/website/src/app/login/page.tsx /Users/eko3/massu-internal/website/src/app/signup/page.tsx | wc -l` returns 2.

---

### P4-002: Replace dangerouslySetInnerHTML with DOMPurify [2.3]

**File**: `/Users/eko3/massu-internal/website/src/components/docs/MarkdownRenderer.tsx`

**Action**: Add `isomorphic-dompurify` (or `dompurify`) as dependency. Pass rendered HTML through `DOMPurify.sanitize()` before setting innerHTML.

**Verification**: `grep -n 'DOMPurify' /Users/eko3/massu-internal/website/src/components/docs/MarkdownRenderer.tsx` returns match. Note: `sanitize` alone is NOT a valid check because a pre-existing `sanitizeUrl` function (line 30) already matches that pattern.

---

### P4-003: Add Loading States to Dashboard Routes [2.13]

**Problem**: Only 3 of ~41 dashboard pages have `loading.tsx`.

**Action**: Create `loading.tsx` files for all dashboard sub-routes that fetch data. Use a consistent skeleton pattern (e.g., animate-pulse cards matching each page's layout).

**Verification**: `find /Users/eko3/massu-internal/website/src/app/dashboard -name 'loading.tsx' | wc -l` should be >= 10.

---

### P4-004: Remove Framer Motion from Button [2.14]

**File**: `/Users/eko3/massu-internal/website/src/components/ui/Button.tsx`

**Action**: Replace `<motion.button>` (line 74) and `<motion.a>` (line 60) with regular `<button>` and `<a>` using CSS transitions for hover/tap effects. Remove the `framer-motion` import (line 4). This removes the ~30-40KB framer-motion bundle from every page that uses a button.

**Verification**: `grep -c 'motion' /Users/eko3/massu-internal/website/src/components/ui/Button.tsx` returns 0.

---

### P4-005: Mount ToastProvider in Root Layout [2.15]

**File**: `/Users/eko3/massu-internal/website/src/app/layout.tsx`

**Action**: Add toast provider component to the root layout so toast notifications work globally.

**Verification**: `grep -n 'Toast\|toast' /Users/eko3/massu-internal/website/src/app/layout.tsx` returns match for provider import/mount.

---

### P4-006: Persist Contact Form Submissions [2.16]

**File**: `/Users/eko3/massu-internal/website/src/app/api/contact/route.ts`

**Action**: Add `supabase.from('contact_submissions').insert({ name, email, company, message, created_at })` before sending email notifications. Create migration for `contact_submissions` table if it doesn't exist.

**Verification**: `grep -n 'contact_submissions' /Users/eko3/massu-internal/website/src/app/api/contact/route.ts` returns match.

---

### P4-007: Fix Modal Hardcoded Colors [2.11]

**File**: `/Users/eko3/massu-internal/website/src/components/ui/Modal.tsx`

**Action**: Replace hardcoded Tailwind colors with semantic design tokens (`bg-surface`, `text-foreground`, `border-border`, etc.).

**Verification**: `grep -c 'bg-\(white\|gray\|slate\|zinc\)' /Users/eko3/massu-internal/website/src/components/ui/Modal.tsx` returns 0 (no hardcoded color classes).

---

### P4-008: Fix Alert Hardcoded Colors [3.8]

**File**: `/Users/eko3/massu-internal/website/src/components/ui/Alert.tsx`

**Action**: Replace hardcoded variant colors with semantic design tokens.

**Verification**: `grep -c 'bg-\(red\|green\|yellow\|blue\)-' /Users/eko3/massu-internal/website/src/components/ui/Alert.tsx` returns 0 (no hardcoded color classes).

---

### P4-009: Fix Dashboard Error Page Buttons [3.9]

**File**: `/Users/eko3/massu-internal/website/src/app/dashboard/error.tsx`

**Action**: Import and use `Button` component instead of raw `<button>` with inline Tailwind classes.

**Verification**: `grep -n 'import.*Button' /Users/eko3/massu-internal/website/src/app/dashboard/error.tsx` returns match.

---

### P4-010: Add Sitemap Routes [3.10]

**File**: `/Users/eko3/massu-internal/website/src/app/sitemap.ts`

**Action**: Add `'/terms'` and `'/privacy'` to the `staticPages` array.

**Verification**: `grep -c "terms\|privacy" /Users/eko3/massu-internal/website/src/app/sitemap.ts` returns >= 2.

---

### P4-011: Remove PII from Contact Logs [3.14]

**File**: `/Users/eko3/massu-internal/website/src/app/api/contact/route.ts`

**Action**: Replace `{ name: sanitized.name, email: sanitized.email }` in logger.info with `{ emailDomain: sanitized.email.split('@')[1] }`.

**Verification**: `grep 'emailDomain' /Users/eko3/massu-internal/website/src/app/api/contact/route.ts` returns match. Note: grepping for `sanitized.name\|sanitized.email` returning 0 is NOT a valid check because the replacement expression `sanitized.email.split('@')[1]` still contains `sanitized.email` as a substring.

---

### P4-012: Fix Badge Slug Enumeration [3.12]

**File**: `/Users/eko3/massu-internal/website/src/app/api/badge/[orgSlug]/[type]/route.ts`

**Action**: Return the same generic "not available" SVG badge for both "org not found" and "not configured" cases.

**Verification**: `grep -c "'not found'" /Users/eko3/massu-internal/website/src/app/api/badge/[orgSlug]/[type]/route.ts` returns 0 (currently 1 at line 30). Both the "org not found" (line 27-37) and "not configured" (line 48-58) paths should use the same generic message (e.g., "not available").

---

### P4-013: Sanitize Content-Disposition Header [3.13]

**File**: `/Users/eko3/massu-internal/website/src/app/api/export/route.ts`

**Action**: Sanitize `orgSlug` before injecting into Content-Disposition header: `orgSlug.replace(/[^a-zA-Z0-9-]/g, '')`.

**Verification**: `grep -n 'replace.*a-zA-Z0-9' /Users/eko3/massu-internal/website/src/app/api/export/route.ts` returns match near Content-Disposition.

---

### P4-014: Convert 404 Image to WebP [3.7]

**File**: `/Users/eko3/massu-internal/website/public/images/massu-lamassu-404.png` (235KB)

**Action**: Convert PNG to WebP format. Update reference in `not-found.tsx`.

**Verification**: `ls /Users/eko3/massu-internal/website/public/images/massu-lamassu-404.webp` exists and `grep 'webp' /Users/eko3/massu-internal/website/src/app/not-found.tsx` returns match.

---

## Phase 5: Documentation & Configuration (8 deliverables)

### P5-001: Update CLAUDE.md Tech Stack [3.3]

**File**: `/Users/eko3/massu/.claude/CLAUDE.md`

**Action**: Remove `@modelcontextprotocol/sdk for MCP protocol` (line 26 of CLAUDE.md). Replace with `Raw JSON-RPC 2.0 over stdio (MCP protocol)`.

**Verification**: `grep '@modelcontextprotocol/sdk' /Users/eko3/massu/.claude/CLAUDE.md` returns 0 matches.

---

### P5-002: Update CLAUDE.md Tool Module Inventory [3.4]

**File**: `/Users/eko3/massu/.claude/CLAUDE.md`

**Action**: Change "NO" to "YES" for all 10 modules that now have tests: analytics, cost-tracker, prompt-analyzer, audit-trail, validation-engine, adr-generator, security-scorer, dependency-scorer, team-knowledge, regression-detector. (Confirmed: all 10 test files exist in `packages/core/src/__tests__/`.)

**Verification**: `grep -c '| NO |' /Users/eko3/massu/.claude/CLAUDE.md` returns 0 in the tool module inventory section.

---

### P5-003: Update CLAUDE.md Workflow Commands Table [3.5]

**File**: `/Users/eko3/massu/.claude/CLAUDE.md`

**Action**: Add the missing commands to the Workflow Commands section, organized by category. Audit `.claude/commands/` directory to determine the full list.

**Verification**: Count of commands in CLAUDE.md Workflow Commands section matches count of `.md` files in `.claude/commands/`.

---

### P5-004: Fix Website Command Paths [3.17]

**File**: `/Users/eko3/massu/.claude/commands/massu-website-check.md`

**Action**: Add a preamble that detects the website repo location (check `../massu-internal/website` or use `$WEBSITE_ROOT` env var), or document that this command should be run from the website repo.

**Verification**: `head -5 /Users/eko3/massu/.claude/commands/massu-website-check.md` contains either a `WEBSITE_ROOT` reference or path detection logic.

---

### P5-005: Extract Trial Period to Config [3.19]

**File**: `/Users/eko3/massu-internal/website/src/app/api/stripe/checkout/route.ts`

**Action**: Replace hardcoded `trial_period_days: 14` (line 97) with a config constant (e.g., `TRIAL_PERIOD_DAYS` from a shared constants file or environment variable).

**Verification**: `grep -c 'trial_period_days: 14' /Users/eko3/massu-internal/website/src/app/api/stripe/checkout/route.ts` returns 0.

---

### P5-006: Fix Prompt Library Tier Enforcement [3.20]

**Problem**: FeatureComparison says "Personal" at cloud-pro and "Team-wide" at cloud-team, but no code enforces this distinction.

**File**: `/Users/eko3/massu-internal/website/src/components/pricing/FeatureComparison.tsx` (line 37)

**Action**: Either:
(a) Add tier check in prompt sharing logic to restrict team-wide sharing to cloud-team, or
(b) Update FeatureComparison to show "Full" for both cloud-pro and cloud-team if the distinction is not enforced.

**Verification**: Either (a) `grep -rn 'prompt.*sharing.*cloud_team\|cloud_team.*prompt.*shar' /Users/eko3/massu-internal/website/src/` returns match in prompt-specific code (note: existing `requirePlan('cloud_team')` in team/marketplace pages does NOT count), or (b) `grep 'Prompt library.*Personal' /Users/eko3/massu-internal/website/src/components/pricing/FeatureComparison.tsx` returns 0 (currently 1 at line 37). Note: `grep 'Personal'` alone is NOT valid because "Personal analytics" (line 24) is a separate feature that should remain.

---

### P5-007: Add JSON-LD Structured Data [3.11]

**File**: `/Users/eko3/massu-internal/website/src/app/layout.tsx` or `page.tsx`

**Action**: Add `Organization` and `WebSite` JSON-LD schema to the root layout for SEO.

**Verification**: `grep -n 'application/ld+json\|json-ld\|JSON-LD' /Users/eko3/massu-internal/website/src/app/layout.tsx` returns match.

---

### P5-008: Add CORS Headers to v1 API [2.17]

**Problem**: v1 API routes have no CORS headers. If clients call from browsers, requests will fail.

**Note**: This item also appears as deferred item D4 because it requires a design decision (server-to-server vs browser usage). The implementation here is contingent on that decision.

**Action**: Determine whether the v1 API is designed for server-to-server or browser usage. If server-to-server only, add documentation stating this and skip CORS. If browser usage is planned, add CORS middleware with explicit allowed origins to `/api/v1/` routes.

---

## Deferred / Design Decisions Needed (4 items)

These issues require architectural decisions before implementation:

| # | Issue | Decision Needed |
|---|-------|----------------|
| D1 / 2.2 | CSRF protection | Next.js SameSite=Lax provides partial protection. Full CSRF tokens add complexity. Determine if the threat model warrants explicit tokens. |
| D2 / 2.6 | In-memory rate limiter fallback | Only matters if Upstash is not configured in production. Verify Upstash is always configured. If yes, this is a non-issue. |
| D3 / 2.25 | Command file overhead (14K+ lines) | Structural concern. Potential solutions: consolidate similar commands, remove unused ones, or accept the overhead. Requires audit of usage patterns. |
| D4 / 2.17 | CORS on v1 API | Depends on whether the API is designed for browser or server-to-server use. (Also tracked as P5-008.) |

---

## Implementation Priority & Tracker

| # | Phase | Deliverable | Area | Priority | Status |
|---|-------|-------------|------|----------|--------|
| 1 | 1 | P1-001: Fix SSO auth bypass | Security | CRITICAL | DONE |
| 2 | 1 | P1-002: Webhook SSRF validation | Security | CRITICAL | DONE |
| 3 | 1 | P1-003: Stop exposing webhook secret | Security | CRITICAL | DONE |
| 4 | 1 | P1-004: Fix encryption plaintext fallback | Security | CRITICAL | DONE |
| 5 | 1 | P1-005: Path traversal in schema verify | Security | HIGH | DONE |
| 6 | 1 | P1-006: Rate limiting on API routes | Security | HIGH | DONE |
| 7 | 1 | P1-007: Dashboard plan gating | Security | HIGH | DONE |
| 8 | 2 | P2-001: NPM publishability | Adoption | HIGH | DONE |
| 9 | 2 | P2-002: Extract helper duplication | Code Quality | HIGH | DONE |
| 10 | 2 | P2-003: Fix model pricing defaults | Correctness | HIGH | DONE |
| 11 | 2 | P2-004: Fix repo URL mismatch | Correctness | HIGH | DONE |
| 12 | 2 | P2-005: Fix tier badges on features page | Correctness | HIGH | DONE |
| 13 | 3 | P3-001: Split memory-db.ts | Code Quality | MEDIUM | DONE |
| 14 | 3 | P3-002: Extract core tools from tools.ts | Code Quality | MEDIUM | DONE |
| 15 | 3 | P3-003: Migrate legacy tool modules | Code Quality | MEDIUM | DONE |
| 16 | 3 | P3-004: Extract getMemoryDb pattern | Code Quality | MEDIUM | DONE |
| 17 | 3 | P3-005: Cache schema initialization | Performance | MEDIUM | DONE |
| 18 | 3 | P3-006: Fix FTS5 error swallowing | Code Quality | MEDIUM | DONE |
| 19 | 3 | P3-007: Add uncaughtException exit | Code Quality | MEDIUM | DONE |
| 20 | 3 | P3-008: Fix 'my-project' default | Code Quality | MEDIUM | DONE |
| 21 | 3 | P3-009: Remove packages/shared | Cleanup | LOW | DONE |
| 22 | 3 | P3-010: Fix set -uo pipefail | Code Quality | LOW | DONE |
| 23 | 4 | P4-001: Login/signup metadata | Website | MEDIUM | DONE |
| 24 | 4 | P4-002: DOMPurify for markdown | Security | MEDIUM | DONE |
| 25 | 4 | P4-003: Dashboard loading states | UX | MEDIUM | DONE |
| 26 | 4 | P4-004: Remove framer-motion from Button | Performance | MEDIUM | DONE |
| 27 | 4 | P4-005: Mount ToastProvider | UX | MEDIUM | DONE |
| 28 | 4 | P4-006: Persist contact submissions | Correctness | MEDIUM | DONE |
| 29 | 4 | P4-007: Fix Modal colors | UI | LOW | DONE |
| 30 | 4 | P4-008: Fix Alert colors | UI | LOW | DONE |
| 31 | 4 | P4-009: Fix error page buttons | UI | LOW | DONE |
| 32 | 4 | P4-010: Add sitemap routes | SEO | LOW | DONE |
| 33 | 4 | P4-011: Remove PII from logs | Security | LOW | DONE |
| 34 | 4 | P4-012: Fix badge enumeration | Security | LOW | DONE |
| 35 | 4 | P4-013: Sanitize Content-Disposition | Security | LOW | DONE |
| 36 | 4 | P4-014: Convert 404 image to WebP | Performance | LOW | DONE |
| 37 | 5 | P5-001: Update tech stack in CLAUDE.md | Docs | LOW | DONE |
| 38 | 5 | P5-002: Update test inventory in CLAUDE.md | Docs | LOW | DONE |
| 39 | 5 | P5-003: Update commands table in CLAUDE.md | Docs | LOW | DONE |
| 40 | 5 | P5-004: Fix website command paths | Docs | LOW | DONE |
| 41 | 5 | P5-005: Extract trial period to config | Config | LOW | DONE |
| 42 | 5 | P5-006: Fix prompt library tier enforcement | Correctness | LOW | DONE |
| 43 | 5 | P5-007: Add JSON-LD structured data | SEO | LOW | DONE |
| 44 | 5 | P5-008: Add CORS headers to v1 API | Config | LOW | DONE |

---

## Verification Commands

| Phase | Command | Expected |
|-------|---------|----------|
| All | `cd packages/core && npx tsc --noEmit` | 0 errors |
| All | `npm test` | All pass |
| All | `bash scripts/massu-pattern-scanner.sh` | Exit 0 |
| All | `cd packages/core && npm run build:hooks` | Exit 0 |
| Phase 1 | `grep -rn "select('\*')" /Users/eko3/massu-internal/website/src/app/api/v1/webhooks/` | 0 matches |
| Phase 1 | `grep -rn 'store unencrypted' /Users/eko3/massu-internal/website/supabase/functions/sync/` | 0 matches |
| Phase 1 | `grep -n 'ensureWithinRoot' packages/core/src/tools.ts` | Match found |
| Phase 2 | `grep -c 'function p(' packages/core/src/tool-helpers.ts` | 1 |
| Phase 2 | `grep -rn 'function p(' packages/core/src/ \| grep -v tool-helpers \| grep -v __tests__ \| wc -l` | 0 |
| Phase 3 | `wc -l packages/core/src/tools.ts` | < 300 |
| Phase 3 | `wc -l packages/core/src/memory-db.ts` | < 400 |

---

**Plan Version**: 2.0 (verification audit pass 1 - all 44 deliverables verified DONE)
**Last Updated**: 2026-02-21
