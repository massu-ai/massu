# Knowledge Fixture Project

A deterministic corpus for `knowledge-tools.test.ts`. Every row below exists because a test
asserts on it; nothing here is decorative. It is an ORACLE — a guard's expectation of the
answer — and so it is hand-authored and may never be derived from the live tree (G32).

## Canonical Rules (CR)

| ID | Rule | Verification Type |
|----|------|-------------------|
| CR-1 | Never claim state without proof | VR-BUILD |
| CR-2 | Never assume file or module structure | VR-GREP |
| CR-3 | Run the test suite before claiming complete | VR-TEST |
| CR-9 | Fix every issue encountered, including pre-existing ones | VR-TEST |

## Verification Requirements (VR)

| Type | Command | Expected | Use When |
|------|---------|----------|----------|
| VR-BUILD | `npm run build` | Exit 0 | Claiming production ready |
| VR-TEST | `npm test` | All pass | Before claiming complete |
| VR-GREP | `grep -rn pattern src/` | Match found | Claiming code added |

## Known Schema Mismatches

| Table | Wrong Column | Correct Column |
|-------|--------------|----------------|
| sessions | started | started_at |

## Config Access Pattern

Read project configuration through the config loader rather than parsing YAML directly.
A direct parse bypasses caching and drifts from the loader's defaults.
