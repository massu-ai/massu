# Plan Test: Phase Rollback — version strings and item ids are not phase ranges

**Date**: 2026-08-12
**Plan Token**: `plan-test-phase-rb-prose`
**Status**: 📋 DRAFT — awaiting approval

## 4. Implementation items

### Phase P1 — first

### Phase P2 — second

### Phase P3 — third

## 7. Rollback

P1: deprecate the release and cut a hotfix.

The prose below must create NO coverage. An earlier range expander read all of it as
phase ranges, and read it DIFFERENTLY under mawk and BWK awk — so the same plan passed
on one machine and failed on the other:

1. Deprecate `@massu/core@1.2.0` and pin consumers to `1.1.0 - 1.2.0` while the fix lands.
2. Revert the P5-007 regression probe.
3. Re-run the battery.
