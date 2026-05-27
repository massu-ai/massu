# Leak Fixture — Trigger Case

This fixture contains a word that the generic leak-guard pattern `CONFIDENTIAL` matches: CONFIDENTIAL.

The leak-guard scanner in commit-mode MUST FAIL on this file. The vitest test `leak-guard-commit-mode.test.ts` invokes the scanner with `MASSU_LEAK_GUARD_MODE=commit` and asserts exit code 1.

The trigger is a GENERIC catalog pattern (always loaded from the synced `scripts/lib/leak-patterns.sh` CONTENT_PATTERNS), so this test verifies the same mechanism in both the internal context and the public-mirror CI where operator-only patterns are absent.
