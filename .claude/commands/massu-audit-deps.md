---
name: massu-audit-deps
description: Comprehensive dependency audit (vulnerabilities, outdated, licenses, unused, bundle size)
allowed-tools: Bash(*), Read(*), Grep(*), Glob(*)
---
name: massu-audit-deps

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9, CR-35 enforced.

# CS Audit Deps: Comprehensive Dependency Audit

## Objective

Run a multi-phase dependency audit covering security vulnerabilities, outdated packages, license compliance, unused dependencies, and bundle size analysis. This is a READ-ONLY audit - no packages are modified.

## Workflow Position

Dependency audit is a diagnostic command. Produces a report of vulnerabilities, license issues, and unused packages.

```
/massu-audit-deps  ->  dependency report  ->  /massu-create-plan (if updates needed)
```

---

## NON-NEGOTIABLE RULES

- Do NOT install, update, or remove any packages
- Do NOT modify package.json or package-lock.json
- Report ALL findings with severity classification
- License compliance checks MUST account for BSL 1.1 compatibility
- Bundle size analysis applies to hooks (esbuild output)

---

## PHASE 1: VULNERABILITY SCAN

```bash
# Run npm audit with full detail
npm audit 2>&1

# Separate by severity
npm audit --audit-level=critical 2>&1 || true
npm audit --audit-level=high 2>&1 || true
```

### Vulnerability Classification

| Severity | Action Required | Blocks Push? |
|----------|----------------|--------------|
| Critical | MUST fix before any deployment | YES |
| High | MUST fix before push | YES |
| Moderate | Document, create fix plan | NO |
| Low | Informational only | NO |

### For Each Vulnerability

```markdown
| Package | Severity | CVE | Affects Production? | Fix Available? | Action |
|---------|----------|-----|---------------------|----------------|--------|
| [pkg] | [sev] | [cve] | YES/NO (dev-only) | YES/NO | [action] |
```

**Key distinction**: Dev-only vulnerabilities (in devDependencies, build tooling) are lower priority than production runtime vulnerabilities.

---

## PHASE 2: OUTDATED PACKAGES

```bash
# Check for outdated packages
npm outdated 2>&1 || true

# Check in website directory if it exists
ls website/package.json 2>/dev/null && (cd website && npm outdated 2>&1 || true)
```

### Outdated Classification

| Update Type | Risk | Recommendation |
|-------------|------|----------------|
| Patch (1.2.3 -> 1.2.4) | Low | Update in next commit |
| Minor (1.2.3 -> 1.3.0) | Medium | Review changelog, then update |
| Major (1.2.3 -> 2.0.0) | High | Plan migration, check breaking changes |

```markdown
### Outdated Packages

| Package | Current | Wanted | Latest | Type | Risk |
|---------|---------|--------|--------|------|------|
| [pkg] | [ver] | [ver] | [ver] | patch/minor/major | Low/Med/High |
```

---

## PHASE 3: LICENSE COMPLIANCE

**Massu uses BSL 1.1 license. Dependencies must be compatible.**

```bash
# List all production dependency licenses
npx license-checker --production --summary 2>/dev/null || \
  npm ls --all --production 2>/dev/null | head -50

# Check for known problematic licenses
npx license-checker --production --failOn "GPL-2.0;GPL-3.0;AGPL-3.0;AGPL-1.0;SSPL-1.0" 2>/dev/null || \
  echo "license-checker not installed - manual review needed"
```

### License Compatibility Matrix

| License | Compatible with BSL 1.1? | Action |
|---------|-------------------------|--------|
| MIT | YES | No action |
| Apache-2.0 | YES | No action |
| BSD-2-Clause | YES | No action |
| BSD-3-Clause | YES | No action |
| ISC | YES | No action |
| GPL-2.0 | INCOMPATIBLE | Must replace |
| GPL-3.0 | INCOMPATIBLE | Must replace |
| AGPL-3.0 | INCOMPATIBLE | Must replace |
| SSPL-1.0 | INCOMPATIBLE | Must replace |
| LGPL-2.1 | REVIEW | Check usage pattern |

**If license-checker is not installed**, manually check:
```bash
# For each production dependency, check license field
cat package.json | node -e "
  const pkg = require('./package.json');
  const deps = Object.keys(pkg.dependencies || {});
  deps.forEach(d => {
    try {
      const p = require(d + '/package.json');
      console.log(d + ': ' + (p.license || 'UNKNOWN'));
    } catch(e) { console.log(d + ': CHECK MANUALLY'); }
  });
"
```

---

## PHASE 4: UNUSED DEPENDENCY DETECTION

```bash
# Check if each dependency is actually imported in source
for dep in $(node -e "const p=require('./package.json'); Object.keys(p.dependencies||{}).forEach(d=>console.log(d))"); do
  count=$(grep -rn "from ['\"]$dep" packages/core/src/ --include="*.ts" 2>/dev/null | wc -l | tr -d ' ')
  count2=$(grep -rn "require(['\"]$dep" packages/core/src/ --include="*.ts" 2>/dev/null | wc -l | tr -d ' ')
  total=$((count + count2))
  if [ "$total" -eq 0 ]; then
    echo "UNUSED: $dep (0 imports found)"
  fi
done
```

```markdown
### Unused Dependencies

| Package | In package.json | Imports Found | Recommendation |
|---------|----------------|---------------|----------------|
| [pkg] | dependencies | 0 | Remove or verify indirect usage |
```

**Note**: Some packages may be used indirectly (peer deps, plugin systems). Flag but don't auto-remove.

---

## PHASE 5: BUNDLE SIZE ANALYSIS (Hooks)

```bash
# Check compiled hook sizes
ls -la packages/core/dist/hooks/*.js 2>/dev/null

# Check total hook bundle size
du -sh packages/core/dist/hooks/ 2>/dev/null || echo "Hooks not compiled - run: cd packages/core && npm run build:hooks"
```

### Hook Size Thresholds

| Metric | Threshold | Status |
|--------|-----------|--------|
| Individual hook | < 50 KB | PASS/FAIL |
| Total hooks dir | < 500 KB | PASS/FAIL |

---

## COMPLETION REPORT

```markdown
## CS AUDIT DEPS COMPLETE

### Summary
| Phase | Findings | Critical? |
|-------|----------|-----------|
| Vulnerabilities | [N] total ([N] high/critical) | YES/NO |
| Outdated | [N] packages ([N] major) | NO |
| License | [N] incompatible | YES/NO |
| Unused | [N] potentially unused | NO |
| Bundle Size | [size] total hooks | PASS/FAIL |

### Action Items (Priority Order)
1. [Critical/High vulnerabilities to fix]
2. [Incompatible licenses to replace]
3. [Major version updates to plan]
4. [Unused deps to investigate]

### Overall Health
- **Vulnerability Score**: CLEAN / MODERATE / AT RISK
- **Freshness Score**: CURRENT / STALE / OUTDATED
- **License Compliance**: COMPLIANT / REVIEW NEEDED / NON-COMPLIANT
```
