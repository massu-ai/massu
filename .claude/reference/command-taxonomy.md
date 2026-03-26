# Command Taxonomy

Categorization of all commands into the 9-type taxonomy from "Lessons from Building Claude Code: How We Use Skills."

## Categories

| # | Category | Description |
|---|----------|-------------|
| 1 | Library & API Reference | Shared knowledge, patterns, specifications |
| 2 | Verification | Validation, testing, quality gates |
| 3 | Data Fetching & Analysis | Database queries, metrics, analytics |
| 4 | Business Process & Team Automation | Workflows, session management, orchestration |
| 5 | Code Scaffolding & Templates | File generation, boilerplate, format templates |
| 6 | Code Review | Quality analysis, simplification, auditing |
| 7 | Deployment | Push, release, hotfix, rollback |
| 8 | Investigation | Debugging, incident response, root cause analysis |
| 9 | Infrastructure Operations | Dependencies, hooks, dead code, configuration |

---

## Full Mapping

### 1. Library & API Reference (2)

| Command | Purpose |
|---------|---------|
| `_shared-preamble` | Shared preamble injected into all commands |
| `massu-guide` | User onboarding and system documentation |

### 2. Verification (6)

| Command | Purpose |
|---------|---------|
| `massu-verify` | Run verification requirements (VR-*) |
| `massu-checkpoint` | Mid-implementation checkpoint audit |
| `massu-loop-playwright` | Browser-based E2E verification loop |
| `massu-verify-playwright` | Single-page browser verification |
| `massu-test` | Run test suites |
| `massu-tdd` | Test-driven development workflow |

### 3. Data Fetching & Analysis (3)

| Command | Purpose |
|---------|---------|
| `massu-parity` | Cross-environment schema parity check |
| `massu-gap-enhancement-analyzer` | Gap and enhancement analysis from reports |
| `massu-data` | Database analytics and query library |

### 4. Business Process & Team Automation (6)

| Command | Purpose |
|---------|---------|
| `massu-golden-path` | Full autonomous plan-to-push pipeline |
| `massu-bearings` | Morning session orientation |
| `massu-recap` | End-of-session handoff |
| `massu-squirrels` | Park tangential ideas mid-task |
| `massu-create-plan` | Plan creation from requirements |
| `massu-plan` | Plan audit for gaps |

### 5. Code Scaffolding & Templates (6)

| Command | Purpose |
|---------|---------|
| `format-supabase-migration` | SQL migration file template |
| `format-trpc-router` | tRPC router file template |
| `massu-scaffold-page` | New page scaffolding |
| `massu-scaffold-router` | New tRPC router scaffolding |
| `massu-scaffold-hook` | New hook scaffolding |
| `massu-scaffold-mcp` | New MCP integration scaffolding |

### 6. Code Review (9)

| Command | Purpose |
|---------|---------|
| `massu-simplify` | Post-change multi-reviewer quality analysis |
| `massu-commit` | Pre-commit verification gates |
| `massu-article-review` | External article/post analysis |
| `massu-command-health` | Command quality dashboard |
| `massu-command-improve` | Improve a specific command |
| `massu-codebase-audit` | Full codebase quality audit |
| `massu-ui-audit` | UI/UX quality audit |
| `massu-feature-audit` | Feature completeness audit |
| `massu-extended-audit` | Extended multi-dimension audit |

### 7. Deployment (4)

| Command | Purpose |
|---------|---------|
| `massu-push` | Push with pre-push verification |
| `massu-push-light` | Lightweight push (fewer checks) |
| `massu-hotfix` | Emergency production fix pipeline |
| `massu-rollback` | Deployment rollback |

### 8. Investigation (2)

| Command | Purpose |
|---------|---------|
| `massu-debug` | Structured bug investigation with auto-learning |
| `massu-incident` | Incident documentation and response protocol |

### 9. Infrastructure Operations (12)

| Command | Purpose |
|---------|---------|
| `massu-deps` | Dependency health audit |
| `massu-hooks` | Hook system inventory |
| `massu-dead-code` | Dead code detection and removal |
| `massu-ai-models` | AI model configuration audit |
| `massu-batch` | Parallel code-only migrations |
| `massu-config-audit` | Configuration consistency audit |
| `massu-db-audit` | Database health audit |
| `massu-db-branch` | Database branching operations |
| `massu-import-audit` | Import chain analysis |
| `massu-infra-audit` | Infrastructure audit |
| `massu-migrate` | Code migration assistant |
| `massu-session-optimization` | Session context optimization |

### Cross-Cutting Orchestration (6)

| Command | Purpose |
|---------|---------|
| `massu-loop` | Plan implementation loop |
| `massu-new-feature` | New feature workflow |
| `massu-new-pattern` | New pattern documentation |
| `massu-rebuild` | Feature rebuild with parity |
| `massu-refactor` | Refactoring workflow |
| `massu-learning-audit` | Learning pipeline audit |

### Specialized (9)

| Command | Purpose |
|---------|---------|
| `massu-api-contract` | API contract validation |
| `massu-docs` | Documentation generation |
| `massu-mobile-research` | Mobile platform research |
| `massu-perf` | Performance analysis |
| `massu-plan-audit` | Plan audit (subset of massu-plan) |
| `massu-security` | Security audit |
| `massu-type-mismatch-audit` | TypeScript type mismatch detection |
| `careful` | Session-scoped destructive command blocking |
| `freeze` | Session-scoped edit directory restriction |

---

## Coverage Analysis

| Category | Count | Coverage |
|----------|-------|----------|
| 1. Library & API Reference | 2 | Thin -- relies on pattern files in `patterns/` and `specs/` |
| 2. Verification | 6 | Strong |
| 3. Data Fetching & Analysis | 3 | Moderate |
| 4. Business Process | 6 | Strong |
| 5. Code Scaffolding | 6 | Strong |
| 6. Code Review | 9 | Very Strong |
| 7. Deployment | 4 | Strong |
| 8. Investigation | 2 | Adequate -- high quality per command |
| 9. Infrastructure Ops | 12 | Very Strong |

### Coverage Gaps

1. **Library & API Reference**: Relies on pattern files rather than dedicated commands. The `_shared-preamble` + `massu-guide` cover basics, but specific API reference skills could be useful as standalone lookups. **Recommendation**: Low priority -- pattern files serve this role well.

2. **Data Fetching & Analysis**: Could benefit from a dedicated analytics/dashboard skill. **Recommendation**: Monitor usage of `massu-data` before expanding.

3. **Investigation**: Only 2 commands but both are comprehensive folder-based skills. Quality over quantity. **Recommendation**: No action needed.

---

## Folder-Based Skills

Commands that have been migrated to folder-based structure for progressive disclosure:

| Command | Files | Scripts |
|---------|-------|---------|
| `massu-golden-path/` | Reference docs | -- |
| `massu-debug/` | Reference docs | Diagnostic scripts |
| `massu-loop/` | Reference docs | -- |
| `massu-data/` | Reference docs | SQL scripts |
