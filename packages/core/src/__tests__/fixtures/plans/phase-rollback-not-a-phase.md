# Plan Test: Phase Rollback — headings that only LOOK like phase declarations

**Date**: 2026-08-12
**Plan Token**: `plan-test-phase-rb-notaphase`
**Status**: 📋 DRAFT — awaiting approval

## 4. Implementation items

### Phase P1 — the only real phase here

## Phase Shippability (CR-39 / VR-PRODUCT)

Measured false positive: without the trailing-delimiter clause this heading parses as
phase "S" and demands a rollback for a section that ships nothing.

## Security Pre-Screen (Phase 4.8)

"Phase" mid-heading is a reference, not a declaration.

```markdown
### Phase P9 — inside a fenced block, so it is documentation, not a declaration
```

## 7. Rollback

P1: revert the commit.
