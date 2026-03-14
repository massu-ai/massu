---
name: massu-release
description: Release preparation — version bump, changelog, full verification, tagging
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---
name: massu-release

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9, CR-35 enforced.

# CS Release: Release Preparation Gate

## Objective

Prepare a verified release with proper versioning, changelog generation, and tagging. Runs the full verification gate before creating any release artifacts. Does NOT push — waits for user confirmation.

**Usage**: `/massu-release` (auto-detect version) or `/massu-release [major|minor|patch]`

---

## NON-NEGOTIABLE RULES

- ALL verification gates MUST pass before version bump
- Do NOT push to remote (wait for user)
- Changelog MUST be generated from conventional commits
- Version MUST follow semver
- ALL package.json files MUST be updated consistently
- If ANY gate fails, ABORT with clear reason

---

## STEP 1: VERSION DETERMINATION

### 1.1 Get Current State

```bash
# Current version
grep '"version"' packages/core/package.json

# Last tag
git describe --tags --abbrev=0 2>/dev/null || echo "no tags"

# Commits since last tag
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
if [ -n "$LAST_TAG" ]; then
  git log ${LAST_TAG}..HEAD --oneline
  echo "---"
  echo "Commit count since $LAST_TAG:"
  git log ${LAST_TAG}..HEAD --oneline | wc -l
else
  git log --oneline | head -20
  echo "---"
  echo "No previous tags found"
fi
```

### 1.2 Classify Commits

```bash
# Count by type
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
RANGE="${LAST_TAG:+$LAST_TAG..}HEAD"

echo "=== Commit Classification ==="
echo "feat (minor):"
git log $RANGE --oneline | grep -c '^[a-f0-9]* feat' || echo "0"
echo "fix (patch):"
git log $RANGE --oneline | grep -c '^[a-f0-9]* fix' || echo "0"
echo "BREAKING CHANGE (major):"
git log $RANGE --format="%B" | grep -c 'BREAKING CHANGE' || echo "0"
echo "perf:"
git log $RANGE --oneline | grep -c '^[a-f0-9]* perf' || echo "0"
echo "refactor:"
git log $RANGE --oneline | grep -c '^[a-f0-9]* refactor' || echo "0"
echo "other:"
git log $RANGE --oneline | grep -vc '^[a-f0-9]* \(feat\|fix\|perf\|refactor\|docs\|test\|chore\|ci\|build\)' || echo "0"
```

### 1.3 Determine Version Bump

| Commit Types Present | Auto-Detected Bump |
|---------------------|-------------------|
| BREAKING CHANGE | major (X.0.0) |
| feat | minor (0.X.0) |
| fix, perf, refactor only | patch (0.0.X) |

If `$ARGUMENTS` specifies `major`, `minor`, or `patch`, use that instead of auto-detection.

```markdown
### Version Determination
- **Current version**: [X.Y.Z]
- **Last tag**: [tag or none]
- **Commits since tag**: [N]
- **Auto-detected bump**: [major/minor/patch]
- **Proposed version**: [X.Y.Z] -> [A.B.C]
```

---

## STEP 2: PRE-RELEASE VERIFICATION

Run the full verification gate sequence. If ANY check fails, ABORT the release.

### Tier 1: Quick Checks

```bash
# 1.1 Pattern Scanner
bash scripts/massu-pattern-scanner.sh
# MUST exit 0

# 1.2 TypeScript
cd packages/core && npx tsc --noEmit
# MUST show 0 errors

# 1.3 Hook Build
cd packages/core && npm run build:hooks
# MUST exit 0
```

### Tier 2: Full Test Suite

```bash
# 2.1 All tests
npm test
# MUST exit 0, all tests pass
```

```bash
# 2.2 Tool registration verification
grep -c "ToolDefinitions()" packages/core/src/tools.ts
grep -c "isTool\b\|startsWith" packages/core/src/tools.ts
```

### Tier 3: Security & Compliance

```bash
# 3.1 npm audit
npm audit --audit-level=high 2>&1 || true

# 3.2 Secrets scan
grep -rn 'sk-[a-zA-Z0-9]\{20,\}\|password.*=.*["\x27][^"\x27]\{8,\}' --include="*.ts" --include="*.tsx" \
  packages/core/src/ 2>/dev/null \
  | grep -v "process.env\|RegExp\|regex\|REDACT\|redact\|sanitize\|mask\|\.test\.ts:" \
  | wc -l
# MUST be 0

# 3.3 Dependency audit
npm audit --audit-level=high 2>&1
```

### Tier 4: Website Build (if website exists)

```bash
if [ -d "website" ]; then
  cd website && npm run build 2>&1
  # MUST exit 0
fi
```

```markdown
### Pre-Release Verification

| Tier | Check | Result | Status |
|------|-------|--------|--------|
| 1 | Pattern Scanner | Exit [X] | PASS/FAIL |
| 1 | TypeScript | [X] errors | PASS/FAIL |
| 1 | Hook Build | Exit [X] | PASS/FAIL |
| 2 | Tests | [X]/[X] passed | PASS/FAIL |
| 2 | Tool Registration | All wired | PASS/FAIL |
| 3 | npm audit | [X] high/critical | PASS/FAIL |
| 3 | Secrets scan | [X] found | PASS/FAIL |
| 4 | Website build | Exit [X] | PASS/FAIL/N/A |

**PRE-RELEASE GATE: PASS / FAIL**
```

**If ANY check fails**: ABORT with "Release blocked: [specific failure reason]". Do NOT proceed.

---

## STEP 3: CHANGELOG GENERATION

### 3.1 Parse Conventional Commits

```bash
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
RANGE="${LAST_TAG:+$LAST_TAG..}HEAD"

git log $RANGE --pretty=format:"%H|%s|%an|%ad" --date=short
```

### 3.2 Group by Type

| Commit Type | Changelog Section |
|-------------|------------------|
| feat | Added |
| fix | Fixed |
| perf | Performance |
| refactor | Changed |
| docs | Documentation |
| test | Tests |
| build/ci | Build & CI |
| chore | Maintenance |
| BREAKING CHANGE | Breaking Changes |

### 3.3 Generate Changelog Section

```markdown
## [X.Y.Z] - YYYY-MM-DD

### Breaking Changes
- [breaking changes, if any]

### Added
- [feat commits, stripped of Co-authored-by lines]

### Changed
- [refactor commits]

### Fixed
- [fix commits]

### Performance
- [perf commits]
```

**Empty sections are omitted.**

### 3.4 Update CHANGELOG.md

1. Read existing `CHANGELOG.md`
2. Replace `## [Unreleased]` content with empty section
3. Insert new version section below `## [Unreleased]`
4. Preserve all previous released sections unchanged

---

## STEP 4: VERSION BUMP

### 4.1 Update Package Versions

```bash
# Find all package.json files that need version updates
grep -rn '"version"' packages/*/package.json package.json 2>/dev/null
```

Update version in:
- `packages/core/package.json`
- `packages/plugin/package.json` (if exists)
- Root `package.json` (if has version field)

### 4.2 Verify Consistency

```bash
# All version fields should now show the new version
grep '"version"' packages/*/package.json package.json 2>/dev/null
```

---

## STEP 5: RELEASE NOTES DRAFT

Generate user-facing release notes:

```markdown
# Release vX.Y.Z

## Highlights
- [Most impactful features/changes — 2-3 bullet points]

## Breaking Changes
- [Breaking changes with migration instructions, if any]

## Bug Fixes
- [Notable bug fixes]

## Dependencies
- [Notable dependency updates, if any]

## Full Changelog
See CHANGELOG.md for the complete list of changes.
```

---

## STEP 6: COMMIT AND TAG

### 6.1 Stage Release Files

```bash
git add CHANGELOG.md
git add packages/*/package.json
git add package.json 2>/dev/null || true
```

### 6.2 Create Release Commit

```bash
git commit -m "$(cat <<'EOF'
chore: release vX.Y.Z

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

### 6.3 Create Annotated Tag

```bash
git tag -a vX.Y.Z -m "Release vX.Y.Z"
```

### 6.4 Verify

```bash
# Verify tag was created
git tag -l 'vX.Y.Z'
git log -1 --oneline
git show vX.Y.Z --quiet
```

**Do NOT push.** Wait for user to review and confirm.

---

## COMPLETION REPORT

```markdown
## CS RELEASE COMPLETE

### Release Summary
- **Version**: [old] -> [new]
- **Bump type**: [major/minor/patch]
- **Commits included**: [N]
- **Tag**: vX.Y.Z

### Pre-Release Verification
| Tier | Status |
|------|--------|
| Tier 1 (patterns, types, hooks) | PASS |
| Tier 2 (tests, tool registration) | PASS |
| Tier 3 (security, compliance) | PASS |
| Tier 4 (website build) | PASS/N/A |

### Changelog
- **Sections updated**: [list]
- **Breaking changes**: [N]
- **Features**: [N]
- **Fixes**: [N]

### Files Modified
- `CHANGELOG.md`
- `packages/core/package.json`
- `packages/plugin/package.json` (if exists)

### Release Artifacts
- Commit: [hash]
- Tag: vX.Y.Z

### Next Steps
- Review the changelog and release notes
- Push to remote: `git push origin [branch] --follow-tags`
- Create GitHub release (optional): `gh release create vX.Y.Z --notes-file [notes]`
```
