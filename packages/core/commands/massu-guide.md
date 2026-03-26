---
name: massu-guide
description: "When a new user or contributor asks 'how does this work', 'give me a tour', 'onboarding', or needs an interactive walkthrough of the codebase"
allowed-tools: Bash(*), Read(*), Grep(*), Glob(*)
---
name: massu-guide

# Massu Guide: Codebase Onboarding Walkthrough

## Objective

Provide a guided orientation for new developers (or fresh AI sessions) to understand the project — its architecture, .claude/ infrastructure, workflows, and common gotchas. Read-only exploration, no modifications.

---

## WALKTHROUGH (5 Sections)

### Section 1: Project Overview

Read and present:

```bash
# Tech stack from package.json
cat package.json | jq '{name, version, scripts: (.scripts | keys | length), dependencies: (.dependencies | keys | length), devDependencies: (.devDependencies | keys | length)}'

# Core framework versions
cat package.json | jq '{next: .dependencies.next, react: .dependencies.react, prisma: .devDependencies.prisma, trpc: .dependencies["@trpc/server"], typescript: .devDependencies.typescript}'
```

Read `.claude/CLAUDE.md` first 30 lines — Prime Directive and CR table header.

Count key entities:
```bash
ls src/server/api/routers/*.ts 2>/dev/null | wc -l  # Routers
find src/components -name "*.tsx" -maxdepth 3 | wc -l  # Components
find src/app -name "page.tsx" | wc -l  # Pages
find . -name "*.test.*" -o -name "*.spec.*" | grep -v node_modules | wc -l  # Tests
```

Output: "[Project Name]: Next.js [ver] / React [ver] / tRPC [ver] / Prisma [ver] / TypeScript [ver] with N routers, N components, N pages, N tests."

---

### Section 2: Architecture Map

Run the codebase map script (if available):
```bash
./scripts/codebase-map.sh 2>/dev/null || echo "Running manual count..."
```

Or count manually:
```bash
echo "=== ARCHITECTURE MAP ==="
echo "Pages:      $(find src/app -name 'page.tsx' | wc -l)"
echo "Layouts:    $(find src/app -name 'layout.tsx' | wc -l)"
echo "API Routes: $(find src/app/api -name 'route.ts' 2>/dev/null | wc -l)"
echo "Routers:    $(ls src/server/api/routers/*.ts | wc -l)"
echo "Components: $(find src/components -name '*.tsx' -maxdepth 3 | wc -l)"
echo "Lib files:  $(find src/lib -name '*.ts' | wc -l)"
echo "Hooks:      $(find src -name 'use*.ts' -o -name 'use*.tsx' | grep -v node_modules | wc -l)"
```

Highlight key files:
- `src/lib/db.ts` — Database client (ctx.db)
- `src/server/api/trpc.ts` — tRPC context + procedures
- `src/middleware.ts` — Auth + routing
- `src/server/api/root.ts` — Router aggregation

---

### Section 3: Infrastructure Tour

```bash
echo "=== .CLAUDE/ INFRASTRUCTURE ==="
echo "Commands:   $(ls .claude/commands/*.md | wc -l)"
echo "Patterns:   $(ls .claude/patterns/*.md | wc -l)"
echo "Protocols:  $(ls .claude/protocols/*.md | wc -l)"
echo "References: $(ls .claude/reference/*.md | wc -l)"
echo "Incidents:  $(grep -c '^### Incident' .claude/incidents/INCIDENT-LOG.md 2>/dev/null || echo 0)"
echo "CR Rules:   $(grep -c '^| CR-' .claude/CLAUDE.md)"
echo "VR Types:   $(grep -c '^| VR-' .claude/reference/vr-verification-reference.md 2>/dev/null || echo '50+')"
echo "Hook Scripts: $(ls scripts/hooks/*.sh 2>/dev/null | wc -l)"
echo "Audit Scripts: $(ls scripts/audit-*.sh scripts/check-*.sh 2>/dev/null | wc -l)"
```

List top 10 most-used commands:
- `/massu-loop` — Main implementation loop with verification
- `/massu-create-plan` — Plan generation from requirements
- `/massu-plan` — Plan audit and improvement
- `/massu-commit` — Pre-commit verification gate
- `/massu-push` — Pre-push full verification
- `/massu-verify` — Run all VR-* checks
- `/massu-test` — Test coverage audit
- `/massu-tdd` — Test-driven development cycle
- `/massu-hotfix` — Emergency fix protocol
- `/massu-debug` — Systematic debugging

---

### Section 4: Key Workflows

Present the standard development workflow:

```
/massu-create-plan -> /massu-plan -> /massu-loop -> /massu-commit -> /massu-push
(CREATE)           (AUDIT)       (IMPLEMENT)  (COMMIT)       (PUSH)
```

Explain the verification system:
- **VR-BUILD**: `npm run build` must exit 0
- **VR-TYPE**: `npx tsc --noEmit` must have 0 errors
- **VR-TEST**: `npm test` must pass (MANDATORY)
- **VR-SCHEMA**: Query database before using column names
- **VR-NEGATIVE**: grep returns 0 matches for removed code

Explain the audit commands:
- `/massu-dead-code` — Unused code detection

---

### Section 5: Common Gotchas

Extract from CLAUDE.md and project patterns:

**Database Rules**:
- Use `ctx.db` NOT `ctx.prisma`
- Use `user_profiles` NOT `users`
- 3-step query pattern (no `include:`)
- BigInt: use `Number()` on return
- RLS + Grants: both needed

**Build Rules**:
- JSDOM/Cheerio: dynamic import only
- Client/Server boundary: no `@/lib/db` in client components
- Suspense boundaries for `use(params)` pages

**UI Rules**:
- Select.Item: never `value=""`, use `__none__`
- Null guards: `(status || "pending").replace()`
- Page layout: always `page-container` class

**Known Schema Mismatches**:
- ALWAYS run VR-SCHEMA-PRE before writing queries
- Column names may differ from what you expect — verify against `information_schema.columns`

---

## OUTPUT FORMAT

Present each section with a clear header and structured output. After all 5 sections, provide:

```markdown
## ORIENTATION COMPLETE

You are now oriented with:
- [X] Project tech stack and scale
- [X] Architecture map with key files
- [X] .claude/ infrastructure (commands, hooks, rules)
- [X] Standard workflows and verification system
- [X] Common gotchas and schema traps

**Ready to start work. Recommended next steps:**
1. Read the plan file if one exists
2. Run `/massu-create-plan` for new features
3. Use `/massu-verify` to check current state
```

---

**This is a read-only command. It explores and presents — it does not modify any files.**
