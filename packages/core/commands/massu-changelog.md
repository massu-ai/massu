---
name: massu-changelog
description: Generate changelog entries from conventional commits
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---
name: massu-changelog

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9, CR-35 enforced.

# CS Changelog: Generate Changelog from Commits

## Objective

Parse conventional commits since the last release/tag and generate structured changelog entries. Updates `CHANGELOG.md` with properly categorized changes.

**Usage**: `/massu-changelog` (since last tag) or `/massu-changelog [since-ref]`

---

## STEP 1: DETERMINE RANGE

```bash
# Find the last tag
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")

# If no tags, use first commit
if [ -z "$LAST_TAG" ]; then
  SINCE=$(git rev-list --max-parents=0 HEAD)
  echo "No tags found, generating from first commit"
else
  SINCE="$LAST_TAG"
  echo "Generating changelog since $LAST_TAG"
fi

# If argument provided, use that as the since reference
# SINCE=$ARGUMENTS (if provided)

# Get commit log
git log $SINCE..HEAD --pretty=format:"%H|%s|%an|%ad" --date=short
```

---

## STEP 2: PARSE CONVENTIONAL COMMITS

Parse each commit message using conventional commit format: `type(scope): description`

### Commit Type Mapping

| Type | Changelog Section | Emoji |
|------|------------------|-------|
| feat | Added | - |
| fix | Fixed | - |
| perf | Performance | - |
| refactor | Changed | - |
| docs | Documentation | - |
| test | Tests | - |
| build | Build | - |
| ci | CI/CD | - |
| chore | Maintenance | - |
| security | Security | - |
| revert | Reverted | - |
| BREAKING CHANGE | Breaking Changes | - |

### Parsing Rules
- Commits not following conventional format go under "Other"
- Scope (if present) is included in parentheses
- Multi-line commit bodies are included as sub-bullets
- Co-authored-by lines are stripped from display

---

## STEP 3: GROUP AND FORMAT

```markdown
## [Unreleased]

### Breaking Changes
- [breaking changes, if any]

### Added
- [feat commits]

### Changed
- [refactor commits]

### Fixed
- [fix commits]

### Performance
- [perf commits]

### Security
- [security-related commits]

### Documentation
- [docs commits]

### Tests
- [test commits]

### Build & CI
- [build/ci commits]

### Maintenance
- [chore commits]
```

**Empty sections are omitted.**

---

## STEP 4: UPDATE CHANGELOG.md

1. Read existing `CHANGELOG.md`
2. Insert new entries under `## [Unreleased]` section
3. If entries already exist under `[Unreleased]`, merge (don't duplicate)

```bash
# Read current changelog
cat CHANGELOG.md
```

**Merge strategy:**
- If `## [Unreleased]` exists, replace its content with new entries
- If no `## [Unreleased]`, insert after the header
- Preserve all previous released sections unchanged

---

## STEP 5: OPTIONAL TAG CREATION

Ask the user if they want to create a release tag:

```markdown
### Changelog generated. Create a release tag?

If yes, provide:
- Version number (semver): e.g., 0.2.0
- This will:
  1. Replace `## [Unreleased]` with `## [0.2.0] - YYYY-MM-DD`
  2. Add a new empty `## [Unreleased]` section above
  3. Create git tag `v0.2.0`
```

---

## COMPLETION REPORT

```markdown
## CS CHANGELOG COMPLETE

### Summary
- **Range**: [since]..HEAD
- **Commits parsed**: [N]
- **Sections updated**: [list]

### Changes by Type
| Type | Count |
|------|-------|
| feat | [N] |
| fix | [N] |
| refactor | [N] |
| docs | [N] |
| other | [N] |

### File Updated
- `CHANGELOG.md`

### Next Steps
- Review the changelog entries
- Run `/massu-commit` to commit the changelog update
- Optionally create a release tag
```
